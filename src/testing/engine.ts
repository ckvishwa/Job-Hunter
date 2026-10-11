import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closureHashes, discoverTests, explainChange, fingerprintTest, resetFileHashCache, treeFingerprint, unitFingerprint, type Context, type Fingerprint } from "./fingerprint.js";

// Smart test engine. Receipts and checkpoints live in private-runtime/test-cache/ (git-ignored). Rules it never breaks:
//   * a receipt is reused only when its fingerprint equals the current one AND it passed AND the unit is not uncertain / never-cache
//   * a failed run overwrites the unit's receipt with a failure, so an older green result can never come back
//   * a unit with no completed receipt (interrupted, crashed, corrupt) is rerun whole; partial integration state is never reused
//   * reports separate "executed now" from "reused" and never present reused results as a fresh run

export const RECEIPT_SCHEMA = "orbital-test-receipt/1";
export const CHECKPOINT_SCHEMA = "orbital-test-run/1";
export const GATE_SCHEMA = "orbital-test-gate/1";

export type UnitKind = "vitest" | "python" | "typecheck";
export type Mode = "changed" | "failed" | "full";

export interface UnitRef { id: string; kind: UnitKind }
export interface UnitResult { status: "pass" | "fail"; tests: number; failedTests: string[]; durationMs: number; skipped?: number }

export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  unit: string;
  kind: UnitKind;
  hash: string;
  components: Record<string, string>;
  closureFiles: Record<string, string>;
  uncertain: string | null;
  status: "pass" | "fail";
  tests: number;
  failedTests: string[];
  skipped: number;
  durationMs: number;
  runId: string;
  mode: Mode;
  ranAt: string;
  selfHash: string;
}

export interface Checkpoint {
  schema: typeof CHECKPOINT_SCHEMA;
  runId: string;
  mode: Mode;
  startedAt: string;
  updatedAt: string;
  status: "running" | "complete" | "failed";
  planned: string[];
  doneUnits: string[];
  treeFingerprint: string;
  selfHash: string;
}

export interface Executors {
  vitest(files: string[]): Promise<Map<string, UnitResult> | null>;
  python(): Promise<UnitResult | null>;
  typecheck(): Promise<UnitResult | null>;
}

export interface EngineOptions {
  ctx: Context;
  executors: Executors;
  batchSize?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const withHash = <T extends { selfHash: string }>(body: Omit<T, "selfHash">): T => ({ ...body, selfHash: sha(JSON.stringify(body)) }) as T;
const verifies = (o: { selfHash: string } & Record<string, unknown>): boolean => {
  const { selfHash, ...rest } = o;
  return sha(JSON.stringify(rest)) === selfHash;
};

export interface UnitState {
  unit: UnitRef;
  fingerprint: { hash: string; components: Record<string, string>; closure: string[]; uncertain: string | null };
  receipt: Receipt | null;
  corrupt: boolean;
  /** reusable = verified pass with an identical fingerprint */
  reusable: boolean;
  reasons: string[];
}

export interface Summary {
  mode: Mode | "status";
  runId: string | null;
  executedNow: { units: number; tests: number; files: string[] };
  reused: { units: number; tests: number };
  invalidated: Array<{ unit: string; reasons: string[] }>;
  failed: Array<{ unit: string; tests: string[] }>;
  skipped: string[];
  pending: string[];
  durationMs: number;
  fullGate: GateStatus;
}

export type GateStatus = { state: "PASS_CURRENT" | "PASS_STALE" | "FAILED" | "NONE"; detail: string; finishedAt?: string; runId?: string; tests?: number; units?: number };

export class TestEngine {
  readonly cacheDir: string;
  constructor(private readonly o: EngineOptions) {
    this.cacheDir = path.join(o.ctx.root, "private-runtime", "test-cache");
  }
  private now(): Date { return (this.o.now ?? (() => new Date()))(); }
  private log(line: string): void { (this.o.log ?? (() => undefined))(line); }
  private receiptFile(unit: string): string { return path.join(this.cacheDir, "receipts", `${sha(unit).slice(0, 24)}.json`); }
  private get checkpointFile(): string { return path.join(this.cacheDir, "current-run.json"); }
  private get gateFile(): string { return path.join(this.cacheDir, "full-gate.json"); }

