import { spawnSync } from "node:child_process";
const norm = (value: string): string => value.split("\\").join("/");

export interface SelectableUnit {
  unit: { id: string; kind: "vitest" | "python" | "typecheck" };
  fingerprint: { closure: string[] };
  receipt: unknown;
  corrupt?: boolean;
  reusable: boolean;
}

/** null means git could not be asked. An empty array means a clean tree. */
export function gitChangedFiles(root: string): string[] | null {
  const run = (args: string[]): string[] | null => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    if (result.status !== 0) return null;
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  };
  const tracked = run(["diff", "--name-only", "HEAD"]);
  if (!tracked) return null;
  const untracked = run(["ls-files", "--others", "--exclude-standard"]);
  if (!untracked) return null;
  return [...new Set([...tracked, ...untracked].map(norm))];
}

export function affectedUnitIds(states: readonly SelectableUnit[], changedFiles: readonly string[]): Set<string> {
  const changed = new Set(changedFiles.map(norm));
  const appChanged = [...changed].some((file) => file.startsWith("services/ai/app/") || file === "services/ai/requirements.txt" || file.startsWith("services/ai/app"));
  const typecheckChanged = [...changed].some((file) => file.endsWith(".ts") || file === "tsconfig.json" || file === "package.json" || file === "package-lock.json");
  const ids = new Set<string>();
  for (const state of states) {
    if (state.unit.kind === "vitest") {
      if (changed.has(state.unit.id) || state.fingerprint.closure.some((file) => changed.has(norm(file)))) ids.add(state.unit.id);
    } else if (state.unit.kind === "python") {
      const file = state.unit.id.replace(/^python:/, "");
      if (file === "services/ai" ? [...changed].some((item) => item.startsWith("services/ai/")) : changed.has(file) || appChanged) ids.add(state.unit.id);
    } else if (state.unit.kind === "typecheck" && typecheckChanged) ids.add(state.unit.id);
  }
  return ids;
}

/** Cold caches must not become a full suite. Missing receipts are selected only from the git diff. */
export function selectChangedUnits(states: readonly SelectableUnit[], gitFiles: string[] | null): { ids: Set<string>; reason: string } {
  const cold = states.length > 0 && states.every((state) => !state.receipt);
  if (cold) {
    if (!gitFiles) return { ids: new Set(), reason: "cold-cache: git diff unavailable; refused to expand to the full suite" };
    if (gitFiles.length === 0) return { ids: new Set(), reason: "cold-cache: no changed files; refused to expand to the full suite" };
    return { ids: affectedUnitIds(states, gitFiles), reason: "cold-cache: git diff selected affected units only" };
  }
  const ids = new Set<string>();
  for (const state of states) {
    if (!state.reusable) ids.add(state.unit.id);
  }
  return { ids, reason: "incremental: units without a reusable receipt" };
}
