import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { TestEngine, type Summary } from "./engine.js";
import { buildContext, realExecutors } from "./exec.js";

// npm run test:changed | test:failed | test:resume | test:status | test:full      (see CLAUDE.md "Testing policy")
const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { json: { type: "boolean", default: false }, batch: { type: "string", default: "12" } } });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ctx = buildContext(root);
const engine = new TestEngine({ ctx, executors: realExecutors(ctx, (s) => console.error(`  ${s}`)), batchSize: Number(values.batch), log: (s) => console.error(`  ${s}`) });

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
function print(s: Summary): number {
  if (values.json) { console.log(JSON.stringify(s, null, 2)); return s.failed.length ? 1 : s.pending.length ? 3 : 0; }
  console.log(`\ntest:${s.mode}  ${s.runId ?? ""}  (${secs(s.durationMs)} wall)`);
  console.log(`  executed NOW : ${s.executedNow.units} unit(s), ${s.executedNow.tests} test(s)${s.executedNow.files.length ? `  [${s.executedNow.files.slice(0, 8).join(", ")}${s.executedNow.files.length > 8 ? ", ..." : ""}]` : ""}`);
  console.log(`  REUSED       : ${s.reused.units} unit(s), ${s.reused.tests} test(s) from verified receipts (identical fingerprint, passed; NOT executed in this run)`);
  console.log(`  invalidated  : ${s.invalidated.length}${s.invalidated.slice(0, 6).map((i) => `\n      ${i.unit}: ${i.reasons.slice(0, 4).join("; ")}`).join("")}`);
  console.log(`  FAILED       : ${s.failed.length}${s.failed.map((f) => `\n      ${f.unit}: ${f.tests.slice(0, 3).join(" | ")}`).join("")}`);
  console.log(`  skipped      : ${s.skipped.length}   pending: ${s.pending.length}${s.pending.slice(0, 6).map((p) => `\n      ${p}`).join("")}`);
  console.log(`  selection    : ${s.selectionReason}`);
  console.log(`  full regression gate: ${s.fullGate.state}. ${s.fullGate.detail}${s.fullGate.tests !== undefined ? ` (${s.fullGate.tests} tests, ${s.fullGate.units} units, run ${s.fullGate.runId}, ${s.fullGate.finishedAt})` : ""}`);
  return s.failed.length ? 1 : s.pending.length ? 3 : 0;
}

async function main(): Promise<number> {
  switch (command) {
    case "changed": return print(await engine.run("changed"));
    case "failed": return print(await engine.run("failed"));
    case "full": return print(await engine.run("full"));
    case "resume": {
      const s = await engine.resume();
      if (!s) { console.log("Nothing to resume: no interrupted run. Use test:changed."); return 0; }
      return print(s);
    }
    case "status": {
      const st = engine.status();
      if (values.json) { console.log(JSON.stringify(st, null, 2)); return 0; }
      console.log(`units ${st.counts.units}: reusable ${st.counts.reusable}, stale ${st.counts.stale}, failed ${st.counts.failed}, no receipt ${st.counts.missing}, never reusable (uncertain/skipped) ${st.counts.uncertain}`);
      for (const s of st.stale.slice(0, 15)) console.log(`  stale  ${s.unit}: ${s.reasons.slice(0, 3).join("; ")}`);
      for (const f of st.failed) console.log(`  FAILED ${f.unit}: ${f.tests.slice(0, 3).join(" | ")}`);
      if (st.interrupted) console.log(`  interrupted run ${st.interrupted.runId} (${st.interrupted.mode}): ${st.interrupted.planned.length - st.interrupted.doneUnits.length} unit(s) left; run test:resume`);
      console.log(`full regression gate: ${st.fullGate.state}. ${st.fullGate.detail}`);
      return 0;
    }
    default:
      console.error("usage: test:changed | test:failed | test:resume | test:status | test:full   [--json] [--batch N]");
      return 2;
  }
}

process.exitCode = await main();
