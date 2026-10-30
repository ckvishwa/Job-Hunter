import type { JobPosting } from "../../adapters/types.js";
import { companyRegistryEntrySchema, type CompanyRegistryEntry } from "../../config/schema.js";
import { computeJobId } from "../../dedup/canonicalize-url.js";
import { assessJobDescription, evaluatePersistable, stampResolution } from "../../domain/canonical-job.js";
import { stripHtml } from "../../extraction/jd-cleaner.js";
import { fetchBoardPostings, type BoardCompany } from "../../pipeline/discovery/board-discoverer.js";
import { workdayAdapter } from "../../adapters/workday.js";
import type { SiteConfig } from "../../types.js";
import { postingDatePrecision } from "../posting-date.js";
import { assertFetchableUrl } from "../security/url-guard.js";
import { extractAtsHints, type AtsHint } from "./ats-hints.js";
import type { GuardedResponse } from "./guarded-get.js";
import { extractJsonLdJobs } from "./jsonld.js";
import {
  countDates,
  dedupeListings,
  JD_SAMPLE_LIMIT,
  type EmployerCounters,
  type ObservedRecord,
  type SourceError,
} from "./records.js";

export interface PilotEmployer {
  id: string;
  displayName: string;
  careersUrl: string;
  nameTokens: string[];
}

export interface CollectDeps {
  get: (url: string) => Promise<GuardedResponse>;
  now?: () => string;
  maxJds?: number;
  pace?: () => Promise<void>;
  loadBoard?: typeof fetchBoardPostings;
}

export interface EmployerCollection {
  counters: EmployerCounters;
  observed: ObservedRecord[];
  canonical: JobPosting[];
  errors: SourceError[];
}

interface ListingDraft {
  requisitionId: string | null;
  title: string;
  location: string | null;
  sourceUrl: string;
  postedAt: string | null;
  descriptionText: string | null;
  department: string | null;
  employmentType: string | null;
  atsType: string;
}

const EMPTY_PACE = async () => undefined;

export function googleResultsUrl(): string {
  const url = "https://www.google.com/about/careers/applications/jobs/results/?location=United%20States&sort_by=date";
  if (new URL(url).searchParams.has("page")) throw new Error("Google pagination is disallowed.");
  return url;
}

export function amazonSearchUrl(): string {
  return "https://www.amazon.jobs/en/search.json?base_query=&loc_query=United%20States&sort=recent&result_limit=10&offset=0";
}

