import type { DiscoveredJobLite, PortalDiscoveryAdapter, DiscoveryContext } from "../types.js";
import { pauseForVerification } from "../../browser/verification.js";
import { pacer, withRetry } from "../rate-limit.js";

export const indeedDiscoveryAdapter: PortalDiscoveryAdapter = {
  source: "indeed",

  async discover(context: DiscoveryContext): Promise<void> {
    const { page, keyword, location, settings, checkpoint, onPageProcessed, portalConfig } = context;
    if (!portalConfig) {
      throw new Error(
        `indeed adapter requires a portalConfig (config/portals.yml entry with id "indeed") in the discovery context`,
      );
    }
    if (!portalConfig.jobLinkSelector) {
      throw new Error(`Portal "${portalConfig.id}" (indeed) is missing required "jobLinkSelector"`);
    }
    const jobLinkSelector = portalConfig.jobLinkSelector;
    const startPage = checkpoint.lastPage + 1;
    const pace = pacer(settings.delayBetweenRequestsMs);
    const keywordParam = portalConfig.keywordParam ?? "q";
    const locationParam = portalConfig.locationParam ?? "l";

    for (let pageNum = startPage; pageNum <= settings.maxPagesPerSource; pageNum++) {
      // "start" is Indeed's pagination-offset param, not a portal-identity selector -- kept
      // hardcoded per adapter (pagination logic, not config).
      const startParam = (pageNum - 1) * 10;
      const url = `${portalConfig.baseUrl}?${keywordParam}=${encodeURIComponent(keyword)}&${locationParam}=${encodeURIComponent(location)}&start=${startParam}`;

      await pace(url);
      await withRetry(
        () => page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs }),
        { retries: 2, backoffMs: 500 },
      );
      const verification = await pauseForVerification(page);
      if (verification.detected) {
        context.onVerificationPause?.();
      }

      // Selectors for Indeed (from config/portals.yml's "indeed" entry)
      const cards = await page.$$(portalConfig.resultCardSelector);

      if (cards.length === 0) {
        // No results on this page, or we've reached the end
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

        // Indeed result URLs are usually like indeed.com/rc/clk?jk=... or indeed.com/viewjob?jk=...
        const jkMatch = href.match(/[?&]jk=([^&]+)/);
        const jobId: string | null = jkMatch ? (jkMatch[1] ?? null) : null;

        jobs.push({
          source: "indeed",
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
          matchedProfiles: [], // Will be resolved by the orchestrator/matcher
        });
      }

      const beforeCount = checkpoint.sourceJobIds.length;
      const newJobs = jobs.filter((j) => {
        if (!j.sourceJobId) return true;
        if (checkpoint.sourceJobIds.includes(j.sourceJobId)) return false;
        checkpoint.sourceJobIds.push(j.sourceJobId);
        return true;
      });

      // Save checkpoints page-by-page and write results
      await onPageProcessed(newJobs, pageNum);

      // If no new job IDs were found on this page compared to before, we can stop
      if (checkpoint.sourceJobIds.length === beforeCount && pageNum > startPage) {
        break;
      }
    }
  },
};
