import type { BrowserContext, Page } from "playwright";
import type { DiscoveredJobLite } from "../discovery/types.js";
import type { JobPosting, RawJobDetail } from "../adapters/types.js";
import { loadCompanyRegistry } from "../config/loader.js";
import { resolveAdapter } from "../adapters/registry.js";
import { computeJobId } from "../dedup/canonicalize-url.js";
import { extractRequiredYears } from "../extraction/metadata.js";
import { stripHtml } from "../extraction/jd-cleaner.js";
import type { SiteConfig } from "../types.js";
import type { CompanyRegistryEntry } from "../config/schema.js";
import { pauseForVerification } from "../browser/verification.js";
import { pacer, withRetry } from "../discovery/rate-limit.js";
import {
  extractGreenhouseJidParam,
  hostMatchesDomain,
  parseAtsPostingUrl,
  stampResolution,
  type ExtractionMethod,
} from "../domain/canonical-job.js";
import path from "node:path";

const RETRY_OPTS = { retries: 2, backoffMs: 500 };

export async function resolveRedirects(url: string): Promise<string> {
  try {
    const res = await withRetry(
      () =>
        fetch(url, {
          method: "GET",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
          redirect: "follow",
        }),
      RETRY_OPTS,
    );
    return res.url || url;
  } catch {
    return url;
  }
}

export async function resolveRedirectsWithPlaywright(
  url: string,
  context?: BrowserContext,
  pace: (url: string) => Promise<void> = pacer(500),
): Promise<string> {
  if (!context) return resolveRedirects(url);

  const urlObj = new URL(url);
  if (!urlObj.hostname.includes("indeed.com") && !urlObj.hostname.includes("linkedin.com") && !urlObj.hostname.includes("monster.com")) {
    const fastUrl = await resolveRedirects(url);
    if (fastUrl !== url) return fastUrl;
  }

  const page = await context.newPage();
  try {
    await pace(url);
    await withRetry(
      () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }),
      RETRY_OPTS,
    ).catch(() => undefined);
    await pauseForVerification(page);
    return page.url();
  } catch {
    return url;
  } finally {
    await page.close();
  }
}

/**
 * Maps a final posting URL to a registry employer using PARSED URL parts only:
 *  1. a hosted ATS board whose slug the registry ties to the company (exact host + slug), then
 *  2. the company's corporate domain (exact host or subdomain), then
 *  3. the company's registry careers URL (same host and path prefix).
 * A company domain appearing inside a query string or another host's path matches nothing.
 */
export function matchCompany(url: string, registry: CompanyRegistryEntry[]): CompanyRegistryEntry | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();

  const ats = parseAtsPostingUrl(url);
  if (ats?.board) {
    const byBoard = registry.find(
      (c) => c.atsType === ats.ats && c.atsTenantOrBoardId !== null && c.atsTenantOrBoardId.toLowerCase() === ats.board!.toLowerCase(),
    );
    if (byBoard) return byBoard;
  }

  const byDomain = registry.find((c) => c.corporateDomain !== null && hostMatchesDomain(host, c.corporateDomain));
  if (byDomain) return byDomain;

  for (const c of registry) {
    if (c.careersUrl === null) continue;
    try {
      const careers = new URL(c.careersUrl);
      const careersPath = careers.pathname.replace(/\/+$/, "");
      if (
        careers.hostname.toLowerCase() === host &&
        careersPath.length > 0 &&
        (parsed.pathname === careersPath || parsed.pathname.startsWith(`${careersPath}/`))
      ) {
        return c;
      }
    } catch {
      // Registry entry with an unparseable careers URL never matches.
    }
  }
  return null;
}

function detectAtsType(url: string): "greenhouse" | "lever" | "workday" | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (hostMatchesDomain(host, "greenhouse.io")) return "greenhouse";
  if (hostMatchesDomain(host, "lever.co")) return "lever";
  if (hostMatchesDomain(host, "myworkdayjobs.com")) return "workday";
  return null;
}

async function extractFallback(page: Page, url: string): Promise<RawJobDetail> {
  const title = await page.title().catch(() => "");
  const descriptionHtml = await page.evaluate(() => {
    const selectors = [
      ".job-description", ".description", "#job-description", 
      "[class*='description']", "article", "main", ".content"
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.textContent && el.textContent.trim().length > 200) {
        return el.innerHTML;
      }
    }
    // No description container found. Returning document.body here used to turn navigation
    // menus and cookie banners into a "JD"; fail closed instead (empty -> JD_EXTRACTION_FAILED).
    return "";
  }).catch(() => "");

  return {
    externalId: url,
    title: title || "Job Posting",
    descriptionText: stripHtml(descriptionHtml),
    descriptionHtml: descriptionHtml || null,
    location: null, // never fabricated; resolve() falls back to the listing's own location
    department: null,
    employmentType: null,
    requisitionId: null,
    postingDate: null,
    salaryText: null,
    canonicalUrl: url,
    applyUrl: url,
    rawMetadata: {},
  };
}

