import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Dependency-advisory triage gate for CI (SDLC-T01). Policy:
//   * Production dependencies (`npm audit --omit=dev`): any advisory of moderate or higher FAILS. No allowlist.
//   * All dependencies: a critical or high advisory FAILS unless `.github/audit-allowlist.json` lists its advisory id
//     with a reason, an owner and an unexpired `expires` date. An expired entry fails again.
//   * Moderate and low advisories in development tooling are reported, never silent.
//   * If the audit cannot run (registry unreachable, unparseable output) the gate FAILS; it never passes by default.
// Nothing here prints package contents, tokens or environment values.

export type Severity = "info" | "low" | "moderate" | "high" | "critical";
const RANK: Record<Severity, number> = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

export interface Advisory {
  id: number;
  severity: Severity;
  pkg: string;
  title: string;
}

export interface AllowEntry {
  id: number;
  package: string;
  severity: Severity;
  reason: string;
  owner: string;
  expires: string;
  remediation: string;
}

export interface AuditResult {
  failures: string[];
  warnings: string[];
  accepted: string[];
}

/** Collects the distinct advisories from `npm audit --json` (v7+ format). Throws if the shape is not an audit report. */
export function extractAdvisories(report: unknown): Advisory[] {
  const r = report as { vulnerabilities?: Record<string, { via?: unknown[] }>; error?: unknown } | null;
  if (!r || typeof r !== "object" || r.error !== undefined || typeof r.vulnerabilities !== "object" || r.vulnerabilities === null) {
    throw new Error("npm audit did not return a vulnerability report");
  }
  const found = new Map<number, Advisory>();
  for (const [name, entry] of Object.entries(r.vulnerabilities)) {
    for (const via of entry.via ?? []) {
      if (!via || typeof via !== "object") continue;
      const v = via as { source?: unknown; severity?: unknown; title?: unknown; name?: unknown };
      if (typeof v.source !== "number" || typeof v.severity !== "string" || !(v.severity in RANK)) continue;
      found.set(v.source, { id: v.source, severity: v.severity as Severity, pkg: typeof v.name === "string" ? v.name : name, title: typeof v.title === "string" ? v.title.slice(0, 90) : "" });
    }
  }
  return [...found.values()].sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.id - b.id);
}

export function parseAllowlist(raw: unknown): AllowEntry[] {
  const entries = (raw as { entries?: unknown[] } | null)?.entries;
  if (!Array.isArray(entries)) throw new Error("allowlist must contain an entries array");
  return entries.map((e, i) => {
    const x = e as Record<string, unknown>;
    const ok = Number.isInteger(x.id) && typeof x.package === "string" && typeof x.severity === "string" && x.severity in RANK && ["reason", "owner", "remediation"].every((k) => typeof x[k] === "string" && (x[k] as string).trim().length >= 8) && typeof x.expires === "string" && !Number.isNaN(Date.parse(x.expires));
    if (!ok) throw new Error(`allowlist entry ${i} is incomplete (needs id, package, severity, reason, owner, remediation, expires)`);
    return x as unknown as AllowEntry;
  });
}

export function evaluateAudit(input: { all: unknown; prod: unknown; allowlist: AllowEntry[]; now: Date }): AuditResult {
  const result: AuditResult = { failures: [], warnings: [], accepted: [] };
  const prod = extractAdvisories(input.prod);
  for (const a of prod) {
    if (RANK[a.severity] >= RANK.moderate) result.failures.push(`production dependency advisory ${a.id} (${a.severity}, ${a.pkg}): production advisories are never allowlisted`);
    else result.warnings.push(`production advisory ${a.id} (${a.severity}, ${a.pkg})`);
  }
  const all = extractAdvisories(input.all);
  const byId = new Map(input.allowlist.map((e) => [e.id, e]));
  const prodIds = new Set(prod.map((a) => a.id));
  for (const a of all) {
    if (prodIds.has(a.id)) continue; // already judged above
    if (RANK[a.severity] >= RANK.high) {
      const entry = byId.get(a.id);
      if (!entry) result.failures.push(`${a.severity} advisory ${a.id} (${a.pkg}) is not triaged: fix it or add a reviewed allowlist entry`);
      else if (Date.parse(entry.expires) < input.now.getTime()) result.failures.push(`allowlist entry for ${a.severity} advisory ${a.id} (${a.pkg}) expired on ${entry.expires}`);
      else result.accepted.push(`${a.severity} advisory ${a.id} (${a.pkg}) accepted until ${entry.expires}; owner ${entry.owner}`);
    } else {
      result.warnings.push(`${a.severity} advisory ${a.id} (${a.pkg}) in development tooling`);
    }
  }
  const current = new Set(all.map((a) => a.id));
  for (const e of input.allowlist) if (!current.has(e.id)) result.warnings.push(`allowlist entry ${e.id} (${e.package}) no longer matches an advisory; remove it`);
  return result;
}

function runAudit(omitDev: boolean): unknown {
  let out: string;
  try {
    // Constant command string: nothing user-controlled reaches the shell.
    out = execSync(omitDev ? "npm audit --json --omit=dev" : "npm audit --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    // `npm audit` exits non-zero when it finds advisories but still prints the report.
    out = (error as { stdout?: string }).stdout ?? "";
  }
  return JSON.parse(out);
}

export function main(allowlistPath = path.resolve(".github/audit-allowlist.json")): number {
  let result: AuditResult;
  try {
    const allowlist = parseAllowlist(JSON.parse(readFileSync(allowlistPath, "utf8")));
    result = evaluateAudit({ all: runAudit(false), prod: runAudit(true), allowlist, now: new Date() });
  } catch (error) {
    console.error(`AUDIT GATE FAILED: audit could not be evaluated (${error instanceof Error ? error.message : "unknown error"}). The gate never passes by default.`);
    return 2;
  }
  for (const line of result.accepted) console.log(`ACCEPTED  ${line}`);
  for (const line of result.warnings) console.log(`WARNING   ${line}`);
  for (const line of result.failures) console.error(`FAILURE   ${line}`);
  console.log(`audit gate: ${result.failures.length} failure(s), ${result.accepted.length} accepted, ${result.warnings.length} warning(s)`);
  return result.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
