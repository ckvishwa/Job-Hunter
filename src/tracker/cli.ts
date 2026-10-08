import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildTrackerRows, rowToCells, TRACKER_COLUMNS } from "./rows.js";
import { buildXlsx } from "./xlsx.js";

// npm run tracker -- --data-dir <dir with jobs.jsonl> --output-dir <pipeline output dir> --out <tracker.xlsx>
//
// Rebuilds the whole workbook from the authoritative stores on every run and replaces the file
// atomically. The workbook is a projection: it is never read back and edits to it are discarded.

export interface TrackerArgs {
  dataDir: string;
  outputDir?: string;
  out?: string;
}

export function parseTrackerArgs(argv: string[]): TrackerArgs {
  const args: TrackerArgs = { dataDir: "data" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--data-dir") args.dataDir = argv[++i] ?? args.dataDir;
    else if (argv[i] === "--output-dir") args.outputDir = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  return args;
}

export function writeTracker(args: { jobsPath: string; outputDir: string; out: string; now?: string }): { rows: number; problems: string[] } {
  const { rows, problems } = buildTrackerRows({ jobsPath: args.jobsPath, outputDir: args.outputDir });
  const bytes = buildXlsx([
    { name: "Tracker", header: [...TRACKER_COLUMNS], rows: rows.map(rowToCells), widths: [24, 36, 10, 11, 48, 20, 11, 14, 20, 24, 60] },
    {
      name: "About",
      header: ["Note"],
      rows: [
        ["This workbook is a generated projection of the job ledger (jobs.jsonl and per-run application records). It is not authoritative."],
        ["Edits here are discarded: the file is rebuilt from the ledger on every run (npm run tracker)."],
        [`Generated: ${args.now ?? new Date().toISOString()}`],
        ...problems.map((p) => [`Warning: ${p}`]),
      ],
      widths: [110],
    },
  ]);
  mkdirSync(path.dirname(args.out), { recursive: true });
  const tmp = `${args.out}.${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, args.out);
  return { rows: rows.length, problems };
}

export async function runTracker(args: TrackerArgs, log: (line: string) => void = console.log): Promise<number> {
  if (!args.out) {
    log("usage: tracker --data-dir <dir> --output-dir <dir> --out <tracker.xlsx>");
    return 2;
  }
  try {
    const result = writeTracker({ jobsPath: path.resolve(args.dataDir, "jobs.jsonl"), outputDir: path.resolve(args.outputDir ?? path.join(args.dataDir, "output")), out: path.resolve(args.out) });
    log(`Tracker written: ${path.resolve(args.out)} (${result.rows} rows${result.problems.length ? `, ${result.problems.length} unreadable files noted in About` : ""})`);
    return 0;
  } catch (error) {
    // Typically EBUSY/EPERM when the workbook is open in Excel; the previous file is left untouched.
    const code = (error as NodeJS.ErrnoException).code;
    log(`Tracker not written: ${error instanceof Error ? error.name : "UnknownError"}${code ? ` (${code})` : ""}`);
    return 1;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runTracker(parseTrackerArgs(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
}
