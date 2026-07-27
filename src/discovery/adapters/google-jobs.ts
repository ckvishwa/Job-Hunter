import type { DiscoveredJobLite, PortalDiscoveryAdapter, DiscoveryContext } from "../types.js";
import { pauseForVerification } from "../../browser/verification.js";

export const googleJobsDiscoveryAdapter: PortalDiscoveryAdapter = {
  source: "google-jobs",

  async discover(context: DiscoveryContext): Promise<void> {
    const { page, keyword, location, settings, checkpoint, onPageProcessed } = context;
    const startPage = checkpoint.lastPage + 1;

    // Google Jobs is typically accessed via Google search with "ibp=htl;jobs"
    const url = `https://www.google.com/search?q=${encodeURIComponent(keyword + " jobs " + location)}&ibp=htl;jobs`;

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs });
    await pauseForVerification(page);

    // Google Jobs uses an infinite scrolling list of jobs on the left.
    // We scroll the container to load more results.
    let pageNum = startPage;
    let previousCount = 0;

    while (pageNum <= settings.maxPagesPerSource) {
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await pauseForVerification(page);

      // Selectors for Google Jobs
      // Typical card selector: li, div[role='treeitem'], or .i3PoEe
      const cards = await page.$$("li[data-job-id], [role='treeitem'], .i3PoEe, [class*='JobCard']");
      if (cards.length === 0 || cards.length === previousCount) {
        break;
      }

      const jobs: DiscoveredJobLite[] = [];
      for (const card of cards) {
        const title = await card.$eval("[role='heading'], [class*='Title'], h2, h3", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const company = await card.$eval(".t7YFBb, .wTabPo, [class*='Company'], [class*='company']", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const loc = await card.$eval(".SuWscb, .Qk3OTc, [class*='Location'], [class*='location']", (el) => el.textContent?.trim() ?? "").catch(() => "");
        const salary = await card.$eval("[class*='Salary'], [class*='salary']", (el) => el.textContent?.trim() ?? null).catch(() => null);
        const age = await card.$eval("[class*='Date'], [class*='date'], span:has-text('ago')", (el) => el.textContent?.trim() ?? null).catch(() => null);

        // For Google Jobs, the "Apply on..." links inside the details view contain the redirect URL.
        // We can use the card's data attribute or fallback.
        const jobId = (await card.getAttribute("data-job-id").catch(() => null)) ||
                      (await card.getAttribute("id").catch(() => null)) ||
                      `${title}::${company}`;

        // Construct a pseudo resultUrl using jobId or fallback Google search URL.
        const resultUrl = `https://www.google.com/search?q=${encodeURIComponent(title + " " + company)}&ibp=htl;jobs#fpstate=tldetail&htidocid=${encodeURIComponent(jobId)}`;

        if (!title) continue;

        jobs.push({
          source: "google-jobs",
          searchKeyword: keyword,
          title,
          company,
          location: loc,
          salarySnippet: salary,
          resultUrl,
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

      // Scroll the job list panel to load more results.
      // Usually, there is a scrollable container for the list (role="tabpanel" or scrollable div).
      const scrollable = await page.$("[role='tabpanel'], [class*='scroll'], .active-list, #jsc");
      if (scrollable) {
        await scrollable.evaluate((el) => el.scrollBy(0, 1000)).catch(() => undefined);
      } else {
        await page.evaluate(() => window.scrollBy(0, 1000)).catch(() => undefined);
      }

      previousCount = cards.length;
      pageNum++;

      if (checkpoint.sourceJobIds.length === beforeCount && pageNum > startPage) {
        break;
      }
    }
  },
};
