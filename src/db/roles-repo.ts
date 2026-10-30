import type pg from "pg";
import { z } from "zod";
import type { CandidateFact } from "../domain/candidate-profile.js";
import { loadScopedEvidence } from "./profile-repo.js";
import {
  canonicalAliases, familySchema, normalizeAlias, roleDefinitionDigest, roleDefinitionSchema, roleEditSchema, sha256Json,
  type RoleDefinition, type RoleEdit, type RoleFamily,
} from "../roles/catalog.js";
import { RoleRuleError } from "../roles/errors.js";
import { summarizeExperience, type ExperienceSummary } from "../roles/experience.js";
import { assessRoles, experienceNote, suggestSearchBand, type Gap, type RoleAssessment } from "../roles/recommend.js";
import { SEED_CATALOG } from "../roles/seed.js";

// PostgreSQL access for S2 (role catalog, recommendations, selections). The only writer of those tables.
// Recommendations are derived data: they are recomputed from currently APPROVED facts and the live catalog, never copied from
// JSONL. Human decisions attach to a specific input digest and are never carried onto different evidence.

export const SELECTION_WORK_MODES = ["remote", "hybrid", "onsite"] as const;
export const SELECTION_SENIORITY = ["entry", "junior", "mid", "senior"] as const;

export const locationSchema = z.object({ kind: z.enum(["country", "region", "city", "remote"]), value: z.string().trim().min(1).max(80) }).strict();
export const searchBandSchema = z
  .object({ minYears: z.number().int().min(0).max(30), maxYears: z.number().int().min(0).max(30) })
  .strict()
  .refine((b) => b.minYears <= b.maxYears, { message: "minYears must not exceed maxYears" });

export const selectionInputSchema = z
  .object({
    expectedRevision: z.number().int().min(0),
    expectedCatalogVersion: z.number().int().min(1),
    targetFamilies: z.array(z.string().max(64)).max(12),
    roleSlugs: z.array(z.string().max(64)).max(60),
    locations: z.array(locationSchema).max(20),
    workModes: z.array(z.enum(SELECTION_WORK_MODES)).max(3),
    seniorityLevels: z.array(z.enum(SELECTION_SENIORITY)).max(4),
    searchBand: searchBandSchema,
  })
  .strict();
export type SelectionInput = z.infer<typeof selectionInputSchema>;

export interface SelectionView {
  revisionNo: number;
  targetFamilies: string[];
  roleSlugs: string[];
  locations: Array<z.infer<typeof locationSchema>>;
  workModes: string[];
  seniorityLevels: string[];
  searchBand: z.infer<typeof searchBandSchema>;
  catalogVersion: number;
  actor: string;
  createdAt: Date;
}

export interface CatalogRoleView extends RoleDefinition {
  revision: number;
  origin: "seed" | "user";
  definitionDigest: string;
  familyName: string;
  familyTier: "primary" | "secondary";
  updatedAt: Date;
}

export interface CatalogView {
  catalogVersion: number;
  families: RoleFamily[];
  roles: CatalogRoleView[];
}

interface RoleDbRow {
  role_slug: string; family_slug: string; title: string; description: string; evidence: unknown; active: boolean; origin: "seed" | "user";
  seed_digest: string | null; definition_digest: string; head_revision: number; updated_at: Date; aliases: string[] | null;
}
interface FamilyDbRow { family_slug: string; name: string; tier: "primary" | "secondary"; sort_order: number; description: string }
interface RecDbRow {
  id: string; role_slug: string; family_slug: string; input_digest: string; role_revision: number; role_definition_digest: string; catalog_version: number;
  profile_revision_no: number; support: "SUPPORTED" | "PARTIAL"; source_fact_ids: string[]; evidence: { requirements: unknown[]; titleSignals: unknown[]; coreMet: number; coreTotal: number; minCoreMatches: number };
  gaps: Gap[]; status: "PROPOSED" | "APPROVED" | "DISMISSED"; decided_by: string | null; decided_at: Date | null; superseded_at: Date | null;
  superseded_reason: string | null; created_at: Date;
}

