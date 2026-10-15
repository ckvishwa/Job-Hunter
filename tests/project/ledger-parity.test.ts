import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { governance, nextTask, parseLedger, phaseStates } from "../../src/project/ledger.js";
import { synthLedger } from "../helpers/project-fixtures.js";

// Golden parity: the TypeScript port must agree with scripts/sync_progress.py (the authority) on the synthetic ledger AND on the
// real docs/PROGRESS_LEDGER.json: phase states, the next task and every evidence error.

const script = path.resolve("scripts", "sync_progress.py");
const PY = [
  "import importlib.util, json, sys",
  "spec = importlib.util.spec_from_file_location('sp', sys.argv[1]); sp = importlib.util.module_from_spec(spec); spec.loader.exec_module(sp)",
  "d = json.load(open(sys.argv[2], encoding='utf-8'))",
  "idx = {p['id']: p for p in d['phases']}; cache = {}",
  "states = {p['id']: sp.state(p, idx, cache) for p in d['phases']}",
  "errors = [e for e in sp.validate(d) if not e.startswith('PRD SHA256') and e != 'Missing docs/PRD.md']",
  "print(json.dumps({'states': states, 'next': sp.next_task(d), 'errors': sorted(errors)}))",
].join("\n");

function findPython(): string | null {
  for (const cmd of ["python", "python3", "py"]) {
    const r = spawnSync(cmd, ["-c", "print(1)"], { encoding: "utf8" });
    if (r.status === 0) return cmd;
  }
  return null;
}
const py = findPython();
const suite = py ? describe : describe.skip;

function viaPython(file: string) {
  const r = spawnSync(py!, ["-c", PY, script, file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as { states: Record<string, string>; next: unknown; errors: string[] };
}

function viaTs(raw: unknown) {
  const ledger = parseLedger(raw);
  const states = phaseStates(ledger);
  const gov = governance(ledger, ledger.prd_sha256);
  return { states: Object.fromEntries(states), next: nextTask(ledger, states), errors: [...gov.ledgerErrors, ...[...gov.taskErrors.values()].flat()].sort() };
}

suite("TypeScript ledger port vs scripts/sync_progress.py", () => {
  it("agrees on the synthetic ledger", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jh-parity-"));
    try {
      const file = path.join(dir, "ledger.json");
      const raw = synthLedger("x");
      writeFileSync(file, JSON.stringify(raw));
      expect(viaTs(raw)).toEqual(viaPython(file));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("agrees on the real project ledger", () => {
    const file = path.resolve("docs", "PROGRESS_LEDGER.json");
    expect(viaTs(JSON.parse(readFileSync(file, "utf8")))).toEqual(viaPython(file));
  });
});
