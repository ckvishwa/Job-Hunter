import { createHash } from "node:crypto";
import { postingDatePrecision } from "../../discovery/posting-date.js";
import { mapCareerOpsOffer } from "./careerops-mapper.js";
import type { CareerOpsOffer } from "./careerops-schema.js";

export const DISCOVERY_CONTRACT_VERSION = "m5.1-d/1";

export interface IngestedListing {
  contractVersion: typeof DISCOVERY_CONTRACT_VERSION;
  sourceId: string;
  sourceKind: "careerops-offer";
  employerName: string;
  title: string;
  location: string | null;
  sourceUrl: string;
  postedAt: string | null;
  postingDatePrecision: "exact" | "approximate" | "unknown";
  description: null;
  descriptionHash: null;
  resolutionStatus: "pending";
  providerVersion: string;
}

/** Keep every schema-valid offer. Relevance is a later step and cannot drop the record here. */
export function ingestOffers(offers: readonly CareerOpsOffer[], providerVersion: string): { listings: IngestedListing[]; mapFailures: number } {
  const listings: IngestedListing[] = [];
  let mapFailures = 0;
  for (const offer of offers) {
    const mapped = mapCareerOpsOffer(offer);
    if (!mapped.ok) {
      mapFailures += 1;
      continue;
    }
    const dated = postingDatePrecision(offer.postedAt);
    listings.push({
      contractVersion: DISCOVERY_CONTRACT_VERSION,
      sourceId: createHash("sha256").update(`${offer.source}|${offer.url}`).digest("hex").slice(0, 16),
      sourceKind: "careerops-offer",
      employerName: offer.company,
      title: offer.title,
      location: offer.location ?? null,
      sourceUrl: offer.url,
      postedAt: dated.postedAt,
      postingDatePrecision: dated.precision,
      description: null,
      descriptionHash: null,
      resolutionStatus: "pending",
      providerVersion,
    });
  }
  return { listings, mapFailures };
}
