import type { DiscoveredJobLite, PortalDiscoveryAdapter, DiscoveryContext } from "../types.js";
import { pauseForVerification } from "../../browser/verification.js";
import type { SiteConfig } from "../../types.js";

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

export function validateGenericPortalConfig(site: SiteConfig): void {
  const gp = site.generic as unknown as GenericPortalSelectors | undefined;
  if (!gp) {
    throw new Error(`Site "${site.id}" uses generic portal adapter but has no generic/selectors config`);
  }
  if (!gp.resultCardSelector || !gp.jobLinkSelector || !gp.titleSelector || !gp.locationSelector) {
    throw new Error(`Site "${site.id}" generic portal config is missing required selectors`);
  }
}

export const configurableGenericPortalAdapter: PortalDiscoveryAdapter = {
  source: "configurable-generic-portal",

  async discover(context: DiscoveryContext): Promise<void> {
    const { page, keyword, location, settings, checkpoint, onPageProcessed } = context;
    const startPage = checkpoint.lastPage + 1;

    // We expect the config to be passed in some site settings, but for this discovery adapter,
    // we can retrieve the selector set from generic metadata in SiteConfig if passed.
    // If not, we fall back to generic selectors or a placeholder.
    // Let's assume the site config is passed in context or options.
    // Wait, how does the orchestrator pass site details? We can attach siteConfig to context or options.
    // Let's modify DiscoveryContext to include siteConfig if needed!
    // Wait! Let's check DiscoveryContext again. It does not have siteConfig. Let's add it!
    // Yes! Let's extend DiscoveryContext to include the SiteConfig object.
    const siteConfig = (context as any).siteConfig as SiteConfig;
    if (!siteConfig) {
      throw new Error("Generic Portal adapter requires siteConfig in the discovery context");
    }

    validateGenericPortalConfig(siteConfig);
    const gp = siteConfig.generic as unknown as GenericPortalSelectors;

    for (let pageNum = startPage; pageNum <= settings.maxPagesPerSource; pageNum++) {
      let url = siteConfig.url;
      if (gp.searchUrlTemplate) {
        url = gp.searchUrlTemplate
          .replace("{{keyword}}", encodeURIComponent(keyword))
          .replace("{{location}}", encodeURIComponent(location))
          .replace("{{page}}", String(pageNum));
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs });
      } else {
        if (pageNum === startPage) {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs });
          await pauseForVerification(page);
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

      await pauseForVerification(page);

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
          : siteConfig.name;
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
          source: siteConfig.id,
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
