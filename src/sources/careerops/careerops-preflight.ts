import { existsSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";

export type CareerOpsPreflightIssueCode =
  | "HOME_NOT_FOUND"
  | "HOME_NOT_DIRECTORY"
  | "SCAN_SCRIPT_NOT_FOUND"
  | "PORTALS_CONFIG_NOT_FOUND"
  | "NODE_NOT_AVAILABLE"
  | "GIT_COMMIT_UNAVAILABLE"
  | "PIN_MISMATCH";

export interface CareerOpsPreflightIssue {
  code: CareerOpsPreflightIssueCode;
  message: string;
}

export interface CareerOpsPreflightResult {
  ok: boolean;
  careerOpsHome: string;
  scanScriptPath?: string;
  currentCommit?: string;
  pinnedCommit?: string;
  errors: CareerOpsPreflightIssue[];
  warnings: CareerOpsPreflightIssue[];
}

export interface CareerOpsPreflightOptions {
  careerOpsHome: string;
  pinnedCommit?: string;
}

interface StatLike {
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface CareerOpsPreflightDependencies {
  existsFn?: (targetPath: string) => boolean;
  statFn?: (targetPath: string) => StatLike;
  // Returns the raw {stdout, stderr} shape (matches util.promisify(child_process.execFile)) --
  // rejects on a non-zero exit / spawn failure, same as the real thing.
  execFileFn?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

function defaultExecFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { shell: false }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

// Read-only by construction: every dependency this module accepts (existsFn/statFn/execFileFn)
// is read-only in its default (real) implementation, and `git rev-parse HEAD` never mutates the
// clone. Never creates portals.yml, never runs npm install, never pulls/checks out/resets
// CareerOps -- this function has no code path capable of any of that.
export async function preflightCareerOps(
  options: CareerOpsPreflightOptions,
  deps: CareerOpsPreflightDependencies = {},
): Promise<CareerOpsPreflightResult> {
  const existsFn = deps.existsFn ?? existsSync;
  const statFn = deps.statFn ?? statSync;
  const execFileFn = deps.execFileFn ?? defaultExecFile;

  const errors: CareerOpsPreflightIssue[] = [];
  const warnings: CareerOpsPreflightIssue[] = [];

  const { careerOpsHome, pinnedCommit } = options;
  const scanScriptPath = path.join(careerOpsHome, "scan-ats-full.mjs");
  const portalsPath = path.join(careerOpsHome, "portals.yml");

  if (!existsFn(careerOpsHome)) {
    errors.push({ code: "HOME_NOT_FOUND", message: `CareerOps home not found: ${careerOpsHome}` });
  } else if (!statFn(careerOpsHome).isDirectory()) {
    errors.push({ code: "HOME_NOT_DIRECTORY", message: `CareerOps home is not a directory: ${careerOpsHome}` });
  }

  if (!existsFn(scanScriptPath) || !statFn(scanScriptPath).isFile()) {
    errors.push({ code: "SCAN_SCRIPT_NOT_FOUND", message: `scan-ats-full.mjs not found: ${scanScriptPath}` });
  }

  if (!existsFn(portalsPath) || !statFn(portalsPath).isFile()) {
    errors.push({
      code: "PORTALS_CONFIG_NOT_FOUND",
      message: `portals.yml not found: ${portalsPath}. Copy templates/portals.example.yml and set title_filter.positive first.`,
    });
  }

  if (!existsFn(process.execPath)) {
    errors.push({ code: "NODE_NOT_AVAILABLE", message: `Node executable not found: ${process.execPath}` });
  }

  let currentCommit: string | undefined;
  try {
    const { stdout } = await execFileFn("git", ["-C", careerOpsHome, "rev-parse", "HEAD"]);
    const trimmed = stdout.trim();
    // Empty/whitespace-only stdout from a zero-exit git call is not a valid commit hash -- treat
    // it the same as a failed read (below), not as "successfully determined an empty commit."
    if (!trimmed) throw new Error("git rev-parse HEAD returned no output");
    currentCommit = trimmed;
  } catch (err) {
    const issue: CareerOpsPreflightIssue = {
      code: "GIT_COMMIT_UNAVAILABLE",
      message: `Could not read CareerOps' current git commit: ${(err as Error).message}`,
    };
    // Only fatal when a pin was supplied -- without one there's nothing to verify, so an
    // unreadable commit is advisory (we just won't stamp provenance with it), not blocking.
    if (pinnedCommit) errors.push(issue);
    else warnings.push(issue);
  }

  if (currentCommit && pinnedCommit && currentCommit !== pinnedCommit) {
    warnings.push({
      code: "PIN_MISMATCH",
      message: `CareerOps commit ${currentCommit} does not match the pinned commit ${pinnedCommit} (config/careerops-version.json). Not blocking -- the clone may have been legitimately updated.`,
    });
  }

  return {
    ok: errors.length === 0,
    careerOpsHome,
    scanScriptPath,
    currentCommit,
    pinnedCommit,
    errors,
    warnings,
  };
}
