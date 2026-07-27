import type { CollectSettings, SiteConfig } from "../types.js";
import type { DiscoveredJob, RawJobDetail, RoleSearch, SourceAdapter } from "./types.js";
import { matchProfiles } from "./match-profiles.js";
import { detectVerification } from "../browser/verification.js";
import { stripHtml } from "../extraction/jd-cleaner.js";
import { extractRequiredYears } from "../extraction/metadata.js";
import { computeJobId } from "../dedup/canonicalize-url.js";

interface LeverPosting {
  id: string;
  text: string;
  categories?: { commitment?: string; location?: string; team?: string; department?: string };
  hostedUrl: string;
  applyUrl: string;
  description?: string;
  descriptionPlain?: string;
  createdAt?: number;
}

function extractSiteSlug(site: SiteConfig): string {
  if (site.lever?.site) return site.lever.site;
  const match = site.url.match(/jobs\.lever\.co\/([^/?#]+)/i);
  if (match?.[1]) return match[1];
  throw new Error(`Cannot determine Lever site slug for "${site.id}" - set site.lever.site`);
}

async function fetchPostings(siteSlug: string): Promise<LeverPosting[]> {
  const res = await fetch(`https://api.lever.co/v0/postings/${siteSlug}?mode=json`);
  const text = await res.text();

  const verification = detectVerification({ html: text, url: res.url || siteSlug });
  if (verification.detected) {
    throw new Error(`Verification required fetching Lever site "${siteSlug}": ${verification.reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Lever site "${siteSlug}" returned a non-JSON response`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Lever site "${siteSlug}" returned an unexpected response shape`);
  }

  return parsed as LeverPosting[];
}

export const leverAdapter: SourceAdapter = {
  sourceType: "lever",

  canHandle(site: SiteConfig): boolean {
    return site.adapter === "lever";
  },

  async discoverJobs(
    site: SiteConfig,
    searches: RoleSearch[],
    settings: CollectSettings,
  ): Promise<DiscoveredJob[]> {
    const slug = extractSiteSlug(site);
    const postings = await fetchPostings(slug);
    return postings.slice(0, settings.maxJobsPerSource).map((posting) => ({
      externalId: posting.id,
      title: posting.text,
      url: posting.hostedUrl,
      matchedProfiles: matchProfiles(posting.text, searches),
      rawMetadata: posting as unknown as Record<string, unknown>,
    }));
  },

  async fetchJobDetails(job: DiscoveredJob): Promise<RawJobDetail> {
    const raw = job.rawMetadata as unknown as LeverPosting;
    return {
      externalId: job.externalId,
      title: raw.text,
      descriptionText: stripHtml(raw.descriptionPlain ?? raw.description ?? ""),
      descriptionHtml: raw.description ?? null,
      location: raw.categories?.location ?? null,
      department: raw.categories?.team ?? raw.categories?.department ?? null,
      employmentType: raw.categories?.commitment ?? null,
      requisitionId: job.externalId,
      postingDate: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
      salaryText: null,
      canonicalUrl: raw.hostedUrl,
      applyUrl: raw.applyUrl,
      rawMetadata: raw as unknown as Record<string, unknown>,
    };
  },

  normalize(raw: RawJobDetail, site: SiteConfig, matchedProfiles: string[]) {
    const now = new Date().toISOString();
    return {
      id: computeJobId(raw.canonicalUrl),
      source: site.id,
      sourceType: "lever" as const,
      company: site.name,
      title: raw.title,
      location: raw.location,
      remoteType: null,
      employmentType: raw.employmentType,
      department: raw.department,
      requisitionId: raw.requisitionId,
      postingDate: raw.postingDate,
      discoveredAt: now,
      lastSeenAt: now,
      canonicalUrl: raw.canonicalUrl,
      applyUrl: raw.applyUrl,
      descriptionText: raw.descriptionText,
      descriptionHtml: raw.descriptionHtml,
      requiredYears: extractRequiredYears(raw.descriptionText),
      salaryText: raw.salaryText,
      matchedProfiles,
      rawMetadata: raw.rawMetadata,
    };
  },
};
