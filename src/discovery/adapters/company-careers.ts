import type { DiscoveredJobLite, PortalDiscoveryAdapter, DiscoveryContext } from "../types.js";
import { resolveAdapter } from "../../adapters/registry.js";
import { loadCompanyRegistry } from "../../config/loader.js";
import type { SiteConfig, RoleConfig } from "../../types.js";
import path from "node:path";

export const companyCareersDiscoveryAdapter: PortalDiscoveryAdapter = {
  source: "company-careers",

  async discover(context: DiscoveryContext): Promise<void> {
    const { page, keyword, settings, checkpoint, onPageProcessed } = context;

    const registryPath = path.resolve("config/fortune500-registry.json");
    const companies = loadCompanyRegistry(registryPath);

    const searches = [
      {
        keyword: keyword,
        profileIds: context.profileIds,
      },
    ];

    const startIndex = checkpoint.lastPage;

    // Only greenhouse/lever registry entries carry enough verified data to build a real
    // SiteConfig today (a boardToken/site slug). Workday needs a verified per-company ATS
    // "site" segment and generic needs verified per-company selectors -- neither field
    // exists on the registry schema yet (added in Task 2). Rather than guess a Workday
    // "site" value or reuse placeholder CSS selectors against a page we've never verified,
    // those companies are skipped with a clear, itemized reason until the registry can
    // supply real data.
    let readyCount = 0;
    const skipped: { company: string; atsType: string; reason: string; missingFields: string[] }[] = [];

    // checkpointCursor is the resume point persisted to disk. It only advances past a
    // company once that company has been attempted (successfully or as a structural skip);
    // it freezes at the first *failure* so a future --resume retries that company instead
    // of silently skipping it forever. Within this run we still attempt every remaining
    // company once -- no retry loop within a single run.
    let checkpointCursor = startIndex;
    let hitFailure = false;

    for (let i = startIndex; i < companies.length; i++) {
      const company = companies[i]!;
      const companyName = company.company.toLowerCase();
      console.log(`[company-careers] Processing company: ${company.company} (${company.atsType})`);

      if (company.atsType === "workday") {
        console.log(`[company-careers] Skipping ${company.company}: workday requires a verified per-company ATS site identifier not yet stored in the registry. No site value guessed.`);
        skipped.push({
          company: company.company,
          atsType: company.atsType,
          reason: "missing verified Workday ATS site identifier",
          missingFields: ["atsWorkdaySite"],
        });
        if (!hitFailure) checkpointCursor = i + 1;
        await onPageProcessed([], checkpointCursor);
        continue;
      }

      if (company.atsType === "generic") {
        console.log(`[company-careers] Skipping ${company.company}: generic ATS requires verified per-company selectors not yet stored in the registry. No placeholder selectors used.`);
        skipped.push({
          company: company.company,
          atsType: company.atsType,
          reason: "missing verified generic-portal selectors",
          missingFields: ["genericSelectors"],
        });
        if (!hitFailure) checkpointCursor = i + 1;
        await onPageProcessed([], checkpointCursor);
        continue;
      }

      try {
        const site: SiteConfig = {
          id: `company-careers::${companyName}`,
          name: company.company,
          url: company.careersUrl,
          adapter: company.atsType,
          enabled: true,
        };

        if (company.atsType === "greenhouse") {
          site.greenhouse = { boardToken: company.atsTenantOrBoardId || undefined };
        } else if (company.atsType === "lever") {
          site.lever = { site: company.atsTenantOrBoardId || undefined };
        }

        const genericDeps = {
          context: page.context(),
          onVerificationPause: () => {
            if (context.onVerificationPause) {
              context.onVerificationPause();
            }
          },
        };
        const adapter = resolveAdapter(site, genericDeps);

        const discovered = await adapter.discoverJobs(site, searches, settings);

        // Greenhouse/Lever's fetchJobDetails is a pure local transform over data already
        // fetched by discoverJobs (SourceAdapter.fetchesPerJob === false) -- calling it here
        // is free and gives the real location instead of guessing one. Workday/generic (both
        // skipped above) are the only adapters where fetchesPerJob is true; if that ever
        // changes, this still only fetches real data, never fabricates it.
        const jobs: DiscoveredJobLite[] = [];
        for (const job of discovered) {
          let location = "";
          let salarySnippet: string | null = null;
          if (!adapter.fetchesPerJob) {
            const raw = await adapter.fetchJobDetails(job, site, settings);
            location = raw.location ?? "";
            salarySnippet = raw.salaryText;
          }
          jobs.push({
            source: "company-careers",
            searchKeyword: keyword,
            title: job.title,
            company: company.company,
            location,
            salarySnippet,
            resultUrl: job.url,
            possibleOfficialUrl: job.url,
            postingAgeOrDate: null,
            sourceJobId: job.externalId,
            discoveredAt: new Date().toISOString(),
            matchedProfiles: job.matchedProfiles,
          });
        }

        const newJobs = jobs.filter((j) => {
          if (!j.sourceJobId) return true;
          const key = `${companyName}::${j.sourceJobId}`;
          if (checkpoint.sourceJobIds.includes(key)) return false;
          checkpoint.sourceJobIds.push(key);
          return true;
        });

        readyCount += 1;
        if (!hitFailure) checkpointCursor = i + 1;
        await onPageProcessed(newJobs, checkpointCursor);
      } catch (err) {
        hitFailure = true;
        console.error(
          `[company-careers] Error processing company ${company.company}: ${(err as Error).message}. Checkpoint held at index ${checkpointCursor} -- will retry on next --resume.`,
        );
        await onPageProcessed([], checkpointCursor);
      }
    }

    console.log(
      `[company-careers] Registry coverage: ${readyCount} ready, ${skipped.length} skipped, ${companies.length} total. ` +
        (skipped.length > 0
          ? `Skipped: ${skipped.map((s) => `${s.company} (${s.reason})`).join("; ")}`
          : "No skips."),
    );
  },
};