const ROLE_SELECT = `SELECT c.role_slug, c.family_slug, c.title, c.description, c.evidence, c.active, c.origin, c.seed_digest, c.definition_digest, c.head_revision, c.updated_at,
  (SELECT array_agg(a.alias ORDER BY a.alias_norm) FROM role_aliases a WHERE a.role_slug = c.role_slug) AS aliases FROM role_catalog c`;

const toDefinition = (r: RoleDbRow): RoleDefinition =>
  roleDefinitionSchema.parse({ roleSlug: r.role_slug, familySlug: r.family_slug, title: r.title, description: r.description, aliases: r.aliases ?? [], evidence: r.evidence, active: r.active });

const toFamily = (r: FamilyDbRow): RoleFamily => ({ familySlug: r.family_slug, name: r.name, tier: r.tier, sortOrder: r.sort_order, description: r.description });

export interface SeedResult {
  catalogVersion: number;
  created: number;
  updated: number;
  unchanged: number;
  skippedUserEdited: number;
}

/** What the profile boundary let through and what it kept out, for display and audit. */
export function evidenceScopeView(e: Awaited<ReturnType<typeof loadScopedEvidence>>) {
  return {
    profile: e.profile, sources: e.sources.map((s) => ({ resumeId: s.resumeId, provenance: s.provenance, authorized: s.authorized, basis: s.basis })),
    confirmedEmploymentReferences: e.confirmed.length, factsUsed: e.facts.length, excludedApproved: e.excluded, duplicatesCountedOnce: e.duplicates,
    unauthorizedFactCountsByResume: e.unauthorizedFactCounts,
  };
}

export class RolesRepo {
  constructor(private readonly pool: pg.Pool) {}

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // --- catalog ------------------------------------------------------------------------------------------------------

  private async currentVersion(q: pg.Pool | pg.PoolClient): Promise<number> {
    const { rows } = await q.query<{ v: number | null }>("SELECT MAX(version_no) AS v FROM role_catalog_versions");
    return rows[0]?.v ?? 0;
  }

