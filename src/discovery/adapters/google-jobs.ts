import type { DiscoveredJobLite, PortalDiscoveryAdapter, DiscoveryContext } from "../types.js";
import { pauseForVerification } from "../../browser/verification.js";
import { pacer, withRetry } from "../rate-limit.js";

export const googleJobsDiscoveryAdapter: PortalDiscoveryAdapter = {
  source: "google-jobs",

  async discover(context: DiscoveryContext): Promise<void> {
    const { page, keyword, location, settings, checkpoint, onPageProcessed, portalConfig } = context;
    if (!portalConfig) {
      throw new Error(
        `google-jobs adapter requires a portalConfig (config/portals.yml entry with id "google-jobs") in the discovery context`,
      );
    }
    const startPage = checkpoint.lastPage + 1;
    const pace = pacer(settings.delayBetweenRequestsMs);

    // Google Jobs is typically accessed via Google search with "ibp=htl;jobs" -- that query
    // param is Google-Jobs-specific URL-building logic, not a portal-identity selector, so
    // it stays hardcoded here (same as the "start" pagination param in indeed.ts).
    const keywordParam = portalConfig.keywordParam ?? "q";
    const url = `${portalConfig.baseUrl}?${keywordParam}=${encodeURIComponent(keyword + " jobs " + location)}&ibp=htl;jobs`;

    await pace(url);
    await withRetry(
      () => page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs }),
      { retries: 2, backoffMs: 500 },
    );
    const initialVerification = await pauseForVerification(page);
    if (initialVerification.detected) {
      context.onVerificationPause?.();
    }

    // Google Jobs uses an infinite scrolling list of jobs on the left.
    // We scroll the container to load more results.
    let pageNum = startPage;
    let previousCount = 0;

    while (pageNum <= settings.maxPagesPerSource) {
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const verification = await pauseForVerification(page);
      if (verification.detected) {
        context.onVerificationPause?.();
      }

      // Selectors for Google Jobs (from config/portals.yml's "google-jobs" entry)
      const cards = await page.$$(portalConfig.resultCardSelector);
      if (cards.length === 0 || cards.length === previousCount) {
        break;
      }

      const jobs: DiscoveredJobLite[] = [];
      for (const card of cards) {
        const title = await card.$eval(portalConfig.titleSelector, (el) => el.textContent?.trim() ?? "").catch(() => "");
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

        // For Google Jobs, the "Apply on..." links inside the details view contain the redirect URL.
        // We can use the card's data attribute or fallback.
        const jobId = (await card.getAttribute("data-job-id").catch(() => null)) ||
                      (await card.getAttribute("id").catch(() => null)) ||
                      `${title}::${company}`;

        // Construct a pseudo resultUrl using jobId or fallback Google search URL.
        const resultUrl = `${portalConfig.baseUrl}?${keywordParam}=${encodeURIComponent(title + " " + company)}&ibp=htl;jobs#fpstate=tldetail&htidocid=${encodeURIComponent(jobId)}`;

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
          // No department/description available at portal-search-result time -- relevance
          // evaluation (orchestrator.ts) falls back to title/location only for this source.
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