export class PostingResolver {
  private registry: CompanyRegistryEntry[];
  // One pacer per resolver instance (i.e. per discovery run), not module-level -- resolve()
  // is called once per job, so pacing only does anything useful if it persists across those
  // calls, but scoped to this instance so unrelated PostingResolver instances (e.g. separate
  // test cases, or any future multi-run process) never share pacing state by accident.
  private pace = pacer(500);

  constructor(registryPath: string = path.resolve("config/fortune500-registry.json")) {
    this.registry = loadCompanyRegistry(registryPath);
  }

  async resolve(job: DiscoveredJobLite, context?: BrowserContext): Promise<JobPosting | null> {
    const finalUrl = await resolveRedirectsWithPlaywright(job.resultUrl, context, this.pace);
    const now = new Date().toISOString();

    const companyMatch = matchCompany(finalUrl, this.registry);
    const atsType = companyMatch?.atsType || detectAtsType(finalUrl);

    let details: RawJobDetail | null = null;
    let extractionMethod: ExtractionMethod = "ats-api";
    // Job id the ATS API itself reported; cross-checked against the id in the URL.
    let apiJobId: string | null = null;
    let sourceType: JobPosting["sourceType"] = "portal";
    let companyName = job.company;

    if (companyMatch) {
      companyName = companyMatch.company;
      sourceType = "company-careers";
    }

    // Workday needs a real per-job "site" path segment: a registry-verified
    // atsWorkdaySite value, or one already present in the discovered URL. Never fabricate
    // a default like "careers" -- matches company-careers.ts's skip-rather-than-guess rule
    // for the same field. Compute it up front so we can skip the ATS-adapter path entirely
    // when it can't be determined, and fall through to the generic Playwright DOM-scrape
    // fallback below instead of guessing.
    const workdayUrlParts = atsType === "workday" ? new URL(finalUrl).pathname.split("/") : null;
    const workdaySite = atsType === "workday" ? companyMatch?.atsWorkdaySite || workdayUrlParts?.[3] || null : null;

    // The registry can now carry atsType values (ashby, icims, unknown) with no native
    // adapter -- narrowed out inline here (TS control-flow narrowing needs the literal
    // comparisons directly in this expression, not behind a separate boolean) rather than
    // widening AdapterKind, since CareerOps is the intended discovery/resolution path for
    // those, not this native resolver.
    if (
      (atsType === "greenhouse" || atsType === "lever" || atsType === "workday" || atsType === "generic") &&
      context &&
      (atsType !== "workday" || workdaySite)
    ) {
      const site: SiteConfig = {
        id: companyMatch ? `company-careers::${companyMatch.company.toLowerCase()}` : `resolved-ats::${atsType}`,
        name: companyName,
        url: finalUrl,
        adapter: atsType,
        enabled: true,
      };

      let boardToken = companyMatch?.atsTenantOrBoardId || undefined;
      let leverSite = companyMatch?.atsTenantOrBoardId || undefined;

      const hostedAts = parseAtsPostingUrl(finalUrl);
      if (atsType === "greenhouse") {
        boardToken = boardToken || (hostedAts?.ats === "greenhouse" ? hostedAts.board ?? undefined : undefined);
        site.greenhouse = { boardToken };
      } else if (atsType === "lever") {
        leverSite = leverSite || (hostedAts?.ats === "lever" ? hostedAts.board ?? undefined : undefined);
        site.lever = { site: leverSite };
      } else if (atsType === "workday") {
        const urlObj = new URL(finalUrl);
        site.workday = {
          hostname: urlObj.hostname,
          tenant: companyMatch?.atsTenantOrBoardId || workdayUrlParts?.[2] || "",
          site: workdaySite!,
        };
      }

      try {
        const genericDeps = { context, onVerificationPause: () => {} };
        const adapter = resolveAdapter(site, genericDeps);
        
        let rawMetadata: Record<string, unknown> = {};

        // Greenhouse and Lever adapters do not execute HTTP queries in fetchJobDetails;
        // they transform the job's rawMetadata. We need to query their APIs.
        let postingId: string | null = null;
        if (atsType === "greenhouse" && boardToken) {
          const jobMatch = finalUrl.match(/jobs\/(\d+)/i) || finalUrl.match(/jobs=([^&]+)/);
          const jobId = (jobMatch ? jobMatch[1] : null) ?? extractGreenhouseJidParam(finalUrl);
          postingId = jobId ?? null;
          if (jobId) {
            const apiRes = await withRetry(
              () => fetch(`https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs/${jobId}`),
              RETRY_OPTS,
            );
            if (apiRes.ok) {
              rawMetadata = (await apiRes.json().catch(() => ({}))) as Record<string, unknown>;
            }
          }
        } else if (atsType === "lever" && leverSite) {
          const postMatch = finalUrl.match(/jobs\.lever\.co\/[^/]+\/([^/?#]+)/i);
          const postId = postMatch ? postMatch[1] : null;
          postingId = postId ?? null;
          if (postId) {
            const apiRes = await withRetry(
              () => fetch(`https://api.lever.co/v0/postings/${leverSite}/${postId}`),
              RETRY_OPTS,
            );
            if (apiRes.ok) {
              rawMetadata = (await apiRes.json().catch(() => ({}))) as Record<string, unknown>;
            }
          }
        }

        // Greenhouse/Lever: an ATS call that returned nothing must NOT flow into the adapter,
        // which would happily emit an empty title/description. Leave details null so the
        // headed-browser extraction below gets a chance, and the persistence gate sees the
        // honest outcome otherwise.
        const needsApiData = atsType === "greenhouse" || atsType === "lever";
        if (needsApiData && Object.keys(rawMetadata).length === 0) {
          throw new Error(`${atsType} API returned no data for ${postingId ? `job ${postingId}` : "this URL"}`);
        }
        if (needsApiData && rawMetadata.id !== undefined && rawMetadata.id !== null) {
          apiJobId = String(rawMetadata.id);
        }

        const discJob = {
          externalId: needsApiData ? postingId ?? finalUrl : finalUrl,
          title: job.title,
          url: finalUrl,
          matchedProfiles: job.matchedProfiles,
          rawMetadata,
        };

        if (atsType === "workday") {
          const pathParts = finalUrl.split("/");
          const externalPath = pathParts[pathParts.length - 1] || "";
          discJob.externalId = externalPath;
        }

        details = await adapter.fetchJobDetails(discJob, site, {
          maxPagesPerSource: 1,
          maxJobsPerSource: 1,
          navigationTimeoutMs: 15000,
          delayBetweenRequestsMs: 0,
        });

      } catch (err) {
        console.error(`[resolver] ATS extraction failed for ${finalUrl}: ${(err as Error).message}`);
      }
    }

    if (!details && context) {
      const page = await context.newPage();
      try {
        await page.goto(finalUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined);
        await pauseForVerification(page);
        details = await extractFallback(page, finalUrl);
        extractionMethod = "browser-dom";
      } catch (err) {
        console.error(`[resolver] Fallback extraction failed for ${finalUrl}: ${(err as Error).message}`);
      } finally {
        await page.close();
      }
    }

    if (!details) {
      details = {
        externalId: job.sourceJobId || finalUrl,
        title: job.title,
        descriptionText: `Job posting found on ${job.source}. Full description not extracted.`,
        descriptionHtml: null,
        location: job.location,
        department: null,
        employmentType: null,
        requisitionId: job.sourceJobId,
        postingDate: null,
        salaryText: job.salarySnippet,
        canonicalUrl: finalUrl,
        applyUrl: finalUrl,
        rawMetadata: {},
      };
    }

    const posting: JobPosting = {
      id: computeJobId(details.canonicalUrl),
      source: companyMatch ? `company-careers::${companyMatch.company.toLowerCase()}` : job.source,
      sourceType,
      company: companyName,
      title: details.title || job.title,
      location: details.location || job.location,
      remoteType: null,
      employmentType: details.employmentType,
      department: details.department,
      requisitionId: details.requisitionId || job.sourceJobId,
      postingDate: details.postingDate,
      discoveredAt: now,
      lastSeenAt: now,
      canonicalUrl: details.canonicalUrl,
      applyUrl: details.applyUrl,
      descriptionText: details.descriptionText,
      descriptionHtml: details.descriptionHtml,
      requiredYears: extractRequiredYears(details.descriptionText),
      salaryText: details.salaryText || job.salarySnippet,
      matchedProfiles: job.matchedProfiles,
      discoveredFrom: [job.source],
      discoveredUrl: job.resultUrl,
      matchedKeywords: job.matchedKeywords,
      relevanceReason: job.relevanceReason,
      rawMetadata: details.rawMetadata || {},
    };

    // The "no details at all" placeholder above carries no JD; stamping marks it unresolved
    // (placeholder description) so it can never be mistaken for an extracted posting.
    return stampResolution(posting, {
      sourceKind: job.source,
      observedUrl: job.resultUrl,
      observedAt: job.discoveredAt,
      finalUrl,
      extractionMethod,
      discoveredCompany: job.company,
      registryEntry: companyMatch,
      apiJobId,
      now,
    });
  }
}
