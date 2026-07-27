import type { DiscoveredJobLite, PortalDiscoveryAdapter, DiscoveryContext } from "../types.js";
import { pauseForVerification } from "../../browser/verification.js";

export const linkedinPublicDiscoveryAdapter: PortalDiscoveryAdapter = {
  source: "linkedin-public",

  async discover(context: DiscoveryContext): Promise<void> {
    const { page, keyword, location, settings, checkpoint, onPageProcessed } = context;
    const startPage = checkpoint.lastPage + 1;

    for (let pageNum = startPage; pageNum <= settings.maxPagesPerSource; pageNum++) {
      const startParam = (pageNum - 1) * 25;
      const url = `https://www.linkedin.com/jobs/search?keywords=${encodeURIComponent(keyword)}&location=${encodeURIComponent(location)}&start=${startParam}`;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs });
      await pauseForVerification(page);

      // Selectors for LinkedIn public
      const cardSelector = ".job-search-card, .base-search-card, li[data-id]";
      const cards = await page.$$(cardSelector);

      if (cards.length === 0) {
        break;
      }

      const jobs: DiscoveredJobLite[] = [];
      for (const card of cards) {
        const title = await card.$eval(".base-search-card__title, h3", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const href = await card.$eval("a.base-card__full-link, a", (el) => (el as HTMLAnchorElement).href).catch(() => "");
        const company = await card.$eval(".base-search-card__subtitle, h4, [class*='subtitle']", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const loc = await card.$eval(".job-search-card__location, span[class*='location']", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const salary = await card.$eval(".job-search-card__salary-info", (el) => el.textContent?.trim() ?? null).catch(() => null);
        const age = await card.$eval("time, .job-search-card__listdate", (el) => el.textContent?.trim() ?? el.getAttribute("datetime") ?? null).catch(() => null);

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
