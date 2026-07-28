import type { DiscoveredJobLite, PortalDiscoveryAdapter, DiscoveryContext } from "../types.js";
import { pauseForVerification } from "../../browser/verification.js";
import { pacer, withRetry } from "../rate-limit.js";
import type { SiteConfig } from "../../types.js";
import type { PortalConfig } from "../../config/schema.js";

export interface GenericPortalSelectors {
  searchInputSelector?: string;
  searchButtonSelector?: string;
  resultCardSelector: string;
  jobLinkSelector: string;
  nextButtonSelector?: string;
  loadMoreSelector?: string;
  titleSelector: string;
  locationSelector: string;
  companySelector?: string;
  salarySelector?: string;
  dateSelector?: string;
  searchUrlTemplate?: string; // e.g. "https://example.com/jobs?q={{keyword}}&l={{location}}&page={{page}}"
}

// This adapter is invoked from two distinct config sources (see design spec §11 /
// orchestrator.ts): a config/portals.yml entry with type: "generic" (a job-search portal),
// or a config/sites.yml entry's SiteConfig.generic (a company career-page selector set).
// They're different concepts with different schemas -- portalConfig, when present, wins.
function selectorsFromPortalConfig(pc: PortalConfig): GenericPortalSelectors {
  if (!pc.jobLinkSelector) {
    throw new Error(`Portal "${pc.id}" (type: generic) is missing required "jobLinkSelector"`);
  }
  return {
    searchInputSelector: pc.searchInputSelector,
    searchButtonSelector: pc.searchButtonSelector,
    resultCardSelector: pc.resultCardSelector,
    jobLinkSelector: pc.jobLinkSelector,
    nextButtonSelector: pc.nextButtonSelector,
    loadMoreSelector: pc.loadMoreSelector,
    titleSelector: pc.titleSelector,
    locationSelector: pc.locationSelector,
    companySelector: pc.companySelector,
    salarySelector: pc.salarySelector,
    dateSelector: pc.dateSelector,
    searchUrlTemplate: pc.searchUrlTemplate,
  };
}

function selectorsFromSiteConfig(site: SiteConfig): GenericPortalSelectors {
  const gp = site.generic;
  if (!gp) {
    throw new Error(`Site "${site.id}" uses generic portal adapter but has no generic/selectors config`);
  }
  // sites.yml's genericSelectorsSchema has no companySelector/salarySelector/dateSelector/
  // searchUrlTemplate fields (it's the company career-page shape, not portals.yml's) --
  // left explicitly absent here, never fabricated.
  return {
    searchInputSelector: gp.searchInputSelector,
    searchButtonSelector: gp.searchButtonSelector,
    resultCardSelector: gp.resultCardSelector,
    jobLinkSelector: gp.jobLinkSelector,
    nextButtonSelector: gp.nextButtonSelector,
    loadMoreSelector: gp.loadMoreSelector,
    titleSelector: gp.titleSelector,
    locationSelector: gp.locationSelector,
  };
}