  private async writeRole(
    c: pg.PoolClient,
    def: RoleDefinition,
    meta: { insert: boolean; origin: "seed" | "user"; seedDigest: string | null; revision: number; action: "SEED" | "EDIT"; actor: string; catalogVersion: number },
  ): Promise<void> {
    const aliases = canonicalAliases(def.aliases);
    const digest = roleDefinitionDigest(def);
    if (meta.insert) {
      await c.query(
        `INSERT INTO role_catalog (role_slug, family_slug, title, description, evidence, active, origin, seed_digest, definition_digest, head_revision)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
        [def.roleSlug, def.familySlug, def.title, def.description, JSON.stringify(def.evidence), def.active, meta.origin, meta.seedDigest, digest, meta.revision],
      );
    } else {
      await c.query(
        `UPDATE role_catalog SET title=$2, description=$3, evidence=$4::jsonb, active=$5, origin=$6, seed_digest=$7, definition_digest=$8, head_revision=$9, updated_at=now()
          WHERE role_slug=$1`,
        [def.roleSlug, def.title, def.description, JSON.stringify(def.evidence), def.active, meta.origin, meta.seedDigest, digest, meta.revision],
      );
      await c.query("DELETE FROM role_aliases WHERE role_slug=$1", [def.roleSlug]);
    }
    for (const alias of aliases) {
      await c.query("INSERT INTO role_aliases (role_slug, alias_norm, alias) VALUES ($1,$2,$3)", [def.roleSlug, normalizeAlias(alias), alias]);
    }
    await c.query(
      `INSERT INTO role_catalog_revisions (role_slug, revision, catalog_version, action, actor, snapshot, definition_digest) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [def.roleSlug, meta.revision, meta.catalogVersion, meta.action, meta.actor, JSON.stringify({ ...def, aliases }), digest],
    );
  }

  /**
   * Safe to run on every start. Inserts missing roles, refreshes a role only if it is still seed-owned and the seed changed, and
   * never overwrites a role a person edited. A run that changes nothing creates no catalog version.
   */
  async seedCatalog(seed: { families: RoleFamily[]; roles: RoleDefinition[] } = SEED_CATALOG, actor = "seed"): Promise<SeedResult> {
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('roles:catalog'))");
      for (const raw of seed.families) {
        const f = familySchema.parse(raw);
        await c.query(
          `INSERT INTO role_families (family_slug, name, tier, sort_order, description) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (family_slug) DO UPDATE SET name=EXCLUDED.name, tier=EXCLUDED.tier, sort_order=EXCLUDED.sort_order, description=EXCLUDED.description`,
          [f.familySlug, f.name, f.tier, f.sortOrder, f.description],
        );
      }
      type Op = { def: RoleDefinition; seedDigest: string; kind: "create" | "update"; revision: number };
      const ops: Op[] = [];
      let unchanged = 0;
      let skippedUserEdited = 0;
      for (const raw of seed.roles) {
        const def = roleDefinitionSchema.parse(raw);
        const seedDigest = roleDefinitionDigest(def);
        const { rows } = await c.query<{ origin: "seed" | "user"; seed_digest: string | null; head_revision: number }>(
          "SELECT origin, seed_digest, head_revision FROM role_catalog WHERE role_slug=$1 FOR UPDATE", [def.roleSlug]);
        const existing = rows[0];
        if (!existing) ops.push({ def, seedDigest, kind: "create", revision: 1 });
        else if (existing.origin === "user") skippedUserEdited += 1;
        else if (existing.seed_digest !== seedDigest) ops.push({ def, seedDigest, kind: "update", revision: existing.head_revision + 1 });
        else unchanged += 1;
      }
      let version = await this.currentVersion(c);
      if (ops.length > 0) {
        version += 1;
        const created = ops.filter((o) => o.kind === "create").length;
        await c.query("INSERT INTO role_catalog_versions (version_no, reason) VALUES ($1,$2)", [version, `seed: ${created} created, ${ops.length - created} updated`]);
        for (const op of ops) {
          await this.writeRole(c, op.def, { insert: op.kind === "create", origin: "seed", seedDigest: op.seedDigest, revision: op.revision, action: "SEED", actor, catalogVersion: version });
        }
      }
      return {
        catalogVersion: version, created: ops.filter((o) => o.kind === "create").length, updated: ops.filter((o) => o.kind === "update").length, unchanged, skippedUserEdited,
      };
    });
  }

  private async loadCatalog(q: pg.Pool | pg.PoolClient): Promise<CatalogView> {
    const families = (await q.query<FamilyDbRow>("SELECT family_slug, name, tier, sort_order, description FROM role_families ORDER BY sort_order, family_slug")).rows.map(toFamily);
    const byFamily = new Map(families.map((f) => [f.familySlug, f]));
    const rows = (await q.query<RoleDbRow>(`${ROLE_SELECT} ORDER BY c.role_slug`)).rows;
    const roles = rows.map((r): CatalogRoleView => {
      const f = byFamily.get(r.family_slug)!;
      return { ...toDefinition(r), revision: r.head_revision, origin: r.origin, definitionDigest: r.definition_digest, familyName: f.name, familyTier: f.tier, updatedAt: r.updated_at };
    });
    roles.sort((a, b) => byFamily.get(a.familySlug)!.sortOrder - byFamily.get(b.familySlug)!.sortOrder || a.title.localeCompare(b.title));
    return { catalogVersion: await this.currentVersion(q), families, roles };
  }

  getCatalog(): Promise<CatalogView> {
    return this.loadCatalog(this.pool);
  }

  async editRole(roleSlug: string, expectedRevision: number, patch: RoleEdit, actor: string): Promise<{ changed: boolean; role: CatalogRoleView; catalogVersion: number }> {
    const parsedPatch = roleEditSchema.safeParse(patch);
    if (!parsedPatch.success) throw new RoleRuleError("INVALID_ROLE_DEFINITION", `The edit is not valid: ${parsedPatch.error.issues[0]?.message ?? "invalid"}.`);
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext('roles:catalog'))");
      const row = (await c.query<RoleDbRow>(`${ROLE_SELECT} WHERE c.role_slug=$1 FOR UPDATE OF c`, [roleSlug])).rows[0];
      if (!row) throw new RoleRuleError("UNKNOWN_ROLE", "Unknown role.");
      if (row.head_revision !== expectedRevision) throw new RoleRuleError("STALE_ROLE", "This role changed since you loaded it. Reload and try again.");
      const merged = roleDefinitionSchema.safeParse({ ...toDefinition(row), ...parsedPatch.data });
      if (!merged.success) throw new RoleRuleError("INVALID_ROLE_DEFINITION", `The edited role is not valid: ${merged.error.issues[0]?.message ?? "invalid"}.`);
      const def = merged.data;
      const finish = async (changed: boolean) => {
        const catalog = await this.loadCatalog(c);
        return { changed, role: catalog.roles.find((r) => r.roleSlug === roleSlug)!, catalogVersion: catalog.catalogVersion };
      };
      if (roleDefinitionDigest(def) === row.definition_digest) return finish(false);
      const version = (await this.currentVersion(c)) + 1;
      await c.query("INSERT INTO role_catalog_versions (version_no, reason) VALUES ($1,$2)", [version, `edit ${roleSlug}`]);
      await this.writeRole(c, def, { insert: false, origin: "user", seedDigest: row.seed_digest, revision: row.head_revision + 1, action: "EDIT", actor: `user:${actor}`, catalogVersion: version });
      return finish(true);
    });
  }

  // --- recommendations ------------------------------------------------------------------------------------------------

  /** Facts S2 may use: only evidence the ACTIVE candidate profile authorizes (see roles/profile-evidence.ts). */
  private loadEvidence(c: pg.Pool | pg.PoolClient, userId: string) {
    return loadScopedEvidence(c, userId);
  }

  private async profileRevision(c: pg.PoolClient, userId: string): Promise<{ revisionNo: number; digest: string | null }> {
    const { rows } = await c.query<{ revision_no: number; profile_digest: string }>(
      "SELECT revision_no, profile_digest FROM profile_revisions WHERE user_id=$1 ORDER BY revision_no DESC LIMIT 1", [userId]);
    return rows[0] ? { revisionNo: rows[0].revision_no, digest: rows[0].profile_digest } : { revisionNo: 0, digest: null };
  }

  /** Recomputes and persists recommendations for the user inside the caller's transaction. */
  private async refreshTx(c: pg.PoolClient, userId: string, asOf: string) {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`roles:${userId}`]);
    const catalog = await this.loadCatalog(c);
    const evidence = await this.loadEvidence(c, userId);
    const facts: CandidateFact[] = evidence.facts;
    const profile = await this.profileRevision(c, userId);
    const { assessments, pendingHints } = assessRoles({ roles: catalog.roles, facts, asOf });
    const experience = summarizeExperience(facts, asOf);
    const current = new Map(
      (await c.query<RecDbRow>("SELECT * FROM candidate_role_recommendations WHERE user_id=$1 AND superseded_at IS NULL FOR UPDATE", [userId])).rows.map((r) => [r.role_slug, r]),
    );
    const supersede = (id: string, reason: string) =>
      c.query("UPDATE candidate_role_recommendations SET superseded_at=now(), superseded_reason=$2, updated_at=now() WHERE id=$1", [id, reason]);
    const byRole = new Map(catalog.roles.map((r) => [r.roleSlug, r]));
    let inserted = 0;
    let superseded = 0;

    for (const a of assessments) {
      const cur = current.get(a.roleSlug);
      if (a.support === "NO_MATCH") {
        if (cur) { await supersede(cur.id, "NO_LONGER_SUPPORTED"); superseded += 1; }
        continue;
      }
      if (cur && cur.input_digest === a.inputDigest) continue;
      if (cur) { await supersede(cur.id, "INPUTS_CHANGED"); superseded += 1; }
      const role = byRole.get(a.roleSlug)!;
      await c.query(
        `INSERT INTO candidate_role_recommendations (user_id, role_slug, family_slug, input_digest, role_revision, role_definition_digest, catalog_version,
           profile_revision_no, support, source_fact_ids, evidence, gaps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
        [userId, a.roleSlug, a.familySlug, a.inputDigest, role.revision, a.roleDefinitionDigest, catalog.catalogVersion, profile.revisionNo, a.support, a.sourceFactIds,
          JSON.stringify({ requirements: a.requirements, titleSignals: a.titleSignals, coreMet: a.coreMet, coreTotal: a.coreTotal, minCoreMatches: a.minCoreMatches }), JSON.stringify(a.gaps)],
      );
      inserted += 1;
    }
    for (const [slug, cur] of current) {
      if (!assessments.some((a) => a.roleSlug === slug)) { await supersede(cur.id, "ROLE_INACTIVE"); superseded += 1; }
    }
    return { catalog, facts, evidence, profile, assessments, pendingHints, experience, inserted, superseded };
  }

  /**
   * Read-only preview of the current assessment (nothing is written, nothing superseded). Used by diagnostics, which must never change
   * state. `persisted` is the status the database currently holds for each role's live recommendation, so a stale one is visible.
   */
  async previewAssessment(userId: string, asOf: string) {
    const catalog = await this.loadCatalog(this.pool);
    const evidence = await this.loadEvidence(this.pool, userId);
    const facts = evidence.facts;
    const { assessments, pendingHints } = assessRoles({ roles: catalog.roles, facts, asOf });
    const persisted = (await this.pool.query<{ role_slug: string; status: string; input_digest: string; superseded_at: Date | null }>(
      "SELECT role_slug, status, input_digest, superseded_at FROM candidate_role_recommendations WHERE user_id=$1 AND superseded_at IS NULL", [userId])).rows;
    return { catalogVersion: catalog.catalogVersion, assessments, pendingHints, experience: summarizeExperience(facts, asOf), persisted, evidence };
  }

  /** Idempotent: identical inputs change nothing. */
  async refresh(userId: string, asOf: string): Promise<{ inserted: number; superseded: number }> {
    return this.tx(async (c) => {
      const r = await this.refreshTx(c, userId, asOf);
      return { inserted: r.inserted, superseded: r.superseded };
    });
  }

  async getRecommendations(userId: string, asOf: string) {
    return this.tx(async (c) => {
      const r = await this.refreshTx(c, userId, asOf);
      const families = new Map(r.catalog.families.map((f) => [f.familySlug, f]));
      const roles = new Map(r.catalog.roles.map((x) => [x.roleSlug, x]));
      const rows = (await c.query<RecDbRow>("SELECT * FROM candidate_role_recommendations WHERE user_id=$1 AND superseded_at IS NULL", [userId])).rows;
      const recommendations = rows
        .map((row) => {
          const role = roles.get(row.role_slug)!;
          const family = families.get(row.family_slug)!;
          const note = experienceNote(role, r.experience);
          const hints = r.pendingHints[row.role_slug] ?? {};
          return {
            id: row.id, roleSlug: row.role_slug, title: role.title, familySlug: row.family_slug, familyName: family.name, familyTier: family.tier,
            support: row.support, status: row.status, decidedBy: row.decided_by, decidedAt: row.decided_at, inputDigest: row.input_digest,
            roleRevision: row.role_revision, catalogVersion: row.catalog_version, profileRevisionNo: row.profile_revision_no,
            sourceFactIds: row.source_fact_ids, evidence: row.evidence, gaps: row.gaps,
            // which uploaded résumé contributed each supporting fact (null = an attested statement)
            sourceFacts: row.source_fact_ids.map((factId: string) => ({ factId, resumeId: r.evidence.factResume.get(factId) ?? null })),
            pendingHints: Object.entries(hints).map(([requirementId, factIds]) => ({ requirementId, factIds })),
            experienceNote: note, createdAt: row.created_at,
            _sort: [family.tier === "primary" ? 0 : 1, family.sortOrder, row.support === "SUPPORTED" ? 0 : 1, role.title] as const,
          };
        })
        .sort((a, b) => a._sort[0] - b._sort[0] || a._sort[1] - b._sort[1] || a._sort[2] - b._sort[2] || a._sort[3].localeCompare(b._sort[3]))
        .map(({ _sort: _s, ...rest }) => rest);

      const noMatch = r.assessments
        .filter((a: RoleAssessment) => a.support === "NO_MATCH")
        .map((a) => {
          const family = families.get(a.familySlug)!;
          return {
            roleSlug: a.roleSlug, title: a.title, familySlug: a.familySlug, familyName: family.name, familyTier: family.tier, gaps: a.gaps,
            pendingHints: Object.entries(r.pendingHints[a.roleSlug] ?? {}).map(([requirementId, factIds]) => ({ requirementId, factIds })),
          };
        })
        .sort((x, y) => (x.familyTier === y.familyTier ? 0 : x.familyTier === "primary" ? -1 : 1) || x.title.localeCompare(y.title));

      // A decision made on evidence that has since changed is shown as stale, never as a current decision.
      const stale = (await c.query<{ role_slug: string; status: string; decided_at: Date; superseded_at: Date; superseded_reason: string }>(
        `SELECT DISTINCT ON (s.role_slug) s.role_slug, s.status, s.decided_at, s.superseded_at, s.superseded_reason
           FROM candidate_role_recommendations s
          WHERE s.user_id=$1 AND s.superseded_at IS NOT NULL AND s.status IN ('APPROVED','DISMISSED')
            AND NOT EXISTS (SELECT 1 FROM candidate_role_recommendations k WHERE k.user_id=s.user_id AND k.role_slug=s.role_slug AND k.superseded_at IS NULL AND k.status <> 'PROPOSED')
          ORDER BY s.role_slug, s.superseded_at DESC`, [userId])).rows;
      const staleDecisions = stale.map((s) => ({
        roleSlug: s.role_slug, title: roles.get(s.role_slug)?.title ?? s.role_slug, previousStatus: s.status, decidedAt: s.decided_at,
        supersededAt: s.superseded_at, reason: s.superseded_reason,
      }));

      // Display index for every fact the response points at, so the UI can show a value and link back to the review page.
      const ids = new Set<string>();
      for (const rec of recommendations) { rec.sourceFactIds.forEach((id) => ids.add(id)); rec.pendingHints.forEach((h) => h.factIds.forEach((id) => ids.add(id))); }
      for (const nm of noMatch) nm.pendingHints.forEach((h) => h.factIds.forEach((id) => ids.add(id)));
      for (const e of r.experience.entries) ids.add(e.factId);
      for (const i of r.experience.issues) if (i.factId) ids.add(i.factId);
      const factIndex: Record<string, { factId: string; kind: string; value: string; approvalStatus: string; resumeId: string | null }> = {};
      if (ids.size > 0) {
        const { rows: idx } = await c.query(
          `SELECT f.fact_id, f.kind, f.value, f.approval_status, v.resume_id FROM candidate_facts f
             LEFT JOIN resume_versions v ON v.id = f.resume_version_id WHERE f.user_id=$1 AND f.fact_id = ANY($2::text[])`, [userId, [...ids]]);
        for (const x of idx) factIndex[x.fact_id] = { factId: x.fact_id, kind: x.kind, value: x.value, approvalStatus: x.approval_status, resumeId: x.resume_id };
      }

      return {
        asOf, catalogVersion: r.catalog.catalogVersion, profile: r.profile, experience: r.experience,
        evidenceScope: evidenceScopeView(r.evidence),
        suggestedSearchBand: suggestSearchBand(r.experience), recommendations, noMatch, staleDecisions, factIndex,
        selection: await this.selectionTx(c, userId),
      };
    });
  }

  async decide(
    userId: string, actor: string, input: { recommendationId: string; decision: "approve" | "dismiss" | "reset"; expectedInputDigest: string }, asOf: string,
  ): Promise<{ changed: boolean; recommendation: { id: string; roleSlug: string; status: "PROPOSED" | "APPROVED" | "DISMISSED"; inputDigest: string } }> {
    // Recompute first, in its own committed transaction, so evidence that changed is superseded even when this call is refused.
    await this.refresh(userId, asOf);
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`roles:${userId}`]);
      const row = (await c.query<RecDbRow>("SELECT * FROM candidate_role_recommendations WHERE id=$1 AND user_id=$2 FOR UPDATE", [input.recommendationId, userId])).rows[0];
      if (!row) throw new RoleRuleError("UNKNOWN_RECOMMENDATION", "Unknown recommendation.");
      if (row.superseded_at !== null || row.input_digest !== input.expectedInputDigest) {
        throw new RoleRuleError("STALE_RECOMMENDATION", "The evidence behind this recommendation changed. Reload to see the current recommendation.");
      }
      const next = input.decision === "approve" ? "APPROVED" : input.decision === "dismiss" ? "DISMISSED" : "PROPOSED";
      const view = { id: row.id, roleSlug: row.role_slug, status: next as "PROPOSED" | "APPROVED" | "DISMISSED", inputDigest: row.input_digest };
      if (row.status === next) return { changed: false, recommendation: view };
      await c.query(
        `UPDATE candidate_role_recommendations SET status=$2::text, decided_by=$3, decided_at=CASE WHEN $2::text='PROPOSED' THEN NULL ELSE now() END, updated_at=now() WHERE id=$1`,
        [row.id, next, next === "PROPOSED" ? null : actor],
      );
      await c.query("INSERT INTO candidate_role_decisions (recommendation_id, status, actor) VALUES ($1,$2,$3)", [row.id, next, `user:${actor}`]);
      return { changed: true, recommendation: view };
    });
  }

  // --- selection ----------------------------------------------------------------------------------------------------

  private async selectionTx(q: pg.Pool | pg.PoolClient, userId: string): Promise<SelectionView | null> {
    const { rows } = await q.query(
      `SELECT revision_no, target_families, role_slugs, locations, work_modes, seniority_levels, search_band, catalog_version, actor, created_at
         FROM search_preferences WHERE user_id=$1 ORDER BY revision_no DESC LIMIT 1`, [userId]);
    const r = rows[0];
    if (!r) return null;
    return {
      revisionNo: r.revision_no, targetFamilies: r.target_families, roleSlugs: r.role_slugs, locations: r.locations, workModes: r.work_modes,
      seniorityLevels: r.seniority_levels, searchBand: r.search_band, catalogVersion: r.catalog_version, actor: r.actor, createdAt: r.created_at,
    };
  }

  getSelection(userId: string): Promise<SelectionView | null> {
    return this.selectionTx(this.pool, userId);
  }

  async saveSelection(userId: string, actor: string, input: SelectionInput): Promise<{ changed: boolean; selection: SelectionView }> {
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`roles:${userId}`]);
      const current = await this.selectionTx(c, userId);
      if ((current?.revisionNo ?? 0) !== input.expectedRevision) {
        throw new RoleRuleError("STALE_SELECTION", "Your selection changed in another window. Reload and try again.");
      }
      const catalog = await this.loadCatalog(c);
      if (catalog.catalogVersion !== input.expectedCatalogVersion) {
        throw new RoleRuleError("STALE_CATALOG", "The role catalog changed since you loaded it. Reload and review your selection.");
      }
      const families = new Set(catalog.families.map((f) => f.familySlug));
      const active = new Set(catalog.roles.filter((r) => r.active).map((r) => r.roleSlug));
      const targetFamilies = [...new Set(input.targetFamilies)].sort();
      const roleSlugs = [...new Set(input.roleSlugs)].sort();
      const unknownFamily = targetFamilies.find((f) => !families.has(f));
      if (unknownFamily) throw new RoleRuleError("INVALID_SELECTION", `Unknown role family "${unknownFamily}".`);
      const unknownRole = roleSlugs.find((r) => !active.has(r));
      if (unknownRole) throw new RoleRuleError("INVALID_SELECTION", `Unknown or inactive role "${unknownRole}".`);
      const normalized = {
        targetFamilies, roleSlugs,
        locations: input.locations.map((l) => ({ kind: l.kind, value: l.value.trim() })),
        workModes: [...new Set(input.workModes)].sort(), seniorityLevels: [...new Set(input.seniorityLevels)].sort(), searchBand: input.searchBand,
      };
      // Canonical comparison: jsonb does not preserve object key order.
      if (current && sha256Json(normalized) === sha256Json({
        targetFamilies: current.targetFamilies, roleSlugs: current.roleSlugs, locations: current.locations, workModes: current.workModes,
        seniorityLevels: current.seniorityLevels, searchBand: current.searchBand,
      })) {
        return { changed: false, selection: current };
      }
      const revisionNo = (current?.revisionNo ?? 0) + 1;
      await c.query(
        `INSERT INTO search_preferences (user_id, revision_no, target_families, role_slugs, locations, work_modes, seniority_levels, search_band, catalog_version, actor)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,$10)`,
        [userId, revisionNo, normalized.targetFamilies, normalized.roleSlugs, JSON.stringify(normalized.locations), normalized.workModes, normalized.seniorityLevels,
          JSON.stringify(normalized.searchBand), catalog.catalogVersion, `user:${actor}`],
      );
      return { changed: true, selection: (await this.selectionTx(c, userId))! };
    });
  }
}

export type RecommendationsView = Awaited<ReturnType<RolesRepo["getRecommendations"]>>;
