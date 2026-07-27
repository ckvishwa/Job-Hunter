import type { CollectSettings, SiteConfig } from "../types.js";
import type { DiscoveredJob, RawJobDetail, RoleSearch, SourceAdapter } from "./types.js";
import { matchProfiles } from "./match-profiles.js";
import { detectVerification } from "../browser/verification.js";
import { stripHtml } from "../extraction/jd-cleaner.js";
import { extractRequiredYears } from "../extraction/metadata.js";
import { computeJobId } from "../dedup/canonicalize-url.js";

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  departments?: { name: string }[];
  content?: string;
  updated_at?: string;
}

interface GreenhouseBoardResponse {
  jobs: GreenhouseJob[];
}

function extractBoardToken(site: SiteConfig): string {
  if (site.greenhouse?.boardToken) return site.greenhouse.boardToken;
  const match = site.url.match(/boards\.greenhouse\.io\/([^/?#]+)/i);
  if (match?.[1]) return match[1];
  throw new Error(
    `Cannot determine Greenhouse board token for site "${site.id}" - set site.greenhouse.boardToken`,
  );
}

async function fetchBoard(token: string): Promise<GreenhouseBoardResponse> {
  const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
  const text = await res.text();

  const verification = detectVerification({ html: text, url: res.url || token });
  if (verification.detected) {
    throw new Error(`Verification required fetching Greenhouse board "${token}": ${verification.reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Greenhouse board "${token}" returned a non-JSON response`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as GreenhouseBoardResponse).jobs)
  ) {
    throw new Error(`Greenhouse board "${token}" returned an unexpected response shape`);
  }

  return parsed as GreenhouseBoardResponse;
}

export const greenhouseAdapter: SourceAdapter = {
  sourceType: "greenhouse",

  canHandle(site: SiteConfig): boolean {
    return site.adapter === "greenhouse";
  },

  async discoverJobs(
    site: SiteConfig,
    searches: RoleSearch[],
    settings: CollectSettings,
  ): Promise<DiscoveredJob[]> {
    const token = extractBoardToken(site);
    const board = await fetchBoard(token);
    return board.jobs.slice(0, settings.maxJobsPerSource).map((job) => ({
      externalId: String(job.id),
      title: job.title,
      url: job.absolute_url,
      matchedProfiles: matchProfiles(job.title, searches),
      rawMetadata: job as unknown as Record<string, unknown>,
    }));
  },

  async fetchJobDetails(job: DiscoveredJob): Promise<RawJobDetail> {
    const raw = job.rawMetadata as unknown as GreenhouseJob;
    return {
      externalId: job.externalId,
      title: raw.title,
      descriptionText: stripHtml(raw.content ?? ""),
      descriptionHtml: raw.content ?? null,
      location: raw.location?.name ?? null,
      department: raw.departments?.[0]?.name ?? null,
      employmentType: null,
      requisitionId: job.externalId,
      postingDate: raw.updated_at ?? null,
      salaryText: null,
      canonicalUrl: job.url,
      applyUrl: job.url,
      rawMetadata: raw as unknown as Record<string, unknown>,
    };
  },

  normalize(raw: RawJobDetail, site: SiteConfig, matchedProfiles: string[]) {
    const now = new Date().toISOString();
    return {
      id: computeJobId(raw.canonicalUrl),
      source: site.id,
      sourceType: "greenhouse" as const,
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
