import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Context } from "./fingerprint.js";
import type { Executors, UnitResult } from "./engine.js";

// Real executors: Vitest (JSON reporter, serialized, one batch per process), pytest for services/ai, and tsc. Output goes to log files under
// private-runtime/test-cache/logs; nothing here interprets results beyond pass/fail/skipped counts.

const require = createRequire(import.meta.url);

export function buildContext(root: string): Context {
  let chromeVersion: string | null = null;
  const chromeDir = "C:/Program Files/Google/Chrome/Application";
  if (existsSync(chromeDir)) chromeVersion = readdirSync(chromeDir).find((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n)) ?? null;
  const policyFile = path.join(root, "config", "test-cache-policy.json");
  const policy = existsSync(policyFile) ? (JSON.parse(readFileSync(policyFile, "utf8")) as { neverCache?: string[] }) : {};
  return {
    root, chromeVersion, nodeVersion: process.version, vitestVersion: (JSON.parse(readFileSync(require.resolve("vitest/package.json"), "utf8")) as { version: string }).version,
    neverCache: (policy.neverCache ?? []).map((p) => new RegExp(p)),
  };
}

function run(cmd: string, args: string[], cwd: string, logFile: string, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  mkdirSync(path.dirname(logFile), { recursive: true });
  return new Promise((resolve) => {
    const out: Buffer[] = [];
    const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => out.push(d));
    p.on("error", () => resolve(null));
    p.on("close", (code) => {
      import("node:fs").then((fs) => fs.writeFileSync(logFile, Buffer.concat(out)));
      resolve(code);
    });
  });
}

interface VitestJson {
  testResults: Array<{ name: string; status: string; message?: string; startTime?: number; endTime?: number; assertionResults: Array<{ fullName: string; status: string }> }>;
}

export function realExecutors(ctx: Context, log: (s: string) => void = () => undefined): Executors {
  const cache = path.join(ctx.root, "private-runtime", "test-cache");
  let batchNo = 0;
  return {
    async vitest(files) {
      batchNo += 1;
      const outFile = path.join(cache, "tmp", `vitest-${process.pid}-${batchNo}.json`);
      rmSync(outFile, { force: true });
      mkdirSync(path.dirname(outFile), { recursive: true });
      const bin = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
      const code = await run(process.execPath, [bin, "run", "--reporter=json", `--outputFile=${outFile}`, "--maxWorkers=1", "--minWorkers=1", "--no-file-parallelism", ...files], ctx.root, path.join(cache, "logs", `vitest-${process.pid}-${batchNo}.log`));
      if (!existsSync(outFile)) { log(`vitest exited ${code} without a result file`); return null; }
      const json = JSON.parse(readFileSync(outFile, "utf8")) as VitestJson;
      if (json.testResults.some((r) => r.status !== "passed")) copyFileSync(outFile, path.join(cache, "logs", `vitest-${process.pid}-${batchNo}.failures.json`)); // keep the evidence
      rmSync(outFile, { force: true });
      const out = new Map<string, UnitResult>();
      for (const r of json.testResults) {
        const unit = path.relative(ctx.root, r.name).split(path.sep).join("/");
        const asserts = r.assertionResults;
        const failedTests = asserts.filter((a) => a.status === "failed").map((a) => a.fullName);
        const skipped = asserts.filter((a) => a.status === "skipped" || a.status === "pending" || a.status === "todo").length;
        const suiteFailed = r.status === "failed" && failedTests.length === 0;
        out.set(unit, { status: r.status === "passed" && !failedTests.length ? "pass" : "fail", tests: asserts.filter((a) => a.status === "passed").length + failedTests.length, failedTests: suiteFailed ? [`(suite failed to run) ${String(r.message ?? "").replace(/\s+/g, " ").slice(0, 400)}`] : failedTests, skipped, durationMs: (r.endTime ?? 0) - (r.startTime ?? 0) });
      }
      for (const f of files) if (!out.has(f)) out.set(f, { status: "fail", tests: 0, failedTests: ["(no result reported for this file)"], skipped: 0, durationMs: 0 });
      return out;
    },
    async python() {
      const py = path.join(ctx.root, "services", "ai", ".venv", process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
      if (!existsSync(py)) return { status: "fail", tests: 0, failedTests: ["services/ai/.venv is missing"], durationMs: 0 } as UnitResult;
      const started = Date.now();
      const logFile = path.join(cache, "logs", `pytest-${process.pid}.log`);
      const code = await run(py, ["-m", "pytest", "-q", "-p", "no:cacheprovider"], path.join(ctx.root, "services", "ai"), logFile);
      const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      const passed = Number(/(\d+) passed/.exec(text)?.[1] ?? 0);
      const failed = Number(/(\d+) failed/.exec(text)?.[1] ?? 0);
      return { status: code === 0 && failed === 0 ? "pass" : "fail", tests: passed + failed, failedTests: failed ? [`${failed} pytest failure(s)`] : [], skipped: Number(/(\d+) skipped/.exec(text)?.[1] ?? 0), durationMs: Date.now() - started };
    },
    async typecheck() {
      const started = Date.now();
      const code = await run(process.execPath, [require.resolve("typescript/bin/tsc"), "--noEmit"], ctx.root, path.join(cache, "logs", `tsc-${process.pid}.log`));
      return { status: code === 0 ? "pass" : "fail", tests: 0, failedTests: code === 0 ? [] : ["tsc reported errors"], skipped: 0, durationMs: Date.now() - started };
    },
  };
}
