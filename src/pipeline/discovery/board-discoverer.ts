import { randomBytes } from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { JobPosting } from "../../adapters/types.js";
import { companyRegistryEntrySchema, type CompanyRegistryEntry } from "../../config/schema.js";
import { computeJobId } from "../../dedup/canonicalize-url.js";
import { mergeJobs } from "../../dedup/deduplicator.js";
import {
  buildJobFailure,
  evaluatePersistable,
  stampResolution,
  type JobFailure,
  type JobFailureCode,
} from "../../domain/canonical-job.js";
import { stripHtml, unescapeEscapedHtml } from "../../extraction/jd-cleaner.js";
import { appendJobFailures, updateJobs } from "../../storage/jsonl-store.js";
import { classifyLocation } from "./location.js";
import { noopRunEventLog, type RunEventLog } from "../../events/run-events.js";

// Discovery source: the public Greenhouse and Lever board APIs, for a company list the candidate
// provides. No browser, no LinkedIn, no scraping: one JSON GET per company board. Every posting
// still passes the same official-board verification, description gate and merge/dedupe as any other
// discovery source before it reaches jobs.jsonl.

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const companySchema = z
  .object({
    company: z.string().trim().min(1).max(120),
    ats: z.enum(["greenhouse", "lever"]),
    // The board token / site slug exactly as it appears in the employer's own job-board URL.
    board: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "board must be the token from the employer's board URL"),
    // Only needed when the employer's Greenhouse posting URLs live on its own domain (?gh_jid=...).
    corporateDomain: z.string().regex(DOMAIN_RE).optional(),
    region: z.enum(["global", "eu"]).optional(),
  })
  .strict();

const keywordList = z.array(z.string().trim().min(1).max(60)).min(1).max(100);

// A track is a named group of title phrases. Tracks are ordered: when a title matches several, the
// earliest track wins (so SECURITY listed before QA claims a title that matches both).
const trackSchema = z.object({ name: z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/, "track name must be upper-case, e.g. SECURITY"), keywords: keywordList }).strict();

// Employers whose careers site is on an ATS this tool has no adapter for. They are listed in the
// tracker as MANUAL_WATCH rows for the candidate to check by hand; nothing is fetched or scraped.
const watchSchema = z
  .object({
    company: z.string().trim().min(1).max(120),
    ats: z.string().trim().min(1).max(40),
    careersUrl: z.string().url().refine((u) => /^https?:/i.test(u), { message: "careersUrl must be http(s)" }),
    track: z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .strict();
export type ManualWatchEntry = z.infer<typeof watchSchema>;

export const boardListSchema = z
  .object({
    version: z.literal(1),
    // Either one flat phrase list (no track label) or ordered tracks. There is no "keep everything" mode.
    titleKeywords: keywordList.optional(),
    tracks: z.array(trackSchema).min(1).max(5).optional(),
    // Applied before any track: a title containing one of these phrases is dropped.
    excludeTitleKeywords: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
    // Drop postings whose location is clearly outside the US (default true). Unknown or ambiguous
    // locations are never dropped; the tracker flags them instead.
    dropNonUsLocations: z.boolean().optional(),
    manualWatch: z.array(watchSchema).max(100).optional(),
    companies: z.array(companySchema).min(1).max(300),
  })
  .strict()
  .superRefine((list, ctx) => {
    if ((list.titleKeywords === undefined) === (list.tracks === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["titleKeywords"], message: "provide exactly one of titleKeywords or tracks" });
    }
    const trackNames = (list.tracks ?? []).map((t) => t.name);
    if (new Set(trackNames).size !== trackNames.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tracks"], message: "duplicate track name" });
    const seen = new Set<string>();
    list.companies.forEach((c, i) => {
      const key = `${c.ats}:${c.board.toLowerCase()}`;
      if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["companies", i], message: `duplicate board ${key}` });
      seen.add(key);
    });
  });
export type BoardList = z.infer<typeof boardListSchema>;
export type BoardCompany = BoardList["companies"][number];

export function loadBoardList(filePath: string): BoardList {
  return boardListSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
}

