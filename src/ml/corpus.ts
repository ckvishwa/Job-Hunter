import { fetchBoardPostings, type BoardCompany } from "../pipeline/discovery/board-discoverer.js";
import { textSha } from "../match/embedding-cache.js";
import type { CorpusInput } from "./repo.js";

// Reads the OFFICIAL Greenhouse/Lever board APIs of the owner's configured employers (plain GETs, polite delay, same reader as S3 discovery)
// and returns postings for the private ML corpus. A corpus posting is raw material for review, not a positive example and not a job match.

export const MIN_JD_CHARS = 200;

export interface SnapshotBoardResult { boardKey: string; status: "OK" | "FAILED"; fetched: number; kept: number; skippedShort: number; detail?: string }

const safeId = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");

export async function snapshotBoards(
  companies: readonly BoardCompany[],
  opts: { fetchImpl?: typeof fetch; delayMs?: number; sleep?: (ms: number) => Promise<void>; onBoard?: (r: SnapshotBoardResult) => void } = {},
): Promise<{ rows: CorpusInput[]; boards: SnapshotBoardResult[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rows: CorpusInput[] = [];
  const boards: SnapshotBoardResult[] = [];
  for (const [i, company] of companies.entries()) {
    const boardKey = `${company.ats}:${company.board}`;
    let result: SnapshotBoardResult;
    try {
      const postings = await fetchBoardPostings(company, fetchImpl);
      let kept = 0, skippedShort = 0;
      for (const p of postings) {
        const description = p.descriptionText.trim();
        if (description.length < MIN_JD_CHARS || !/^https:\/\//.test(p.url)) { skippedShort++; continue; }
        rows.push({
          sourceKey: `${boardKey}:${safeId(p.externalId)}`, company: company.company, ats: company.ats, board: company.board, requisitionId: safeId(p.externalId),
          title: p.title.trim(), location: p.location, department: p.department, sourceUrl: p.url, description, textSha256: textSha(`${p.title.trim()}\n${description}`),
        });
        kept++;
      }
      result = { boardKey, status: "OK", fetched: postings.length, kept, skippedShort };
    } catch (e) {
      result = { boardKey, status: "FAILED", fetched: 0, kept: 0, skippedShort: 0, detail: e instanceof Error ? e.message.slice(0, 160) : "unknown" };
    }
    boards.push(result);
    opts.onBoard?.(result);
    if (i < companies.length - 1 && (opts.delayMs ?? 0) > 0) await sleep(opts.delayMs!);
  }
  return { rows, boards };
}
