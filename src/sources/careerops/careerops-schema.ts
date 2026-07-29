import { z } from "zod";

// Only http:/https: may ever reach applyUrl/canonicalUrl downstream (writers.ts::safeHref
// enforces this again at the HTML edge -- this is the first gate, at ingestion). A
// syntactically invalid URL (new URL() throws) is rejected the same way an unsafe scheme is:
// both fail this refinement, neither reaches the rest of the pipeline.
export function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export const careerOpsOfferSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1).refine(isSafeUrl, { message: "url must be a safe http(s) URL" }),
  location: z.string().nullable().optional(),
  postedAt: z.string().nullable().optional(),
  dateStatus: z.string().optional(),
  blacklisted: z.boolean().optional(),
  note: z.string().nullable().optional(),
  source: z.string().min(1),
});

export type CareerOpsOffer = z.infer<typeof careerOpsOfferSchema>;

// offers is deliberately NOT deep-validated here (z.array(z.unknown())) -- top-level shape
// validation (this schema) and per-offer validation (validateOffers, below) are separate
// concerns: a scan result with some malformed offers is still a structurally valid top-level
// response, and "one malformed record must never fail the whole import" only holds if the
// wrapper's own validity doesn't depend on every element already being valid.
export const careerOpsScanResultSchema = z.object({
  date: z.string(),
  sources: z.array(z.string()),
  resumed: z.boolean(),
  sinceDays: z.number(),
  companiesAvailable: z.number(),
  companiesScanned: z.number(),
  capHit: z.boolean(),
  datasetStatus: z.record(z.string()),
  postingsKept: z.number(),
  postingsDroppedNoDate: z.number(),
  postingsFilteredBlacklist: z.number(),
  postingsAnnotatedBlacklisted: z.number(),
  postingsDroppedContent: z.number(),
  unreachableBoards: z.number(),
  cappedBoards: z.number(),
  saved: z.boolean(),
  offers: z.array(z.unknown()),
});

export type CareerOpsScanResult = z.infer<typeof careerOpsScanResultSchema>;

export interface InvalidOffer {
  index: number;
  message: string;
}

export interface ValidateOffersResult {
  valid: CareerOpsOffer[];
  invalid: InvalidOffer[];
}

// Validates each offer independently -- one malformed record is isolated (counted + reported
// via `invalid`), never throws, never drops the surrounding valid records.
export function validateOffers(offers: unknown[]): ValidateOffersResult {
  const valid: CareerOpsOffer[] = [];
  const invalid: InvalidOffer[] = [];

  offers.forEach((offer, index) => {
    const result = careerOpsOfferSchema.safeParse(offer);
    if (result.success) {
      valid.push(result.data);
    } else {
      invalid.push({ index, message: result.error.issues.map((i) => i.message).join("; ") });
    }
  });

  return { valid, invalid };
}
