import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { boardApiUrl, boardListSchema, type BoardCompany } from "./board-discoverer.js";

// Live check of every board token against the public Greenhouse/Lever API before discovery runs.
// A token that returns jobs may still belong to a different organization, so Greenhouse boards are
// also checked against the board's own published name. Lever has no name endpoint: a Lever token is
// reported as reachable, never as identity-confirmed.

export type VerifyStatus = "OK" | "NAME_MISMATCH" | "NOT_FOUND" | "ERROR";

export interface BoardCandidate {
  ats: "greenhouse" | "lever";
  board: string;
  jobs: number;
  boardName: string | null;
  nameMatches: boolean | null;
}

export interface BoardVerification {
  company: string;
  ats: "greenhouse" | "lever";
  board: string;
  status: VerifyStatus;
  jobs: number | null;
  boardName: string | null;
  detail: string;
  /** A different token that answered and (for Greenhouse) carries the company's name. Not applied automatically. */
  correction?: BoardCandidate;
  /** The same token answered on the other ATS. Reported only: the employer's real ATS is not guessed. */
  otherAts?: BoardCandidate;
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
const STOP = new Set(["inc", "llc", "ltd", "corp", "corporation", "company", "co", "technologies", "technology", "systems", "networks", "labs", "the"]);

/** Loose organisation-name match: one normalized name contains the other, or their leading words agree. */
export function namesMatch(company: string, boardName: string): boolean {
  const a = norm(company);
  const b = norm(boardName);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const lead = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w))[0] ?? "";
  return lead(company) !== "" && lead(company) === lead(boardName);
}

export function candidateTokens(company: string, original: string): string[] {
  const words = company.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const joined = words.join("");
  const base = new Set([joined, words.join("-"), words[0] ?? ""].filter(Boolean));
  const out = new Set<string>();
  for (const b of base) {
    out.add(b);
    for (const suffix of ["inc", "corp", "corporation", "hq", "labs", "security", "io", "co", "company"]) out.add(`${b}${suffix}`);
  }
  out.delete(original.toLowerCase());
  return [...out].filter((t) => /^[a-z0-9._-]{2,64}$/.test(t));
}

async function getJson(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<{ status: number; json: unknown } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    const text = await response.text();
    try {
      return { status: response.status, json: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, json: null };
    }
  } catch (error) {
    return { error: controller.signal.aborted ? "timeout" : error instanceof Error ? error.name : "UnknownError" };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(company: string, ats: "greenhouse" | "lever", board: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<BoardCandidate | "NOT_FOUND" | "ERROR"> {
  const entry: BoardCompany = { company, ats, board };
  const jobsResponse = await getJson(boardApiUrl(entry), fetchImpl, timeoutMs);
  if ("error" in jobsResponse) return "ERROR";
  if (jobsResponse.status === 404) return "NOT_FOUND";
  if (jobsResponse.status !== 200) return "ERROR";
  const json = jobsResponse.json as { jobs?: unknown[] } | unknown[] | null;
  const jobs = ats === "greenhouse" ? (json && !Array.isArray(json) && Array.isArray(json.jobs) ? json.jobs.length : null) : Array.isArray(json) ? json.length : null;
  if (jobs === null) return "ERROR";
  if (ats === "lever") return { ats, board, jobs, boardName: null, nameMatches: null };
  const nameResponse = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}`, fetchImpl, timeoutMs);
  const boardName = !("error" in nameResponse) && nameResponse.status === 200 && nameResponse.json && typeof (nameResponse.json as { name?: unknown }).name === "string" ? (nameResponse.json as { name: string }).name : null;
  return { ats, board, jobs, boardName, nameMatches: boardName === null ? null : namesMatch(company, boardName) };
}

export async function verifyBoards(
  companies: BoardCompany[],
  options: { fetchImpl?: typeof fetch; delayMs?: number; timeoutMs?: number; log?: (line: string) => void } = {},
): Promise<BoardVerification[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, options.delayMs ?? 400));
  const results: BoardVerification[] = [];
  for (const c of companies) {
    const first = await probe(c.company, c.ats, c.board, fetchImpl, timeoutMs);
    let result: BoardVerification;
    if (typeof first !== "string") {
      const mismatch = first.nameMatches === false;
      result = {
        company: c.company, ats: c.ats, board: c.board,
        status: mismatch ? "NAME_MISMATCH" : "OK", jobs: first.jobs, boardName: first.boardName,
        detail: mismatch ? `Board answers but is named "${first.boardName}", not "${c.company}"; not used.` : c.ats === "lever" ? "Reachable (Lever publishes no board name; identity not confirmed)." : `Board named "${first.boardName ?? "(unnamed)"}".`,
      };
    } else {
      result = { company: c.company, ats: c.ats, board: c.board, status: first, jobs: null, boardName: null, detail: first === "NOT_FOUND" ? "Token not found (HTTP 404)." : "Board request failed or returned an unexpected response." };
    }
    if (result.status !== "OK") {
      if (first !== "ERROR") {
        // Try other tokens on the same ATS, then the same token on the other ATS.
        for (const token of candidateTokens(c.company, c.board)) {
          await pause();
          const candidate = await probe(c.company, c.ats, token, fetchImpl, timeoutMs);
          if (typeof candidate !== "string" && candidate.jobs >= 0 && (c.ats === "lever" ? true : candidate.nameMatches === true)) {
            result.correction = candidate;
            break;
          }
        }
      }
      await pause();
      const other = await probe(c.company, c.ats === "greenhouse" ? "lever" : "greenhouse", c.board, fetchImpl, timeoutMs);
      if (typeof other !== "string" && (other.ats === "lever" || other.nameMatches === true)) result.otherAts = other;
    }
    results.push(result);
    options.log?.(`[verify] ${c.company} ${c.ats}:${c.board} ${result.status}${result.jobs !== null ? ` jobs=${result.jobs}` : ""}${result.correction ? ` -> ${result.correction.board} (${result.correction.jobs} jobs, "${result.correction.boardName ?? "?"}")` : ""}`);
    await pause();
  }
  return results;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const argv = process.argv.slice(2);
  const config = argv.includes("--config") ? argv[argv.indexOf("--config") + 1] : undefined;
  if (!config) {
    console.log("usage: boards:verify --config <config/company-boards.json>");
    process.exitCode = 2;
  } else {
    const list = boardListSchema.parse(JSON.parse(readFileSync(path.resolve(config), "utf8")));
    verifyBoards(list.companies, { log: console.log }).then((results) => {
      console.log(JSON.stringify(results, null, 2));
      process.exitCode = results.every((r) => r.status === "OK") ? 0 : 1;
    });
  }
}
