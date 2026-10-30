import path from "node:path";

// Resolution order: CLI option, then CAREER_OPS_HOME env var, then the documented sibling
// default (../career-ops relative to cwd) -- never a hardcoded personal absolute path.
export function resolveCareerOpsHome(cliOption?: string): string {
  if (cliOption) return cliOption;
  if (process.env.CAREER_OPS_HOME) return process.env.CAREER_OPS_HOME;
  return path.resolve(process.cwd(), "..", "career-ops");
}
