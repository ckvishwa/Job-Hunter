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

    // Company completion isn't sequential (company 5 can fail while company 6 succeeds), so
    // unlike portal pagination's lastPage cursor, resume tracks exactly which companies are
    // done via checkpoint.completedCompanyKeys. Keyed by "company::corporateDomain" (the same
    // pair Task 2's registry schema already enforces as unique) rather than array index -- the
    // registry can grow/reorder between runs, and a raw index would silently point at the
    // wrong company after that. Every run considers every company, skipping only keys already
    // recorded as done; failed companies are retried each run/resume.
    if (!checkpoint.completedCompanyKeys) checkpoint.completedCompanyKeys = [];
    const completedKeys = checkpoint.completedCompanyKeys;
    const registryKey = (c: { company: string; corporateDomain: string }): string =>
      `${c.company.toLowerCase()}::${c.corporateDomain.toLowerCase()}`;

    // Only greenhouse/lever registry entries carry enough verified data to build a real
    // SiteConfig today (a boardToken/site slug). Workday needs a verified per-company ATS
    // "site" segment and generic needs verified per-company selectors -- neither field
    // exists on the registry schema yet (added in Task 2). Rather than guess a Workday
    // "site" value or reuse placeholder CSS selectors against a page we've never verified,
    // those companies are skipped with a clear, itemized reason until the registry can
    // supply real data.
    let readyCount = 0;
    const skipped: { company: string; atsType: string; reason: string; missingFields: string[] }[] = [];

    for (let i = 0; i < companies.length; i++) {
      const company = companies[i]!;
      const companyKey = registryKey(company);
      if (completedKeys.includes(companyKey)) continue;

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
        // A structural skip is a permanent, non-transient outcome (the registry data will
        // never appear mid-run) -- mark it done so it isn't reattempted every run. If the
        // registry is later filled in with real data for this company, a --reset-checkpoint
        // (or manually clearing this key) is required to retry it -- matches how a completed
        // success is handled, no separate mechanism invented for this narrower case.
        completedKeys.push(companyKey);
        await onPageProcessed([], i + 1);
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
        completedKeys.push(companyKey);
        await onPageProcessed([], i + 1);
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
        completedKeys.push(companyKey);
        await onPageProcessed(newJobs, i + 1);
      } catch (err) {
        console.error(
          `[company-careers] Error processing company ${company.company}: ${(err as Error).message}. Not marked complete -- will retry on next --resume.`,
        );
        await onPageProcessed([], i + 1);
      }
    }

    console.log(
      `[company-careers] Registry coverage: ${readyCount} ready, ${skipped.length} skipped, ${companies.length} total. ` +
        (skipped.length > 0
          ? `Skipped: ${skipped.map((s) => `${s.company} (${s.reason})`).join("; ")}`
          : "No skips."),
    );

    // The orchestrator marks the whole checkpoint `completed: true` unconditionally once
    // discover() returns without throwing (it has no visibility into per-company outcomes).
    // Since every per-company failure above is already caught, discover() would otherwise
    // never throw and the orchestrator would wrongly mark this source::keyword::location
    // combo fully done even with companies pending retry -- which would make --resume never
    // re-enter this adapter at all (the orchestrator skips already-`completed` checkpoints
    // before calling discover()). Throwing here, after every company's real work and
    // checkpointing has already happened via onPageProcessed, keeps `checkpoint.completed`
    // false so a future run retries exactly the still-incomplete companies.
    if (completedKeys.length < companies.length) {
      throw new Error(
        `[company-careers] ${companies.length - completedKeys.length} of ${companies.length} companies not completed this run (failures); will retry on next --resume.`,
      );
    }
  },
};
