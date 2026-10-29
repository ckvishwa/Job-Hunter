import type { CatalogView } from "../db/roles-repo.js";
import { textSha } from "../match/embedding-cache.js";
import { DEFAULT_ENCODER } from "../nlu/local-transformer.js";
import { FEATURE_REVISION, meanUnit, pairFeatures, pairSimilarity, protoTexts, type FeatureVector, type PairSim, type PostingVectors, type RoleProto } from "./features.js";
import type { CorpusRow, MlRepo } from "./repo.js";
import { allRolesPlan, ruleDecision, type RuleDecision } from "./rules.js";
import { breakLongRuns, jdPassages, TEXT_PREPROCESS } from "./types.js";
import type { DiscoveryPlan } from "../jobs/planner.js";

export interface TextEncoder { embed(text: string): Promise<{ vector: number[] }> }

export interface EmbedRequest { subjectKey: string; kind: "title" | "jd_passage" | "role_phrase" | "role_text"; chunk: number; text: string; jdSha?: string }

export interface EmbedService {
  identity: { modelId: string; revision: string };
  stats: { hits: number; misses: number; failed: number };
  vec(req: EmbedRequest): Promise<number[]>;
}

const unit = (v: readonly number[]): number[] => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (!Number.isFinite(n) || n === 0) throw new Error("Encoder returned a zero or invalid embedding.");
  return v.map((x) => x / n);
};

const preprocessOf = (kind: EmbedRequest["kind"]): string => (kind === "title" ? TEXT_PREPROCESS.title : kind === "jd_passage" ? TEXT_PREPROCESS.passage : TEXT_PREPROCESS.role);

/**
 * Cache key = subject + exact text hash + kind + chunk + preprocess revision + model id/revision (+ stored dimension). A changed JD changes the text hash,
 * a changed model or preprocessing changes the revision: exactly the dependent vectors are recomputed and older ones stay as history.
 */
export function makeEmbedService(repo: MlRepo, encoder: TextEncoder, identity = { modelId: DEFAULT_ENCODER.modelId, revision: DEFAULT_ENCODER.revision }, dims: number = DEFAULT_ENCODER.embeddingDimensions): EmbedService {
  const stats = { hits: 0, misses: 0, failed: 0 };
  return {
    identity, stats,
    async vec(req) {
      const pre = preprocessOf(req.kind);
      const sha = textSha(req.text);
      const cached = await repo.getEmbedding({ subjectKey: req.subjectKey, textSha256: sha, kind: req.kind, chunk: req.chunk, preprocess: pre, modelId: identity.modelId, modelRevision: identity.revision });
      if (cached) { stats.hits++; return cached; }
      stats.misses++;
      const v = unit((await encoder.embed(req.text)).vector);
      if (v.length !== dims) throw new Error(`Encoder returned ${v.length} dimensions, expected ${dims}.`);
      await repo.putEmbedding({ subjectKey: req.subjectKey, textSha256: sha, jdSha256: req.jdSha ?? null, kind: req.kind, chunk: req.chunk, preprocess: pre, modelId: identity.modelId, modelRevision: identity.revision, vector: v });
      return v;
    },
  };
}

export interface EngineContext {
  catalogVersion: number;
  plan: DiscoveryPlan;
  familyOf: Map<string, string>;
  families: string[];
  protos: RoleProto[];
  embed: EmbedService;
}

export async function buildContext(catalog: CatalogView, embed: EmbedService): Promise<EngineContext> {
  const active = catalog.roles.filter((r) => r.active);
  const familyOf = new Map(active.map((r) => [r.roleSlug, r.familySlug]));
  const families = [...new Set(active.map((r) => r.familySlug))].sort();
  const protos: RoleProto[] = [];
  for (const role of active) {
    const t = protoTexts(role);
    const subject = `role:${role.roleSlug}`;
    protos.push({
      roleSlug: role.roleSlug, familySlug: role.familySlug, coreGroups: t.coreGroups,
      phraseVecs: await Promise.all(t.phrases.map((p, i) => embed.vec({ subjectKey: subject, kind: "role_phrase", chunk: i, text: p }))),
      textVec: await embed.vec({ subjectKey: subject, kind: "role_text", chunk: 0, text: t.text }),
    });
  }
  return { catalogVersion: catalog.catalogVersion, plan: allRolesPlan(catalog), familyOf, families, protos, embed };
}

export interface Featurized {
  posting: CorpusRow;
  rule: RuleDecision;
  vectors: PostingVectors;
}

export async function featurize(ctx: EngineContext, posting: CorpusRow): Promise<Featurized> {
  const rule = ruleDecision({ title: posting.title, description: posting.description }, ctx.plan, ctx.familyOf);
  const subject = posting.sourceKey;
  const titleVec = await ctx.embed.vec({ subjectKey: subject, kind: "title", chunk: 0, text: breakLongRuns(posting.title), jdSha: posting.textSha256 });
  const { passages, truncated } = jdPassages(posting.description);
  const passageVecs: number[][] = [];
  let degraded = false;
  for (const [i, text] of passages.entries()) {
    try {
      passageVecs.push(await ctx.embed.vec({ subjectKey: subject, kind: "jd_passage", chunk: i, text, jdSha: posting.textSha256 }));
    } catch {
      degraded = true; // a passage the encoder cannot take is skipped and reported, never fatal for the whole corpus
      ctx.embed.stats.failed++;
    }
  }
  if (passageVecs.length === 0) passageVecs.push(titleVec);
  return { posting, rule, vectors: { titleVec, passageVecs, docVec: meanUnit(passageVecs), truncated: truncated || degraded } };
}

export interface PairView extends FeatureVector { roleSlug: string; familySlug: string; sim: PairSim }

export function pairFor(ctx: EngineContext, f: Featurized, roleSlug: string): PairView {
  const role = ctx.protos.find((p) => p.roleSlug === roleSlug);
  if (!role) throw new Error(`Unknown catalog role "${roleSlug}".`);
  const pf = pairFeatures({ title: f.posting.title, description: f.posting.description, vectors: f.vectors, role, allRoles: ctx.protos, families: ctx.families, rule: f.rule });
  return { names: pf.names, values: pf.values, roleSlug, familySlug: role.familySlug, sim: pf.sim };
}

/** Roles worth a human or model look for this posting: every role the rules admitted plus the k most similar catalog roles. */
export function candidateRoles(ctx: EngineContext, f: Featurized, k = 3): string[] {
  const ranked = ctx.protos.map((r) => ({ slug: r.roleSlug, s: pairSimilarity(f.vectors, r).score })).sort((a, b) => b.s - a.s || a.slug.localeCompare(b.slug)).slice(0, k).map((x) => x.slug);
  return [...new Set([...f.rule.roleSlugs, ...ranked])];
}

export { FEATURE_REVISION };