  private writeAtomic(file: string, body: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(body, null, 2));
    renameSync(tmp, file);
  }
  private readVerified<T extends { selfHash: string; schema: string }>(file: string, schema: string): { value: T | null; corrupt: boolean } {
    if (!existsSync(file)) return { value: null, corrupt: false };
    try {
      const v = JSON.parse(readFileSync(file, "utf8")) as T;
      return v.schema === schema && verifies(v as never) ? { value: v, corrupt: false } : { value: null, corrupt: true };
    } catch {
      return { value: null, corrupt: true };
    }
  }

  // ---- units ----------------------------------------------------------------------------------------------------------------------------

  units(): Array<{ ref: UnitRef; fp: () => { hash: string; components: Record<string, string>; closure: string[]; uncertain: string | null } }> {
    const { ctx } = this.o;
    resetFileHashCache();
    const tests = discoverTests(ctx.root).map((abs) => {
      const f: Fingerprint = fingerprintTest(ctx, abs);
      return { ref: { id: f.unit, kind: "vitest" as const }, fp: () => ({ hash: f.hash, components: f.components, closure: f.closure, uncertain: f.uncertain }) };
    });
    const py = unitFingerprint(ctx.root, "python", ["services/ai"], (n) => /\.(?:py|txt|json|ini)$/.test(n), [], ["python-tests"]);
    const tc = unitFingerprint(ctx.root, "typecheck", ["src", "tests"], (n) => n.endsWith(".ts"), ["tsconfig.json", "package-lock.json", "package.json"], [`node ${ctx.nodeVersion}`]);
    return [
      ...tests,
      { ref: { id: "python:services/ai", kind: "python" }, fp: () => ({ ...py, closure: [], uncertain: null }) },
      { ref: { id: "typecheck:tsc", kind: "typecheck" }, fp: () => ({ ...tc, closure: [], uncertain: null }) },
    ];
  }

  states(): UnitState[] {
    return this.units().map(({ ref, fp }) => {
      const fingerprint = fp();
      const { value: receipt, corrupt } = this.readVerified<Receipt>(this.receiptFile(ref.id), RECEIPT_SCHEMA);
      const reasons: string[] = [];
      let reusable = false;
      if (corrupt) reasons.push("receipt corrupt: ignored");
      else if (!receipt) reasons.push("no receipt");
      else if (receipt.status !== "pass") reasons.push("last run failed");
      else if (receipt.skipped > 0) reasons.push(`not reusable: ${receipt.skipped} skipped test(s) (environment-dependent)`);
      else if (fingerprint.uncertain) reasons.push(`not reusable: ${fingerprint.uncertain}`);
      else if (receipt.hash !== fingerprint.hash) reasons.push(...explainChange(receipt, { ...fingerprint, unit: ref.id } as Fingerprint, this.o.ctx.root));
      else reusable = true;
      return { unit: ref, fingerprint, receipt, corrupt, reusable, reasons };
    });
  }

  gateStatus(): GateStatus {
    const { value, corrupt } = this.readVerified<{ schema: string; selfHash: string; treeFingerprint: string; finishedAt: string; runId: string; tests: number; units: number; status: "pass" | "fail" }>(this.gateFile, GATE_SCHEMA);
    if (corrupt) return { state: "NONE", detail: "gate record corrupt: ignored" };
    if (!value) return { state: "NONE", detail: "no full regression gate has been run" };
    if (value.status === "fail") return { state: "FAILED", detail: "the last full run failed", finishedAt: value.finishedAt, runId: value.runId };
    const current = treeFingerprint(this.o.ctx);
    return current === value.treeFingerprint
      ? { state: "PASS_CURRENT", detail: "the tree is byte-identical to the one the uncached full run passed on", finishedAt: value.finishedAt, runId: value.runId, tests: value.tests, units: value.units }
      : { state: "PASS_STALE", detail: "files changed since the last passing full run; run test:full again before release", finishedAt: value.finishedAt, runId: value.runId, tests: value.tests, units: value.units };
  }

