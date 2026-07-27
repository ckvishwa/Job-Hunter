import type { CollectSettings, SiteConfig, WorkdayConfig } from "../types.js";
import type { DiscoveredJob, RawJobDetail, RoleSearch, SourceAdapter } from "./types.js";
import { detectVerification } from "../browser/verification.js";
import { stripHtml } from "../extraction/jd-cleaner.js";
import { extractRequiredYears } from "../extraction/metadata.js";
import { computeJobId } from "../dedup/canonicalize-url.js";

interface WorkdayJobPosting {
  title: string;
  externalPath: string;
}

interface WorkdaySearchResponse {
  total: number;
  jobPostings: WorkdayJobPosting[];
}

function requireWorkdayConfig(site: SiteConfig): WorkdayConfig {
  if (!site.workday) {
    throw new Error(
      `Site "${site.id}" uses adapter "workday" but has no workday config block (hostname/tenant/site)`,
    );
  }
  return site.workday;
}

async function fetchJson(url: string, init: RequestInit, label: string): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  const verification = detectVerification({ html: text, url: res.url || url });
  if (verification.detected) {
    throw new Error(`Verification required on ${label}: ${verification.reason}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }
}

async function searchPage(
  config: WorkdayConfig,
  searchText: string,
  offset: number,
  limit: number,
): Promise<WorkdaySearchResponse> {
  const parsed = await fetchJson(
    `https://${config.hostname}/wday/cxs/${config.tenant}/${config.site}/jobs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText }),
    },
    `Workday tenant "${config.tenant}"`,
  );

  const obj = parsed as Partial<WorkdaySearchResponse>;
  if (!obj || typeof obj.total !== "number" || !Array.isArray(obj.jobPostings)) {
    throw new Error(`Workday tenant "${config.tenant}" returned an unrecognized response shape`);
  }
  return obj as WorkdaySearchResponse;
}

export const workdayAdapter: SourceAdapter = {
  sourceType: "workday",

  canHandle(site: SiteConfig): boolean {
    return site.adapter === "workday";
  },

  async discoverJobs(
    site: SiteConfig,
    searches: RoleSearch[],
    settings: CollectSettings,
  ): Promise<DiscoveredJob[]> {
    const config = requireWorkdayConfig(site);
    const byPath = new Map<string, DiscoveredJob>();
    const effectiveSearches = searches.length ? searches : [{ keyword: "", profileIds: [] }];
    const limit = 50;

    for (const search of effectiveSearches) {
      let offset = 0;
      let pages = 0;
      let jobsInSearch = 0;

      while (pages < settings.maxPagesPerSource) {
        const page = await searchPage(config, search.keyword, offset, limit);
        pages += 1;
        if (page.jobPostings.length === 0) break;

        for (const posting of page.jobPostings) {
          const existing = byPath.get(posting.externalPath);
          const profiles = new Set(existing?.matchedProfiles ?? []);
          for (const profileId of search.profileIds) profiles.add(profileId);
          byPath.set(posting.externalPath, {
            externalId: posting.externalPath,
            title: posting.title,
            url: `https://${config.hostname}/${config.site}/job/${posting.externalPath}`,
            matchedProfiles: [...profiles],
          });
          jobsInSearch += 1;
        }

        if (jobsInSearch >= page.total) break;
        offset += limit;
        if (byPath.size >= settings.maxJobsPerSource) break;
      }
    }

    return [...byPath.values()].slice(0, settings.maxJobsPerSource);
  },

  async fetchJobDetails(
    job: DiscoveredJob,
    site: SiteConfig,
  ): Promise<RawJobDetail> {
    const config = requireWorkdayConfig(site);
    const parsed = await fetchJson(
      `https://${config.hostname}/wday/cxs/${config.tenant}/${config.site}/job/${job.externalId}`,
      { method: "GET" },
      `Workday job detail "${job.externalId}"`,
    );

    const info = (parsed as { jobPostingInfo?: Record<string, unknown> }).jobPostingInfo ?? {};
    const description = String(info.jobDescription ?? "");

    return {
      externalId: job.externalId,
      title: String(info.title ?? job.title),
      descriptionText: stripHtml(description),
      descriptionHtml: description || null,
      location: (info.location as string) ?? null,
      department: null,
      employmentType: (info.timeType as string) ?? null,
      requisitionId: (info.jobReqId as string) ?? job.externalId,
      postingDate: (info.startDate as string) ?? null,
      salaryText: null,
      canonicalUrl: job.url,
      applyUrl: job.url,
      rawMetadata: info,
    };
  },

  normalize(raw: RawJobDetail, site: SiteConfig, matchedProfiles: string[]) {
    const now = new Date().toISOString();
    return {
      id: computeJobId(raw.canonicalUrl),
      source: site.id,
      sourceType: "workday" as const,
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
