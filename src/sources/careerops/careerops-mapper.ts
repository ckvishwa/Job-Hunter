import type { DiscoveredJobLite } from "../../discovery/types.js";
import { isSafeUrl, type CareerOpsOffer } from "./careerops-schema.js";

export type CareerOpsMapErrorCode = "UNSAFE_URL" | "MISSING_REQUIRED_FIELD";

export type CareerOpsMapResult =
  | { ok: true; job: DiscoveredJobLite }
  | { ok: false; code: CareerOpsMapErrorCode; message: string };

// Maps an already schema-validated CareerOps offer to a DiscoveredJobLite -- the same
// preliminary-discovery shape native adapters produce (see src/discovery/adapters/
// company-careers.ts:178-200) before relevance evaluation and resolution ever run. Never
// produces a JobPosting: CareerOps supplies no description, so nothing here can honestly claim
// a job is resolved. The defensive re-checks below exist because the type system alone can't
// guarantee every caller actually ran schema validation first -- never trust that blindly.
export function mapCareerOpsOffer(offer: CareerOpsOffer): CareerOpsMapResult {
  if (!offer.source || !offer.source.trim()) {
    return { ok: false, code: "MISSING_REQUIRED_FIELD", message: "offer.source is required" };
  }
  if (!offer.company || !offer.company.trim()) {
    return { ok: false, code: "MISSING_REQUIRED_FIELD", message: "offer.company is required" };
  }
  if (!offer.title || !offer.title.trim()) {
    return { ok: false, code: "MISSING_REQUIRED_FIELD", message: "offer.title is required" };
  }
  if (!offer.url || !isSafeUrl(offer.url)) {
    return { ok: false, code: "UNSAFE_URL", message: `offer.url is not a safe http(s) URL: ${String(offer.url)}` };
  }

  const job: DiscoveredJobLite = {
    // Preserved exactly as CareerOps reports it (e.g. "greenhouse-full", "lever-full") -- never
    // relabeled. An unrecognized future ATS suffix passes through the same way: safe raw
    // provenance, not a rejection, since passthrough alone can never misclassify anything.
    source: offer.source,
    // CareerOps is reverse discovery -- there is no per-keyword search on our side to record.
    // Empty is the honest "not applicable" value, not a fabricated keyword.
    searchKeyword: "",
    title: offer.title,
    company: offer.company,
    // Matches company-careers.ts's own `raw.location ?? ""` convention -- unknown stays
    // unknown, never "Remote" or any inferred value.
    location: offer.location ?? "",
    salarySnippet: null,
    resultUrl: offer.url,
    // CareerOps' url is already the direct ATS-hosted board link, not a search result needing a
    // separately-guessed "official" URL -- matches company-careers.ts's `possibleOfficialUrl: job.url`.
    possibleOfficialUrl: offer.url,
    postingAgeOrDate: offer.postedAt ?? null,
    // CareerOps gives no ID separate from the URL.
    sourceJobId: null,
    discoveredAt: new Date().toISOString(),
    department: null,
    // CareerOps' --json contract never supplies a description -- null, never "" (which would
    // read as "fetched an empty description" rather than "never fetched one").
    descriptionSnippet: null,
    // Neutral placeholders, identical to company-careers.ts's own comment: "these start as
    // neutral placeholders and are overwritten [by the orchestrator's relevance evaluation]
    // before a job is ever written to disk." CareerOps' own broad title_filter is never trusted
    // as our relevance decision.
    matchedProfiles: [],
    searchedProfile: null,
    matchedKeywords: [],
    matchedFields: [],
    relevanceReason: "",
  };

  return { ok: true, job };
}
