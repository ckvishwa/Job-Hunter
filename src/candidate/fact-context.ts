import type { CandidateRepo } from "../db/candidate-repo.js";
import { detectEmploymentConflicts, employmentRecordsFromFacts, findLatestPriorProfile, loadPriorEmploymentRecords, type EmploymentConflict, type EmploymentRecord } from "./employment-conflicts.js";

// Read-only: gathers every employment record the user has (all uploaded résumés, plus an earlier reviewed profile if one is available)
// and reports the disagreements. Used by the reviewer export/apply gate, the correction CLI and the diagnostics.

export interface ConflictContext {
  conflicts: EmploymentConflict[];
  records: EmploymentRecord[];
  priorProfileFile: string | null;
  priorProfileProblem: string | null;
}

/** `prior`: undefined = use the newest private-runtime/candidate/candidate-profile.reviewed-N.json if present; null = none; string = that file. */
export async function collectEmploymentConflicts(repo: CandidateRepo, userId: string, prior?: string | null): Promise<ConflictContext> {
  const records: EmploymentRecord[] = [];
  for (const r of await repo.listResumes(userId)) records.push(...employmentRecordsFromFacts(await repo.listFacts(userId, r.resumeId), r.resumeId));
  const file = prior === undefined ? findLatestPriorProfile() : prior;
  let priorProfileProblem: string | null = null;
  let used: string | null = null;
  if (file) {
    try {
      records.push(...loadPriorEmploymentRecords(file));
      used = file;
    } catch (error) {
      priorProfileProblem = `Could not read the earlier profile: ${(error as Error).message.split("\n")[0]}`;
    }
  }
  return { conflicts: detectEmploymentConflicts(records), records, priorProfileFile: used, priorProfileProblem };
}
