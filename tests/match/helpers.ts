import type { JobPosting } from "../../src/adapters/types.js";
import { computeJdContentHash } from "../../src/domain/canonical-job.js";

export function makeJob(text: string, over: Partial<Record<string, unknown>> = {}): JobPosting {
  return {
    id: "synthetic-job-1", source: "test", sourceType: "ats", company: "Examplecorp", title: "Security Analyst I", location: "Remote", remoteType: "remote", employmentType: null,
    department: null, requisitionId: "R1", postingDate: null, discoveredAt: "2026-10-01T00:00:00Z", lastSeenAt: "2026-10-01T00:00:00Z", canonicalUrl: "https://example.test/jobs/1", applyUrl: null,
    descriptionText: text, descriptionHtml: null, requiredYears: null, salaryText: null, matchedProfiles: [], discoveredFrom: "test", discoveredUrl: "https://example.test/jobs/1", matchedKeywords: [],
    relevanceReason: "", rawMetadata: {}, schemaVersion: 1, jdContentHash: computeJdContentHash(text), extractedAt: "2026-10-01T00:00:00Z", resolutionStatus: "resolved", sourceObservations: [],
    atsIdentity: "greenhouse:examplecorp:1", ...over,
  } as unknown as JobPosting;
}

export const SYNTHETIC_JD = [
  "About the role",
  "We are hiring a Security Analyst to triage alerts for our customers.",
  "",
  "Minimum Qualifications",
  "- 2+ years of experience in security operations.",
  "- 3+ years of experience with Splunk.",
  "- Experience with Python or PowerShell for scripting.",
  "- Bachelor's degree in computer science or a related field.",
  "- CISSP or Security+ certification.",
  "- Strong written communication.",
  "- Experience with Kubernetes is not required.",
  "",
  "Preferred Qualifications",
  "- Familiarity with EDR tools such as CrowdStrike, SentinelOne.",
  "- Awareness of the MITRE ATT&CK framework.",
  "",
  "Additional notes",
  "This role is remote. Candidates must be authorized to work in the United States. U.S. citizenship is required. We do not currently sponsor visas.",
].join("\n");
