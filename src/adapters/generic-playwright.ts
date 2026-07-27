import type { BrowserContext, Page } from "playwright";
import type { CollectSettings, SiteConfig } from "../types.js";
import type { DiscoveredJob, RawJobDetail, RoleSearch, SourceAdapter } from "./types.js";
import { pauseForVerification } from "../browser/verification.js";
import { stripHtml } from "../extraction/jd-cleaner.js";
import { extractRequiredYears } from "../extraction/metadata.js";
import { computeJobId } from "../dedup/canonicalize-url.js";

export interface GenericPlaywrightDeps {
  context: BrowserContext;
  onVerificationPause?: () => void;
}

const REQUIRED_SELECTORS = [
  "searchInputSelector",
  "searchButtonSelector",
  "resultCardSelector",
  "jobLinkSelector",
  "titleSelector",
  "locationSelector",
  "descriptionSelector",
] as const;

export function validateGenericSelectors(site: SiteConfig): void {
  if (!site.generic) {
    throw new Error(`Site "${site.id}" uses adapter "generic" but has no generic selector block configured`);
  }
  for (const key of REQUIRED_SELECTORS) {
    if (!site.generic[key]) {
      throw new Error(`Site "${site.id}" generic config missing required selector "${key}"`);
    }
  }
}

export function createGenericPlaywrightAdapter(deps: GenericPlaywrightDeps): SourceAdapter {
  const { context, onVerificationPause } = deps;

  async function checkVerification(page: Page): Promise<void> {
    const result = await pauseForVerification(page as never);
    if (result.detected) onVerificationPause?.();
  }

  async function collectLinksForKeyword(
    page: Page,
    site: SiteConfig,
    keyword: string,
    settings: CollectSettings,
  ): Promise<Map<string, void>> {
    const selectors = site.generic!;
    const found = new Map<string, void>();

    if (keyword) {
      await page.fill(selectors.searchInputSelector, keyword);
      await page.click(selectors.searchButtonSelector);
      await page.waitForLoadState("networkidle").catch(() => undefined);
    }

    let pageCount = 0;
    while (pageCount < settings.maxPagesPerSource) {
      await checkVerification(page);

      const links = await page.$$eval(selectors.jobLinkSelector, (elements) =>
        elements.map((el) => el.href).filter(Boolean),
      );
      const beforeSize = found.size;
      for (const link of links) {
        found.set(link, undefined);
        if (found.size >= settings.maxJobsPerSource) return found;
      }

      pageCount += 1;

      const advanceSelector = selectors.loadMoreSelector ?? selectors.nextButtonSelector;
      if (!advanceSelector) break;
      const advanceHandle = await page.$(advanceSelector);
      if (!advanceHandle) break;
      await advanceHandle.click();
      await page.waitForLoadState("networkidle").catch(() => undefined);

      if (found.size === beforeSize && pageCount > 1) break;
    }

    return found;
  }

  return {
    sourceType: "generic",

    canHandle(site: SiteConfig): boolean {
      return site.adapter === "generic";
    },

    async discoverJobs(
      site: SiteConfig,
      searches: RoleSearch[],
      settings: CollectSettings,
    ): Promise<DiscoveredJob[]> {
      validateGenericSelectors(site);
      const page = await context.newPage();
      try {
        await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs });
        await checkVerification(page);

        const profilesByUrl = new Map<string, string[]>();
        const effective = searches.length ? searches : [{ keyword: "", profileIds: [] }];

        for (const search of effective) {
          const found = await collectLinksForKeyword(page, site, search.keyword, settings);
          for (const url of found.keys()) {
            const profiles = profilesByUrl.get(url) ?? [];
            for (const profileId of search.profileIds) {
              if (!profiles.includes(profileId)) profiles.push(profileId);
            }
            profilesByUrl.set(url, profiles);
          }
        }

        return [...profilesByUrl.entries()]
          .slice(0, settings.maxJobsPerSource)
          .map(([url, matchedProfiles]) => ({ externalId: url, title: "", url, matchedProfiles }));
      } finally {
        await page.close();
      }
    },

    async fetchJobDetails(
      job: DiscoveredJob,
      site: SiteConfig,
      settings: CollectSettings,
    ): Promise<RawJobDetail> {
      const selectors = site.generic!;
      const page = await context.newPage();
      try {
        await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs });
        await checkVerification(page);

        const title = await page.$eval(selectors.titleSelector, (el) => el.textContent?.trim() ?? "").catch(() => "");
        const location = await page.$eval(selectors.locationSelector, (el) => el.textContent?.trim() ?? "").catch(() => "");
        const descriptionHtml = await page.$eval(selectors.descriptionSelector, (el) => el.innerHTML).catch(() => "");
        const applyUrl = selectors.applyLinkSelector
          ? await page.$eval(selectors.applyLinkSelector, (el) => el.href).catch(() => job.url)
          : job.url;

        return {
          externalId: job.externalId,
          title: title || job.title,
          descriptionText: stripHtml(descriptionHtml),
          descriptionHtml: descriptionHtml || null,
          location: location || null,
          department: null,
          employmentType: null,
          requisitionId: null,
          postingDate: null,
          salaryText: null,
          canonicalUrl: job.url,
          applyUrl,
          rawMetadata: {},
        };
      } finally {
        await page.close();
      }
    },

    normalize(raw: RawJobDetail, site: SiteConfig, matchedProfiles: string[]) {
      const now = new Date().toISOString();
      return {
        id: computeJobId(raw.canonicalUrl),
        source: site.id,
        sourceType: "generic" as const,
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
}
