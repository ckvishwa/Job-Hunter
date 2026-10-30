import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { CandidateRepo } from "../db/candidate-repo.js";
import { DEFAULT_ENV_FILE, createPool, loadEnvFile, pgSettingsFromEnv } from "../db/pool.js";
import { RolesRepo } from "../db/roles-repo.js";
import { createFileStore } from "../api/file-store.js";
import { buildDiagnostic, type Diagnostic } from "./diagnostics.js";
import { collectEmploymentConflicts } from "./fact-context.js";
import { referenceSchema, type ReferenceLabels } from "./extraction-metrics.js";

// npm run resumes:diagnose -- --resume <id> [--json] [--out file] [--reveal] [--redact-values] [--show-text] [--rerun-parser]
//                           | --compare [--json]       (see docs/RESUME-DIAGNOSTICS.md)
// Read-only. It never approves, edits, re-extracts or writes to PostgreSQL. Sensitive fields (name, email, phone, ...) are masked unless --reveal.

const { values } = parseArgs({
  options: {
    resume: { type: "string" },
    compare: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    out: { type: "string" },
    user: { type: "string" },
    reveal: { type: "boolean", default: false },
    "redact-values": { type: "boolean", default: false },
    "show-text": { type: "boolean", default: false },
    reference: { type: "string" },
    "prior-profile": { type: "string" },
    "no-prior-profile": { type: "boolean", default: false },
    "rerun-parser": { type: "boolean", default: false },
    "as-of": { type: "string" },
  },
});

const fail = (message: string, code = 2): never => {
  console.error(message);
  process.exit(code);
};

loadEnvFile(DEFAULT_ENV_FILE);
const handle = values.user ?? process.env.JH_USER_HANDLE ?? "local";
const asOf = values["as-of"] ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) fail("--as-of must be YYYY-MM-DD");

function latestRulesRevision(): string | null {
  try {
    return /PARSER_REVISION\s*=\s*"([^"]+)"/.exec(readFileSync(path.resolve("services", "ai", "app", "parse_resume.py"), "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
}