function hostOf(url: string): string | null {
  try {
    return assertFetchableUrl(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function named(body: string, tokens: readonly string[]): boolean {
  const haystack = body.toLowerCase();
  return tokens.some((token) => token.length >= 3 && haystack.includes(token.toLowerCase()));
}

function domainOf(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  return host.startsWith("www.") ? host.slice(4) : host;
}

function registryFor(employer: PilotEmployer, hint: AtsHint | null, careersUrl: string): CompanyRegistryEntry | null {
  const domain = domainOf(careersUrl);
  const base = {
    company: employer.displayName,
    fortuneRank: null,
    corporateDomain: hint?.kind === "workday" ? null : domain,
    careersUrl,
    atsType: hint?.kind ?? "generic",
    atsTenantOrBoardId: hint?.board ?? null,
    atsWorkdaySite: hint?.workday?.site ?? null,
    atsWorkdayHostname: hint?.workday?.hostname ?? null,
    enabled: true,
    verificationStatus: "verified" as const,
    verificationNote: "Live page or redirect exposed this recruiting platform during M5.1-D.1.",
    sourceProvenance: ["m51d1-live-fetch"],
    lastVerifiedAt: new Date().toISOString(),
  };
  const parsed = companyRegistryEntrySchema.safeParse(base);
  return parsed.success ? parsed.data : null;
}

function draftToObserved(employer: PilotEmployer, draft: ListingDraft, resolved: boolean): ObservedRecord {
  const dated = postingDatePrecision(draft.postedAt);
  return {
    employerId: employer.id,
    employerName: employer.displayName,
    requisitionId: draft.requisitionId,
    title: draft.title.trim() ? draft.title.trim() : null,
    location: draft.location,
    sourceUrl: draft.sourceUrl,
    postedAt: dated.postedAt,
    postingDatePrecision: dated.precision,
    descriptionText: draft.descriptionText,
    recordClass: "live",
    resolutionStatus: resolved ? "resolved" : draft.descriptionText ? "rejected" : "pending",
    atsType: draft.atsType,
  };
}

function toCanonical(employer: PilotEmployer, draft: ListingDraft, registry: CompanyRegistryEntry | null, now: string): JobPosting | null {
  if (!draft.title.trim() || !draft.descriptionText || !hostOf(draft.sourceUrl)) return null;
  const posting: JobPosting = {
    id: computeJobId(draft.sourceUrl),
    source: `m51d1:${employer.id}`,
    sourceType: draft.atsType === "greenhouse" || draft.atsType === "lever" || draft.atsType === "workday" ? draft.atsType : "company-careers",
    company: employer.displayName,
    title: draft.title,
    location: draft.location,
    remoteType: null,
    employmentType: draft.employmentType,
    department: draft.department,
    requisitionId: draft.requisitionId,
    postingDate: draft.postedAt,
    discoveredAt: now,
    lastSeenAt: now,
    canonicalUrl: draft.sourceUrl,
    applyUrl: draft.sourceUrl,
    descriptionText: stripHtml(draft.descriptionText),
    descriptionHtml: null,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: [],
    discoveredFrom: ["m51d1-live"],
    rawMetadata: {},
  };
  const stamped = stampResolution(posting, {
    sourceKind: draft.atsType,
    observedUrl: draft.sourceUrl,
    observedAt: now,
    finalUrl: draft.sourceUrl,
    extractionMethod: "ats-api",
    discoveredCompany: employer.displayName,
    registryEntry: registry,
    apiJobId: draft.requisitionId,
    now,
  });
  const gate = evaluatePersistable(stamped);
  return gate.ok ? gate.posting : null;
}

function blank(employer: PilotEmployer): EmployerCounters {
  return {
    employerId: employer.id,
    displayName: employer.displayName,
    searchAttempted: true,
    careerSiteReachable: false,
    atsIdentityVerified: false,
    atsType: null,
    careersUrl: employer.careersUrl,
    finalUrl: null,
    listingsObserved: 0,
    uniqueListings: 0,
    jobsPersisted: 0,
    fullJdsRetrieved: 0,
    validOfficialUrls: 0,
    knownPostingDates: 0,
    unknownPostingDates: 0,
    elapsedMs: 0,
    truncated: false,
    status: "TRANSIENT_FAILURE",
    reason: "",
    failures: [],
  };
}

async function boardDrafts(employer: PilotEmployer, hint: AtsHint, deps: CollectDeps): Promise<{ drafts: ListingDraft[]; truncated: boolean; error?: string }> {
  if (hint.kind !== "greenhouse" && hint.kind !== "lever") return { drafts: [], truncated: false, error: "not a board adapter" };
  const company: BoardCompany = { company: employer.displayName, ats: hint.kind, board: hint.board! };
  const load = deps.loadBoard ?? fetchBoardPostings;
  const postings = await load(company, fetch, 60_000);
  const maxJds = deps.maxJds ?? JD_SAMPLE_LIMIT;
  let withJd = 0;
  const drafts: ListingDraft[] = [];
  for (const posting of postings) {
    const keepJd = withJd < maxJds && assessJobDescription(posting.descriptionText) === null;
    if (keepJd) withJd += 1;
    drafts.push({
      requisitionId: posting.externalId,
      title: posting.title,
      location: posting.location,
      sourceUrl: posting.url,
      postedAt: posting.postingDate,
      descriptionText: keepJd ? posting.descriptionText : null,
      department: posting.department,
      employmentType: posting.employmentType,
      atsType: hint.kind,
    });
  }
  return { drafts, truncated: postings.length > drafts.length ? false : withJd < postings.filter((posting) => assessJobDescription(posting.descriptionText) === null).length };
}

async function workdayDrafts(employer: PilotEmployer, hint: AtsHint, deps: CollectDeps): Promise<{ drafts: ListingDraft[]; truncated: boolean }> {
  const coords = hint.workday!;
  const site: SiteConfig = {
    id: employer.id,
    name: employer.displayName,
    url: hint.evidenceUrl,
    adapter: "workday",
    enabled: true,
    workday: { hostname: coords.hostname, tenant: coords.tenant, site: coords.site },
  };
  const settings = { maxPagesPerSource: 1, maxJobsPerSource: 20, navigationTimeoutMs: 20_000, delayBetweenRequestsMs: 0 };
  const found = await workdayAdapter.discoverJobs(site, [{ keyword: "", profileIds: [] }], settings);
  const maxJds = deps.maxJds ?? JD_SAMPLE_LIMIT;
  const drafts: ListingDraft[] = [];
  for (const job of found) {
    let description: string | null = null;
    if (drafts.filter((row) => row.descriptionText).length < Math.min(3, maxJds)) {
      await (deps.pace ?? EMPTY_PACE)();
      const detail = await workdayAdapter.fetchJobDetails(job, site, settings);
      description = detail.descriptionText || null;
      drafts.push({
        requisitionId: detail.requisitionId,
        title: detail.title,
        location: detail.location,
        sourceUrl: detail.canonicalUrl,
        postedAt: detail.postingDate,
        descriptionText: description,
        department: detail.department,
        employmentType: detail.employmentType,
        atsType: "workday",
      });
    } else {
      drafts.push({
        requisitionId: job.externalId,
        title: job.title,
        location: null,
        sourceUrl: job.url,
        postedAt: null,
        descriptionText: null,
        department: null,
        employmentType: null,
        atsType: "workday",
      });
    }
  }
  return { drafts, truncated: found.length >= settings.maxJobsPerSource };
}

async function ashbyDrafts(hint: AtsHint, deps: CollectDeps): Promise<{ drafts: ListingDraft[]; error?: string }> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(hint.board!)}?includeCompensation=true`;
  const response = await deps.get(url);
  if (response.error || response.status !== 200) return { drafts: [], error: response.error ?? `Ashby HTTP ${response.status}` };
  const parsed = JSON.parse(response.body) as { jobs?: Record<string, unknown>[] };
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const maxJds = deps.maxJds ?? JD_SAMPLE_LIMIT;
  let kept = 0;
  const drafts: ListingDraft[] = [];
  for (const job of jobs) {
    const sourceUrl = typeof job.jobUrl === "string" ? job.jobUrl : "";
    if (!hostOf(sourceUrl)) continue;
    const description = typeof job.descriptionPlain === "string" ? job.descriptionPlain : null;
    const keep = description && kept < maxJds;
    if (keep) kept += 1;
    const location = typeof job.location === "string" ? job.location : null;
    drafts.push({
      requisitionId: typeof job.id === "string" ? job.id : null,
      title: typeof job.title === "string" ? job.title : "Untitled",
      location,
      sourceUrl,
      postedAt: typeof job.publishedAt === "string" ? job.publishedAt : null,
      descriptionText: keep ? description : null,
      department: null,
      employmentType: null,
      atsType: "ashby",
    });
  }
  return { drafts };
}

function htmlJobText(html: string): string | null {
  const start = html.search(/<h[1-3][^>]*>\s*(Minimum qualifications|Preferred qualifications|Description|About the job|Responsibilities|What you(?:'|’)ll do)/i);
  if (start < 0) return null;
  let slice = html.slice(start, start + 20_000);
  const stop = slice.search(/Follow Life at Google|Information collected and processed as part of your Google Careers/i);
  if (stop > 400) slice = slice.slice(0, stop);
  const text = stripHtml(slice).replace(/\s+/g, " ").trim();
  return text.length >= 200 ? text : null;
}

function jsonLdDrafts(html: string, pageUrl: string, atsType: string, maxJds: number): ListingDraft[] {
  const drafts: ListingDraft[] = [];
  for (const job of extractJsonLdJobs(html)) {
    const sourceUrl = job.url && hostOf(job.url) ? job.url : pageUrl;
    if (!hostOf(sourceUrl)) continue;
    drafts.push({
      requisitionId: job.identifier,
      title: job.title ?? "Untitled",
      location: job.location,
      sourceUrl,
      postedAt: job.datePosted,
      descriptionText: drafts.filter((row) => row.descriptionText).length < maxJds ? job.description : null,
      department: null,
      employmentType: null,
      atsType,
    });
  }
  return drafts;
}

async function amazonDrafts(deps: CollectDeps): Promise<{ drafts: ListingDraft[]; truncated: boolean; error?: string }> {
  const response = await deps.get(amazonSearchUrl());
  if (response.error || response.status !== 200) return { drafts: [], truncated: false, error: response.error ?? `Amazon HTTP ${response.status}` };
  const parsed = JSON.parse(response.body) as { jobs?: Record<string, unknown>[]; hits?: number };
  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  const owned = jobs.filter((job) => /amazon|aws/i.test(String(job.company_name ?? "")));
  const maxJds = deps.maxJds ?? JD_SAMPLE_LIMIT;
  const drafts: ListingDraft[] = [];
  for (const job of owned) {
    const jobPath = typeof job.job_path === "string" ? job.job_path : "";
    const sourceUrl = jobPath ? `https://www.amazon.jobs${jobPath.startsWith("/") ? jobPath : `/${jobPath}`}` : "";
    if (!hostOf(sourceUrl)) continue;
    const parts = [job.description, job.basic_qualifications, job.preferred_qualifications].filter((part): part is string => typeof part === "string" && part.trim().length > 0);
    const description = parts.join("\n\n");
    const keep = description.length > 0 && drafts.filter((row) => row.descriptionText).length < maxJds;
    drafts.push({
      requisitionId: job.id_icims != null ? String(job.id_icims) : job.id != null ? String(job.id) : null,
      title: typeof job.title === "string" ? job.title : "Untitled",
      location: [job.city, job.state, job.country_code].filter((part) => typeof part === "string" && part).join(", ") || null,
      sourceUrl,
      postedAt: typeof job.posted_date === "string" ? job.posted_date : null,
      descriptionText: keep ? description : null,
      department: typeof job.job_category === "string" ? job.job_category : null,
      employmentType: typeof job.job_schedule_type === "string" ? job.job_schedule_type : null,
      atsType: "amazon",
    });
  }
  return { drafts, truncated: typeof parsed.hits === "number" ? parsed.hits > owned.length : true };
}

