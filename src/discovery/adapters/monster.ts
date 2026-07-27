import type { DiscoveredJobLite, PortalDiscoveryAdapter, DiscoveryContext } from "../types.js";
import { pauseForVerification } from "../../browser/verification.js";

export const monsterDiscoveryAdapter: PortalDiscoveryAdapter = {
  source: "monster",

  async discover(context: DiscoveryContext): Promise<void> {
    const { page, keyword, location, settings, checkpoint, onPageProcessed } = context;
    const startPage = checkpoint.lastPage + 1;

    for (let pageNum = startPage; pageNum <= settings.maxPagesPerSource; pageNum++) {
      // Monster allows pagination via page query parameter
      const url = `https://www.monster.com/jobs/search?q=${encodeURIComponent(keyword)}&where=${encodeURIComponent(location)}&page=${pageNum}`;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs });
      await pauseForVerification(page);

      // Selectors for Monster
      const cardSelector = "article, [data-testid='job-card'], [class*='JobCard']";
      const cards = await page.$$(cardSelector);

      if (cards.length === 0) {
        break;
      }

      const jobs: DiscoveredJobLite[] = [];
      for (const card of cards) {
        const title = await card.$eval("[data-testid='job-title'], [class*='Title'], h2", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const href = await card.$eval("a", (el) => (el as HTMLAnchorElement).href).catch(() => "");
        const company = await card.$eval("[data-testid='job-company'], [class*='Company']", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const loc = await card.$eval("[data-testid='job-location'], [class*='Location']", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const salary = await card.$eval("[data-testid='job-salary'], [class*='Salary']", (el) => el.textContent?.trim() ?? null).catch(() => null);
        const age = await card.$eval("[data-testid='job-date'], [class*='Date']", (el) => el.textContent?.trim() ?? null).catch(() => null);

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