  // ---- running --------------------------------------------------------------------------------------------------------------------------

  /** `resumeRun`: continue an interrupted lineage. Units finished in THAT run (same runId, same fingerprint) are valid; everything else is rerun. */
  async run(mode: Mode, resumeRun: Checkpoint | null = null): Promise<Summary> {
    const started = Date.now();
    const states = this.states();
    const runId = resumeRun?.runId ?? `run-${this.now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(2).toString("hex")}`;
    const lineageFull = mode === "full";
    const validForLineage = (s: UnitState): boolean => (lineageFull ? s.reusable && s.receipt?.runId === runId : s.reusable);
    let toRun: UnitState[];
    if (mode === "failed") toRun = states.filter((s) => s.receipt?.status === "fail" && !(resumeRun && validForLineage(s)));
    else toRun = states.filter((s) => !validForLineage(s));
    const reused = mode === "failed" ? [] : states.filter((s) => !toRun.includes(s) && s.reusable);
    const skipped = mode === "failed" ? states.filter((s) => !toRun.includes(s)).map((s) => s.unit.id) : [];
    const checkpoint = (status: Checkpoint["status"], done: string[]): void =>
      this.writeAtomic(this.checkpointFile, withHash<Checkpoint>({ schema: CHECKPOINT_SCHEMA, runId, mode, startedAt: resumeRun?.startedAt ?? this.now().toISOString(), updatedAt: this.now().toISOString(), status, planned: toRun.map((s) => s.unit.id), doneUnits: done, treeFingerprint: treeFingerprint(this.o.ctx) }));
    const done: string[] = [];
    const executed: Array<{ id: string; result: UnitResult }> = [];
    const pending = new Set(toRun.map((s) => s.unit.id));
    checkpoint("running", done);

    const record = (s: UnitState, r: UnitResult): void => {
      const receipt = withHash<Receipt>({
        schema: RECEIPT_SCHEMA, unit: s.unit.id, kind: s.unit.kind, hash: s.fingerprint.hash, components: s.fingerprint.components,
        closureFiles: closureHashes(this.o.ctx.root, s.fingerprint.closure), uncertain: s.fingerprint.uncertain, status: r.status, tests: r.tests, failedTests: r.failedTests, skipped: r.skipped ?? 0,
        durationMs: r.durationMs, runId, mode, ranAt: this.now().toISOString(),
      });
      this.writeAtomic(this.receiptFile(s.unit.id), receipt);
      executed.push({ id: s.unit.id, result: r });
      done.push(s.unit.id);
      pending.delete(s.unit.id);
    };

    const vitestUnits = toRun.filter((s) => s.unit.kind === "vitest");
    const size = this.o.batchSize ?? 12;
    for (let i = 0; i < vitestUnits.length; i += size) {
      const batch = vitestUnits.slice(i, i + size);
      this.log(`batch ${Math.floor(i / size) + 1}/${Math.ceil(vitestUnits.length / size)}: ${batch.length} file(s)`);
      const results = await this.o.executors.vitest(batch.map((b) => b.unit.id));
      if (!results) { this.log("batch produced no result (crashed or interrupted); its files stay pending"); break; }
      for (const s of batch) {
        const r = results.get(s.unit.id);
        if (r) record(s, r);
      }
      checkpoint("running", done);
    }
    for (const kind of ["python", "typecheck"] as const) {
      const s = toRun.find((x) => x.unit.kind === kind);
      if (!s) continue;
      const r = await (kind === "python" ? this.o.executors.python() : this.o.executors.typecheck());
      if (r) record(s, r);
      checkpoint("running", done);
    }

    const failed = executed.filter((e) => e.result.status === "fail").map((e) => ({ unit: e.id, tests: e.result.failedTests }));
    const complete = pending.size === 0;
    checkpoint(!complete ? "running" : failed.length ? "failed" : "complete", done);

    if (lineageFull && complete) {
      // The full gate counts only when EVERY unit holds a passing receipt of this very run lineage on the current tree.
      const after = this.states();
      const all = after.every((s) => s.receipt?.runId === runId && s.receipt.status === "pass" && s.receipt.hash === s.fingerprint.hash);
      const tests = after.reduce((n, s) => n + (s.receipt?.tests ?? 0), 0);
      this.writeAtomic(this.gateFile, withHash({ schema: GATE_SCHEMA, status: all && !failed.length ? "pass" : "fail", runId, finishedAt: this.now().toISOString(), treeFingerprint: treeFingerprint(this.o.ctx), tests, units: after.length } as never));
    }

    const stale = states.filter((s) => !s.reusable && s.receipt && s.receipt.status === "pass").map((s) => ({ unit: s.unit.id, reasons: s.reasons }));
    return {
      mode, runId,
      executedNow: { units: executed.length, tests: executed.reduce((n, e) => n + e.result.tests, 0), files: executed.map((e) => e.id) },
      reused: { units: reused.length, tests: reused.reduce((n, s) => n + (s.receipt?.tests ?? 0), 0) },
      invalidated: stale, failed, skipped, pending: [...pending], durationMs: Date.now() - started, fullGate: this.gateStatus(),
    };
  }

