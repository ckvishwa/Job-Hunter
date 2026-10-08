import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { boardListSchema, type BoardList } from "./board-discoverer.js";

// Maps the candidate's hand-written company list (named tracks with priorities, boardToken, notes)
// onto the real board-list schema. The schema is not bent to fit the candidate's file; fields the
// schema has no home for are dropped and reported, never silently kept.

const candidateFileSchema = z
  .object({
    titleMatching: z
      .object({
        tracks: z.record(z.string(), z.object({ priority: z.number(), keywords: z.array(z.string()).min(1) }).passthrough()),
        excludeTitleKeywords: z.array(z.string()).optional(),
      })
      .passthrough(),
    companies: z.array(z.object({ company: z.string(), ats: z.enum(["greenhouse", "lever"]), boardToken: z.string() }).passthrough()).min(1),
  })
  .passthrough();

export interface ImportedBoardList {
  list: BoardList;
  /** Source fields that have no place in the board-list schema (reported, not carried over). */
  dropped: string[];
}

export function convertCandidateBoardList(input: unknown): ImportedBoardList {
  const parsed = candidateFileSchema.parse(input);
  const dropped = new Set<string>();
  for (const key of Object.keys(parsed)) if (!["titleMatching", "companies"].includes(key)) dropped.add(key);
  for (const key of Object.keys(parsed.titleMatching)) if (!["tracks", "excludeTitleKeywords"].includes(key)) dropped.add(`titleMatching.${key}`);
  const tracks = Object.entries(parsed.titleMatching.tracks)
    .sort(([, a], [, b]) => a.priority - b.priority)
    .map(([name, track]) => {
      for (const key of Object.keys(track)) if (!["priority", "keywords"].includes(key)) dropped.add(`tracks.${key}`);
      return { name, keywords: track.keywords };
    });
  const companies = parsed.companies.map((c) => {
    for (const key of Object.keys(c)) if (!["company", "ats", "boardToken"].includes(key)) dropped.add(`companies[].${key}`);
    return { company: c.company, ats: c.ats, board: c.boardToken };
  });
  const list = boardListSchema.parse({
    version: 1,
    tracks,
    ...(parsed.titleMatching.excludeTitleKeywords ? { excludeTitleKeywords: parsed.titleMatching.excludeTitleKeywords } : {}),
    companies,
  });
  return { list, dropped: [...dropped].sort() };
}

// npm run boards:import -- --in company-boards.json --out config/company-boards.json
export function runBoardImport(args: { in?: string; out?: string }, log: (line: string) => void = console.log): number {
  if (!args.in || !args.out) {
    log("usage: boards:import --in <candidate list.json> --out <config/company-boards.json>");
    return 2;
  }
  try {
    const { list, dropped } = convertCandidateBoardList(JSON.parse(readFileSync(path.resolve(args.in), "utf8")));
    writeFileSync(path.resolve(args.out), `${JSON.stringify(list, null, 2)}\n`, "utf8");
    log(`Wrote ${path.resolve(args.out)}: ${list.companies.length} companies, tracks ${list.tracks!.map((t) => `${t.name}(${t.keywords.length})`).join(" > ")}, ${list.excludeTitleKeywords?.length ?? 0} exclusions.`);
    if (dropped.length) log(`Not mapped (no schema field): ${dropped.join(", ")}`);
    return 0;
  } catch (error) {
    log(`Import failed: ${error instanceof Error ? error.name : "UnknownError"}: ${error instanceof Error ? error.message.slice(0, 300) : ""}`);
    return 2;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const argv = process.argv.slice(2);
  const arg = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  process.exitCode = runBoardImport({ in: arg("--in"), out: arg("--out") });
}
