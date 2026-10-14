import { defaultPython, scoreRows, type PythonRunner } from "./artifact.js";
import { candidateRoles, featurize, pairFor, type EngineContext } from "./engine.js";
import type { LlmProvider, RoleBrief } from "./llm-label.js";
import type { CorpusRow, ModelRecord } from "./repo.js";
import { routePrediction, type MlAcceptance, type RoutedPrediction } from "./router.js";
import { ML_DIR, pairRow } from "./workflows.js";

export interface RouteShadowRow { postingId: string; company: string; title: string; roleSlug: string; ruleRelevant: boolean; mlScore: number | null; routed: RoutedPrediction }
export interface RouteShadowReport { rows: RouteShadowRow[]; byPath: Record<string, number>; modelRevision: string | null; mlAcceptanceEnabled: boolean; mlError: string | null }

/**
 * Shadow-only three-way routing (ML_ACCEPT / LLM_FALLBACK / REVIEW). Nothing is written to the database; callers may save the returned report.
 * ML acceptance requires a HUMAN-PROMOTED model: a trained or even gate-qualifying candidate is not enough, so with no promoted model every
 * decision comes from evidence-checked Qwen or lands in REVIEW. An unreadable or tampered artifact degrades to Qwen/REVIEW, never to an error.
 */
export async function routeShadow(
  ctx: EngineContext, postings: readonly CorpusRow[], model: ModelRecord | null, qwen: LlmProvider, briefs: ReadonlyMap<string, RoleBrief>,
  opts: { limit: number; python?: PythonRunner; outDir?: string } = { limit: 5 },
): Promise<RouteShadowReport> {
  const pairs: Array<{ p: CorpusRow; roleSlug: string; ruleRelevant: boolean; f: Awaited<ReturnType<typeof featurize>>; view: ReturnType<typeof pairFor> }> = [];
  for (const p of postings) {
    if (pairs.length >= opts.limit) break;
    const f = await featurize(ctx, p);
    const roles = candidateRoles(ctx, f, 1);
    if (roles[0]) pairs.push({ p, roleSlug: roles[0], ruleRelevant: f.rule.roleSlugs.includes(roles[0]), f, view: pairFor(ctx, f, roles[0]) });
  }
  const enabled = model?.status === "promoted";
  let scores: number[] | null = null;
  let band: [number, number] = [0.1, 0.9];
  let mlError: string | null = null;
  if (model && enabled && pairs.length) {
    try {
      const out = scoreRows(model, pairs[0]!.view.names, pairs.map((x) => pairRow(x.f, x.view, ["hybrid_emb", "minilm"].includes(model.candidate))), opts.outDir ?? ML_DIR, opts.python ?? defaultPython);
      scores = out.scores; band = out.abstainBand;
    } catch (e) { mlError = e instanceof Error ? e.message : "model scoring failed"; }
  }
  const rows: RouteShadowRow[] = [];
  for (const [i, x] of pairs.entries()) {
    const brief = briefs.get(x.roleSlug);
    const score = scores ? scores[i]! : null;
    const ml: MlAcceptance | null = score === null ? null : { score, calibrated: true, acceptanceValidated: true, band };
    const routed = brief
      ? await routePrediction({ title: x.p.title, company: x.p.company, description: x.p.description }, brief, ml, qwen)
      : { path: "REVIEW" as const, decision: "unknown" as const, reason: "role is not in the active catalog", evidence: [], elapsedMs: 0 };
    rows.push({ postingId: x.p.id, company: x.p.company, title: x.p.title, roleSlug: x.roleSlug, ruleRelevant: x.ruleRelevant, mlScore: score, routed });
  }
  const byPath: Record<string, number> = {};
  for (const r of rows) byPath[r.routed.path] = (byPath[r.routed.path] ?? 0) + 1;
  return { rows, byPath, modelRevision: model?.revision ?? null, mlAcceptanceEnabled: enabled && !mlError, mlError };
}
