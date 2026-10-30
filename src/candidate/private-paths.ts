import { existsSync } from "node:fs";
import path from "node:path";

// Where private candidate data is allowed to live, and the one check that enforces it.
//
// `private-runtime/` inside the checkout is gitignored and stays valid for the .docx import
// that already writes there. Anything derived from a candidate PDF goes outside every Git
// checkout instead: an ignore rule is a decision someone can undo in one line, and a file
// that is not in a working tree cannot be staged by a careless `git add -A` at all.
//
// JH_PRIVATE_ROOT names that directory (e.g. F:\JobHunterPrivate). Paths are compared after
// resolution, so a relative path, a trailing separator or a different drive letter case all
// reduce to the same answer on Windows.

export const PRIVATE_ROOT_ENV = "JH_PRIVATE_ROOT";

/** The nearest ancestor of `start` holding a `.git` entry (in a worktree, `.git` is a file). */
export function findRepoRoot(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** True when `target` is `root` or sits under it. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface PrivatePathProblem {
  code: "INSIDE_GIT_CHECKOUT" | "PRIVATE_ROOT_NOT_SET" | "OUTSIDE_PRIVATE_ROOT";
  detail: string;
}

/**
 * Check a path meant to hold candidate-derived data.
 *
 * The non-negotiable part is the first check: not inside a Git checkout. A private root, when
 * one is configured, additionally keeps every run writing to the same place.
 */
export function checkPrivateTarget(target: string, options: { requirePrivateRoot?: boolean; env?: NodeJS.ProcessEnv } = {}): PrivatePathProblem[] {
  const env = options.env ?? process.env;
  const resolved = path.resolve(target);
  const problems: PrivatePathProblem[] = [];
  const searchFrom = existsSync(resolved) ? resolved : path.dirname(resolved);
  const repo = findRepoRoot(searchFrom);
  if (repo) problems.push({ code: "INSIDE_GIT_CHECKOUT", detail: `${resolved} is inside the Git checkout rooted at ${repo}` });

  const root = env[PRIVATE_ROOT_ENV];
  if (!root) {
    if (options.requirePrivateRoot) problems.push({ code: "PRIVATE_ROOT_NOT_SET", detail: `${PRIVATE_ROOT_ENV} is not set; set it to the private data directory (e.g. F:\\JobHunterPrivate)` });
  } else if (!isInside(root, resolved)) {
    problems.push({ code: "OUTSIDE_PRIVATE_ROOT", detail: `${resolved} is outside ${PRIVATE_ROOT_ENV} (${root})` });
  }
  return problems;
}

/** A path under the configured private root, or null when none is configured. */
export function privatePath(...segments: string[]): string | null {
  const root = process.env[PRIVATE_ROOT_ENV];
  return root ? path.join(root, ...segments) : null;
}
