import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDashboardServer, listenLoopback } from "./server.js";

// npm run dashboard -- [--data-dir data] [--output-dir private-runtime/job-specific] [--boards config/company-boards.json] [--events private-runtime/run-events.jsonl] [--port 4317]
// Read-only local dashboard on 127.0.0.1. Reads the same stores as the tracker; never writes to them.

export interface DashboardArgs {
  dataDir: string;
  outputDir: string;
  boardsPath?: string;
  eventsPath?: string;
  port: number;
}

export function parseDashboardArgs(argv: string[]): DashboardArgs {
  const args: DashboardArgs = { dataDir: "data", outputDir: "private-runtime/job-specific", port: 4317 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--data-dir") args.dataDir = argv[++i] ?? args.dataDir;
    else if (argv[i] === "--output-dir") args.outputDir = argv[++i] ?? args.outputDir;
    else if (argv[i] === "--boards") args.boardsPath = argv[++i];
    else if (argv[i] === "--events") args.eventsPath = argv[++i];
    else if (argv[i] === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error("--port must be an integer 0-65535");
      args.port = n;
    }
  }
  if (!args.boardsPath) {
    const fallback = ["config/company-boards.json", "company-boards.json"].find((p) => existsSync(p));
    if (fallback) args.boardsPath = fallback;
  }
  return args;
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const args = parseDashboardArgs(process.argv.slice(2));
  const server = createDashboardServer({ dataDir: path.resolve(args.dataDir), outputDir: path.resolve(args.outputDir), boardsPath: args.boardsPath ? path.resolve(args.boardsPath) : undefined, eventsPath: args.eventsPath ? path.resolve(args.eventsPath) : undefined });
  listenLoopback(server, args.port).then(
    (addr) => console.log(`Dashboard (read-only): http://127.0.0.1:${addr.port}/`),
    (error: Error) => {
      console.error(`Dashboard not started: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
