import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import type { DiscoveredJobLite } from "../../src/discovery/types.js";

// Synthetic fixtures for the V1 Slice 1 canonical-job gate. Every boundary here is a
// substitute: `fetch` is routed by URL (no network), the registry is a temp file, and
// "Acme" is not a real company. They prove wiring and failure behaviour, not live ATS behaviour.

export const ACME = {
  company: "Acme",
  domain: "acme-corp.com",
  board: "acme",
};

export function registryEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    company: ACME.company,
    fortuneRank: null,
    corporateDomain: ACME.domain,
    careersUrl: `https://${ACME.domain}/careers`,
    atsType: "greenhouse",
    atsTenantOrBoardId: ACME.board,
    atsWorkdaySite: null,
    atsWorkdayHostname: null,
    enabled: true,
    verificationStatus: "verified",
    verificationNote: null,
    sourceProvenance: ["synthetic-test-fixture"],
    lastVerifiedAt: "2026-10-07",
    ...overrides,
  };
}

export function writeRegistry(entries: Record<string, unknown>[] = [registryEntry()]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-registry-"));
  const file = path.join(dir, "registry.json");
  writeFileSync(file, JSON.stringify(entries), "utf-8");
  return file;
}

export function tempDataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-canonical-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ~600 characters / ~100 words: comfortably above the JD minimum.
export const FULL_JD_HTML =
  "<p>Acme is hiring a Software Development Engineer in Test to own end-to-end quality for our " +
  "payments platform.</p><ul><li>Design and maintain automated test suites in Playwright and Java.</li>" +
  "<li>Partner with developers to define test strategy for new services.</li>" +
  "<li>Build CI pipelines that gate releases on reliable, fast feedback.</li></ul><p>You have " +
  "experience testing distributed systems, strong debugging skills and clear written communication. " +
  "You will work with a small, collaborative team and see your work ship to customers every week.</p>";

export function greenhousePayload(id: number | string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Number(id),
    title: "SDET II",
    absolute_url: `https://boards.greenhouse.io/${ACME.board}/jobs/${id}?gh_jid=${id}`,
    location: { name: "Remote - US" },
    departments: [{ name: "Engineering" }],
    content: FULL_JD_HTML,
    updated_at: "2026-10-01T12:00:00-04:00",
    ...overrides,
  };
}

export interface FetchRouterOptions {
  // requested URL -> final URL after redirects
  redirects?: Record<string, string>;
  // greenhouse job id -> payload (undefined / missing = HTTP 404)
  greenhouse?: Record<string, Record<string, unknown> | undefined>;
  // job ids whose API call should reject (network error)
  greenhouseThrows?: string[];
}

/** URL-routed stand-in for global fetch. Records every call in `.calls`. */
export function makeFetchRouter(options: FetchRouterOptions = {}) {
  const calls: string[] = [];
  const impl = async (input: unknown): Promise<unknown> => {
    const url = String(input);
    calls.push(url);
    const api = url.match(/boards-api\.greenhouse\.io\/v1\/boards\/([^/]+)\/jobs\/(\d+)/);
    if (api) {
      const id = api[2]!;
      if (options.greenhouseThrows?.includes(id)) throw new Error("network down");
      const payload = options.greenhouse?.[id];
      return {
        ok: payload !== undefined,
        status: payload !== undefined ? 200 : 404,
        url,
        text: async () => JSON.stringify(payload ?? {}),
        json: async () => payload ?? {},
      };
    }
    // Mirrors observed live behaviour: boards.greenhouse.io/... redirects to job-boards.greenhouse.io/...
    const defaultFinal = url.replace("://boards.greenhouse.io/", "://job-boards.greenhouse.io/");
    const finalUrl = options.redirects?.[url] ?? defaultFinal;
    return { ok: true, status: 200, url: finalUrl, text: async () => "{}", json: async () => ({}) };
  };
  return { impl, calls };
}

export function installFetch(options: FetchRouterOptions = {}) {
  const router = makeFetchRouter(options);
  vi.stubGlobal("fetch", vi.fn(router.impl));
  return router;
}

export function discoveredJob(id: string, overrides: Partial<DiscoveredJobLite> = {}): DiscoveredJobLite {
  return {
    source: "company-careers",
    searchKeyword: "SDET",
    title: "SDET II",
    company: ACME.company,
    location: "Remote - US",
    salarySnippet: null,
    resultUrl: `https://boards.greenhouse.io/${ACME.board}/jobs/${id}?gh_jid=${id}`,
    possibleOfficialUrl: null,
    postingAgeOrDate: null,
    sourceJobId: id,
    discoveredAt: "2026-10-07T12:00:00.000Z",
    matchedProfiles: ["sdet"],
    department: "Engineering",
    descriptionSnippet: null,
    searchedProfile: null,
    matchedKeywords: [],
    matchedFields: [],
    relevanceReason: "",
    ...overrides,
  };
}

/** Page double for the browser-extraction path: evaluate() returns the description HTML. */
export function fakePage(descriptionHtml: string, finalUrl: string) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue("<html>no verification here</html>"),
    title: vi.fn().mockResolvedValue("Posting"),
    close: vi.fn().mockResolvedValue(undefined),
    url: () => finalUrl,
    evaluate: vi.fn().mockResolvedValue(descriptionHtml),
  };
}

export function fakeContextWith(page: ReturnType<typeof fakePage>) {
  return { newPage: vi.fn().mockResolvedValue(page) };
}
