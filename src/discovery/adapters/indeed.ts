import type { DiscoveredJobLite, PortalDiscoveryAdapter, DiscoveryContext } from "../types.js";
import { pauseForVerification } from "../../browser/verification.js";

export const indeedDiscoveryAdapter: PortalDiscoveryAdapter = {
  source: "indeed",

  async discover(context: DiscoveryContext): Promise<void> {
    const { page, keyword, location, settings, checkpoint, onPageProcessed } = context;
    const startPage = checkpoint.lastPage + 1;

    for (let pageNum = startPage; pageNum <= settings.maxPagesPerSource; pageNum++) {
      const startParam = (pageNum - 1) * 10;
      const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}&start=${startParam}`;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs });
      await pauseForVerification(page);

      // Selectors for Indeed
      const cardSelector = ".job_seen_beacon";
      const cards = await page.$$(cardSelector);

      if (cards.length === 0) {
        // No results on this page, or we've reached the end
        break;
      }

      const jobs: DiscoveredJobLite[] = [];
      for (const card of cards) {
        const title = await card.$eval("span[id^='jobTitle']", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const href = await card.$eval("a.jcs-JobTitle", (el) => (el as HTMLAnchorElement).href).catch(() => "");
        const company = await card.$eval("[data-testid='company-name']", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const loc = await card.$eval("[data-testid='text-location']", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const salary = await card.$eval(".salary-snippet-container, .estimated-salary-container", (el) => el.textContent?.trim() ?? null).catch(() => null);
        const age = await card.$eval("span.date", (el) => el.textContent?.trim() ?? null).catch(() => null);

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
