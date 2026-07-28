import type { DiscoveredJobLite, PortalDiscoveryAdapter, DiscoveryContext } from "../types.js";
import { pauseForVerification } from "../../browser/verification.js";
import { pacer, withRetry } from "../rate-limit.js";

export const monsterDiscoveryAdapter: PortalDiscoveryAdapter = {
  source: "monster",

  async discover(context: DiscoveryContext): Promise<void> {
    const { page, keyword, location, settings, checkpoint, onPageProcessed, portalConfig } = context;
    if (!portalConfig) {
      throw new Error(
        `monster adapter requires a portalConfig (config/portals.yml entry with id "monster") in the discovery context`,
      );
    }
    if (!portalConfig.jobLinkSelector) {
      throw new Error(`Portal "${portalConfig.id}" (monster) is missing required "jobLinkSelector"`);
    }
    const jobLinkSelector = portalConfig.jobLinkSelector;
    const startPage = checkpoint.lastPage + 1;
    const pace = pacer(settings.delayBetweenRequestsMs);
    const keywordParam = portalConfig.keywordParam ?? "q";
    const locationParam = portalConfig.locationParam ?? "where";

    for (let pageNum = startPage; pageNum <= settings.maxPagesPerSource; pageNum++) {
      // Monster allows pagination via page query parameter -- "page" is pagination logic,
      // not a portal-identity selector, kept hardcoded per adapter.
      const url = `${portalConfig.baseUrl}?${keywordParam}=${encodeURIComponent(keyword)}&${locationParam}=${encodeURIComponent(location)}&page=${pageNum}`;

      await pace(url);
      await withRetry(
        () => page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs }),
        { retries: 2, backoffMs: 500 },
      );
      const verification = await pauseForVerification(page);
      if (verification.detected) {
        context.onVerificationPause?.();
      }

      // Selectors for Monster (from config/portals.yml's "monster" entry)
      const cards = await page.$$(portalConfig.resultCardSelector);

      if (cards.length === 0) {
        break;
      }

      const jobs: DiscoveredJobLite[] = [];
      for (const card of cards) {
        const title = await card.$eval(portalConfig.titleSelector, (el) => el.textContent?.trim() ?? "").catch(() => "");
        const href = await card.$eval(jobLinkSelector, (el) => (el as HTMLAnchorElement).href).catch(() => "");
        const company = portalConfig.companySelector
          ? await card.$eval(portalConfig.companySelector, (el) => el.textContent?.trim() ?? "").catch(() => "")
          : "";
        const loc = await card.$eval(portalConfig.locationSelector, (el) => el.textContent?.trim() ?? "").catch(() => "");
        const salary = portalConfig.salarySelector
          ? await card.$eval(portalConfig.salarySelector, (el) => el.textContent?.trim() ?? null).catch(() => null)
          : null;
        const age = portalConfig.dateSelector
          ? await card.$eval(portalConfig.dateSelector, (el) => el.textContent?.trim() ?? null).catch(() => null)
          : null;

        if (!href || !title) continue;

        // Try to extract a jobId from url or use url hash/pathname
        const urlObj = new URL(href);
        const jobId = urlObj.pathname.split("/").pop() || href;

        jobs.push({
          source: "monster",
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
