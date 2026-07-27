import type { DiscoveredJobLite, PortalDiscoveryAdapter, DiscoveryContext } from "../types.js";
import { pauseForVerification } from "../../browser/verification.js";
import { pacer, withRetry } from "../rate-limit.js";

export const linkedinPublicDiscoveryAdapter: PortalDiscoveryAdapter = {
  source: "linkedin-public",

  async discover(context: DiscoveryContext): Promise<void> {
    const { page, keyword, location, settings, checkpoint, onPageProcessed, portalConfig } = context;
    if (!portalConfig) {
      throw new Error(
        `linkedin-public adapter requires a portalConfig (config/portals.yml entry with id "linkedin-public") in the discovery context`,
      );
    }
    if (!portalConfig.jobLinkSelector) {
      throw new Error(`Portal "${portalConfig.id}" (linkedin-public) is missing required "jobLinkSelector"`);
    }
    const jobLinkSelector = portalConfig.jobLinkSelector;
    const startPage = checkpoint.lastPage + 1;
    const pace = pacer(settings.delayBetweenRequestsMs);
    const keywordParam = portalConfig.keywordParam ?? "keywords";
    const locationParam = portalConfig.locationParam ?? "location";

    for (let pageNum = startPage; pageNum <= settings.maxPagesPerSource; pageNum++) {
      // "start" is LinkedIn's pagination-offset param, not a portal-identity selector, kept
      // hardcoded per adapter.
      const startParam = (pageNum - 1) * 25;
      const url = `${portalConfig.baseUrl}?${keywordParam}=${encodeURIComponent(keyword)}&${locationParam}=${encodeURIComponent(location)}&start=${startParam}`;

      await pace(url);
      await withRetry(
        () => page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs }),
        { retries: 2, backoffMs: 500 },
      );
      await pauseForVerification(page);

      // Selectors for LinkedIn public (from config/portals.yml's "linkedin-public" entry)
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
          ? await card.$eval(portalConfig.dateSelector, (el) => el.textContent?.trim() ?? el.getAttribute("datetime") ?? null).catch(() => null)
          : null;

        if (!href || !title) continue;

        // Try to extract a jobId (often found in pathname or via data-entity-urn or similar)
        // e.g. /jobs/view/software-engineer-at-google-3929492 or similar.
        const urn = await card.getAttribute("data-entity-urn").catch(() => null);
        let jobId: string | null = urn ? (urn.split(":").pop() ?? null) : null;
        if (!jobId) {
          const viewMatch = href.match(/view\/(\d+)/) || href.match(/view\/([a-zA-Z0-9-]+)/);
          jobId = viewMatch ? viewMatch[1]! : href;
        }

        jobs.push({
          source: "linkedin-public",
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
