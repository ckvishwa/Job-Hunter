import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readDocxParagraphs } from "../candidate/resume-import.js";
import { factUsability, parseCandidateProfile, profileDigest, type CandidateProfile } from "../domain/candidate-profile.js";

const laneSchema = z.object({
  resume: z.string().min(1),
  coverLetter: z.string().min(1),
  sha256Resume: z.string().regex(/^[0-9A-F]{64}$/i),
  sha256CoverLetter: z.string().regex(/^[0-9A-F]{64}$/i),
}).strict();
const registrySchema = z.object({
  version: z.literal(1),
  status: z.literal("canonical"),
  candidate: z.string().min(1),
  lanes: z.object({ cybersecurity: laneSchema, sdet: laneSchema, cloud: laneSchema, network: laneSchema }).strict(),
  candidateProfile: z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9A-F]{64}$/i) }).strict(),
  pendingFacts: z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9A-F]{64}$/i) }).strict(),
}).passthrough();

export type CanonicalLane = "cybersecurity" | "sdet" | "cloud" | "network";
export type CanonicalRegistry = z.infer<typeof registrySchema>;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function readVerifiedFile(filePath: string, expectedHash: string, label: string): Buffer {
  const absolute = path.resolve(filePath);
  const bytes = readFileSync(absolute);
  const actual = sha256(bytes);
  if (actual.toLowerCase() !== expectedHash.toLowerCase()) throw new Error(`${label} hash mismatch; expected ${expectedHash}, received ${actual}.`);
  return bytes;
}

/** An approved, current employment fact that every job-specific resume must carry unchanged. */
export interface ProtectedEmployment {
  factId: string;
  employer: string;
  title: string;
  /** "January 2022 – July 2023" style label built from the fact's start/end months ("Present" when current). */
  dateLabel: string;
  startLabel: string;
  endLabel: string;
  roleTags: string[];
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthLabel(yearMonth: string): string {
  const [year, month] = yearMonth.split("-");
  return `${MONTH_NAMES[Number(month) - 1] ?? month} ${year}`;
}

/** The historical identity (employer, title, dates) comes from the approved profile itself, never from code. */
export function protectedEmploymentOf(usableFacts: CandidateProfile["facts"]): ProtectedEmployment[] {
  const found: ProtectedEmployment[] = [];
  for (const fact of usableFacts) {
    const { employer, title, startDate, endDate } = fact.attributes;
    if (fact.kind !== "employment" || !employer || !title || !startDate) continue;
    const startLabel = monthLabel(startDate);
    const endLabel = endDate ? monthLabel(endDate) : "Present";
    found.push({ factId: fact.factId, employer, title, startLabel, endLabel, dateLabel: `${startLabel} – ${endLabel}`, roleTags: fact.attributes.roleTags ?? [] });
  }
  return found;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface VerifiedInputs {
  registry: CanonicalRegistry;
  registryPath: string;
  registryHash: string;
  profile: CandidateProfile;
  profilePath: string;
  profileHash: string;
  pendingFactsHash: string;
  approvedFacts: CandidateProfile["facts"];
  protectedEmployment: ProtectedEmployment[];
  laneFiles: Record<CanonicalLane, { resumePath: string; coverLetterPath: string; resumeHash: string; coverLetterHash: string }>;
}

/** Hash-checks the private registry and reviewed profile before any candidate fact is used. */
export function loadVerifiedInputs(input: { registryPath: string; profilePath: string; asOf: string }): VerifiedInputs {
  const registryBytes = readFileSync(path.resolve(input.registryPath));
  const registry = registrySchema.parse(JSON.parse(registryBytes.toString("utf8")));
  const registryHash = sha256(registryBytes);

  const profilePath = path.resolve(input.profilePath);
  const registeredProfilePath = path.resolve(registry.candidateProfile.path);
  if (profilePath.toLocaleLowerCase() !== registeredProfilePath.toLocaleLowerCase()) throw new Error("Candidate profile path does not match the path frozen in the canonical registry.");
  const profileBytes = readVerifiedFile(profilePath, registry.candidateProfile.sha256, "Candidate profile");
  const profile = parseCandidateProfile(JSON.parse(profileBytes.toString("utf8")));
  const pendingPath = path.resolve(registry.pendingFacts.path);
  const pendingHash = sha256(readVerifiedFile(pendingPath, registry.pendingFacts.sha256, "pending-facts.json"));

  const protectedEmployment = protectedEmploymentOf(profile.facts.filter((fact) => factUsability(fact, input.asOf).usable));
  if (protectedEmployment.length === 0) throw new Error("The profile must contain at least one approved, current employment fact (employer, title and start month) to protect in every resume.");

  const laneFiles = {} as VerifiedInputs["laneFiles"];
  for (const lane of ["cybersecurity", "sdet", "cloud", "network"] as const) {
    const entry = registry.lanes[lane];
    const resumePath = path.resolve(entry.resume);
    const coverLetterPath = path.resolve(entry.coverLetter);
    const resumeBytes = readVerifiedFile(resumePath, entry.sha256Resume, `${lane} canonical resume`);
    const coverBytes = readVerifiedFile(coverLetterPath, entry.sha256CoverLetter, `${lane} canonical cover letter`);
    const text = readDocxParagraphs(resumeBytes).join("\n");
    for (const job of protectedEmployment) {
      const dates = new RegExp(`${escapeRegExp(job.startLabel)}\\s*[\\u2013-]\\s*${escapeRegExp(job.endLabel)}`);
      if (!text.includes(job.employer) || !text.includes(job.title) || !dates.test(text)) {
        throw new Error(`${lane} canonical resume is missing the protected employment identity of fact ${job.factId} (employer, title and dates from the approved profile).`);
      }
    }
    laneFiles[lane] = { resumePath, coverLetterPath, resumeHash: sha256(resumeBytes), coverLetterHash: sha256(coverBytes) };
  }

  return {
    registry,
    registryPath: path.resolve(input.registryPath),
    registryHash,
    profile,
    profilePath,
    profileHash: sha256(profileBytes),
    pendingFactsHash: pendingHash,
    approvedFacts: profile.facts.filter((fact) => factUsability(fact, input.asOf).usable),
    protectedEmployment,
    laneFiles,
  };
}

export { profileDigest };
