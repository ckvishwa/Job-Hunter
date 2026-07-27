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
import path from "node:path";

export async function resolveRedirects(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });
    return res.url || url;
  } catch {
    return url;
  }
}

export async function resolveRedirectsWithPlaywright(url: string, context?: BrowserContext): Promise<string> {
  if (!context) return resolveRedirects(url);

  const urlObj = new URL(url);
  if (!urlObj.hostname.includes("indeed.com") && !urlObj.hostname.includes("linkedin.com") && !urlObj.hostname.includes("monster.com")) {
    const fastUrl = await resolveRedirects(url);
    if (fastUrl !== url) return fastUrl;
  }

  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined);
    await pauseForVerification(page);
    return page.url();
  } catch {
    return url;
  } finally {
    await page.close();
  }
}

function matchCompany(url: string, registry: CompanyRegistryEntry[]): CompanyRegistryEntry | null {
  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname.toLowerCase();
    const urlLower = url.toLowerCase();
    
    // Check domain or careersUrl matching
    for (const company of registry) {
      if (
        host.includes(company.corporateDomain.toLowerCase()) ||
        urlLower.includes(company.corporateDomain.toLowerCase()) ||
        urlLower.includes(company.careersUrl.toLowerCase())
      ) {
        return company;
      }
    }
  } catch {
    // Ignore URL parse errors
  }
  return null;
}

function detectAtsType(url: string): "greenhouse" | "lever" | "workday" | null {
  const lower = url.toLowerCase();
  if (lower.includes("greenhouse.io") || lower.includes("boards.greenhouse.io")) return "greenhouse";
  if (lower.includes("lever.co") || lower.includes("jobs.lever.co")) return "lever";
  if (lower.includes("myworkdayjobs.com")) return "workday";
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
    return document.body.innerHTML;
  }).catch(() => "");

  return {
    externalId: url,
    title: title || "Job Posting",
    descriptionText: stripHtml(descriptionHtml),
    descriptionHtml: descriptionHtml || null,
    location: "Remote/Various",
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

  constructor() {
    const registryPath = path.resolve("config/fortune500-registry.json");
    this.registry = loadCompanyRegistry(registryPath);
  }

  async resolve(job: DiscoveredJobLite, context?: BrowserContext): Promise<JobPosting | null> {
    const finalUrl = await resolveRedirectsWithPlaywright(job.resultUrl, context);
    const now = new Date().toISOString();

    const companyMatch = matchCompany(finalUrl, this.registry);
    const atsType = companyMatch?.atsType || detectAtsType(finalUrl);

    let details: RawJobDetail | null = null;
    let sourceType: JobPosting["sourceType"] = "portal";
    let companyName = job.company;

    if (companyMatch) {
      companyName = companyMatch.company;
      sourceType = "company-careers";
    }

    if (atsType && context) {
      const site: SiteConfig = {
        id: companyMatch ? `company-careers::${companyMatch.company.toLowerCase()}` : `resolved-ats::${atsType}`,
        name: companyName,
        url: finalUrl,
        adapter: atsType,
        enabled: true,
      };

      let boardToken = companyMatch?.atsTenantOrBoardId || undefined;
      let leverSite = companyMatch?.atsTenantOrBoardId || undefined;

      if (atsType === "greenhouse") {
        const boardMatch = finalUrl.match(/boards\.greenhouse\.io\/([^/?#]+)/i);
        boardToken = boardToken || boardMatch?.[1];
        site.greenhouse = { boardToken };
      } else if (atsType === "lever") {
        const slugMatch = finalUrl.match(/jobs\.lever\.co\/([^/?#]+)/i);
        leverSite = leverSite || slugMatch?.[1];
        site.lever = { site: leverSite };
      } else if (atsType === "workday") {
        const urlObj = new URL(finalUrl);
        const parts = urlObj.pathname.split("/");
        site.workday = {
          hostname: urlObj.hostname,
          tenant: companyMatch?.atsTenantOrBoardId || parts[2] || "",
          site: parts[3] || "careers",
        };
      }

      try {
        const genericDeps = { context, onVerificationPause: () => {} };
        const adapter = resolveAdapter(site, genericDeps);
        
        let rawMetadata: Record<string, unknown> = {};

        // Greenhouse and Lever adapters do not execute HTTP queries in fetchJobDetails;
        // they transform the job's rawMetadata. We need to query their APIs.
        if (atsType === "greenhouse" && boardToken) {
          const jobMatch = finalUrl.match(/jobs\/(\d+)/i) || finalUrl.match(/jobs=([^&]+)/);
          const jobId = jobMatch ? jobMatch[1] : null;
          if (jobId) {
            const apiRes = await fetch(`https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs/${jobId}`);
            if (apiRes.ok) {
              rawMetadata = (await apiRes.json().catch(() => ({}))) as Record<string, unknown>;
            }
          }
        } else if (atsType === "lever" && leverSite) {
          const postMatch = finalUrl.match(/jobs\.lever\.co\/[^/]+\/([^/?#]+)/i);
          const postId = postMatch ? postMatch[1] : null;
          if (postId) {
            const apiRes = await fetch(`https://api.lever.co/v0/postings/${leverSite}/${postId}`);
            if (apiRes.ok) {
              rawMetadata = (await apiRes.json().catch(() => ({}))) as Record<string, unknown>;
            }
          }
        }

        const discJob = {
          externalId: finalUrl,
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

    return {
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
      rawMetadata: details.rawMetadata || {},
    };
  }
}