async function googleDrafts(deps: CollectDeps): Promise<{ drafts: ListingDraft[]; truncated: boolean; error?: string }> {
  const response = await deps.get(googleResultsUrl());
  if (response.error || response.status !== 200 || !response.finalUrl.startsWith("https://www.google.com/")) {
    return { drafts: [], truncated: false, error: response.error ?? `Google HTTP ${response.status}` };
  }
  const seen = new Set<string>();
  const cards = [...response.body.matchAll(/jobs\/results\/(\d+)-([a-z0-9-]+)/g)];
  const maxJds = Math.min(8, deps.maxJds ?? JD_SAMPLE_LIMIT);
  let detailAttempts = 0;
  const drafts: ListingDraft[] = [];
  for (const match of cards) {
    const id = match[1]!;
    if (seen.has(id)) continue;
    if (seen.size >= 40) break;
    seen.add(id);
    const sourceUrl = `https://www.google.com/about/careers/applications/jobs/results/${id}-${match[2]}`;
    if (sourceUrl.includes("page=")) continue;
    let description: string | null = null;
    let title = "";
    let postedAt: string | null = null;
    if (detailAttempts < maxJds) {
      detailAttempts += 1;
      await (deps.pace ?? EMPTY_PACE)();
      const detail = await deps.get(sourceUrl);
      const ld = detail.status === 200 ? jsonLdDrafts(detail.body, sourceUrl, "google", 1)[0] : undefined;
      const heading = detail.status === 200 ? detail.body.match(/<title>([^<]{4,180})<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() : undefined;
      const section = detail.status === 200 ? htmlJobText(detail.body) : null;
      description = ld?.descriptionText ?? section;
      title = ld?.title ?? (heading && !/search results|job search/i.test(heading) ? heading : "");
      postedAt = ld?.postedAt ?? null;
    }
    if (!title) title = match[2]!.replaceAll("-", " ");
    drafts.push({
      requisitionId: id,
      title,
      location: null,
      sourceUrl,
      postedAt,
      descriptionText: description,
      department: null,
      employmentType: null,
      atsType: "google",
    });
  }
  return { drafts, truncated: true };
}

function sameHostLinks(html: string, pageUrl: string): string[] {
  const page = hostOf(pageUrl);
  if (!page) return [];
  const links: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    let url: URL;
    try {
      url = new URL(match[1]!, pageUrl);
    } catch {
      continue;
    }
    if (url.hostname.toLowerCase() !== page) continue;
    if (!/\/(jobs?|careers)\b|job[-_]?id|gh_jid|requisition/i.test(url.pathname + url.search)) continue;
    const value = url.toString();
    if (seen.has(value)) continue;
    seen.add(value);
    links.push(value);
    if (links.length >= 20) break;
  }
  return links;
}

