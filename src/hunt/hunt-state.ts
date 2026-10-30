import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Keyed by profile id ("sdet", "security", "cloud", "network"), or "*" for a run with no
// --profile filter -- so the daily "since previous successful hunt" freshness baseline
// (Task 3) is tracked per profile, not clobbered by a run of a different profile in between.
export interface HuntState {
  lastSuccessfulHuntAt: Record<string, string>;
}

export function loadHuntState(filePath: string): HuntState {
  if (!existsSync(filePath)) return { lastSuccessfulHuntAt: {} };
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as HuntState;
  } catch (err) {
    console.error(`Error reading hunt-state file ${filePath}: ${(err as Error).message}. Starting fresh.`);
    return { lastSuccessfulHuntAt: {} };
  }
}

export function saveHuntState(filePath: string, state: HuntState): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}
