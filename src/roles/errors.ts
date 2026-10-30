export type RoleRuleCode =
  | "UNKNOWN_RECOMMENDATION"
  | "UNKNOWN_ROLE"
  | "STALE_RECOMMENDATION"
  | "STALE_SELECTION"
  | "STALE_CATALOG"
  | "STALE_ROLE"
  | "INVALID_SELECTION"
  | "INVALID_ROLE_DEFINITION";

/** A business-rule refusal with a deterministic code. The API maps each code to one HTTP status. */
export class RoleRuleError extends Error {
  constructor(readonly code: RoleRuleCode, message: string) {
    super(message);
    this.name = "RoleRuleError";
  }
}