function finish(counters: EmployerCounters, observed: ObservedRecord[], canonical: JobPosting[], started: number): EmployerCounters {
  const unique = dedupeListings(observed);
  const dates = countDates(unique);
  const fullJds = unique.filter((record) => record.descriptionText && assessJobDescription(record.descriptionText) === null).length;
  return {
    ...counters,
    listingsObserved: observed.length,
    uniqueListings: unique.length,
    jobsPersisted: canonical.length,
    fullJdsRetrieved: fullJds,
    validOfficialUrls: unique.filter((record) => hostOf(record.sourceUrl)).length,
    knownPostingDates: dates.known,
    unknownPostingDates: dates.unknown,
    elapsedMs: Date.now() - started,
  };
}

export async function collectEmployer(employer: PilotEmployer, deps: CollectDeps): Promise<EmployerCollection> {
  const started = Date.now();
  const now = deps.now?.() ?? new Date().toISOString();
  const counters = blank(employer);
  const errors: SourceError[] = [];
  const page = await deps.get(employer.careersUrl);
  counters.finalUrl = page.finalUrl || null;
  if (page.error || page.status === 0) {
    counters.status = "TRANSIENT_FAILURE";
    counters.reason = page.error ?? "No response from the careers site.";
    counters.failures.push(counters.reason);
    counters.elapsedMs = Date.now() - started;
    return { counters, observed: [], canonical: [], errors: [{ employerId: employer.id, stage: "careers", url: employer.careersUrl, message: counters.reason, at: now }] };
  }
  if (page.status === 403 || page.status === 429) {
    counters.status = "ACCESS_RESTRICTED";
    counters.reason = `HTTP ${page.status} from ${page.finalUrl}. The board was not searched.`;
    counters.elapsedMs = Date.now() - started;
    return { counters, observed: [], canonical: [], errors: [{ employerId: employer.id, stage: "careers", url: page.finalUrl, message: counters.reason, at: now }] };
  }
  counters.careerSiteReachable = page.status >= 200 && page.status < 400;
  const identified = named(page.body, employer.nameTokens) || named(page.finalUrl, employer.nameTokens);
  if (!counters.careerSiteReachable || !identified) {
    counters.status = "NOT_FOUND";
    counters.reason = `HTTP ${page.status} did not identify ${employer.displayName}. No board was searched.`;
    counters.elapsedMs = Date.now() - started;
    return { counters, observed: [], canonical: [], errors };
  }

  const hints = extractAtsHints(page.body, page.finalUrl);
  const hint = hints[0] ?? null;
  let drafts: ListingDraft[] = [];
  let truncated = false;
  try {
    if (hint?.kind === "greenhouse" || hint?.kind === "lever") {
      const loaded = await boardDrafts(employer, hint, deps);
      drafts = loaded.drafts;
      truncated = loaded.truncated;
      if (loaded.error) throw new Error(loaded.error);
      counters.atsIdentityVerified = drafts.length > 0;
      counters.atsType = hint.kind;
    } else if (hint?.kind === "workday" && hint.workday) {
      const loaded = await workdayDrafts(employer, hint, deps);
      drafts = loaded.drafts;
      truncated = loaded.truncated;
      counters.atsIdentityVerified = drafts.length > 0;
      counters.atsType = "workday";
    } else if (hint?.kind === "ashby") {
      const loaded = await ashbyDrafts(hint, deps);
      drafts = loaded.drafts;
      if (loaded.error) throw new Error(loaded.error);
      counters.atsIdentityVerified = drafts.length > 0;
      counters.atsType = "ashby";
    } else if (employer.id === "amazon-aws" && /amazon\.jobs$/i.test(hostOf(page.finalUrl) ?? "")) {
      const loaded = await amazonDrafts(deps);
      drafts = loaded.drafts;
      truncated = loaded.truncated;
      if (loaded.error) throw new Error(loaded.error);
      counters.atsType = "amazon";
      counters.atsIdentityVerified = drafts.length > 0;
    } else if (employer.id === "google" && /google\.com$/i.test(domainOf(page.finalUrl) ?? "")) {
      const loaded = await googleDrafts(deps);
      drafts = loaded.drafts;
      truncated = loaded.truncated;
      if (loaded.error) throw new Error(loaded.error);
      counters.atsType = "google";
      counters.atsIdentityVerified = drafts.length > 0;
    } else {
      drafts = jsonLdDrafts(page.body, page.finalUrl, "company-careers", deps.maxJds ?? JD_SAMPLE_LIMIT);
      const links = sameHostLinks(page.body, page.finalUrl).slice(0, 3);
      for (const link of links) {
        if (drafts.some((row) => row.sourceUrl === link)) continue;
        await (deps.pace ?? EMPTY_PACE)();
        const detail = await deps.get(link);
        if (detail.status === 200) drafts.push(...jsonLdDrafts(detail.body, detail.finalUrl, "company-careers", deps.maxJds ?? JD_SAMPLE_LIMIT));
      }
      counters.atsType = drafts.length > 0 ? "company-careers" : null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "source failed";
    counters.failures.push(message);
    errors.push({ employerId: employer.id, stage: "listings", url: page.finalUrl, message, at: now });
  }

  if (drafts.length === 0 && counters.failures.length === 0) {
    counters.status = "UNSUPPORTED";
    counters.reason = `${employer.displayName} careers page identified the employer and did not expose a supported Greenhouse, Lever, Ashby, or Workday board. This is not an empty job board.`;
    counters.elapsedMs = Date.now() - started;
    return { counters, observed: [], canonical: [], errors };
  }
  if (drafts.length === 0) {
    counters.status = counters.failures.some((failure) => /404/.test(failure)) ? "NOT_FOUND" : "TRANSIENT_FAILURE";
    counters.reason = counters.failures.join("; ") || "The verified source returned no listings.";
    counters.elapsedMs = Date.now() - started;
    return { counters, observed: [], canonical: [], errors };
  }

  const registry = registryFor(employer, hint, page.finalUrl);
  const observed = dedupeListings(drafts.filter((draft) => hostOf(draft.sourceUrl)).map((draft) => {
    const text = draft.descriptionText ? stripHtml(draft.descriptionText) : null;
    const resolved = Boolean(text && assessJobDescription(text) === null);
    return draftToObserved(employer, { ...draft, descriptionText: text }, resolved);
  }));
  const canonical: JobPosting[] = [];
  for (const draft of drafts) {
    if (!draft.descriptionText) continue;
    const saved = toCanonical(employer, draft, registry, now);
    if (saved) canonical.push(saved);
  }
  counters.truncated = truncated || observed.some((record) => !record.descriptionText);
  counters.status = "VERIFIED";
  counters.reason = counters.atsIdentityVerified
    ? `${counters.atsType} identity came from the live careers page or its redirect. JD text was retrieved for a bounded subset.`
    : `${counters.atsType ?? "company"} listings were read from the employer's own site. A third-party ATS board was not verified.`;
  if (truncated) counters.reason += " Results are truncated.";
  return { counters: finish(counters, observed, canonical, started), observed, canonical, errors };
}
