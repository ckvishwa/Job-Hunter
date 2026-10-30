import { cosineSimilarity, type EmbeddingEncoder } from "../nlu/local-transformer.js";
import { lexicon, normalizeText, type Lexicon } from "./lexicon.js";
import type { EvidenceUnit } from "./evidence.js";
import type { VectorCache } from "./embedding-cache.js";

// S4A candidate-evidence retrieval over APPROVED, authorized units only (see evidence.ts). Four rankers, all returning candidates:
//   lexical  exact whole-phrase match of the requirement's reviewed spellings / category members
//   bm25     Okapi BM25 over unit text (in-house: the corpus is tiny and a dependency would add nothing)
//   semantic MiniLM cosine similarity (optional; absent when no encoder is configured or the encoder failed)
//   hybrid   reciprocal rank fusion (k = 60) of whichever rankers produced a list
// A retrieval score NEVER establishes that a qualification is possessed. Decisions (decide.ts) use deterministic matches; retrieval only
// supplies leads and measurable ranking quality.

export const RRF_K = 60;
export const BM25 = { k1: 1.2, b: 0.75 } as const;

export interface RetrievalQuery {
  requirementId: string;
  /** Text to embed and to tokenize for BM25. */
  text: string;
  /** Reviewed spellings (incl. category members) for exact matching. */
  phrases: string[];
}

export interface Ranked {
  unitId: string;
  rank: number;
  score: number;
}

export interface RetrievalResult {
  requirementId: string;
  lexical: Ranked[];
  bm25: Ranked[];
  semantic: Ranked[] | null;
  hybrid: Ranked[];
}

const tokens = (s: string): string[] => normalizeText(s).split(/[^a-z0-9+#]+/).filter((t) => t.length > 1);

function rankDescending(scores: Map<string, number>): Ranked[] {
  return [...scores.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([unitId, score], i) => ({ unitId, rank: i + 1, score }));
}

export function rrf(lists: ReadonlyArray<ReadonlyArray<Ranked>>, k = RRF_K): Ranked[] {
  const fused = new Map<string, number>();
  for (const list of lists) for (const r of list) fused.set(r.unitId, (fused.get(r.unitId) ?? 0) + 1 / (k + r.rank));
  return rankDescending(fused);
}

export function queryFor(requirement: { id: string; value: string; type: string; quote?: string }, lex: Lexicon = lexicon()): RetrievalQuery {
  const term = lex.lookup(requirement.value);
  const phrases = term ? [...lex.spellings(term.canonical), ...(term.members ?? []).flatMap((m) => lex.spellings(m))] : [requirement.value];
  return { requirementId: requirement.id, text: requirement.value, phrases };
}

export class EvidenceIndex {
  private readonly docTokens = new Map<string, string[]>();
  private readonly docText = new Map<string, string>();
  private readonly df = new Map<string, number>();
  private avgLen = 0;
  private vectors: Map<string, number[]> | null = null;
  semanticStatus: "NOT_CONFIGURED" | "READY" | "FAILED" = "NOT_CONFIGURED";

  constructor(readonly units: readonly EvidenceUnit[], private readonly encoder: EmbeddingEncoder | null = null, private readonly cache: VectorCache | null = null) {
    let total = 0;
    for (const u of units) {
      const t = tokens(u.text);
      this.docTokens.set(u.unitId, t);
      this.docText.set(u.unitId, ` ${normalizeText(u.text)} `);
      total += t.length;
      for (const w of new Set(t)) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    }
    this.avgLen = units.length ? total / units.length : 0;
  }

  /** Embeds every unit once. A failing encoder disables the semantic ranker (fail closed); the other rankers keep working. */
  async prepare(): Promise<void> {
    if (!this.encoder) return;
    try {
      const vectors = new Map<string, number[]>();
      for (const u of this.units) {
        let v = await this.cache?.get(u).catch(() => null);
        if (!v) {
          v = (await this.encoder.embed(u.text)).vector;
          await this.cache?.put(u, v).catch(() => undefined); // a cache failure never changes a result
        }
        vectors.set(u.unitId, v);
      }
      this.vectors = vectors;
      this.semanticStatus = "READY";
    } catch {
      this.vectors = null;
      this.semanticStatus = "FAILED";
    }
  }

  lexical(q: RetrievalQuery): Ranked[] {
    const scores = new Map<string, number>();
    const wanted = q.phrases.map((p) => ` ${normalizeText(p)} `);
    for (const u of this.units) {
      const text = this.docText.get(u.unitId)!;
      const hits = wanted.filter((p) => text.includes(p)).length;
      if (hits > 0) scores.set(u.unitId, hits);
    }
    return rankDescending(scores);
  }

  bm25(q: RetrievalQuery): Ranked[] {
    const n = this.units.length;
    const qTokens = [...new Set(tokens(q.text))];
    const scores = new Map<string, number>();
    for (const u of this.units) {
      const t = this.docTokens.get(u.unitId)!;
      let s = 0;
      for (const w of qTokens) {
        const f = t.filter((x) => x === w).length;
        if (!f) continue;
        const df = this.df.get(w) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s += idf * ((f * (BM25.k1 + 1)) / (f + BM25.k1 * (1 - BM25.b + BM25.b * (t.length / (this.avgLen || 1)))));
      }
      if (s > 0) scores.set(u.unitId, s);
    }
    return rankDescending(scores);
  }

  async semantic(q: RetrievalQuery, topK = 20): Promise<Ranked[] | null> {
    if (!this.encoder || !this.vectors) return null;
    try {
      const qv = (await this.encoder.embed(q.text)).vector;
      const scores = new Map<string, number>();
      for (const [id, v] of this.vectors) scores.set(id, cosineSimilarity(qv, v));
      return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topK).map(([unitId, score], i) => ({ unitId, rank: i + 1, score }));
    } catch {
      this.semanticStatus = "FAILED";
      return null;
    }
  }

  async retrieve(q: RetrievalQuery): Promise<RetrievalResult> {
    const lexical = this.lexical(q);
    const bm25 = this.bm25(q);
    const semantic = await this.semantic(q);
    return { requirementId: q.requirementId, lexical, bm25, semantic, hybrid: rrf([lexical, bm25, ...(semantic ? [semantic] : [])]) };
  }
}
