import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRunEventLog, type RunEventLog } from "../../events/run-events.js";
import { runBoardDiscovery } from "./board-discoverer.js";

// npm run boards:discover -- --config config/company-boards.json --data-dir data [--max-per-company N]
//
// Reads the candidate's company list, calls each company's public Greenhouse/Lever board API once,
// keeps title-matching postings that pass the official-board and full-JD gates, and merges them into
// <data-dir>/jobs.jsonl. No browser, no LinkedIn. Exit code: 0 = every board read, 1 = at least one
// board failed (others are still saved), 2 = usage / configuration error.

export interface BoardsArgs {
  config?: string;
  dataDir: string;
  maxPerCompany?: number;
}

export function parseBoardsArgs(argv: string[]): BoardsArgs {
  const args: BoardsArgs = { dataDir: "data" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config") args.config = argv[++i];
    else if (argv[i] === "--data-dir") args.dataDir = argv[++i] ?? args.dataDir;
    else if (argv[i] === "--max-per-company") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error("--max-per-company must be a positive integer");
      args.maxPerCompany = n;
    }
  }
  return args;
}

export async function runBoardsCli(args: BoardsArgs, log: (line: string) => void = console.log, events?: RunEventLog): Promise<number> {
  if (!args.config) {
    log("usage: boards:discover --config <company-boards.json> --data-dir <dir> [--max-per-company N]");
    return 2;
  }
  try {
    const result = await runBoardDiscovery({ configPath: path.resolve(args.config), dataDir: path.resolve(args.dataDir), maxPerCompany: args.maxPerCompany, log, events });
    const t = result.totals;
    log(`Boards run ${result.runId}: fetched=${t.fetched} matched=${t.matched} saved=${t.saved} unchanged=${t.unchanged} rejected=${t.rejected} failedCompanies=${t.failedCompanies}`);
    return t.failedCompanies > 0 ? 1 : 0;
  } catch (error) {
    log(`Boards discovery not run: ${error instanceof Error ? error.name : "UnknownError"}: ${error instanceof Error ? error.message.slice(0, 300) : ""}`);
    return 2;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  let args: BoardsArgs;
  try {
    args = parseBoardsArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid arguments");
    process.exit(2);
  }
  runBoardsCli(args, console.log, createRunEventLog("boards")).then((code) => {
    process.exitCode = code;
  });
}
