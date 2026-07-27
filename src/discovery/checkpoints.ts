import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DiscoveryCheckpoint } from "./types.js";

export function loadCheckpoints(filePath: string): Record<string, DiscoveryCheckpoint> {
  if (!existsSync(filePath)) return {};
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as Record<string, DiscoveryCheckpoint>;
  } catch (err) {
    console.error(`Error reading checkpoint file ${filePath}: ${(err as Error).message}. Starting fresh.`);
    return {};
  }
}

export function saveCheckpoints(filePath: string, checkpoints: Record<string, DiscoveryCheckpoint>): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(checkpoints, null, 2), "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    console.error(`Error saving checkpoints to ${filePath}: ${(err as Error).message}`);
  }
}

export function buildCheckpointKey(source: string, keyword: string, location: string): string {
  return `${source.toLowerCase()}::${keyword.toLowerCase()}::${location.toLowerCase()}`;
}

export function getOrCreateCheckpoint(
  checkpoints: Record<string, DiscoveryCheckpoint>,
  source: string,
  keyword: string,
  location: string,
): DiscoveryCheckpoint {
  const key = buildCheckpointKey(source, keyword, location);
  if (checkpoints[key]) {
    return checkpoints[key]!;
  }
  const newCheckpoint: DiscoveryCheckpoint = {
    key,
    source,
    keyword,
    location,
    lastPage: 0,
    completed: false,
    lastUpdated: new Date().toISOString(),
    sourceJobIds: [],
  };
  checkpoints[key] = newCheckpoint;
  return newCheckpoint;
}
