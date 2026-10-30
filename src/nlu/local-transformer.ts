import os from "node:os";
import path from "node:path";
import { AutoModel, AutoTokenizer, env, mean_pooling } from "@huggingface/transformers";

export const DEFAULT_ENCODER = {
  modelId: "sentence-transformers/all-MiniLM-L6-v2",
  revision: "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
  maxSequenceLength: 256,
  embeddingDimensions: 384,
  cacheVersion: "local-candidate-embeddings-v1",
} as const;

export interface TextChunk {
  text: string;
  start: number;
  end: number;
  section: string | null;
  tokenCount: number;
}

export interface EncoderModelConfig {
  modelId: string;
  revision: string;
  maxSequenceLength: number;
  embeddingDimensions: number;
  cacheVersion: string;
}

export interface EmbeddingResult {
  vector: number[];
  chunks: TextChunk[];
  model: EncoderModelConfig;
  runtime: string;
  device: string;
  hardware: string;
  elapsedMs: number;
}

export interface EmbeddingEncoder {
  embed(text: string): Promise<EmbeddingResult>;
}

type LoadedEncoder = {
  tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  model: Awaited<ReturnType<typeof AutoModel.from_pretrained>>;
};

function defaultModelDirectory(): string {
  const profile = process.env.USERPROFILE ?? os.homedir();
  return path.join(
    profile,
    ".cache",
    "huggingface",
    "hub",
    "models--sentence-transformers--all-MiniLM-L6-v2",
    "snapshots",
    DEFAULT_ENCODER.revision,
  );
}

function rangesForSentences(text: string): Array<{ start: number; end: number }> {
  const result: Array<{ start: number; end: number }> = [];
  const sentence = /[^.!?\n]+(?:[.!?]+|(?=\n)|$)/g;
  for (const match of text.matchAll(sentence)) {
    const raw = match[0];
    const leading = raw.search(/\S/);
    if (leading < 0 || match.index === undefined) continue;
    const value = raw.trimEnd();
    result.push({ start: match.index + leading, end: match.index + leading + value.length });
  }
  return result.length > 0 ? result : [{ start: 0, end: text.length }];
}

function sectionAt(text: string, offset: number): string | null {
  const prefix = text.slice(0, offset);
  const headings = [...prefix.matchAll(/(?:^|\n)\s*([A-Z][A-Z /&-]{2,50})\s*(?=\n|$)/g)];
  return headings.at(-1)?.[1]?.trim() ?? null;
}

function vectorCount(tensor: { dims: number[] }): number {
  return tensor.dims.at(-1) ?? 0;
}

function normalizeVector(values: ArrayLike<number>): number[] {
  const vector = Array.from(values);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error("Encoder returned a zero or invalid embedding.");
  return vector.map((value) => value / norm);
}

/** Local, pinned ONNX sentence encoder. It never downloads; all model/tokenizer files must be cached. */
export class LocalTransformerEncoder {
  readonly modelDirectory: string;
  private loaded: Promise<LoadedEncoder> | null = null;

  constructor(modelDirectory = process.env.JOBHUNTER_ENCODER_DIR ?? defaultModelDirectory()) {
    this.modelDirectory = path.resolve(modelDirectory);
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
  }

  private load(): Promise<LoadedEncoder> {
    this.loaded ??= Promise.all([
      AutoTokenizer.from_pretrained(this.modelDirectory, { local_files_only: true }),
      AutoModel.from_pretrained(this.modelDirectory, { local_files_only: true }),
    ]).then(([tokenizer, model]) => ({ tokenizer, model }));
    return this.loaded;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    if (!text.trim()) throw new Error("Cannot embed empty text.");
    const started = Date.now();
    const { tokenizer, model } = await this.load();
    const maxBodyTokens = DEFAULT_ENCODER.maxSequenceLength - 2; // BERT [CLS]/[SEP]
    const tokenCount = (value: string) => vectorCount(tokenizer(value, { add_special_tokens: false, truncation: false }).input_ids);
    const atomic: Array<{ start: number; end: number }> = [];

    for (const sentence of rangesForSentences(text)) {
      const value = text.slice(sentence.start, sentence.end);
      if (tokenCount(value) <= maxBodyTokens) {
        atomic.push(sentence);
        continue;
      }
      // Long sentences are split at whitespace boundaries; no source characters are dropped.
      const words = [...value.matchAll(/\S+/g)];
      let partStart = 0;
      let partEnd = 0;
      for (const word of words) {
        const wordStart = word.index ?? 0;
        const wordEnd = wordStart + word[0].length;
        const candidateEnd = wordEnd;
        if (partEnd > partStart && tokenCount(value.slice(partStart, candidateEnd)) > maxBodyTokens) {
          atomic.push({ start: sentence.start + partStart, end: sentence.start + partEnd });
          partStart = wordStart;
        }
        partEnd = wordEnd;
        if (tokenCount(value.slice(partStart, partEnd)) > maxBodyTokens) {
          throw new Error(`A single token exceeds the encoder input limit at source offset ${sentence.start + partStart}.`);
        }
      }
      if (partEnd > partStart) atomic.push({ start: sentence.start + partStart, end: sentence.start + partEnd });
    }

    const chunks: TextChunk[] = [];
    let current: { start: number; end: number } | null = null;
    for (const range of atomic) {
      const proposed: { start: number; end: number } = current ? { start: current.start, end: range.end } : range;
      const candidate = text.slice(proposed.start, proposed.end);
      if (current && tokenCount(candidate) > maxBodyTokens) {
        const currentText = text.slice(current.start, current.end);
        chunks.push({ text: currentText, ...current, section: sectionAt(text, current.start), tokenCount: tokenCount(currentText) + 2 });
        current = range;
      } else {
        current = proposed;
      }
    }
    if (current) {
      const currentText = text.slice(current.start, current.end);
      chunks.push({ text: currentText, ...current, section: sectionAt(text, current.start), tokenCount: tokenCount(currentText) + 2 });
    }

    const weighted = new Array<number>(DEFAULT_ENCODER.embeddingDimensions).fill(0);
    let totalWeight = 0;
    for (const chunk of chunks) {
      const encoded = tokenizer(chunk.text, { padding: true, truncation: false });
      const actualLength = vectorCount(encoded.input_ids);
      if (actualLength > DEFAULT_ENCODER.maxSequenceLength) {
        throw new Error(`Chunk ${chunk.start}-${chunk.end} encoded to ${actualLength} tokens; refusing truncation.`);
      }
      const output = await model(encoded);
      const pooled = mean_pooling(output.last_hidden_state, encoded.attention_mask);
      const vector = normalizeVector(pooled.data);
      const weight = Math.max(1, chunk.tokenCount - 2);
      for (let i = 0; i < vector.length; i += 1) weighted[i] = weighted[i]! + vector[i]! * weight;
      totalWeight += weight;
    }
    if (chunks.length === 0) throw new Error("Tokenizer produced no chunks.");
    const vector = normalizeVector(weighted.map((value) => value / totalWeight));
    return {
      vector,
      chunks,
      model: DEFAULT_ENCODER,
      runtime: "@huggingface/transformers@4.3.1 + ONNX Runtime",
      device: "CPUExecutionProvider",
      hardware: os.cpus()[0]?.model ?? os.arch(),
      elapsedMs: Date.now() - started,
    };
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) throw new Error("Embedding dimensions do not match.");
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i]! * right[i]!;
    leftNorm += left[i]! * left[i]!;
    rightNorm += right[i]! * right[i]!;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
