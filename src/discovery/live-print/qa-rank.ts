import { analyzeJd } from "../../pipeline/discovery/jd-flags.js";

const SKILLS = ["selenium", "playwright", "pytest", "python", "java", "api testing", "postman", "sql", "jira", "ci/cd", "automation", "quality assurance", "test automation", "software testing"];
const QA_ROLE = /\b(qa|quality assurance|quality engineer|sdet|software test|test engineer|automation tester|test analyst|tester)\b/i;
const SENIOR = /\b(senior|staff|principal|director|lead|manager)\b/i;

/** Title-only gate used before persistence so large boards do not flood canonical storage. */
export const isQaTitle = (title: string): boolean => QA_ROLE.test(title) && !HARDWARE_TEST.test(title);
const HARDWARE_TEST = /\b(propulsion|mechanical|hardware|avionics|battery|vehicle|asic|silicon|photonics|manufacturing|electrical)\b/i;

export interface QaAssessment {
  relevant: boolean;
  skills: string[];
  score: number;
  reasons: string[];
  requiredExperience: string;
  eligibility: "PASS" | "FAIL" | "NEEDS_VERIFICATION";
  eligibilityEvidence: string[];
  group: "eligible_recommendation" | "verification_required" | "confirmed_ineligible";
}

/** Deterministic diagnostic ranking from full JD content; never makes eligibility from match score. */
export function assessQaJob(input: { title: string; description: string; location: string | null; approvedFacts: string[] }): QaAssessment {
  const text = `${input.title}\n${input.description}`.toLowerCase();
  const skills = SKILLS.filter((s) => text.includes(s));
  const titleQa = QA_ROLE.test(input.title);
  const responsibility = /\b(test cases?|test plans?|automated tests?|quality engineering|quality assurance|testing framework|regression testing)\b/i.test(input.description);
  const early = /\b(junior|associate|entry.level|early.career|engineer i\b|analyst i\b)\b/i.test(input.title);
  const reasons = [
    ...(titleQa ? ["QA/SDET role family is explicit in the title"] : []),
    ...(responsibility ? ["Full description includes testing/quality responsibilities"] : []),
    ...(skills.length ? [`Full description names relevant skills: ${skills.join(", ")}`] : []),
    ...(early ? ["Title signals junior or early-career seniority"] : []),
    ...(SENIOR.test(input.title) ? ["Senior title reduces target-role fit"] : []),
  ];
  const score = Math.round(100 * Math.min(1, (titleQa ? 0.35 : 0) + (responsibility ? 0.3 : 0) + Math.min(5, skills.length) * 0.06 + (early ? 0.12 : 0) - (SENIOR.test(input.title) ? 0.25 : 0)));
  const flags = analyzeJd(input.description, { location: input.location });
  const requiredExperience = flags.yearsRequired?.quote ?? "Not explicitly stated";
  const eligibilityEvidence: string[] = [];
  const auth = input.description.match(/.{0,90}\b(citizenship|citizen|work authorization|work authori[sz]ation|sponsorship|clearance)\b.{0,150}/i)?.[0];
  if (auth) eligibilityEvidence.push(`JD eligibility statement: “${auth.replace(/\s+/g, " ").trim()}”`);
  if (/\b(currently enrolled|active enrollment|must be enrolled|enrolled in (?:a|an) .{0,40}(?:degree|program)|graduat(?:e|ion) between)\b/i.test(input.description)) {
    eligibilityEvidence.push("JD contains an enrollment or graduation-window condition; approved active-enrollment evidence is unavailable.");
  }
  if (/\b(remote in (?:mexico|argentina|canada|india|uk|united kingdom))\b/i.test(input.location ?? "")) eligibilityEvidence.push(`Location restriction: ${input.location}`);
  // There are no approved eligibility attestations in the active profile; do not infer authorization or reject on absence.
  const eligibility: QaAssessment["eligibility"] = eligibilityEvidence.length ? "NEEDS_VERIFICATION" : "PASS";
  const relevant = titleQa && (responsibility || skills.length > 0);
  const group = eligibility === "NEEDS_VERIFICATION" ? "verification_required" : "eligible_recommendation";
  return { relevant, skills, score, reasons, requiredExperience, eligibility, eligibilityEvidence, group };
}
