import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

// Several browser test files serve the same Astro build (web/dist). Building it from each file at the same time wipes the output
// from under another file's preview server (seen as ERR_CONNECTION_REFUSED / missing pages). This builds once, under a
// cross-process lock, and only when the sources are newer than the output; every other file then reuses the finished build.

const WEB_DIR = path.resolve("web");
const ASTRO = path.join(WEB_DIR, "node_modules", "astro", "bin", "astro.mjs");
const LOCK = path.join(WEB_DIR, ".build-lock");
const STAMP = path.join(WEB_DIR, "dist", "index.html");

function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestSourceMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

const upToDate = (): boolean => {
  if (!existsSync(STAMP)) return false;
  const sources = Math.max(newestSourceMtime(path.join(WEB_DIR, "src")), statSync(path.join(WEB_DIR, "astro.config.mjs")).mtimeMs, statSync(path.join(WEB_DIR, "package.json")).mtimeMs);
  return statSync(STAMP).mtimeMs >= sources;
};

export async function ensureWebBuild(): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      mkdirSync(LOCK); // atomic: only one process holds it
      break;
    } catch {
      // A lock older than 5 minutes belongs to a crashed run.
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 300_000) rmSync(LOCK, { recursive: true, force: true });
      } catch { /* released meanwhile */ }
      if (Date.now() > deadline) throw new Error("Timed out waiting for another process to finish the Astro build.");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  try {
    if (!upToDate()) {
      const build = spawnSync(process.execPath, [ASTRO, "build"], { cwd: WEB_DIR, encoding: "utf8" });
      if (build.status !== 0) throw new Error(`astro build failed: ${build.stderr || build.stdout}`);
    }
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

/** Polls until the URL answers 2xx; throws (never silently continues) if it does not. */
export async function waitForHttp(url: string, label: string, attempts = 150): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${label} did not become reachable at ${url}.`);
}

/**
 * Waits for an Astro preview process. A process that exits is reported immediately with its log.
 * If the process has already announced that it is listening, polling continues through the known
 * Windows loopback stall. A process that never announces readiness still fails at 30 seconds.
 */
export async function waitForPreview(url: string, child: ChildProcess, log: string[]): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error(`The Astro preview server exited before ${url} answered.\n${log.join("").slice(-2000)}`);
    }
    const text = log.join("");
    const announced = /Local\s+http|ready in/i.test(text);
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* not listening yet */ }
    const limit = announced ? 60_000 : 30_000;
    if (Date.now() - started > limit) {
      throw new Error(`The Astro preview server did not become reachable at ${url} after ${limit}ms (announced=${announced}).\n${text.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
