import { readReviewFile, writeReviewFile, type ReviewFact, type ReviewFile } from "./fact-review-file.js";

// Interactive A/R reviewer over the review JSON. Every decision is written to the file immediately (atomic replace), so quitting,
// crashing or closing the window never loses progress. This tool only records decisions in the file; facts:apply is what changes the database.

export type ReviewFilter = "pending" | "undecided" | "warnings" | "all";

export interface ReviewIo {
  ask(prompt: string): Promise<string>;
  out(text: string): void;
}

export interface SessionOptions {
  filter: ReviewFilter;
  /** Also revisit facts that already carry a decision. */
  redo: boolean;
}

export interface SessionSummary {
  approve: number;
  reject: number;
  undecided: number;
  reviewedThisSession: number;
  quit: boolean;
}

const matches = (f: ReviewFact, filter: ReviewFilter): boolean =>
  filter === "all" ? true : filter === "pending" ? f.status === "pending" : filter === "warnings" ? f.warnings.length > 0 : true;

export function summarize(file: ReviewFile): Pick<SessionSummary, "approve" | "reject" | "undecided"> {
  return {
    approve: file.facts.filter((f) => f.decision === "approve").length,
    reject: file.facts.filter((f) => f.decision === "reject").length,
    undecided: file.facts.filter((f) => f.decision === null).length,
  };
}

export function renderFact(f: ReviewFact, position: number, total: number): string {
  const lines = [
    "",
    `ORBITAL FACT REVIEW — ${position} / ${total}`,
    "",
    `TYPE:    ${f.kind.toUpperCase()}`,
    `VALUE:   ${f.value}`,
    `STATUS:  ${f.status.toUpperCase()}${f.decision ? `   (your decision so far: ${f.decision.toUpperCase()})` : ""}`,
    `SOURCE:  ${f.source.reference}${f.source.locator ? ` / ${f.source.locator}` : ""}`,
  ];
  if (f.quote !== null) lines.push(`QUOTE:   "${f.quote.replace(/\s+/g, " ").slice(0, 300)}"`);
  const attrs = Object.entries(f.attributes).filter(([, v]) => v !== null && v !== undefined);
  if (attrs.length) lines.push(`DETAILS: ${attrs.map(([k, v]) => `${k}=${String(v)}`).join(", ")}`);
  if (f.warnings.length) for (const w of f.warnings) lines.push(`WARNING: ${w.code} — ${w.message}`);
  else lines.push("WARNING: None");
  if (f.sensitivity === "sensitive") lines.push("NOTE:    sensitive fact; approving it later needs --confirm-sensitive");
  lines.push("", "  [A] Approve   [R] Reject   [Enter] Skip (unchanged)   [B] Back   [S] Summary   [Q] Quit and keep progress");
  return lines.join("\n");
}

export async function runReviewSession(filePath: string, options: SessionOptions, io: ReviewIo): Promise<SessionSummary> {
  let file = readReviewFile(filePath);
  const queueIds = file.facts.filter((f) => matches(f, options.filter) && (options.redo || f.decision === null)).map((f) => f.factId);
  let reviewed = 0;
  let quit = false;
  let i = 0;
  if (queueIds.length === 0) io.out("\nNothing to review with this filter. Use --filter all, --redo or --filter warnings to see more.");

  const save = (): void => writeReviewFile(filePath, file, { overwrite: true });
  const showSummary = (): void => {
    const s = summarize(file);
    io.out(`\nDecisions in file — approve: ${s.approve}, reject: ${s.reject}, no decision: ${s.undecided}. Nothing is changed in the database until: npm run facts:apply`);
  };

  while (i < queueIds.length) {
    const fact = file.facts.find((f) => f.factId === queueIds[i])!;
    io.out(renderFact(fact, i + 1, queueIds.length));
    const answer = (await io.ask("> ")).trim().toLowerCase();
    if (answer === "q") {
      quit = true;
      break;
    }
    if (answer === "s") {
      showSummary();
      continue;
    }
    if (answer === "b") {
      i = Math.max(0, i - 1);
      continue;
    }
    if (answer === "a" || answer === "r") {
      const decision = answer === "a" ? "approve" : "reject";
      file = { ...file, facts: file.facts.map((f) => (f.factId === fact.factId ? { ...f, decision } : f)) };
      save();
      reviewed += 1;
      i += 1;
      continue;
    }
    if (answer === "") {
      i += 1; // skip: whatever decision the fact already had is kept as is
      continue;
    }
    io.out(`Unknown key "${answer}". Use A, R, Enter, B, S or Q.`);
  }
  showSummary();
  return { ...summarize(file), reviewedThisSession: reviewed, quit };
}