export const configurableGenericPortalAdapter: PortalDiscoveryAdapter = {
  source: "configurable-generic-portal",

  async discover(context: DiscoveryContext): Promise<void> {
    const { page, keyword, location, settings, checkpoint, onPageProcessed } = context;
    const startPage = checkpoint.lastPage + 1;
    const pace = pacer(settings.delayBetweenRequestsMs);

    let gp: GenericPortalSelectors;
    let baseUrl: string;
    let sourceId: string;
    let companyFallbackName: string;

    if (context.portalConfig) {
      gp = selectorsFromPortalConfig(context.portalConfig);
      baseUrl = context.portalConfig.baseUrl;
      sourceId = context.portalConfig.id;
      companyFallbackName = context.portalConfig.id;
    } else if (context.siteConfig) {
      gp = selectorsFromSiteConfig(context.siteConfig);
      baseUrl = context.siteConfig.url;
      sourceId = context.siteConfig.id;
      companyFallbackName = context.siteConfig.name;
    } else {
      throw new Error("Generic Portal adapter requires either portalConfig or siteConfig in the discovery context");
    }

    for (let pageNum = startPage; pageNum <= settings.maxPagesPerSource; pageNum++) {
      let url = baseUrl;
      if (gp.searchUrlTemplate) {
        url = gp.searchUrlTemplate
          .replace("{{keyword}}", encodeURIComponent(keyword))
          .replace("{{location}}", encodeURIComponent(location))
          .replace("{{page}}", String(pageNum));
        await pace(url);
        await withRetry(
          () => page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs }),
          { retries: 2, backoffMs: 500 },
        );
      } else {
        if (pageNum === startPage) {
          await pace(url);
          await withRetry(
            () => page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs }),
            { retries: 2, backoffMs: 500 },
          );
          const initialVerification = await pauseForVerification(page);
          if (initialVerification.detected) {
            context.onVerificationPause?.();
          }
          if (keyword && gp.searchInputSelector && gp.searchButtonSelector) {
            await page.fill(gp.searchInputSelector, keyword);
            await page.click(gp.searchButtonSelector);
            await page.waitForLoadState("networkidle").catch(() => undefined);
          }
        } else {
          // If no searchUrlTemplate, try next page button click
          const advanceSelector = gp.loadMoreSelector ?? gp.nextButtonSelector;
          if (!advanceSelector) break;
          const advanceHandle = await page.$(advanceSelector);
          if (!advanceHandle) break;
          await advanceHandle.click();
          await page.waitForLoadState("networkidle").catch(() => undefined);
        }
      }

      const verification = await pauseForVerification(page);
      if (verification.detected) {
        context.onVerificationPause?.();
      }

      const cards = await page.$$(gp.resultCardSelector);
      if (cards.length === 0) {
        break;
      }

      const jobs: DiscoveredJobLite[] = [];
      for (const card of cards) {
        const title = await card.$eval(gp.titleSelector, (el) => el.textContent?.trim() ?? "").catch(() => "");
        const href = await card.$eval(gp.jobLinkSelector, (el) => (el as HTMLAnchorElement).href).catch(() => "");
        const company = gp.companySelector
          ? await card.$eval(gp.companySelector, (el) => el.textContent?.trim() ?? "").catch(() => "")
          : companyFallbackName;
        const loc = await card.$eval(gp.locationSelector, (el) => el.textContent?.trim() ?? "").catch(() => "");
        const salary = gp.salarySelector
          ? await card.$eval(gp.salarySelector, (el) => el.textContent?.trim() ?? null).catch(() => null)
          : null;
        const age = gp.dateSelector
          ? await card.$eval(gp.dateSelector, (el) => el.textContent?.trim() ?? null).catch(() => null)
          : null;

        if (!href || !title) continue;

        // Job ID extraction from URL or href
        const jobId = new URL(href).pathname.split("/").pop() || href;

        jobs.push({
          source: sourceId,
          searchKeyword: keyword,
          title,
          company,
          location: loc,
          salarySnippet: salary,
          resultUrl: href,
          possibleOfficialUrl: null,
          postingAgeOrDate: age,
          sourceJobId: jobId,
          discoveredAt: new Date().toISOString(),
          matchedProfiles: [],
          department: null,
          descriptionSnippet: null,
          searchedProfile: null,
          matchedKeywords: [],
          matchedFields: [],
          relevanceReason: "",
        });
      }

      const beforeCount = checkpoint.sourceJobIds.length;
      const newJobs = jobs.filter((j) => {
        if (!j.sourceJobId) return true;
        if (checkpoint.sourceJobIds.includes(j.sourceJobId)) return false;
        checkpoint.sourceJobIds.push(j.sourceJobId);
        return true;
      });

      await onPageProcessed(newJobs, pageNum);

      if (checkpoint.sourceJobIds.length === beforeCount && pageNum > startPage) {
        break;
      }
    }
  },
};
