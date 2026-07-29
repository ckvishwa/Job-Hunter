import { spawn } from "node:child_process";
import {
  preflightCareerOps,
  type CareerOpsPreflightResult,
} from "./careerops-preflight.js";
import { careerOpsScanResultSchema, type CareerOpsScanResult } from "./careerops-schema.js";

export const CAREER_OPS_ATS_SOURCES = ["greenhouse", "lever", "ashby", "workday", "icims"] as const;
export type CareerOpsAtsSource = (typeof CAREER_OPS_ATS_SOURCES)[number];

export interface RunCareerOpsScanOptions {
  careerOpsHome: string;
  sinceDays: number;
  // Maps to CareerOps' own --limit, a PER-ATS COMPANY CAP -- not the Hunt report's --limit
  // (a top-N-results cap). Deliberately not named `limit` and never read by anything outside
  // this module, so the two concepts can never be accidentally wired together.
  atsCompanyLimit?: number;
  atsSources?: CareerOpsAtsSource[];
  timeoutMs: number;
}

// Narrow structural subset of ChildProcess this module actually uses -- real `spawn`'s return
// type satisfies it, and so does a lightweight test double, without fighting `spawn`'s stdio-
// overload-dependent return type (ChildProcessWithoutNullStreams vs. ChildProcess) in test code.
export interface CareerOpsChildProcessLike {
  stdout: NodeJS.EventEmitter | null;
  stderr: NodeJS.EventEmitter | null;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
  kill(): void;
}

export type CareerOpsSpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; shell: boolean },
) => CareerOpsChildProcessLike;

const defaultSpawnFn: CareerOpsSpawnFn = (command, args, options) => spawn(command, args, options);

export interface RunCareerOpsScanDependencies {
  spawnFn?: CareerOpsSpawnFn;
  preflightFn?: typeof preflightCareerOps;
  pinnedCommit?: string;
}

export type CareerOpsRunResult =
  | { kind: "invalid-options"; message: string }
  | { kind: "preflight-failed"; preflight: CareerOpsPreflightResult }
  | { kind: "spawn-error"; message: string }
  | { kind: "timeout"; timeoutMs: number; stdout: string; stderr: string }
  | { kind: "non-zero-exit"; exitCode: number | null; stdout: string; stderr: string }
  | { kind: "empty-stdout"; stderr: string }
  | { kind: "invalid-json"; stdout: string; stderr: string; parseError: string }
  | { kind: "invalid-scan-result"; stdout: string; stderr: string; issues: string[] }
  | { kind: "success"; result: CareerOpsScanResult; stderr: string; preflight: CareerOpsPreflightResult };

interface NormalizedOptions {
  sinceDays: number;
  atsCompanyLimit?: number;
  atsSources: CareerOpsAtsSource[];
  timeoutMs: number;
}

function validateOptions(options: RunCareerOpsScanOptions): { ok: true; value: NormalizedOptions } | { ok: false; message: string } {
  if (!Number.isInteger(options.sinceDays) || options.sinceDays <= 0) {
    return { ok: false, message: `sinceDays must be a positive integer, got ${options.sinceDays}` };
  }
  if (options.atsCompanyLimit !== undefined && (!Number.isInteger(options.atsCompanyLimit) || options.atsCompanyLimit <= 0)) {
    return { ok: false, message: `atsCompanyLimit must be a positive integer, got ${options.atsCompanyLimit}` };
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return { ok: false, message: `timeoutMs must be positive, got ${options.timeoutMs}` };
  }
  const rawAts = options.atsSources ?? [];
  const unknown = rawAts.filter((s) => !CAREER_OPS_ATS_SOURCES.includes(s));
  if (unknown.length > 0) {
    return { ok: false, message: `Unsupported ATS source(s): ${unknown.join(", ")}. Valid: ${CAREER_OPS_ATS_SOURCES.join(", ")}` };
  }
  // Duplicates normalized (deduped, first-occurrence order preserved) rather than rejected --
  // deterministic either way, but a duplicate isn't a caller error worth hard-failing on.
  const atsSources = [...new Set(rawAts)];

  return {
    ok: true,
    value: { sinceDays: options.sinceDays, atsCompanyLimit: options.atsCompanyLimit, atsSources, timeoutMs: options.timeoutMs },
  };
}

function buildArgs(scanScriptPath: string, opts: NormalizedOptions): string[] {
  const args = [scanScriptPath, "--json", "--dry-run", "--since", String(opts.sinceDays)];
  if (opts.atsCompanyLimit !== undefined) args.push("--limit", String(opts.atsCompanyLimit));
  if (opts.atsSources.length > 0) args.push("--ats", opts.atsSources.join(","));
  return args;
}

interface RawProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnErrorMessage?: string;
}

function runProcess(
  spawnFn: CareerOpsSpawnFn,
  execPath: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RawProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const settle = (result: RawProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: CareerOpsChildProcessLike;
    try {
      child = spawnFn(execPath, args, { cwd, shell: false });
    } catch (err) {
      // Thrown synchronously by spawnFn itself, before any timer exists -- nothing to clear.
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, spawnErrorMessage: (err as Error).message });
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      settle({ exitCode: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err: Error) => {
      settle({ exitCode: null, stdout, stderr, timedOut: false, spawnErrorMessage: err.message });
    });
    child.on("close", (code: number | null) => {
      settle({ exitCode: code, stdout, stderr, timedOut: false });
    });
  });
}

// Nothing in this module runs at import time -- runCareerOpsScan only does anything once
// called, and only ever spawns after a passing preflight.
export async function runCareerOpsScan(
  options: RunCareerOpsScanOptions,
  deps: RunCareerOpsScanDependencies = {},
): Promise<CareerOpsRunResult> {
  const validated = validateOptions(options);
  if (!validated.ok) {
    return { kind: "invalid-options", message: validated.message };
  }

  const preflightFn = deps.preflightFn ?? preflightCareerOps;
  const preflight = await preflightFn({ careerOpsHome: options.careerOpsHome, pinnedCommit: deps.pinnedCommit });
  if (!preflight.ok) {
    return { kind: "preflight-failed", preflight };
  }

  const spawnFn = deps.spawnFn ?? defaultSpawnFn;
  const args = buildArgs(preflight.scanScriptPath!, validated.value);
  const raw = await runProcess(spawnFn, process.execPath, args, options.careerOpsHome, validated.value.timeoutMs);

  if (raw.spawnErrorMessage !== undefined) {
    return { kind: "spawn-error", message: raw.spawnErrorMessage };
  }
  if (raw.timedOut) {
    return { kind: "timeout", timeoutMs: validated.value.timeoutMs, stdout: raw.stdout, stderr: raw.stderr };
  }
  if (raw.exitCode !== 0) {
    return { kind: "non-zero-exit", exitCode: raw.exitCode, stdout: raw.stdout, stderr: raw.stderr };
  }
  if (raw.stdout.trim().length === 0) {
    return { kind: "empty-stdout", stderr: raw.stderr };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.stdout);
  } catch (err) {
    return { kind: "invalid-json", stdout: raw.stdout, stderr: raw.stderr, parseError: (err as Error).message };
  }

  const schemaResult = careerOpsScanResultSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return {
      kind: "invalid-scan-result",
      stdout: raw.stdout,
      stderr: raw.stderr,
      issues: schemaResult.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }

  return { kind: "success", result: schemaResult.data, stderr: raw.stderr, preflight };
}