function loadReference(file: string | undefined): ReferenceLabels | null {
  if (!file) return null;
  const parsed = referenceSchema.safeParse(JSON.parse(readFileSync(path.resolve(file), "utf8")));
  if (!parsed.success) return fail(`Reference file is not a valid independent reference: ${parsed.error.issues[0]?.path.join(".") || "(root)"}: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

function pythonExe(): string | null {
  const win = path.resolve("services", "ai", ".venv", "Scripts", "python.exe");
  const nix = path.resolve("services", "ai", ".venv", "bin", "python");
  return existsSync(win) ? win : existsSync(nix) ? nix : null;
}

const squash = (v: string): string => v.toLowerCase().replace(/[^a-z0-9+#]+/g, "");

/** Runs the current rules parser over the stored upload in a throw-away process and diffs its proposals against what is stored. */
function rerunPreview(storageRef: string, fileType: string, stored: ReadonlyArray<{ kind: string; value: string; sensitivity: string }>, hideValues: boolean, reveal: boolean) {
  const py = pythonExe();
  if (!py) return { status: "UNAVAILABLE", reason: "services/ai/.venv is not set up; see services/ai/README.md" };
  const bytes = createFileStore(path.resolve(process.env.JH_UPLOAD_DIR ?? path.join("private-runtime", "s1-uploads")));
  let file: string;
  try {
    bytes.read(storageRef); // existence/validity check; the script reads the path itself
    file = path.join(path.resolve(process.env.JH_UPLOAD_DIR ?? path.join("private-runtime", "s1-uploads")), storageRef);
  } catch {
    return { status: "UNAVAILABLE", reason: "The stored upload could not be read." };
  }
  let out: { parserRevision: string; facts: Array<{ kind: string; value: string }>; warnings: Array<{ code: string }>; error?: string };
  try {
    out = JSON.parse(execFileSync(py, ["-I", path.resolve("services", "ai", "preview.py"), file, fileType], { encoding: "utf8", maxBuffer: 20_000_000, timeout: 60_000 }));
  } catch (error) {
    return { status: "FAILED", reason: String((error as Error).message).split("\n")[0] };
  }
  const key = (k: string, v: string): string => `${k}|${squash(v)}`;
  const had = new Map(stored.map((f) => [key(f.kind, f.value), f]));
  const now = new Map(out.facts.map((f) => [key(f.kind, f.value), f]));
  const show = (f: { kind: string; value: string; sensitivity?: string }): string | null =>
    hideValues ? null : !reveal && ["legal_name", "email", "phone"].includes(f.kind) ? "(masked)" : f.value;
  const added = [...now.entries()].filter(([k]) => !had.has(k)).map(([, f]) => ({ kind: f.kind, value: show(f) }));
  const gone = [...had.entries()].filter(([k]) => !now.has(k)).map(([, f]) => ({ kind: f.kind, value: show(f) }));
  return {
    status: "PREVIEW_ONLY_NOTHING_WRITTEN", previewParserRevision: out.parserRevision, proposedNow: out.facts.length, storedFacts: stored.length,
    unchanged: [...now.keys()].filter((k) => had.has(k)).length, wouldBeNew: added, storedButNoLongerProposed: gone,
    parserWarnings: Object.fromEntries(out.warnings.reduce((m, w) => m.set(w.code, (m.get(w.code) ?? 0) + 1), new Map<string, number>())),
  };
}

function renderText(d: Diagnostic, rerun: unknown): string {
  const L: string[] = [];
  const h = (t: string): void => void L.push("", `== ${t} ==`);
  L.push(`ORBITAL RESUME DIAGNOSTIC   (${d.schema})`);
  L.push(`redaction: sensitive ${d.redaction.sensitiveValues}, values ${d.redaction.allValues}, text excerpts ${d.redaction.resumeTextExcerpts}`);
  h("1. resume");
  L.push(`${d.resume.label}  ${d.resume.resumeId}`, `${d.resume.fileType}, ${d.resume.byteSize} bytes, uploaded ${d.resume.uploadedOn}, extraction ${d.resume.extractionState}, ${d.resume.characterCount} chars / ${d.resume.lineCount} lines`);
  h("2. parser");
  L.push(`parser ${d.parser.parserRevision ?? "(none)"}   current rules parser in repo: ${d.parser.latestRulesRevision ?? "?"}   contract ${d.parser.contractRevision}`);
  L.push(`proposed by: ${JSON.stringify(d.parser.proposedBy)}   AI model used for this extraction: ${d.parser.aiModelUsedForThisExtraction}`);
  L.push(`parser warnings: ${d.parser.parserWarnings.map((w) => `${w.code} x${w.count}`).join(", ") || "none"}`);
  for (const c of d.parser.employmentCategoryProvenance) L.push(`employment category ${c.employmentType} on ${c.factId}: ${c.source}`);
  h("3-4. facts and review status");
  const s = d.extractionSummary;
  L.push(`${s.totalFacts} facts: approved ${s.byStatus.approved}, pending ${s.byStatus.pending}, rejected ${s.byStatus.rejected}, edited ${s.edited}; with quality warnings ${s.factsWithQualityWarnings}`);
  h("5. categories detected");
  for (const [k, v] of Object.entries(d.factsByCategory)) L.push(`${k.padEnd(14)} total ${v.total}  approved ${v.approved}  pending ${v.pending}  rejected ${v.rejected}  edited ${v.edited}`);
  h("6. possible omissions");
  for (const sec of d.possibleOmissions.sections) L.push(`${sec.section.padEnd(15)} lines ${sec.nonEmptyLines}  long ${sec.longLines} (covered ${sec.longLinesCoveredByAFact})  expects ${sec.expectedFactKind ?? "-"}: ${sec.factsOfThatKind ?? "-"}${sec.flag ? `   <-- ${sec.flag}` : ""}`);
  L.push(`long lines with no fact: ${d.possibleOmissions.uncoveredLongLines.count}; hyphenated line breaks in text: ${d.possibleOmissions.textLayer.hyphenatedLineBreaksInText}; merged-word runs: ${d.possibleOmissions.textLayer.runsOf30PlusLettersWithoutSpaces}; quantified statements not structured: ${d.possibleOmissions.quantifiedStatementsNotStructured}`);
  h("7. weak, conflicting or missing evidence");
  L.push(`warning codes: ${JSON.stringify(d.qualityWarnings.byCode)}`);
  for (const p of d.qualityWarnings.perFact) for (const w of p.warnings) L.push(`${p.factId} [${p.kind}] ${w.code}${w.message ? ` - ${w.message}` : ""}`);
  for (const c of d.qualityWarnings.employmentConflicts) L.push(`CONFLICT ${c.employer}: ${c.records.map((r) => `${r.ref} (${r.status})`).join(" vs ")}; ${c.differences.map((x) => `${x.field}: ${x.values[0]} vs ${x.values[1]}`).join("; ")}\n   ${c.required}`);
  if (d.qualityWarnings.earlierProfileUsed) L.push(`(earlier reviewed profile compared: ${d.qualityWarnings.earlierProfileUsed})`);
  h("8. approved experience");
  const e = d.approvedExperience;
  L.push(`status ${e.status}. ${e.note}`);
  for (const [name, view] of [["this résumé's approved facts", e.thisResumeApprovedFactsOnly], ["all facts (the view S2 uses)", e.allUploadedAndAttestedFacts_theViewS2Uses]] as const) {
    L.push(`-- ${name}: status ${view.status}`);
    for (const [bucket, b] of Object.entries(view.buckets)) if (b.factIds.length) L.push(`   ${bucket}: ${b.monthsLower}-${b.monthsUpper} months (month precision, ${b.factIds.length} fact(s))`);
    for (const i of view.issues) L.push(`   issue ${i.code}${i.factId ? ` ${i.factId}` : ""}: ${i.message}`);
  }
  h("9-10. S2 role recommendations and their supporting approved facts");
  for (const r of [...d.roleRecommendations.supported, ...d.roleRecommendations.partial]) {
    L.push(`${r.support.padEnd(9)} ${r.title}  core ${r.why.coreRequirementsMet}/${r.why.coreRequirementsTotal} (need ${r.why.minimumCoreMatches})  stored: ${r.stored.status}${r.stored.current ? "" : " (not current)"}${r.dependsOnDisputedRecord ? "  DEPENDS ON A DISPUTED RECORD" : ""}${r.dependsOnWeaklyAnchoredFact ? "  DEPENDS ON A WEAKLY ANCHORED FACT" : ""}`);
    L.push(`   facts: ${r.supportingFacts.map((f) => `${f.factId}${f.value ? ` "${f.value}"` : ""}${f.onThisResume ? "" : " [other source]"}${f.qualityWarningCodes.length ? ` {${f.qualityWarningCodes.join("+")}}` : ""}`).join(", ")}`);
    for (const g of r.gaps) L.push(`   gap ${g.code}: ${g.message}`);
  }
  L.push(`roles with no match: ${d.roleRecommendations.noMatchRoles}`);
  h("evaluation (four separate views, no overall score)");
  const m = d.evaluationMetrics;
  L.push(`coverage: ${JSON.stringify(m.extractionCoverage)}`, `evidence quality: ${JSON.stringify(m.evidenceQuality)}`, `review status: ${JSON.stringify(m.reviewStatus)}`, `career relevance: ${JSON.stringify(m.careerRelevance)}`);
  L.push(`accuracy: precision ${m.accuracy.precision}, recall ${m.accuracy.recall}, F1 ${m.accuracy.f1}${m.accuracy.status === "NOT_EVALUATED" ? `   (${m.accuracy.reason})` : ""}`);
  h("achievement evidence (self-reported text, not facts)");
  L.push(`${d.achievementEvidence.statementCount} statements ${JSON.stringify(d.achievementEvidence.byKind)}; skill context ${JSON.stringify(d.achievementEvidence.skillContext.counts)}`);
  for (const st of d.achievementEvidence.statements.filter((x) => x.quantities.length)) L.push(`   [${st.kind}] ${st.start}-${st.end} owner ${st.ownerFactId ?? "-"}  quantities: ${st.quantities.map((q) => q.raw).join(" | ")}`);
  if (rerun) {
    h("parser re-run preview (nothing written)");
    L.push(JSON.stringify(rerun, null, 2));
  }
  h("next actions");
  for (const a of d.nextActions) L.push(`${a.priority}. ${a.action}${a.command ? `\n     ${a.command}` : ""}`);
  return L.join("\n");
}

async function main(): Promise<number> {
  const pool = createPool(pgSettingsFromEnv(), { max: 2, connectTimeoutMs: 15_000 });
  try {
    const repo = new CandidateRepo(pool);
    const roles = new RolesRepo(pool);
    const user = await repo.findUser(handle);
    if (!user) return fail(`No user "${handle}" in the database.`);
    const priorArg = values["no-prior-profile"] ? null : values["prior-profile"];
    const conflicts = await collectEmploymentConflicts(repo, user.id, priorArg);
    const preview = await roles.previewAssessment(user.id, asOf);
    const reference = loadReference(values.reference);
    const options = { reveal: values.reveal, hideValues: values["redact-values"], showText: values["show-text"] };
    const resumes = await repo.listResumes(user.id);
    const userFacts = [...(await Promise.all(resumes.map((r) => repo.listFacts(user.id, r.resumeId)))).flat(), ...(await repo.listAttestedFacts(user.id))];
    const userCandidateFacts = userFacts.map((f) => ({
      factId: f.factId, kind: f.kind, value: f.value, polarity: f.polarity, attributes: f.attributes, source: f.source, verification: f.verification,
      approvalStatus: f.approvalStatus, sensitivity: f.sensitivity, ...(f.notes ? { notes: f.notes } : {}),
    })) as never[];

    const diagnose = async (resumeId: string, opts = options) => {
      const detail = await repo.getResumeDetail(user.id, resumeId);
      if (!detail) return null;
      const row = resumes.find((r) => r.resumeId === resumeId)!;
      const facts = await repo.listFacts(user.id, resumeId);
      const diag = buildDiagnostic({
        asOf, resume: {
          resumeId, fileType: detail.fileType, sha256: detail.sha256, byteSize: detail.byteSize, createdAt: detail.createdAt, versionId: detail.version.id, state: detail.version.state,
          parserRevision: detail.version.parserRevision, contractRevision: detail.version.contractRevision, warnings: detail.version.warnings, stats: detail.version.stats,
          text: detail.text, textSha256: row.state === "PROPOSED" ? (await repo.getResumeSource(user.id, resumeId))?.textSha256 ?? null : null,
        },
        facts, userFacts: userCandidateFacts, revisions: await repo.listRevisionActions(user.id, resumeId), conflicts, preview, reference,
        latestRulesRevision: latestRulesRevision(), options: opts,
      });
      return { diag, detail, facts };
    };

    if (values.compare) {
      const rows = [];
      const seen = new Map<string, string>();
      const collisions: string[] = [];
      for (const r of resumes) {
        const got = await diagnose(r.resumeId, { ...options, hideValues: true });
        if (!got) continue;
        for (const f of got.facts) {
          const prev = seen.get(f.factId);
          if (prev && prev !== r.resumeId) collisions.push(f.factId);
          seen.set(f.factId, r.resumeId);
        }
        const d = got.diag;
        rows.push({
          resumeId: r.resumeId, label: d.resume.label, fileType: d.resume.fileType, parserRevision: d.parser.parserRevision, extractionState: d.resume.extractionState,
          facts: d.extractionSummary.totalFacts, byStatus: d.extractionSummary.byStatus, edited: d.extractionSummary.edited, categories: Object.fromEntries(Object.entries(d.factsByCategory).map(([k, v]) => [k, v.total])),
          qualityWarningCodes: d.qualityWarnings.byCode, sectionsWithTextButNoFacts: d.evaluationMetrics.extractionCoverage.sectionsWithTextButNoFacts,
          quantifiedStatements: d.evaluationMetrics.extractionCoverage.quantifiedStatements, accuracy: d.evaluationMetrics.accuracy.status,
          approvedMonths: Object.fromEntries(Object.entries(d.approvedExperience.thisResumeApprovedFactsOnly.buckets).filter(([, b]) => b.factIds.length).map(([k, b]) => [k, `${b.monthsLower}-${b.monthsUpper}`])),
        });
      }
      const report = {
        schema: "orbital-resume-comparison/1", asOf, resumes: rows, factIdentityCollisionsAcrossResumes: collisions,
        note: "Each résumé is diagnosed on its own facts. Fact ids are scoped to one extraction, so no fact is shared or merged between résumés. S2 recommendations are user-wide and shown once.",
        employmentConflicts: conflicts.conflicts, s2UserWide: {
          supported: preview.assessments.filter((a) => a.support === "SUPPORTED").map((a) => a.title), partial: preview.assessments.filter((a) => a.support === "PARTIAL").map((a) => a.title),
        },
      };
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        console.log(`Comparison of ${rows.length} résumé(s), as of ${asOf}. Fact identities are never mixed (collisions: ${collisions.length}).`);
        for (const r of rows) console.log(`\n${r.resumeId}  ${r.fileType}  ${r.parserRevision}\n  facts ${r.facts}  approved ${r.byStatus.approved}  pending ${r.byStatus.pending}  rejected ${r.byStatus.rejected}  edited ${r.edited}\n  categories ${JSON.stringify(r.categories)}\n  quality ${JSON.stringify(r.qualityWarningCodes)}  sections without facts: ${r.sectionsWithTextButNoFacts.join(",") || "none"}  approved months: ${JSON.stringify(r.approvedMonths)}`);
        console.log(`\nOpen employment conflicts: ${conflicts.conflicts.length}`);
        console.log(`S2 (user-wide) SUPPORTED: ${report.s2UserWide.supported.join(", ") || "none"}\nS2 (user-wide) PARTIAL: ${report.s2UserWide.partial.join(", ") || "none"}`);
      }
      return 0;
    }

    if (!values.resume) {
      console.log("Pick a résumé:  npm run resumes:diagnose -- --resume <id>   (or --compare)\n");
      for (const r of resumes) console.log(`${r.resumeId}  ${r.fileType}  ${r.state.padEnd(9)}  ${r.parserRevision ?? "-"}  pending ${r.counts.pending}  approved ${r.counts.approved}  rejected ${r.counts.rejected}`);
      return 0;
    }
    const got = await diagnose(values.resume);
    if (!got) return fail("No such résumé for this user.");
    let rerun: unknown = null;
    if (values["rerun-parser"]) {
      rerun = rerunPreview(got.detail.version.id ? (await pool.query<{ storage_ref: string }>("SELECT storage_ref FROM resumes WHERE id=$1", [values.resume])).rows[0]!.storage_ref : "", got.detail.fileType,
        got.facts.map((f) => ({ kind: f.kind, value: f.value, sensitivity: f.sensitivity })), options.hideValues, options.reveal);
    }
    const body = values.json ? JSON.stringify(rerun ? { ...got.diag, parserRerunPreview: rerun } : got.diag, null, 2) : renderText(got.diag, rerun);
    if (values.out) {
      const target = path.resolve(values.out);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, body + "\n", "utf8");
      console.log(`Wrote ${target}${path.relative(path.resolve("private-runtime"), target).startsWith("..") ? "   note: outside private-runtime/; keep it out of Git." : ""}`);
    } else console.log(body);
    return 0;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

process.exit(await main().catch((error) => fail(`resumes:diagnose failed: ${error instanceof Error ? error.message : String(error)}`, 1)));