  /** Continue the interrupted run, if any. Returns null when there is nothing to resume. */
  async resume(): Promise<Summary | null> {
    const { value: cp, corrupt } = this.readVerified<Checkpoint>(this.checkpointFile, CHECKPOINT_SCHEMA);
    if (corrupt) this.log("checkpoint corrupt: ignored; use test:changed to rebuild from receipts");
    if (!cp || cp.status !== "running") return null;
    this.log(`resuming ${cp.runId} (${cp.mode}); completed units are revalidated against current fingerprints`);
    return this.run(cp.mode, cp);
  }

  status(): { counts: { units: number; reusable: number; stale: number; failed: number; missing: number; uncertain: number }; stale: Array<{ unit: string; reasons: string[] }>; failed: Array<{ unit: string; tests: string[] }>; interrupted: Checkpoint | null; fullGate: GateStatus } {
    const states = this.states();
    const { value: cp } = this.readVerified<Checkpoint>(this.checkpointFile, CHECKPOINT_SCHEMA);
    return {
      counts: {
        units: states.length, reusable: states.filter((s) => s.reusable).length, failed: states.filter((s) => s.receipt?.status === "fail").length,
        missing: states.filter((s) => !s.receipt).length, uncertain: states.filter((s) => s.fingerprint.uncertain).length,
        stale: states.filter((s) => s.receipt?.status === "pass" && !s.reusable).length,
      },
      stale: states.filter((s) => s.receipt?.status === "pass" && !s.reusable).map((s) => ({ unit: s.unit.id, reasons: s.reasons })),
      failed: states.filter((s) => s.receipt?.status === "fail").map((s) => ({ unit: s.unit.id, tests: s.receipt!.failedTests })),
      interrupted: cp && cp.status === "running" ? cp : null, fullGate: this.gateStatus(),
    };
  }
}

export const listReceiptFiles = (root: string): string[] => {
  const dir = path.join(root, "private-runtime", "test-cache", "receipts");
  return existsSync(dir) ? readdirSync(dir).map((f) => path.join(dir, f)) : [];
};
