import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelRecord } from "./repo.js";

// Bounded, typed bridge to the scikit-learn kernel (services/ml). One short-lived subprocess per call: no server, no network, hard timeout.
// A joblib artifact is pickle-based, so it is loaded only after its SHA-256 matches the model registry (checked in Python before unpickling).

export type PythonRunner = (script: string, args: string[], timeoutMs?: number) => { status: number | null; stdout: string; stderr: string; timedOut?: boolean };

export const ML_SERVICE_DIR = path.resolve("services", "ml");

export const defaultPython: PythonRunner = (script, args, timeoutMs = 300_000) => {
  const isolated = path.resolve("private-runtime", "ml", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const executable = process.env.JH_ML_PYTHON ?? isolated;
  const r = spawnSync(executable, ["-B", path.join(ML_SERVICE_DIR, script), ...args], { encoding: "utf8", timeout: timeoutMs, cwd: ML_SERVICE_DIR, windowsHide: true, env: { ...process.env, OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1" } });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.error != null && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT" };
};

export class MlRuntimeError extends Error {
  constructor(readonly code: "PYTHON_FAILED" | "TIMEOUT" | "ARTIFACT_MISSING" | "ARTIFACT_HASH_MISMATCH" | "BAD_OUTPUT" | "FEATURE_MISMATCH", message: string) {
    super(message);
    this.name = "MlRuntimeError";
  }
}

export const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

export interface PairRow { title: string; text?: string; role: string; dense: number[]; emb: number[] | null; group?: string; y?: 0 | 1 }
export type Candidate = "title_tfidf" | "hybrid" | "hybrid_emb" | "tfidf" | "minilm";
export const CANDIDATES: readonly Candidate[] = ["title_tfidf", "hybrid", "hybrid_emb", "tfidf", "minilm"];

const safeTail = (s: string): string => s.replace(/\s+/g, " ").slice(0, 300);

export interface TrainMeta { candidate: Candidate; seed: number; C: number; cvF1: number; folds: number; threshold: number; abstainBand: [number, number]; denseNames: string[]; embDim: number; featureRevision: string; datasetVersion: string; splitHash: string; trainCounts: { positive: number; negative: number; groups: number }; libraries: Record<string, string> }

export function trainArtifact(
  input: { purpose?: "production" | "synthetic" | "research"; candidate: Candidate; seed: number; denseNames: string[]; featureRevision: string; datasetVersion: string; splitHash: string; rows: PairRow[] },
  outDir: string, python: PythonRunner = defaultPython,
): { file: string; sha256: string; revision: string; meta: TrainMeta } {
  mkdirSync(path.join(outDir, "tmp"), { recursive: true });
  mkdirSync(path.join(outDir, "models"), { recursive: true });
  const src = path.join(outDir, "tmp", `train-${input.datasetVersion}-${input.candidate}.json`);
  const tmpArtifact = path.join(outDir, "tmp", `${input.datasetVersion}-${input.candidate}.joblib`);
  writeFileSync(src, JSON.stringify({ schemaVersion: 2, purpose: "production", ...input }));
  const r = python("ml_train.py", [src, tmpArtifact]);
  if (r.timedOut) throw new MlRuntimeError("TIMEOUT", "Trainer timed out.");
  if (r.status !== 0) throw new MlRuntimeError("PYTHON_FAILED", `Trainer exited ${r.status}: ${safeTail(r.stdout || r.stderr)}`);
  let meta: TrainMeta;
  try { meta = (JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { meta: TrainMeta }).meta; } catch { throw new MlRuntimeError("BAD_OUTPUT", "Trainer output was not valid JSON."); }
  const sha = sha256File(tmpArtifact);
  const revision = sha.slice(0, 16);
  const file = path.join(outDir, "models", `${input.datasetVersion}-${input.candidate}-${revision}.joblib`);
  writeFileSync(file, readFileSync(tmpArtifact));
  return { file, sha256: sha, revision, meta };
}

export interface ScoreOutput { scores: number[]; threshold: number; abstainBand: [number, number]; inferenceMs: number; peakRssMb: number | null }

export function scoreRows(model: Pick<ModelRecord, "artifactPath" | "artifactSha256" | "featureRevision">, denseNames: string[], rows: PairRow[], outDir: string, python: PythonRunner = defaultPython): ScoreOutput {
  if (!existsSync(model.artifactPath)) throw new MlRuntimeError("ARTIFACT_MISSING", "Model artifact file is missing.");
  mkdirSync(path.join(outDir, "tmp"), { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const src = path.join(outDir, "tmp", `score-in-${stamp}.json`);
  const dst = path.join(outDir, "tmp", `score-out-${stamp}.json`);
  writeFileSync(src, JSON.stringify({ featureRevision: model.featureRevision, denseNames, rows }));
  const r = python("ml_predict.py", [model.artifactPath, model.artifactSha256, src, dst], 120_000);
  if (r.timedOut) throw new MlRuntimeError("TIMEOUT", "Scoring timed out.");
  if (r.status !== 0) {
    const msg = safeTail(r.stdout || r.stderr);
    throw new MlRuntimeError(/hash does not match/.test(msg) ? "ARTIFACT_HASH_MISMATCH" : /schema|dimension/.test(msg) ? "FEATURE_MISMATCH" : "PYTHON_FAILED", msg);
  }
  let out: { scores: number[]; threshold: number; abstainBand: [number, number]; inferenceMs: number; peakRssMb?: number | null };
  try { out = JSON.parse(readFileSync(dst, "utf8")); } catch { throw new MlRuntimeError("BAD_OUTPUT", "Scoring output was not valid JSON."); }
  if (!Array.isArray(out.scores) || out.scores.length !== rows.length || out.scores.some((s) => !Number.isFinite(s) || s < 0 || s > 1)) throw new MlRuntimeError("BAD_OUTPUT", "Scoring output has the wrong length or out-of-range values.");
  return { scores: out.scores, threshold: out.threshold, abstainBand: out.abstainBand, inferenceMs: out.inferenceMs, peakRssMb: out.peakRssMb ?? null };
}