export function titleMatches(title: string, keywords: string[]): string[] {
  const lowered = title.toLowerCase();
  return keywords.filter((keyword) => {
    const k = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`).test(lowered);
  });
}

export interface TitleClassification {
  /** Track name, "" for a flat titleKeywords list, null when the title is not wanted. */
  track: string | null;
  keywords: string[];
  excludedBy: string[];
}

/** Exclusions first, then tracks in configured order; the first track that matches claims the title. */
export function classifyTitle(title: string, list: Pick<BoardList, "titleKeywords" | "tracks" | "excludeTitleKeywords">): TitleClassification {
  const excludedBy = titleMatches(title, list.excludeTitleKeywords ?? []);
  if (excludedBy.length > 0) return { track: null, keywords: [], excludedBy };
  for (const track of list.tracks ?? []) {
    const keywords = titleMatches(title, track.keywords);
    if (keywords.length > 0) return { track: track.name, keywords, excludedBy: [] };
  }
  const flat = titleMatches(title, list.titleKeywords ?? []);
  return flat.length > 0 ? { track: "", keywords: flat, excludedBy: [] } : { track: null, keywords: [], excludedBy: [] };
}

// ---------------------------------------------------------------------------
// Public API payloads (untrusted JSON: parsed narrowly, unknown fields ignored)
// ---------------------------------------------------------------------------

const greenhouseBoardSchema = z.object({
  jobs: z.array(
    z
      .object({
        id: z.union([z.number().int(), z.string().regex(/^\d+$/)]),
        title: z.string(),
        absolute_url: z.string().url(),
        location: z.object({ name: z.string().optional() }).passthrough().optional(),
        departments: z.array(z.object({ name: z.string() }).passthrough()).optional(),
        content: z.string().optional(),
        updated_at: z.string().optional(),
      })
      .passthrough(),
  ),
});

const leverBoardSchema = z.array(
  z
    .object({
      id: z.string().min(1),
      text: z.string(),
      hostedUrl: z.string().url(),
      applyUrl: z.string().url().optional(),
      categories: z.object({ location: z.string().optional(), team: z.string().optional(), department: z.string().optional(), commitment: z.string().optional() }).passthrough().optional(),
      descriptionPlain: z.string().optional(),
      description: z.string().optional(),
      lists: z.array(z.object({ text: z.string().optional(), content: z.string().optional() }).passthrough()).optional(),
      additionalPlain: z.string().optional(),
      createdAt: z.number().optional(),
    })
    .passthrough(),
);

interface BoardPosting {
  externalId: string;
  title: string;
  url: string;
  applyUrl: string;
  location: string | null;
  department: string | null;
  employmentType: string | null;
  postingDate: string | null;
  descriptionText: string;
  descriptionHtml: string | null;
}

export class BoardError extends Error {
  constructor(readonly code: Extract<JobFailureCode, "BOARD_FETCH_FAILED" | "BOARD_NOT_FOUND" | "BOARD_RESPONSE_INVALID">, message: string) {
    super(message);
    this.name = "BoardError";
  }
}

const MAX_RESPONSE_CHARS = 25_000_000;

export function boardApiUrl(company: BoardCompany): string {
  if (company.ats === "greenhouse") return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.board)}/jobs?content=true`;
  const host = company.region === "eu" ? "api.eu.lever.co" : "api.lever.co";
  return `https://${host}/v0/postings/${encodeURIComponent(company.board)}?mode=json`;
}

async function getJson(url: string, fetchImpl: typeof fetch, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (response.status === 404) throw new BoardError("BOARD_NOT_FOUND", "Board token not found (HTTP 404); check the token in the employer's board URL.");
    if (!response.ok) throw new BoardError("BOARD_FETCH_FAILED", `Board API answered HTTP ${response.status}.`);
    const body = await response.text();
    if (body.length > MAX_RESPONSE_CHARS) throw new BoardError("BOARD_RESPONSE_INVALID", "Board response exceeded the size limit.");
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new BoardError("BOARD_RESPONSE_INVALID", "Board API returned a non-JSON response.");
    }
  } catch (error) {
    if (error instanceof BoardError) throw error;
    throw new BoardError("BOARD_FETCH_FAILED", controller.signal.aborted ? "Board request timed out or was cancelled." : `Board request failed (${error instanceof Error ? error.name : "UnknownError"}).`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function fetchBoardPostings(company: BoardCompany, fetchImpl: typeof fetch, timeoutMs = 20_000, signal?: AbortSignal): Promise<BoardPosting[]> {
  const json = await getJson(boardApiUrl(company), fetchImpl, timeoutMs, signal);
  if (company.ats === "greenhouse") {
    const parsed = greenhouseBoardSchema.safeParse(json);
    if (!parsed.success) throw new BoardError("BOARD_RESPONSE_INVALID", "Greenhouse board response has an unexpected shape.");
    return parsed.data.jobs.map((job) => {
      const html = job.content ?? "";
      return {
        externalId: String(job.id),
        title: job.title,
        url: job.absolute_url,
        applyUrl: job.absolute_url,
        location: job.location?.name?.trim() || null,
        department: job.departments?.[0]?.name ?? null,
        employmentType: null,
        postingDate: job.updated_at ?? null,
        descriptionText: stripHtml(unescapeEscapedHtml(html)),
        descriptionHtml: html || null,
      };
    });
  }
  const parsed = leverBoardSchema.safeParse(json);
  if (!parsed.success) throw new BoardError("BOARD_RESPONSE_INVALID", "Lever board response has an unexpected shape.");
  return parsed.data.map((posting) => {
    const sections = (posting.lists ?? []).map((l) => [l.text ?? "", stripHtml(l.content ?? "")].filter(Boolean).join(": ")).filter(Boolean);
    const body = posting.descriptionPlain ?? stripHtml(posting.description ?? "");
    return {
      externalId: posting.id,
      title: posting.text,
      url: posting.hostedUrl,
      applyUrl: posting.applyUrl ?? posting.hostedUrl,
      location: posting.categories?.location ?? null,
      department: posting.categories?.team ?? posting.categories?.department ?? null,
      employmentType: posting.categories?.commitment ?? null,
      postingDate: posting.createdAt ? new Date(posting.createdAt).toISOString() : null,
      descriptionText: [body, ...sections, posting.additionalPlain ?? ""].filter((part) => part.trim()).join("\n\n"),
      descriptionHtml: posting.description ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Discovery run
// ---------------------------------------------------------------------------

export interface BoardCompanyResult {
  company: string;
  ats: "greenhouse" | "lever";
  board: string;
  status: "OK" | "FAILED";
  fetched: number;
  matched: number;
  /** Titles dropped by excludeTitleKeywords before any track was tried. */
  excluded: number;
  /** Title-matched postings dropped because their location is clearly outside the US. */
  droppedLocation: number;
  /** Matched postings per track (key "" for a flat keyword list). */
  byTrack: Record<string, number>;
  /** New canonical records plus changed JD revisions written this run. */
  saved: number;
  unchanged: number;
  rejected: number;
  failure?: { code: JobFailureCode; detail: string };
}

export interface BoardDiscoveryResult {
  runId: string;
  companies: BoardCompanyResult[];
  totals: { fetched: number; matched: number; excluded: number; droppedLocation: number; saved: number; unchanged: number; rejected: number; failedCompanies: number };
}

export interface BoardDiscoveryOptions {
  configPath: string;
  dataDir: string;
  fetchImpl?: typeof fetch;
  now?: () => string;
  /** Pause between companies; the public APIs are polled politely, one board at a time. */
  delayMs?: number;
  timeoutMs?: number;
  /** Optional cap on matched postings processed per company. */
  maxPerCompany?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Append-only run events (run start/end, one stage per company). Defaults to recording nothing. */
  events?: RunEventLog;
}

function registryEntryFor(company: BoardCompany): CompanyRegistryEntry {
  return companyRegistryEntrySchema.parse({
    company: company.company,
    fortuneRank: null,
    corporateDomain: company.corporateDomain ?? null,
    careersUrl: null,
    atsType: company.ats,
    atsTenantOrBoardId: company.board,
    atsWorkdaySite: null,
    atsWorkdayHostname: null,
    enabled: true,
    verificationStatus: "pending",
    verificationNote: "Board token supplied by the candidate's company list; official-board relationship is checked per posting.",
    sourceProvenance: ["candidate-company-list"],
    lastVerifiedAt: null,
  });
}

function toPosting(company: BoardCompany, raw: BoardPosting, matchedKeywords: string[], track: string, now: string): JobPosting {
  return {
    id: computeJobId(raw.url),
    source: `board-api::${company.ats}::${company.board}`,
    sourceType: company.ats,
    company: company.company,
    title: raw.title.trim(),
    location: raw.location,
    remoteType: null,
    employmentType: raw.employmentType,
    department: raw.department,
    requisitionId: raw.externalId,
    postingDate: raw.postingDate,
    discoveredAt: now,
    lastSeenAt: now,
    canonicalUrl: raw.url,
    applyUrl: raw.applyUrl,
    descriptionText: raw.descriptionText,
    descriptionHtml: raw.descriptionHtml,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: track ? [track.toLowerCase()] : [],
    discoveredFrom: ["board-api"],
    discoveredUrl: raw.url,
    matchedKeywords,
    relevanceReason: `${track ? track + ": " : ""}title matched: ${matchedKeywords.join(", ")}`,
    rawMetadata: {},
  } as JobPosting;
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

export async function runBoardDiscovery(options: BoardDiscoveryOptions): Promise<BoardDiscoveryResult> {
  const list = loadBoardList(options.configPath);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? (() => {});
  const runId = `boards-${now().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const jobsPath = path.resolve(options.dataDir, "jobs.jsonl");
  const failuresPath = path.resolve(options.dataDir, "job-failures.jsonl");
  const results: BoardCompanyResult[] = [];
  const events = options.events ?? noopRunEventLog("boards");
  events.runStart();

  for (const [index, company] of list.companies.entries()) {
    if (options.signal?.aborted) break;
    if (index > 0) await wait(options.delayMs ?? 750, options.signal);
    const companyStage = events.stageStart("board", { company: company.company });
    const result: BoardCompanyResult = { company: company.company, ats: company.ats, board: company.board, status: "OK", fetched: 0, matched: 0, excluded: 0, droppedLocation: 0, byTrack: {}, saved: 0, unchanged: 0, rejected: 0 };
    const failures: JobFailure[] = [];
    const fail = (code: JobFailureCode, detail: string, target: string, title: string, sourceJobId: string | null) =>
      failures.push(buildJobFailure({ code, stage: "search", runId, targetUrl: target, company: company.company, title, sourceJobId, detail, at: now() }));
    try {
      const postings = await fetchBoardPostings(company, fetchImpl, options.timeoutMs, options.signal);
      result.fetched = postings.length;
      const registryEntry = registryEntryFor(company);
      const accepted: JobPosting[] = [];
      const classified = postings.map((p) => ({ p, ...classifyTitle(p.title, list) }));
      result.excluded = classified.filter((c) => c.excludedBy.length > 0).length;
      const titleMatched = classified.filter((c) => c.track !== null);
      const dropNonUs = list.dropNonUsLocations !== false;
      const matched = titleMatched.filter((c) => !(dropNonUs && classifyLocation(c.p.location) === "NON_US"));
      result.droppedLocation = titleMatched.length - matched.length;
      result.matched = matched.length;
      for (const m of matched) result.byTrack[m.track!] = (result.byTrack[m.track!] ?? 0) + 1;
      for (const { p, keywords, track } of matched.slice(0, options.maxPerCompany ?? matched.length)) {
        const stamped = stampResolution(toPosting(company, p, keywords, track!, now()), {
          sourceKind: "board-api",
          observedUrl: boardApiUrl(company),
          observedAt: now(),
          finalUrl: p.url,
          extractionMethod: "ats-api",
          discoveredCompany: company.company,
          registryEntry,
          apiJobId: p.externalId,
          confirmedGreenhouseJobId: company.ats === "greenhouse" ? p.externalId : null,
          now: now(),
        });
        const gate = evaluatePersistable(stamped);
        if (!gate.ok) {
          result.rejected += 1;
          failures.push(buildJobFailure({ code: gate.failure.code as JobFailureCode, stage: "resolution", runId, targetUrl: p.url, company: company.company, title: p.title, sourceJobId: p.externalId, detail: gate.failure.detail, at: now() }));
          continue;
        }
        accepted.push(gate.posting);
      }
      if (accepted.length > 0) {
        let before: JobPosting[] = [];
        const merged = await updateJobs(jobsPath, (current) => {
          before = current;
          return mergeJobs(current, accepted, now());
        });
        const known = new Map(before.map((j) => [`${j.atsIdentity ?? j.id}::${j.jdContentHash ?? ""}`, j]));
        const written = new Map(merged.map((j) => [`${j.atsIdentity ?? j.id}::${j.jdContentHash ?? ""}`, j]));
        for (const job of accepted) {
          const key = `${job.atsIdentity ?? job.id}::${job.jdContentHash ?? ""}`;
          if (known.has(key)) result.unchanged += 1;
          else if (written.has(key)) result.saved += 1;
        }
      }
    } catch (error) {
      result.status = "FAILED";
      const code: JobFailureCode = error instanceof BoardError ? error.code : "BOARD_FETCH_FAILED";
      const detail = error instanceof BoardError ? error.message : "Unexpected error while reading the board.";
      result.failure = { code, detail };
      fail(code, detail, boardApiUrl(company), "(board)", null);
    }
    if (failures.length > 0) appendJobFailures(failuresPath, failures);
    results.push(result);
    if (result.status === "FAILED") companyStage.end("ERROR", result.failure?.code);
    else companyStage.end("OK");
    log(`[boards] ${company.company} (${company.ats}:${company.board}) ${result.status} fetched=${result.fetched} matched=${result.matched} excluded=${result.excluded} droppedLocation=${result.droppedLocation} saved=${result.saved} unchanged=${result.unchanged} rejected=${result.rejected}${result.failure ? ` ${result.failure.code}` : ""}`);
  }

  const sum = (pick: (r: BoardCompanyResult) => number) => results.reduce((n, r) => n + pick(r), 0);
  events.runEnd(options.signal?.aborted ? "ABORTED" : results.some((r) => r.status === "FAILED") ? "PARTIAL" : "OK");
  return {
    runId,
    companies: results,
    totals: { fetched: sum((r) => r.fetched), matched: sum((r) => r.matched), excluded: sum((r) => r.excluded), droppedLocation: sum((r) => r.droppedLocation), saved: sum((r) => r.saved), unchanged: sum((r) => r.unchanged), rejected: sum((r) => r.rejected), failedCompanies: results.filter((r) => r.status === "FAILED").length },
  };
}
