# job-hunter Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search configured career sites (Greenhouse/Lever/Workday/generic Playwright), discover every reachable job listing for the configured role keywords, extract full job descriptions, normalize into one `JobPosting` model, deduplicate across runs, and append-safe store to `data/jobs.jsonl` via `npm run collect`.

**Architecture:** Adapter pattern (`SourceAdapter` interface: `canHandle` / `discoverJobs` / `fetchJobDetails` / `normalize`) with one implementation per source type. Greenhouse/Lever/Workday hit public JSON APIs directly via `fetch`; the generic adapter drives real Playwright pages using fully-configurable CSS selectors from `sites.yml`. A `source-runner` orchestrates all enabled sites, isolating per-site failures; a pure `deduplicator` merges new results into the existing JSONL store using a 4-tier priority (canonical URL → source+requisitionId → company+title+location → JD fingerprint).

**Tech Stack:** Node.js (global `fetch`), TypeScript, Playwright (generic adapter only), zod (config validation), vitest (tests, all network/browser calls mocked).

## Global Constraints

- No LLM calls anywhere in this phase.
- No resume matching or scoring yet.
- No SQLite — storage is `data/jobs.jsonl` (append-safe, atomic rewrite on dedup).
- No HTML/CSV dashboard yet.
- Never submit an application; never bypass CAPTCHA, anti-bot, or login/auth controls.
- When verification is detected on a live Playwright page: pause, keep Chrome open, print a clear message, wait for the user, then continue (reuses Phase 1's `pauseForVerification` from `src/browser/verification.ts`).
- Collectors must not stop at page one — loop until no next page, no new listings, or a configured safety limit (`maxPagesPerSource`, `maxJobsPerSource`) is hit.
- One source's failure must not stop other sources (catch-and-log per site).
- Existing Phase 1 tests (14 tests) must continue passing unmodified.
- No live network calls or real browser launches in any test — mock `fetch`; use fake `Page`/`BrowserContext`-shaped objects for the generic adapter.
- Do not commit anything (no git repo present; user has said not to commit regardless).
- Do not guess a Workday tenant/site — the `workday:` config block is required explicitly in `sites.yml`; missing it is a per-site error, not a guess.
- Do not hardcode any one company's selectors into the generic adapter — all selectors come from `site.generic` in `sites.yml`.

---

## Task 1: Extend types + config schema/loader for Phase 2

**Files:**
- Modify: `src/types.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts`
- Modify: `config/sites.yml`
- Modify: `tests/config-loader.test.ts`

**Interfaces:**
- Produces: `WorkdayConfig`, `GenericSelectors`, `CollectSettings` types in `src/types.ts`; extended `SiteConfig` with optional `greenhouse?`, `lever?`, `workday?`, `generic?` blocks; `loadCollectSettings(filePath: string): CollectSettings` in `src/config/loader.ts`.

- [ ] **Step 1: Extend `src/types.ts`**

Add below the existing `SiteConfig` interface (keep `SiteConfig`'s existing 5 fields untouched, just add the four optional blocks):

```ts
export interface WorkdayConfig {
  hostname: string;
  tenant: string;
  site: string;
}

export interface GenericSelectors {
  searchInputSelector: string;
  searchButtonSelector: string;
  resultCardSelector: string;
  jobLinkSelector: string;
  nextButtonSelector?: string;
  loadMoreSelector?: string;
  titleSelector: string;
  locationSelector: string;
  descriptionSelector: string;
  applyLinkSelector?: string;
}

export interface CollectSettings {
  maxPagesPerSource: number;
  maxJobsPerSource: number;
  navigationTimeoutMs: number;
  delayBetweenRequestsMs: number;
}
```

Update `SiteConfig` to:

```ts
export interface SiteConfig {
  id: string;
  name: string;
  url: string;
  adapter: AdapterKind;
  enabled: boolean;
  greenhouse?: { boardToken?: string };
  lever?: { site?: string };
  workday?: WorkdayConfig;
  generic?: GenericSelectors;
}
```

- [ ] **Step 2: Extend `src/config/schema.ts`**

```ts
export const collectSettingsSchema = z
  .object({
    maxPagesPerSource: z.number().int().positive().default(100),
    maxJobsPerSource: z.number().int().positive().default(5000),
    navigationTimeoutMs: z.number().int().positive().default(30000),
    delayBetweenRequestsMs: z.number().int().nonnegative().default(500),
  })
  .default({});

export const workdaySiteSchema = z.object({
  hostname: z.string().min(1),
  tenant: z.string().min(1),
  site: z.string().min(1),
});

export const genericSelectorsSchema = z.object({
  searchInputSelector: z.string().min(1),
  searchButtonSelector: z.string().min(1),
  resultCardSelector: z.string().min(1),
  jobLinkSelector: z.string().min(1),
  nextButtonSelector: z.string().min(1).optional(),
  loadMoreSelector: z.string().min(1).optional(),
  titleSelector: z.string().min(1),
  locationSelector: z.string().min(1),
  descriptionSelector: z.string().min(1),
  applyLinkSelector: z.string().min(1).optional(),
});
```

Update `siteSchema` (add fields, keep existing ones as-is):

```ts
export const siteSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  adapter: z.enum(ADAPTERS),
  enabled: z.boolean(),
  greenhouse: z.object({ boardToken: z.string().min(1).optional() }).optional(),
  lever: z.object({ site: z.string().min(1).optional() }).optional(),
  workday: workdaySiteSchema.optional(),
  generic: genericSelectorsSchema.optional(),
});
```

Update `sitesFileSchema`:

```ts
export const sitesFileSchema = z.object({
  settings: collectSettingsSchema,
  sites: z.array(siteSchema).min(1),
});
```

- [ ] **Step 3: Extend `src/config/loader.ts`**

Add after `loadSitesConfig`:

```ts
import type { CollectSettings } from "../types.js";

export function loadCollectSettings(filePath: string): CollectSettings {
  return parseAndValidate(filePath, sitesFileSchema).settings;
}
```

(Put the `CollectSettings` import alongside the existing `RoleConfig, SiteConfig` import line rather than a second import statement.)

- [ ] **Step 4: Add settings block + workday/generic examples to `config/sites.yml`**

Replace the file's contents with (adds a top-level `settings:` block and fills in `workday:`/`generic:` blocks on the two matching example entries — still all `enabled: false`):

```yaml
# Career sites to search. Only sites listed here are ever visited.
# adapter must be one of: greenhouse, lever, workday, generic
settings:
  maxPagesPerSource: 100
  maxJobsPerSource: 5000
  navigationTimeoutMs: 30000
  delayBetweenRequestsMs: 500

sites:
  - id: example-greenhouse
    name: "Example Co (Greenhouse)"
    url: "https://boards.greenhouse.io/example"
    adapter: greenhouse
    enabled: false

  - id: example-lever
    name: "Example Co (Lever)"
    url: "https://jobs.lever.co/example"
    adapter: lever
    enabled: false

  - id: example-workday
    name: "Example Co (Workday)"
    url: "https://example.wd1.myworkdayjobs.com/careers"
    adapter: workday
    enabled: false
    workday:
      hostname: "example.wd1.myworkdayjobs.com"
      tenant: "example"
      site: "careers"

  - id: example-generic
    name: "Example Co (Generic careers page)"
    url: "https://example.com/careers"
    adapter: generic
    enabled: false
    generic:
      searchInputSelector: "#search-input"
      searchButtonSelector: "#search-button"
      resultCardSelector: ".job-card"
      jobLinkSelector: ".job-card a"
      loadMoreSelector: ".load-more"
      titleSelector: "h1.job-title"
      locationSelector: ".job-location"
      descriptionSelector: ".job-description"
      applyLinkSelector: "a.apply-button"
```

- [ ] **Step 5: Add settings-default test to `tests/config-loader.test.ts`**

Add this `describe` block at the end of the file (keep all existing tests untouched):

```ts
import { loadCollectSettings } from "../src/config/loader.js";

describe("loadCollectSettings", () => {
  it("applies defaults when settings block is omitted", () => {
    const filePath = tempFile(
      "sites.yml",
      `
sites:
  - id: acme
    name: Acme Corp
    url: "https://acme.com/careers"
    adapter: greenhouse
    enabled: true
`,
    );

    expect(loadCollectSettings(filePath)).toEqual({
      maxPagesPerSource: 100,
      maxJobsPerSource: 5000,
      navigationTimeoutMs: 30000,
      delayBetweenRequestsMs: 500,
    });
  });

  it("respects an explicit settings block", () => {
    const filePath = tempFile(
      "sites.yml",
      `
settings:
  maxPagesPerSource: 5
  maxJobsPerSource: 10
  navigationTimeoutMs: 1000
  delayBetweenRequestsMs: 0
sites:
  - id: acme
    name: Acme Corp
    url: "https://acme.com/careers"
    adapter: greenhouse
    enabled: true
`,
    );

    expect(loadCollectSettings(filePath)).toEqual({
      maxPagesPerSource: 5,
      maxJobsPerSource: 10,
      navigationTimeoutMs: 1000,
      delayBetweenRequestsMs: 0,
    });
  });
});
```

(Move the `import { loadCollectSettings } ...` line up to the top import group instead of inline — written here separately only for clarity of what to add.)

- [ ] **Step 6: Run typecheck + full test suite**

Run: `cd F:/Jobs/Job_Search/job-hunter && npm run typecheck && npm test`
Expected: no TS errors; all Phase 1 tests (14) still pass; new settings tests pass (2 more).

---

## Task 2: Dedup primitives — canonicalize-url, fingerprint, job-id

**Files:**
- Create: `src/dedup/canonicalize-url.ts`
- Test: `tests/dedup/canonicalize-url.test.ts`
- Create: `src/dedup/fingerprint.ts`
- Test: `tests/dedup/fingerprint.test.ts`

**Interfaces:**
- Produces: `canonicalizeUrl(rawUrl: string): string`, `computeJobId(canonicalUrl: string): string` (both in `canonicalize-url.ts`); `fingerprintDescription(descriptionText: string): string` (in `fingerprint.ts`).

- [ ] **Step 1: Write failing tests — `tests/dedup/canonicalize-url.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { canonicalizeUrl, computeJobId } from "../../src/dedup/canonicalize-url.js";

describe("canonicalizeUrl", () => {
  it("lowercases the host, strips fragment and trailing slash", () => {
    expect(canonicalizeUrl("https://Example.COM/jobs/123/#apply")).toBe(
      "https://example.com/jobs/123",
    );
  });

  it("strips known tracking params but keeps meaningful ones", () => {
    const result = canonicalizeUrl(
      "https://boards.greenhouse.io/acme/jobs/123?gh_jid=123&gh_src=abc&utm_source=x&utm_campaign=y",
    );
    expect(result).toBe("https://boards.greenhouse.io/acme/jobs/123?gh_jid=123");
  });

  it("is stable regardless of query param order", () => {
    const a = canonicalizeUrl("https://acme.com/jobs/1?gh_jid=1&utm_source=x");
    const b = canonicalizeUrl("https://acme.com/jobs/1?utm_source=x&gh_jid=1");
    expect(a).toBe(b);
  });
});

describe("computeJobId", () => {
  it("is deterministic for the same canonical url", () => {
    const id1 = computeJobId("https://acme.com/jobs/1");
    const id2 = computeJobId("https://acme.com/jobs/1");
    expect(id1).toBe(id2);
  });

  it("differs for different urls", () => {
    const id1 = computeJobId("https://acme.com/jobs/1");
    const id2 = computeJobId("https://acme.com/jobs/2");
    expect(id1).not.toBe(id2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/dedup/canonicalize-url.test.ts`
Expected: FAIL — module `src/dedup/canonicalize-url.ts` does not exist.

- [ ] **Step 3: Implement `src/dedup/canonicalize-url.ts`**

```ts
import { createHash } from "node:crypto";

const TRACKING_PARAMS_EXACT = new Set(["gh_src", "lever-source", "ref", "trk"]);

export function canonicalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  const params = url.searchParams;
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAMS_EXACT.has(lower)) {
      params.delete(key);
    }
  }
  params.sort();
  const query = params.toString();
  url.search = query ? `?${query}` : "";

  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  url.pathname = pathname;

  return url.toString();
}

export function computeJobId(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalizeUrl(canonicalUrl)).digest("hex").slice(0, 16);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/dedup/canonicalize-url.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Write failing test — `tests/dedup/fingerprint.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { fingerprintDescription } from "../../src/dedup/fingerprint.js";

describe("fingerprintDescription", () => {
  it("is stable across whitespace and case differences", () => {
    const a = fingerprintDescription("We need a  Senior  SDET.\n\nApply now!");
    const b = fingerprintDescription("we need a senior sdet. apply now!");
    expect(a).toBe(b);
  });

  it("differs for different content", () => {
    const a = fingerprintDescription("We need a Senior SDET.");
    const b = fingerprintDescription("We need a Senior Network Engineer.");
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/dedup/fingerprint.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Implement `src/dedup/fingerprint.ts`**

```ts
import { createHash } from "node:crypto";

export function fingerprintDescription(descriptionText: string): string {
  const normalized = descriptionText.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex");
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/dedup/fingerprint.test.ts`
Expected: PASS (2 tests)

---

## Task 3: Adapter shared types + extraction helpers + match-profiles

**Files:**
- Create: `src/adapters/types.ts`
- Create: `src/extraction/jd-cleaner.ts`
- Test: `tests/extraction/jd-cleaner.test.ts`
- Create: `src/extraction/metadata.ts`
- Test: `tests/extraction/metadata.test.ts`
- Create: `src/adapters/match-profiles.ts`
- Test: `tests/adapters/match-profiles.test.ts`

**Interfaces:**
- Produces: `JobPosting`, `DiscoveredJob`, `RawJobDetail`, `RoleSearch`, `SourceAdapter` interfaces (`src/adapters/types.ts`); `stripHtml(html: string): string` (`jd-cleaner.ts`); `extractRequiredYears(text: string): number | null` (`metadata.ts`); `matchProfiles(text: string, searches: RoleSearch[]): string[]` (`match-profiles.ts`).
- Consumes: `SiteConfig`, `CollectSettings`, `RoleConfig` from `src/types.ts`.

- [ ] **Step 1: Create `src/adapters/types.ts`** (no test — pure type declarations)

```ts
import type { CollectSettings, RoleConfig, SiteConfig } from "../types.js";

export interface RoleSearch {
  keyword: string;
  profileIds: string[];
}

export interface DiscoveredJob {
  externalId: string;
  title: string;
  url: string;
  matchedProfiles: string[];
  rawMetadata?: Record<string, unknown>;
}

export interface RawJobDetail {
  externalId: string;
  title: string;
  descriptionText: string;
  descriptionHtml: string | null;
  location: string | null;
  department: string | null;
  employmentType: string | null;
  requisitionId: string | null;
  postingDate: string | null;
  salaryText: string | null;
  canonicalUrl: string;
  applyUrl: string;
  rawMetadata: Record<string, unknown>;
}

export interface JobPosting {
  id: string;
  source: string;
  sourceType: SiteConfig["adapter"];
  company: string;
  title: string;
  location: string | null;
  remoteType: string | null;
  employmentType: string | null;
  department: string | null;
  requisitionId: string | null;
  postingDate: string | null;
  discoveredAt: string;
  lastSeenAt: string;
  canonicalUrl: string;
  applyUrl: string;
  descriptionText: string;
  descriptionHtml: string | null;
  requiredYears: number | null;
  salaryText: string | null;
  matchedProfiles: string[];
  rawMetadata: Record<string, unknown>;
}

export interface SourceAdapter {
  sourceType: SiteConfig["adapter"];
  canHandle(site: SiteConfig): boolean;
  discoverJobs(
    site: SiteConfig,
    searches: RoleSearch[],
    settings: CollectSettings,
  ): Promise<DiscoveredJob[]>;
  fetchJobDetails(
    job: DiscoveredJob,
    site: SiteConfig,
    settings: CollectSettings,
  ): Promise<RawJobDetail>;
  normalize(raw: RawJobDetail, site: SiteConfig, matchedProfiles: string[]): JobPosting;
}

export type { RoleConfig };
```

- [ ] **Step 2: Write failing test — `tests/extraction/jd-cleaner.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { stripHtml } from "../../src/extraction/jd-cleaner.js";

describe("stripHtml", () => {
  it("removes tags and collapses whitespace", () => {
    expect(stripHtml("<p>Hello   <b>World</b></p>\n<div>!</div>")).toBe("Hello World !");
  });

  it("removes script and style contents entirely", () => {
    expect(stripHtml("<style>.a{color:red}</style><p>Text</p><script>evil()</script>")).toBe(
      "Text",
    );
  });

  it("decodes common entities", () => {
    expect(stripHtml("Salary:&nbsp;$100k")).toBe("Salary: $100k");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/extraction/jd-cleaner.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `src/extraction/jd-cleaner.ts`**

```ts
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/extraction/jd-cleaner.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Write failing test — `tests/extraction/metadata.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { extractRequiredYears } from "../../src/extraction/metadata.js";

describe("extractRequiredYears", () => {
  it("extracts a plain years requirement", () => {
    expect(extractRequiredYears("Requires 5 years of experience in QA.")).toBe(5);
  });

  it("extracts a plus-years requirement", () => {
    expect(extractRequiredYears("3+ years of Python required.")).toBe(3);
  });

  it("returns null when no years phrasing is present", () => {
    expect(extractRequiredYears("We are looking for a great engineer.")).toBeNull();
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/extraction/metadata.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 8: Implement `src/extraction/metadata.ts`**

```ts
export function extractRequiredYears(text: string): number | null {
  const match = text.match(/(\d{1,2})\+?\s*(?:years|yrs)\b/i);
  return match ? Number(match[1]) : null;
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/extraction/metadata.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 10: Write failing test — `tests/adapters/match-profiles.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { matchProfiles } from "../../src/adapters/match-profiles.js";

describe("matchProfiles", () => {
  it("returns profile ids whose keyword appears (case-insensitive)", () => {
    const result = matchProfiles("Senior SDET - Test Automation Engineer", [
      { keyword: "sdet", profileIds: ["sdet"] },
      { keyword: "network engineer", profileIds: ["network"] },
    ]);
    expect(result).toEqual(["sdet"]);
  });

  it("unions profile ids across multiple matching keywords", () => {
    const result = matchProfiles("Cloud Security Engineer (IAM)", [
      { keyword: "cloud", profileIds: ["cloud"] },
      { keyword: "security", profileIds: ["security"] },
      { keyword: "network", profileIds: ["network"] },
    ]);
    expect(result.sort()).toEqual(["cloud", "security"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(matchProfiles("Barista", [{ keyword: "sdet", profileIds: ["sdet"] }])).toEqual([]);
  });
});
```

- [ ] **Step 11: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/match-profiles.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 12: Implement `src/adapters/match-profiles.ts`**

```ts
import type { RoleSearch } from "./types.js";

export function matchProfiles(text: string, searches: RoleSearch[]): string[] {
  const lower = text.toLowerCase();
  const profiles = new Set<string>();
  for (const search of searches) {
    if (search.keyword && lower.includes(search.keyword.toLowerCase())) {
      for (const profileId of search.profileIds) profiles.add(profileId);
    }
  }
  return [...profiles];
}
```

- [ ] **Step 13: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/match-profiles.test.ts`
Expected: PASS (3 tests)

---

## Task 4: JSONL storage

**Files:**
- Create: `src/storage/jsonl-store.ts`
- Test: `tests/storage/jsonl-store.test.ts`

**Interfaces:**
- Consumes: `JobPosting` from `src/adapters/types.ts`.
- Produces: `loadJobs(filePath: string): JobPosting[]`, `saveJobs(filePath: string, jobs: JobPosting[]): void`.

- [ ] **Step 1: Write failing test — `tests/storage/jsonl-store.test.ts`**

```ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadJobs, saveJobs } from "../../src/storage/jsonl-store.js";
import type { JobPosting } from "../../src/adapters/types.js";

function makeJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "job-1",
    source: "acme-greenhouse",
    sourceType: "greenhouse",
    company: "Acme",
    title: "SDET",
    location: "Remote",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: "123",
    postingDate: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    canonicalUrl: "https://acme.com/jobs/123",
    applyUrl: "https://acme.com/jobs/123",
    descriptionText: "Test description",
    descriptionHtml: null,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: ["sdet"],
    rawMetadata: {},
    ...overrides,
  };
}

describe("jsonl-store", () => {
  it("returns an empty array when the file does not exist", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    expect(loadJobs(path.join(dir, "jobs.jsonl"))).toEqual([]);
  });

  it("round-trips jobs through save and load", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "jobs.jsonl");
    const jobs = [makeJob(), makeJob({ id: "job-2", requisitionId: "456" })];

    saveJobs(filePath, jobs);
    expect(loadJobs(filePath)).toEqual(jobs);
  });

  it("creates the parent directory if missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "nested", "jobs.jsonl");
    saveJobs(filePath, [makeJob()]);
    expect(existsSync(filePath)).toBe(true);
  });

  it("does not leave a .tmp file behind after saving", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "jobs.jsonl");
    saveJobs(filePath, [makeJob()]);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  it("skips malformed lines instead of crashing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "jobs.jsonl");
    const goodJob = makeJob();
    require("node:fs").writeFileSync(
      filePath,
      `${JSON.stringify(goodJob)}\nnot valid json\n`,
      "utf-8",
    );
    expect(loadJobs(filePath)).toEqual([goodJob]);
  });

  it("writes one JSON object per line with no trailing commas", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-jsonl-"));
    const filePath = path.join(dir, "jobs.jsonl");
    saveJobs(filePath, [makeJob(), makeJob({ id: "job-2" })]);
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/storage/jsonl-store.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/storage/jsonl-store.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JobPosting } from "../adapters/types.js";

export function loadJobs(filePath: string): JobPosting[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf-8");
  const jobs: JobPosting[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      jobs.push(JSON.parse(trimmed) as JobPosting);
    } catch {
      console.error(`Skipping malformed JSONL line in ${filePath}`);
    }
  }
  return jobs;
}

export function saveJobs(filePath: string, jobs: JobPosting[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const content = jobs.map((job) => JSON.stringify(job)).join("\n") + (jobs.length ? "\n" : "");
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, filePath);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/storage/jsonl-store.test.ts`
Expected: PASS (6 tests)

---

## Task 5: Deduplicator

**Files:**
- Create: `src/dedup/deduplicator.ts`
- Test: `tests/dedup/deduplicator.test.ts`

**Interfaces:**
- Consumes: `JobPosting` (`src/adapters/types.ts`), `canonicalizeUrl` + `computeJobId` (`canonicalize-url.ts`), `fingerprintDescription` (`fingerprint.ts`).
- Produces: `mergeJobs(existing: JobPosting[], incoming: JobPosting[], now: string): JobPosting[]`.

- [ ] **Step 1: Write failing test — `tests/dedup/deduplicator.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { mergeJobs } from "../../src/dedup/deduplicator.js";
import type { JobPosting } from "../../src/adapters/types.js";

function makeJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "id-1",
    source: "acme-greenhouse",
    sourceType: "greenhouse",
    company: "Acme",
    title: "SDET",
    location: "Remote",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: "123",
    postingDate: null,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    canonicalUrl: "https://acme.com/jobs/123",
    applyUrl: "https://acme.com/jobs/123",
    descriptionText: "We need a great SDET with 5 years experience.",
    descriptionHtml: null,
    requiredYears: 5,
    salaryText: null,
    matchedProfiles: ["sdet"],
    rawMetadata: {},
    ...overrides,
  };
}

describe("mergeJobs", () => {
  it("inserts a brand new job with discoveredAt = lastSeenAt = now", () => {
    const now = "2026-02-01T00:00:00.000Z";
    const result = mergeJobs([], [makeJob()], now);
    expect(result).toHaveLength(1);
    expect(result[0].discoveredAt).toBe(now);
    expect(result[0].lastSeenAt).toBe(now);
  });

  it("matches on canonical URL and preserves original discoveredAt", () => {
    const existing = [makeJob({ discoveredAt: "2026-01-01T00:00:00.000Z" })];
    const now = "2026-02-01T00:00:00.000Z";
    const incoming = [makeJob({ title: "Senior SDET", lastSeenAt: now })];
    const result = mergeJobs(existing, incoming, now);

    expect(result).toHaveLength(1);
    expect(result[0].discoveredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result[0].lastSeenAt).toBe(now);
    expect(result[0].title).toBe("Senior SDET");
  });

  it("matches on source + requisitionId even if the URL changed", () => {
    const existing = [makeJob({ canonicalUrl: "https://acme.com/old-jobs/123" })];
    const now = "2026-02-01T00:00:00.000Z";
    const incoming = [makeJob({ canonicalUrl: "https://acme.com/jobs/123?v=2" })];
    const result = mergeJobs(existing, incoming, now);
    expect(result).toHaveLength(1);
  });

  it("falls back to normalized company+title+location when url/reqId don't match", () => {
    const existing = [
      makeJob({ canonicalUrl: "https://acme.com/a", requisitionId: null }),
    ];
    const now = "2026-02-01T00:00:00.000Z";
    const incoming = [
      makeJob({
        canonicalUrl: "https://acme.com/b",
        requisitionId: null,
        title: "  sdet  ",
        location: "REMOTE",
      }),
    ];
    const result = mergeJobs(existing, incoming, now);
    expect(result).toHaveLength(1);
  });

  it("falls back to JD fingerprint when nothing else matches", () => {
    const existing = [
      makeJob({
        canonicalUrl: "https://acme.com/a",
        requisitionId: null,
        title: "SDET I",
        location: "NYC",
      }),
    ];
    const now = "2026-02-01T00:00:00.000Z";
    const incoming = [
      makeJob({
        canonicalUrl: "https://acme.com/b",
        requisitionId: null,
        title: "SDET II",
        location: "SF",
        descriptionText: "We need a great SDET with 5 years experience.",
      }),
    ];
    const result = mergeJobs(existing, incoming, now);
    expect(result).toHaveLength(1);
  });

  it("does NOT merge two different requisitions that share a title", () => {
    const existing = [
      makeJob({
        canonicalUrl: "https://acme.com/jobs/1",
        requisitionId: "1",
        location: "NYC",
        descriptionText: "First distinct posting text about NYC role.",
      }),
    ];
    const now = "2026-02-01T00:00:00.000Z";
    const incoming = [
      makeJob({
        canonicalUrl: "https://acme.com/jobs/2",
        requisitionId: "2",
        location: "Austin",
        descriptionText: "Second distinct posting text about Austin role.",
      }),
    ];
    const result = mergeJobs(existing, incoming, now);
    expect(result).toHaveLength(2);
  });

  it("running the same incoming list twice does not duplicate", () => {
    const now1 = "2026-02-01T00:00:00.000Z";
    const now2 = "2026-02-02T00:00:00.000Z";
    const first = mergeJobs([], [makeJob()], now1);
    const second = mergeJobs(first, [makeJob()], now2);
    expect(second).toHaveLength(1);
    expect(second[0].discoveredAt).toBe(now1);
    expect(second[0].lastSeenAt).toBe(now2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/dedup/deduplicator.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/dedup/deduplicator.ts`**

```ts
import { canonicalizeUrl } from "./canonicalize-url.js";
import { fingerprintDescription } from "./fingerprint.js";
import type { JobPosting } from "../adapters/types.js";

function normalizeKey(...parts: (string | null)[]): string {
  return parts.map((part) => (part ?? "").toLowerCase().trim().replace(/\s+/g, " ")).join("::");
}

export function mergeJobs(
  existing: JobPosting[],
  incoming: JobPosting[],
  now: string,
): JobPosting[] {
  const result: JobPosting[] = [...existing];
  const byUrl = new Map<string, number>();
  const byReq = new Map<string, number>();
  const byCompanyTitleLoc = new Map<string, number>();
  const byFingerprint = new Map<string, number>();

  function index(job: JobPosting, idx: number): void {
    byUrl.set(canonicalizeUrl(job.canonicalUrl), idx);
    if (job.requisitionId) byReq.set(`${job.source}::${job.requisitionId}`, idx);
    byCompanyTitleLoc.set(normalizeKey(job.company, job.title, job.location), idx);
    byFingerprint.set(fingerprintDescription(job.descriptionText), idx);
  }

  result.forEach(index);

  for (const incomingJob of incoming) {
    const urlKey = canonicalizeUrl(incomingJob.canonicalUrl);
    const reqKey = incomingJob.requisitionId
      ? `${incomingJob.source}::${incomingJob.requisitionId}`
      : null;
    const ctlKey = normalizeKey(incomingJob.company, incomingJob.title, incomingJob.location);
    const fpKey = fingerprintDescription(incomingJob.descriptionText);

    const matchIdx =
      byUrl.get(urlKey) ??
      (reqKey ? byReq.get(reqKey) : undefined) ??
      byCompanyTitleLoc.get(ctlKey) ??
      byFingerprint.get(fpKey);

    if (matchIdx !== undefined) {
      const original = result[matchIdx];
      const merged: JobPosting = {
        ...incomingJob,
        id: original.id,
        discoveredAt: original.discoveredAt,
        lastSeenAt: now,
      };
      result[matchIdx] = merged;
      index(merged, matchIdx);
    } else {
      const fresh: JobPosting = { ...incomingJob, discoveredAt: now, lastSeenAt: now };
      result.push(fresh);
      index(fresh, result.length - 1);
    }
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/dedup/deduplicator.test.ts`
Expected: PASS (7 tests)

---

## Task 6: Greenhouse adapter

**Files:**
- Create: `src/adapters/greenhouse.ts`
- Test: `tests/adapters/greenhouse.test.ts`

**Interfaces:**
- Consumes: `SourceAdapter`, `DiscoveredJob`, `RawJobDetail`, `RoleSearch` (`adapters/types.js`); `matchProfiles` (`adapters/match-profiles.js`); `stripHtml` (`extraction/jd-cleaner.js`); `extractRequiredYears` (`extraction/metadata.js`); `computeJobId` (`dedup/canonicalize-url.js`); `detectVerification` (`browser/verification.js`).
- Produces: `greenhouseAdapter: SourceAdapter` (named export).

- [ ] **Step 1: Write failing test — `tests/adapters/greenhouse.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { greenhouseAdapter } from "../../src/adapters/greenhouse.js";
import type { SiteConfig, CollectSettings } from "../../src/types.js";

const site: SiteConfig = {
  id: "acme-greenhouse",
  name: "Acme",
  url: "https://boards.greenhouse.io/acme",
  adapter: "greenhouse",
  enabled: true,
};

const settings: CollectSettings = {
  maxPagesPerSource: 100,
  maxJobsPerSource: 5000,
  navigationTimeoutMs: 30000,
  delayBetweenRequestsMs: 0,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("greenhouseAdapter", () => {
  it("canHandle returns true only for greenhouse sites", () => {
    expect(greenhouseAdapter.canHandle(site)).toBe(true);
    expect(greenhouseAdapter.canHandle({ ...site, adapter: "lever" })).toBe(false);
  });

  it("discovers jobs from the board and tags matched profiles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobs: [
            {
              id: 1,
              title: "SDET II",
              absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
              location: { name: "Remote" },
              departments: [{ name: "Quality" }],
              content: "<p>5 years of test automation required.</p>",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
            {
              id: 2,
              title: "Barista",
              absolute_url: "https://boards.greenhouse.io/acme/jobs/2",
              content: "<p>Make coffee.</p>",
            },
          ],
        }),
      ),
    );

    const discovered = await greenhouseAdapter.discoverJobs(
      site,
      [{ keyword: "sdet", profileIds: ["sdet"] }],
      settings,
    );

    expect(discovered).toHaveLength(2);
    expect(discovered[0].matchedProfiles).toEqual(["sdet"]);
    expect(discovered[1].matchedProfiles).toEqual([]);
  });

  it("fetchJobDetails + normalize produce a full JobPosting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobs: [
            {
              id: 1,
              title: "SDET II",
              absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
              location: { name: "Remote" },
              departments: [{ name: "Quality" }],
              content: "<p>5 years of test automation required.</p>",
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    );

    const [discovered] = await greenhouseAdapter.discoverJobs(
      site,
      [{ keyword: "sdet", profileIds: ["sdet"] }],
      settings,
    );
    const raw = await greenhouseAdapter.fetchJobDetails(discovered, site, settings);
    const job = greenhouseAdapter.normalize(raw, site, discovered.matchedProfiles);

    expect(job.company).toBe("Acme");
    expect(job.sourceType).toBe("greenhouse");
    expect(job.title).toBe("SDET II");
    expect(job.location).toBe("Remote");
    expect(job.department).toBe("Quality");
    expect(job.requisitionId).toBe("1");
    expect(job.descriptionText).toBe("5 years of test automation required.");
    expect(job.requiredYears).toBe(5);
    expect(job.matchedProfiles).toEqual(["sdet"]);
  });

  it("throws a clear error on a malformed (non-JSON) response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not json", { status: 200 })),
    );
    await expect(greenhouseAdapter.discoverJobs(site, [], settings)).rejects.toThrow(/non-JSON/);
  });

  it("throws a clear error when a verification challenge is detected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html><body>Please verify you are human.</body></html>", { status: 403 }),
      ),
    );
    await expect(greenhouseAdapter.discoverJobs(site, [], settings)).rejects.toThrow(
      /Verification required/,
    );
  });

  it("caps results at maxJobsPerSource", async () => {
    const jobs = Array.from({ length: 5 }, (_, i) => ({
      id: i,
      title: `Job ${i}`,
      absolute_url: `https://boards.greenhouse.io/acme/jobs/${i}`,
      content: "<p>text</p>",
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ jobs })));
    const discovered = await greenhouseAdapter.discoverJobs(site, [], { ...settings, maxJobsPerSource: 2 });
    expect(discovered).toHaveLength(2);
  });

  it("throws when no board token can be determined", async () => {
    const badSite: SiteConfig = { ...site, url: "https://example.com/careers" };
    await expect(greenhouseAdapter.discoverJobs(badSite, [], settings)).rejects.toThrow(
      /board token/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/greenhouse.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/adapters/greenhouse.ts`**

```ts
import type { CollectSettings, SiteConfig } from "../types.js";
import type { DiscoveredJob, RawJobDetail, RoleSearch, SourceAdapter } from "./types.js";
import { matchProfiles } from "./match-profiles.js";
import { detectVerification } from "../browser/verification.js";
import { stripHtml } from "../extraction/jd-cleaner.js";
import { extractRequiredYears } from "../extraction/metadata.js";
import { computeJobId } from "../dedup/canonicalize-url.js";

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  departments?: { name: string }[];
  content?: string;
  updated_at?: string;
}

interface GreenhouseBoardResponse {
  jobs: GreenhouseJob[];
}

function extractBoardToken(site: SiteConfig): string {
  if (site.greenhouse?.boardToken) return site.greenhouse.boardToken;
  const match = site.url.match(/boards\.greenhouse\.io\/([^/?#]+)/i);
  if (match?.[1]) return match[1];
  throw new Error(
    `Cannot determine Greenhouse board token for site "${site.id}" - set site.greenhouse.boardToken`,
  );
}

async function fetchBoard(token: string): Promise<GreenhouseBoardResponse> {
  const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
  const text = await res.text();

  const verification = detectVerification({ html: text, url: res.url || token });
  if (verification.detected) {
    throw new Error(`Verification required fetching Greenhouse board "${token}": ${verification.reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Greenhouse board "${token}" returned a non-JSON response`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as GreenhouseBoardResponse).jobs)
  ) {
    throw new Error(`Greenhouse board "${token}" returned an unexpected response shape`);
  }

  return parsed as GreenhouseBoardResponse;
}

export const greenhouseAdapter: SourceAdapter = {
  sourceType: "greenhouse",

  canHandle(site: SiteConfig): boolean {
    return site.adapter === "greenhouse";
  },

  async discoverJobs(
    site: SiteConfig,
    searches: RoleSearch[],
    settings: CollectSettings,
  ): Promise<DiscoveredJob[]> {
    const token = extractBoardToken(site);
    const board = await fetchBoard(token);
    return board.jobs.slice(0, settings.maxJobsPerSource).map((job) => ({
      externalId: String(job.id),
      title: job.title,
      url: job.absolute_url,
      matchedProfiles: matchProfiles(job.title, searches),
      rawMetadata: job as unknown as Record<string, unknown>,
    }));
  },

  async fetchJobDetails(job: DiscoveredJob): Promise<RawJobDetail> {
    const raw = job.rawMetadata as unknown as GreenhouseJob;
    return {
      externalId: job.externalId,
      title: raw.title,
      descriptionText: stripHtml(raw.content ?? ""),
      descriptionHtml: raw.content ?? null,
      location: raw.location?.name ?? null,
      department: raw.departments?.[0]?.name ?? null,
      employmentType: null,
      requisitionId: job.externalId,
      postingDate: raw.updated_at ?? null,
      salaryText: null,
      canonicalUrl: job.url,
      applyUrl: job.url,
      rawMetadata: raw as unknown as Record<string, unknown>,
    };
  },

  normalize(raw: RawJobDetail, site: SiteConfig, matchedProfiles: string[]) {
    const now = new Date().toISOString();
    return {
      id: computeJobId(raw.canonicalUrl),
      source: site.id,
      sourceType: "greenhouse" as const,
      company: site.name,
      title: raw.title,
      location: raw.location,
      remoteType: null,
      employmentType: raw.employmentType,
      department: raw.department,
      requisitionId: raw.requisitionId,
      postingDate: raw.postingDate,
      discoveredAt: now,
      lastSeenAt: now,
      canonicalUrl: raw.canonicalUrl,
      applyUrl: raw.applyUrl,
      descriptionText: raw.descriptionText,
      descriptionHtml: raw.descriptionHtml,
      requiredYears: extractRequiredYears(raw.descriptionText),
      salaryText: raw.salaryText,
      matchedProfiles,
      rawMetadata: raw.rawMetadata,
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/greenhouse.test.ts`
Expected: PASS (7 tests)

---

## Task 7: Lever adapter

**Files:**
- Create: `src/adapters/lever.ts`
- Test: `tests/adapters/lever.test.ts`

**Interfaces:**
- Same shared imports as Task 6.
- Produces: `leverAdapter: SourceAdapter`.

- [ ] **Step 1: Write failing test — `tests/adapters/lever.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { leverAdapter } from "../../src/adapters/lever.js";
import type { SiteConfig, CollectSettings } from "../../src/types.js";

const site: SiteConfig = {
  id: "acme-lever",
  name: "Acme",
  url: "https://jobs.lever.co/acme",
  adapter: "lever",
  enabled: true,
};

const settings: CollectSettings = {
  maxPagesPerSource: 100,
  maxJobsPerSource: 5000,
  navigationTimeoutMs: 30000,
  delayBetweenRequestsMs: 0,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const postings = [
  {
    id: "abc-123",
    text: "Network Engineer",
    categories: { commitment: "Full-time", location: "Austin, TX", team: "Infrastructure" },
    hostedUrl: "https://jobs.lever.co/acme/abc-123",
    applyUrl: "https://jobs.lever.co/acme/abc-123/apply",
    descriptionPlain: "5 years of networking experience required.",
    createdAt: 1735689600000,
  },
];

describe("leverAdapter", () => {
  it("canHandle returns true only for lever sites", () => {
    expect(leverAdapter.canHandle(site)).toBe(true);
    expect(leverAdapter.canHandle({ ...site, adapter: "greenhouse" })).toBe(false);
  });

  it("discovers postings and tags matched profiles", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(postings)));
    const discovered = await leverAdapter.discoverJobs(
      site,
      [{ keyword: "network", profileIds: ["network"] }],
      settings,
    );
    expect(discovered).toHaveLength(1);
    expect(discovered[0].matchedProfiles).toEqual(["network"]);
  });

  it("fetchJobDetails + normalize produce a full JobPosting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(postings)));
    const [discovered] = await leverAdapter.discoverJobs(site, [], settings);
    const raw = await leverAdapter.fetchJobDetails(discovered, site, settings);
    const job = leverAdapter.normalize(raw, site, ["network"]);

    expect(job.sourceType).toBe("lever");
    expect(job.location).toBe("Austin, TX");
    expect(job.department).toBe("Infrastructure");
    expect(job.employmentType).toBe("Full-time");
    expect(job.requiredYears).toBe(5);
    expect(job.applyUrl).toBe("https://jobs.lever.co/acme/abc-123/apply");
  });

  it("throws a clear error on a malformed (non-array) response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ not: "an array" })));
    await expect(leverAdapter.discoverJobs(site, [], settings)).rejects.toThrow(/unexpected/);
  });

  it("throws a clear error when verification is detected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Checking your browser before accessing", { status: 503 })),
    );
    await expect(leverAdapter.discoverJobs(site, [], settings)).rejects.toThrow(/Verification required/);
  });

  it("caps results at maxJobsPerSource", async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...postings[0], id: `id-${i}` }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(many)));
    const discovered = await leverAdapter.discoverJobs(site, [], { ...settings, maxJobsPerSource: 2 });
    expect(discovered).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/lever.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/adapters/lever.ts`**

```ts
import type { CollectSettings, SiteConfig } from "../types.js";
import type { DiscoveredJob, RawJobDetail, RoleSearch, SourceAdapter } from "./types.js";
import { matchProfiles } from "./match-profiles.js";
import { detectVerification } from "../browser/verification.js";
import { stripHtml } from "../extraction/jd-cleaner.js";
import { extractRequiredYears } from "../extraction/metadata.js";
import { computeJobId } from "../dedup/canonicalize-url.js";

interface LeverPosting {
  id: string;
  text: string;
  categories?: { commitment?: string; location?: string; team?: string; department?: string };
  hostedUrl: string;
  applyUrl: string;
  description?: string;
  descriptionPlain?: string;
  createdAt?: number;
}

function extractSiteSlug(site: SiteConfig): string {
  if (site.lever?.site) return site.lever.site;
  const match = site.url.match(/jobs\.lever\.co\/([^/?#]+)/i);
  if (match?.[1]) return match[1];
  throw new Error(`Cannot determine Lever site slug for "${site.id}" - set site.lever.site`);
}

async function fetchPostings(siteSlug: string): Promise<LeverPosting[]> {
  const res = await fetch(`https://api.lever.co/v0/postings/${siteSlug}?mode=json`);
  const text = await res.text();

  const verification = detectVerification({ html: text, url: res.url || siteSlug });
  if (verification.detected) {
    throw new Error(`Verification required fetching Lever site "${siteSlug}": ${verification.reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Lever site "${siteSlug}" returned a non-JSON response`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Lever site "${siteSlug}" returned an unexpected response shape`);
  }

  return parsed as LeverPosting[];
}

export const leverAdapter: SourceAdapter = {
  sourceType: "lever",

  canHandle(site: SiteConfig): boolean {
    return site.adapter === "lever";
  },

  async discoverJobs(
    site: SiteConfig,
    searches: RoleSearch[],
    settings: CollectSettings,
  ): Promise<DiscoveredJob[]> {
    const slug = extractSiteSlug(site);
    const postings = await fetchPostings(slug);
    return postings.slice(0, settings.maxJobsPerSource).map((posting) => ({
      externalId: posting.id,
      title: posting.text,
      url: posting.hostedUrl,
      matchedProfiles: matchProfiles(posting.text, searches),
      rawMetadata: posting as unknown as Record<string, unknown>,
    }));
  },

  async fetchJobDetails(job: DiscoveredJob): Promise<RawJobDetail> {
    const raw = job.rawMetadata as unknown as LeverPosting;
    return {
      externalId: job.externalId,
      title: raw.text,
      descriptionText: stripHtml(raw.descriptionPlain ?? raw.description ?? ""),
      descriptionHtml: raw.description ?? null,
      location: raw.categories?.location ?? null,
      department: raw.categories?.team ?? raw.categories?.department ?? null,
      employmentType: raw.categories?.commitment ?? null,
      requisitionId: job.externalId,
      postingDate: raw.createdAt ? new Date(raw.createdAt).toISOString() : null,
      salaryText: null,
      canonicalUrl: raw.hostedUrl,
      applyUrl: raw.applyUrl,
      rawMetadata: raw as unknown as Record<string, unknown>,
    };
  },

  normalize(raw: RawJobDetail, site: SiteConfig, matchedProfiles: string[]) {
    const now = new Date().toISOString();
    return {
      id: computeJobId(raw.canonicalUrl),
      source: site.id,
      sourceType: "lever" as const,
      company: site.name,
      title: raw.title,
      location: raw.location,
      remoteType: null,
      employmentType: raw.employmentType,
      department: raw.department,
      requisitionId: raw.requisitionId,
      postingDate: raw.postingDate,
      discoveredAt: now,
      lastSeenAt: now,
      canonicalUrl: raw.canonicalUrl,
      applyUrl: raw.applyUrl,
      descriptionText: raw.descriptionText,
      descriptionHtml: raw.descriptionHtml,
      requiredYears: extractRequiredYears(raw.descriptionText),
      salaryText: raw.salaryText,
      matchedProfiles,
      rawMetadata: raw.rawMetadata,
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/lever.test.ts`
Expected: PASS (6 tests)

---

## Task 8: Workday adapter

**Files:**
- Create: `src/adapters/workday.ts`
- Test: `tests/adapters/workday.test.ts`

**Interfaces:**
- Same shared imports as Task 6/7, plus reads `site.workday` (`WorkdayConfig`).
- Produces: `workdayAdapter: SourceAdapter`.

- [ ] **Step 1: Write failing test — `tests/adapters/workday.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { workdayAdapter } from "../../src/adapters/workday.js";
import type { SiteConfig, CollectSettings } from "../../src/types.js";

const site: SiteConfig = {
  id: "acme-workday",
  name: "Acme",
  url: "https://acme.wd1.myworkdayjobs.com/External",
  adapter: "workday",
  enabled: true,
  workday: { hostname: "acme.wd1.myworkdayjobs.com", tenant: "acme", site: "External" },
};

const settings: CollectSettings = {
  maxPagesPerSource: 100,
  maxJobsPerSource: 5000,
  navigationTimeoutMs: 30000,
  delayBetweenRequestsMs: 0,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workdayAdapter", () => {
  it("throws when the site has no workday config block", async () => {
    const badSite: SiteConfig = { ...site, workday: undefined };
    await expect(workdayAdapter.discoverJobs(badSite, [], settings)).rejects.toThrow(
      /no workday config/,
    );
  });

  it("paginates by offset until jobPostings is empty", async () => {
    const page1 = {
      total: 3,
      jobPostings: [
        { title: "SOC Analyst", externalPath: "req-1" },
        { title: "SOC Analyst II", externalPath: "req-2" },
      ],
    };
    const page2 = { total: 3, jobPostings: [{ title: "SOC Lead", externalPath: "req-3" }] };
    const page3 = { total: 3, jobPostings: [] };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2))
      .mockResolvedValueOnce(jsonResponse(page3));
    vi.stubGlobal("fetch", fetchMock);

    const discovered = await workdayAdapter.discoverJobs(
      site,
      [{ keyword: "soc", profileIds: ["security"] }],
      settings,
    );

    expect(discovered).toHaveLength(3);
    expect(discovered.every((j) => j.matchedProfiles.includes("security"))).toBe(true);
  });

  it("stops pagination once offset reaches total", async () => {
    const onlyPage = { total: 1, jobPostings: [{ title: "Cloud Engineer", externalPath: "req-1" }] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(onlyPage));
    vi.stubGlobal("fetch", fetchMock);

    await workdayAdapter.discoverJobs(site, [{ keyword: "cloud", profileIds: ["cloud"] }], settings);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("respects maxPagesPerSource as a safety cap", async () => {
    const neverEndingPage = {
      total: 999999,
      jobPostings: [{ title: "X", externalPath: "req-x" }],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(neverEndingPage));
    vi.stubGlobal("fetch", fetchMock);

    await workdayAdapter.discoverJobs(site, [{ keyword: "x", profileIds: ["cloud"] }], {
      ...settings,
      maxPagesPerSource: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws a clear error on an unrecognized response shape", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ unexpected: true })));
    await expect(
      workdayAdapter.discoverJobs(site, [{ keyword: "x", profileIds: [] }], settings),
    ).rejects.toThrow(/unrecognized/);
  });

  it("fetchJobDetails + normalize produce a full JobPosting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          jobPostingInfo: {
            title: "SOC Analyst",
            jobDescription: "<p>3 years of SOC experience needed.</p>",
            location: "Remote - US",
            timeType: "Full time",
            jobReqId: "R-1234",
            startDate: "2026-01-01",
          },
        }),
      ),
    );

    const job = {
      externalId: "req-1",
      title: "SOC Analyst",
      url: "https://acme.wd1.myworkdayjobs.com/External/job/req-1",
      matchedProfiles: ["security"],
    };
    const raw = await workdayAdapter.fetchJobDetails(job, site, settings);
    const posting = workdayAdapter.normalize(raw, site, ["security"]);

    expect(posting.sourceType).toBe("workday");
    expect(posting.requisitionId).toBe("R-1234");
    expect(posting.requiredYears).toBe(3);
    expect(posting.location).toBe("Remote - US");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/workday.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/adapters/workday.ts`**

```ts
import type { CollectSettings, SiteConfig, WorkdayConfig } from "../types.js";
import type { DiscoveredJob, RawJobDetail, RoleSearch, SourceAdapter } from "./types.js";
import { detectVerification } from "../browser/verification.js";
import { stripHtml } from "../extraction/jd-cleaner.js";
import { extractRequiredYears } from "../extraction/metadata.js";
import { computeJobId } from "../dedup/canonicalize-url.js";

interface WorkdayJobPosting {
  title: string;
  externalPath: string;
}

interface WorkdaySearchResponse {
  total: number;
  jobPostings: WorkdayJobPosting[];
}

function requireWorkdayConfig(site: SiteConfig): WorkdayConfig {
  if (!site.workday) {
    throw new Error(
      `Site "${site.id}" uses adapter "workday" but has no workday config block (hostname/tenant/site)`,
    );
  }
  return site.workday;
}

async function fetchJson(url: string, init: RequestInit, label: string): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  const verification = detectVerification({ html: text, url: res.url || url });
  if (verification.detected) {
    throw new Error(`Verification required on ${label}: ${verification.reason}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned a non-JSON response`);
  }
}

async function searchPage(
  config: WorkdayConfig,
  searchText: string,
  offset: number,
  limit: number,
): Promise<WorkdaySearchResponse> {
  const parsed = await fetchJson(
    `https://${config.hostname}/wday/cxs/${config.tenant}/${config.site}/jobs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit, offset, searchText }),
    },
    `Workday tenant "${config.tenant}"`,
  );

  const obj = parsed as Partial<WorkdaySearchResponse>;
  if (!obj || typeof obj.total !== "number" || !Array.isArray(obj.jobPostings)) {
    throw new Error(`Workday tenant "${config.tenant}" returned an unrecognized response shape`);
  }
  return obj as WorkdaySearchResponse;
}

export const workdayAdapter: SourceAdapter = {
  sourceType: "workday",

  canHandle(site: SiteConfig): boolean {
    return site.adapter === "workday";
  },

  async discoverJobs(
    site: SiteConfig,
    searches: RoleSearch[],
    settings: CollectSettings,
  ): Promise<DiscoveredJob[]> {
    const config = requireWorkdayConfig(site);
    const byPath = new Map<string, DiscoveredJob>();
    const effectiveSearches = searches.length ? searches : [{ keyword: "", profileIds: [] }];
    const limit = 50;

    for (const search of effectiveSearches) {
      let offset = 0;
      let pages = 0;

      while (pages < settings.maxPagesPerSource) {
        const page = await searchPage(config, search.keyword, offset, limit);
        pages += 1;
        if (page.jobPostings.length === 0) break;

        for (const posting of page.jobPostings) {
          const existing = byPath.get(posting.externalPath);
          const profiles = new Set(existing?.matchedProfiles ?? []);
          for (const profileId of search.profileIds) profiles.add(profileId);
          byPath.set(posting.externalPath, {
            externalId: posting.externalPath,
            title: posting.title,
            url: `https://${config.hostname}/${config.site}/job/${posting.externalPath}`,
            matchedProfiles: [...profiles],
          });
        }

        offset += limit;
        if (offset >= page.total) break;
        if (byPath.size >= settings.maxJobsPerSource) break;
      }
    }

    return [...byPath.values()].slice(0, settings.maxJobsPerSource);
  },

  async fetchJobDetails(
    job: DiscoveredJob,
    site: SiteConfig,
  ): Promise<RawJobDetail> {
    const config = requireWorkdayConfig(site);
    const parsed = await fetchJson(
      `https://${config.hostname}/wday/cxs/${config.tenant}/${config.site}/job/${job.externalId}`,
      { method: "GET" },
      `Workday job detail "${job.externalId}"`,
    );

    const info = (parsed as { jobPostingInfo?: Record<string, unknown> }).jobPostingInfo ?? {};
    const description = String(info.jobDescription ?? "");

    return {
      externalId: job.externalId,
      title: String(info.title ?? job.title),
      descriptionText: stripHtml(description),
      descriptionHtml: description || null,
      location: (info.location as string) ?? null,
      department: null,
      employmentType: (info.timeType as string) ?? null,
      requisitionId: (info.jobReqId as string) ?? job.externalId,
      postingDate: (info.startDate as string) ?? null,
      salaryText: null,
      canonicalUrl: job.url,
      applyUrl: job.url,
      rawMetadata: info,
    };
  },

  normalize(raw: RawJobDetail, site: SiteConfig, matchedProfiles: string[]) {
    const now = new Date().toISOString();
    return {
      id: computeJobId(raw.canonicalUrl),
      source: site.id,
      sourceType: "workday" as const,
      company: site.name,
      title: raw.title,
      location: raw.location,
      remoteType: null,
      employmentType: raw.employmentType,
      department: raw.department,
      requisitionId: raw.requisitionId,
      postingDate: raw.postingDate,
      discoveredAt: now,
      lastSeenAt: now,
      canonicalUrl: raw.canonicalUrl,
      applyUrl: raw.applyUrl,
      descriptionText: raw.descriptionText,
      descriptionHtml: raw.descriptionHtml,
      requiredYears: extractRequiredYears(raw.descriptionText),
      salaryText: raw.salaryText,
      matchedProfiles,
      rawMetadata: raw.rawMetadata,
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/workday.test.ts`
Expected: PASS (6 tests)

---

## Task 9: Generic Playwright adapter

**Files:**
- Create: `src/adapters/generic-playwright.ts`
- Test: `tests/adapters/generic-playwright.test.ts`

**Interfaces:**
- Consumes: `pauseForVerification`, `PageLike` (`browser/verification.js`); `stripHtml`, `extractRequiredYears`, `computeJobId`.
- Produces: `validateGenericSelectors(site: SiteConfig): void`, `createGenericPlaywrightAdapter(deps: GenericPlaywrightDeps): SourceAdapter`, `GenericPlaywrightDeps` interface (`{ context: BrowserContext; onVerificationPause?: () => void }`).

- [ ] **Step 1: Write failing test — `tests/adapters/generic-playwright.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  createGenericPlaywrightAdapter,
  validateGenericSelectors,
} from "../../src/adapters/generic-playwright.js";
import type { SiteConfig, CollectSettings } from "../../src/types.js";

const baseSite: SiteConfig = {
  id: "acme-generic",
  name: "Acme",
  url: "https://acme.com/careers",
  adapter: "generic",
  enabled: true,
  generic: {
    searchInputSelector: "#search",
    searchButtonSelector: "#go",
    resultCardSelector: ".card",
    jobLinkSelector: ".card a",
    loadMoreSelector: ".load-more",
    titleSelector: "h1",
    locationSelector: ".loc",
    descriptionSelector: ".desc",
    applyLinkSelector: "a.apply",
  },
};

const settings: CollectSettings = {
  maxPagesPerSource: 5,
  maxJobsPerSource: 100,
  navigationTimeoutMs: 1000,
  delayBetweenRequestsMs: 0,
};

describe("validateGenericSelectors", () => {
  it("throws naming the missing key when a required selector is absent", () => {
    const badSite = { ...baseSite, generic: { ...baseSite.generic!, titleSelector: "" as unknown as string } };
    delete (badSite.generic as Record<string, unknown>).titleSelector;
    expect(() => validateGenericSelectors(badSite)).toThrow(/titleSelector/);
  });

  it("throws when the generic block is entirely missing", () => {
    expect(() => validateGenericSelectors({ ...baseSite, generic: undefined })).toThrow(
      /no generic selector block/,
    );
  });

  it("passes for a fully configured selector block", () => {
    expect(() => validateGenericSelectors(baseSite)).not.toThrow();
  });
});

function makeFakePage(script: {
  linkBatches: string[][];
  hasLoadMoreAfterBatch: boolean[];
}) {
  let callIndex = 0;
  const clicked: string[] = [];

  const page = {
    url: () => "https://acme.com/careers",
    content: async () => "<html>no captcha here</html>",
    title: async () => "Careers",
    goto: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockImplementation(async (selector: string) => {
      clicked.push(selector);
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    $$eval: vi.fn().mockImplementation(async () => {
      const batch = script.linkBatches[Math.min(callIndex, script.linkBatches.length - 1)];
      return batch;
    }),
    $eval: vi.fn().mockResolvedValue("value"),
    $: vi.fn().mockImplementation(async (selector: string) => {
      const hasMore = script.hasLoadMoreAfterBatch[callIndex] ?? false;
      callIndex += 1;
      return hasMore ? { click: vi.fn().mockResolvedValue(undefined) } : null;
    }),
  };
  return { page, clicked };
}

describe("createGenericPlaywrightAdapter", () => {
  it("stops pagination when no load-more button remains", async () => {
    const { page } = makeFakePage({
      linkBatches: [
        ["https://acme.com/jobs/1", "https://acme.com/jobs/2"],
        ["https://acme.com/jobs/1", "https://acme.com/jobs/2", "https://acme.com/jobs/3"],
      ],
      hasLoadMoreAfterBatch: [true, false],
    });
    const context = { newPage: vi.fn().mockResolvedValue(page) };

    const adapter = createGenericPlaywrightAdapter({ context: context as never });
    const discovered = await adapter.discoverJobs(
      baseSite,
      [{ keyword: "sdet", profileIds: ["sdet"] }],
      settings,
    );

    expect(discovered.length).toBeGreaterThanOrEqual(2);
    expect(discovered.every((j) => j.matchedProfiles.includes("sdet"))).toBe(true);
  });

  it("extracts title/location/description via configured selectors", async () => {
    const { page } = makeFakePage({ linkBatches: [[]], hasLoadMoreAfterBatch: [false] });
    page.$eval = vi
      .fn()
      .mockResolvedValueOnce("SDET II")
      .mockResolvedValueOnce("Remote")
      .mockResolvedValueOnce("<p>Great job</p>")
      .mockResolvedValueOnce("https://acme.com/jobs/1/apply");
    const context = { newPage: vi.fn().mockResolvedValue(page) };

    const adapter = createGenericPlaywrightAdapter({ context: context as never });
    const raw = await adapter.fetchJobDetails(
      { externalId: "https://acme.com/jobs/1", title: "", url: "https://acme.com/jobs/1", matchedProfiles: [] },
      baseSite,
      settings,
    );

    expect(raw.title).toBe("SDET II");
    expect(raw.location).toBe("Remote");
    expect(raw.descriptionText).toBe("Great job");
    expect(raw.applyUrl).toBe("https://acme.com/jobs/1/apply");
  });

  it("normalize produces a full JobPosting", () => {
    const context = { newPage: vi.fn() };
    const adapter = createGenericPlaywrightAdapter({ context: context as never });
    const posting = adapter.normalize(
      {
        externalId: "https://acme.com/jobs/1",
        title: "SDET II",
        descriptionText: "5 years required",
        descriptionHtml: "<p>5 years required</p>",
        location: "Remote",
        department: null,
        employmentType: null,
        requisitionId: null,
        postingDate: null,
        salaryText: null,
        canonicalUrl: "https://acme.com/jobs/1",
        applyUrl: "https://acme.com/jobs/1",
        rawMetadata: {},
      },
      baseSite,
      ["sdet"],
    );
    expect(posting.sourceType).toBe("generic");
    expect(posting.requiredYears).toBe(5);
    expect(posting.matchedProfiles).toEqual(["sdet"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/generic-playwright.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/adapters/generic-playwright.ts`**

```ts
import type { BrowserContext, Page } from "playwright";
import type { CollectSettings, SiteConfig } from "../types.js";
import type { DiscoveredJob, RawJobDetail, RoleSearch, SourceAdapter } from "./types.js";
import { pauseForVerification } from "../browser/verification.js";
import { stripHtml } from "../extraction/jd-cleaner.js";
import { extractRequiredYears } from "../extraction/metadata.js";
import { computeJobId } from "../dedup/canonicalize-url.js";

export interface GenericPlaywrightDeps {
  context: BrowserContext;
  onVerificationPause?: () => void;
}

const REQUIRED_SELECTORS = [
  "searchInputSelector",
  "searchButtonSelector",
  "resultCardSelector",
  "jobLinkSelector",
  "titleSelector",
  "locationSelector",
  "descriptionSelector",
] as const;

export function validateGenericSelectors(site: SiteConfig): void {
  if (!site.generic) {
    throw new Error(`Site "${site.id}" uses adapter "generic" but has no generic selector block configured`);
  }
  for (const key of REQUIRED_SELECTORS) {
    if (!site.generic[key]) {
      throw new Error(`Site "${site.id}" generic config missing required selector "${key}"`);
    }
  }
}

export function createGenericPlaywrightAdapter(deps: GenericPlaywrightDeps): SourceAdapter {
  const { context, onVerificationPause } = deps;

  async function checkVerification(page: Page): Promise<void> {
    const result = await pauseForVerification(page as never);
    if (result.detected) onVerificationPause?.();
  }

  async function collectLinksForKeyword(
    page: Page,
    site: SiteConfig,
    keyword: string,
    settings: CollectSettings,
  ): Promise<Map<string, void>> {
    const selectors = site.generic!;
    const found = new Map<string, void>();

    if (keyword) {
      await page.fill(selectors.searchInputSelector, keyword);
      await page.click(selectors.searchButtonSelector);
      await page.waitForLoadState("networkidle").catch(() => undefined);
    }

    let pageCount = 0;
    while (pageCount < settings.maxPagesPerSource) {
      await checkVerification(page);

      const links = await page.$$eval(selectors.jobLinkSelector, (elements) =>
        elements.map((el) => (el as HTMLAnchorElement).href).filter(Boolean),
      );
      const beforeSize = found.size;
      for (const link of links) {
        found.set(link, undefined);
        if (found.size >= settings.maxJobsPerSource) return found;
      }

      pageCount += 1;

      const advanceSelector = selectors.loadMoreSelector ?? selectors.nextButtonSelector;
      if (!advanceSelector) break;
      const advanceHandle = await page.$(advanceSelector);
      if (!advanceHandle) break;
      await advanceHandle.click();
      await page.waitForLoadState("networkidle").catch(() => undefined);

      if (found.size === beforeSize && pageCount > 1) break;
    }

    return found;
  }

  return {
    sourceType: "generic",

    canHandle(site: SiteConfig): boolean {
      return site.adapter === "generic";
    },

    async discoverJobs(
      site: SiteConfig,
      searches: RoleSearch[],
      settings: CollectSettings,
    ): Promise<DiscoveredJob[]> {
      validateGenericSelectors(site);
      const page = await context.newPage();
      try {
        await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs });
        await checkVerification(page);

        const profilesByUrl = new Map<string, string[]>();
        const effective = searches.length ? searches : [{ keyword: "", profileIds: [] }];

        for (const search of effective) {
          const found = await collectLinksForKeyword(page, site, search.keyword, settings);
          for (const url of found.keys()) {
            const profiles = profilesByUrl.get(url) ?? [];
            for (const profileId of search.profileIds) {
              if (!profiles.includes(profileId)) profiles.push(profileId);
            }
            profilesByUrl.set(url, profiles);
          }
        }

        return [...profilesByUrl.entries()]
          .slice(0, settings.maxJobsPerSource)
          .map(([url, matchedProfiles]) => ({ externalId: url, title: "", url, matchedProfiles }));
      } finally {
        await page.close();
      }
    },

    async fetchJobDetails(
      job: DiscoveredJob,
      site: SiteConfig,
      settings: CollectSettings,
    ): Promise<RawJobDetail> {
      const selectors = site.generic!;
      const page = await context.newPage();
      try {
        await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: settings.navigationTimeoutMs });
        await checkVerification(page);

        const title = await page.$eval(selectors.titleSelector, (el) => el.textContent?.trim() ?? "").catch(() => "");
        const location = await page.$eval(selectors.locationSelector, (el) => el.textContent?.trim() ?? "").catch(() => "");
        const descriptionHtml = await page.$eval(selectors.descriptionSelector, (el) => el.innerHTML).catch(() => "");
        const applyUrl = selectors.applyLinkSelector
          ? await page.$eval(selectors.applyLinkSelector, (el) => (el as HTMLAnchorElement).href).catch(() => job.url)
          : job.url;

        return {
          externalId: job.externalId,
          title: title || job.title,
          descriptionText: stripHtml(descriptionHtml),
          descriptionHtml: descriptionHtml || null,
          location: location || null,
          department: null,
          employmentType: null,
          requisitionId: null,
          postingDate: null,
          salaryText: null,
          canonicalUrl: job.url,
          applyUrl,
          rawMetadata: {},
        };
      } finally {
        await page.close();
      }
    },

    normalize(raw: RawJobDetail, site: SiteConfig, matchedProfiles: string[]) {
      const now = new Date().toISOString();
      return {
        id: computeJobId(raw.canonicalUrl),
        source: site.id,
        sourceType: "generic" as const,
        company: site.name,
        title: raw.title,
        location: raw.location,
        remoteType: null,
        employmentType: raw.employmentType,
        department: raw.department,
        requisitionId: raw.requisitionId,
        postingDate: raw.postingDate,
        discoveredAt: now,
        lastSeenAt: now,
        canonicalUrl: raw.canonicalUrl,
        applyUrl: raw.applyUrl,
        descriptionText: raw.descriptionText,
        descriptionHtml: raw.descriptionHtml,
        requiredYears: extractRequiredYears(raw.descriptionText),
        salaryText: raw.salaryText,
        matchedProfiles,
        rawMetadata: raw.rawMetadata,
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/generic-playwright.test.ts`
Expected: PASS (6 tests)

---

## Task 10: Adapter registry

**Files:**
- Create: `src/adapters/registry.ts`
- Test: `tests/adapters/registry.test.ts`

**Interfaces:**
- Consumes: `greenhouseAdapter`, `leverAdapter`, `workdayAdapter`, `createGenericPlaywrightAdapter`, `GenericPlaywrightDeps`.
- Produces: `resolveAdapter(site: SiteConfig, genericDeps?: GenericPlaywrightDeps): SourceAdapter`.

- [ ] **Step 1: Write failing test — `tests/adapters/registry.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { resolveAdapter } from "../../src/adapters/registry.js";
import type { SiteConfig } from "../../src/types.js";

function site(overrides: Partial<SiteConfig>): SiteConfig {
  return {
    id: "s",
    name: "S",
    url: "https://example.com",
    adapter: "greenhouse",
    enabled: true,
    ...overrides,
  };
}

describe("resolveAdapter", () => {
  it("resolves greenhouse", () => {
    expect(resolveAdapter(site({ adapter: "greenhouse" })).sourceType).toBe("greenhouse");
  });

  it("resolves lever", () => {
    expect(resolveAdapter(site({ adapter: "lever" })).sourceType).toBe("lever");
  });

  it("resolves workday", () => {
    expect(resolveAdapter(site({ adapter: "workday" })).sourceType).toBe("workday");
  });

  it("resolves generic when deps are provided", () => {
    const deps = { context: { newPage: vi.fn() } as never };
    expect(resolveAdapter(site({ adapter: "generic" }), deps).sourceType).toBe("generic");
  });

  it("throws for generic without deps", () => {
    expect(() => resolveAdapter(site({ adapter: "generic" }))).toThrow(/requires a browser context/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/registry.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/adapters/registry.ts`**

```ts
import type { SiteConfig } from "../types.js";
import type { SourceAdapter } from "./types.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { workdayAdapter } from "./workday.js";
import { createGenericPlaywrightAdapter, type GenericPlaywrightDeps } from "./generic-playwright.js";

const STATIC_ADAPTERS: SourceAdapter[] = [greenhouseAdapter, leverAdapter, workdayAdapter];

export function resolveAdapter(site: SiteConfig, genericDeps?: GenericPlaywrightDeps): SourceAdapter {
  for (const adapter of STATIC_ADAPTERS) {
    if (adapter.canHandle(site)) return adapter;
  }
  if (site.adapter === "generic") {
    if (!genericDeps) {
      throw new Error(`Site "${site.id}" requires a browser context for the generic adapter`);
    }
    return createGenericPlaywrightAdapter(genericDeps);
  }
  throw new Error(`No adapter can handle site "${site.id}" (adapter: ${site.adapter})`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/adapters/registry.test.ts`
Expected: PASS (5 tests)

---

## Task 11: Source runner (orchestration)

**Files:**
- Create: `src/runner/source-runner.ts`
- Test: `tests/runner/source-runner.test.ts`

**Interfaces:**
- Consumes: `loadSitesConfig`, `loadRolesConfig`, `loadCollectSettings` (`config/loader.js`); `launchPersistentChrome` (`browser/launcher.js`); `resolveAdapter` (`adapters/registry.js`); `loadJobs`, `saveJobs` (`storage/jsonl-store.js`); `mergeJobs` (`dedup/deduplicator.js`).
- Produces: `runCollect(paths: CollectPaths, filters?: CollectFilters): Promise<CollectSummary>`, `CollectPaths`, `CollectFilters`, `CollectSummary` types.

- [ ] **Step 1: Write failing test — `tests/runner/source-runner.test.ts`**

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCollect } from "../../src/runner/source-runner.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function writeConfigs(dir: string): { sitesPath: string; rolesPath: string; jobsPath: string } {
  const sitesPath = path.join(dir, "sites.yml");
  const rolesPath = path.join(dir, "roles.yml");
  const jobsPath = path.join(dir, "jobs.jsonl");

  writeFileSync(
    sitesPath,
    `
settings:
  maxPagesPerSource: 5
  maxJobsPerSource: 100
  navigationTimeoutMs: 1000
  delayBetweenRequestsMs: 0
sites:
  - id: acme-greenhouse
    name: Acme
    url: "https://boards.greenhouse.io/acme"
    adapter: greenhouse
    enabled: true
  - id: acme-workday
    name: Acme Workday
    url: "https://acme.wd1.myworkdayjobs.com/External"
    adapter: workday
    enabled: true
`,
    "utf-8",
  );

  writeFileSync(
    rolesPath,
    `
roles:
  - id: sdet
    profile: sdet
    keywords:
      - SDET
`,
    "utf-8",
  );

  return { sitesPath, rolesPath, jobsPath };
}

describe("runCollect", () => {
  it("collects from a working site and isolates a failing site's error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-runner-"));
    const { sitesPath, rolesPath, jobsPath } = writeConfigs(dir);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("boards-api.greenhouse.io")) {
          return Promise.resolve(
            jsonResponse({
              jobs: [
                {
                  id: 1,
                  title: "SDET II",
                  absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
                  content: "<p>5 years required.</p>",
                },
              ],
            }),
          );
        }
        // Workday site has no `workday:` config block in sites.yml above,
        // so the adapter should throw before ever reaching fetch. This
        // branch should not be hit; if it is, fail loudly.
        return Promise.reject(new Error("unexpected fetch call for workday"));
      }),
    );

    const summary = await runCollect({
      sitesConfigPath: sitesPath,
      rolesConfigPath: rolesPath,
      jobsStorePath: jobsPath,
    });

    expect(summary.sitesAttempted).toBe(2);
    expect(summary.sitesSucceeded).toBe(1);
    expect(summary.sitesFailed).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].site).toBe("acme-workday");
    expect(summary.errors[0].message).toMatch(/no workday config/);
    expect(summary.jobsWritten).toBe(1);
    expect(summary.totalsByProfile.sdet).toBe(1);
  });

  it("does not duplicate jobs across repeated runs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-runner-"));
    const { sitesPath, rolesPath, jobsPath } = writeConfigs(dir);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("boards-api.greenhouse.io")) {
          return Promise.resolve(
            jsonResponse({
              jobs: [
                {
                  id: 1,
                  title: "SDET II",
                  absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
                  content: "<p>5 years required.</p>",
                },
              ],
            }),
          );
        }
        return Promise.reject(new Error("workday not configured"));
      }),
    );

    await runCollect({ sitesConfigPath: sitesPath, rolesConfigPath: rolesPath, jobsStorePath: jobsPath });
    const second = await runCollect({
      sitesConfigPath: sitesPath,
      rolesConfigPath: rolesPath,
      jobsStorePath: jobsPath,
    });

    expect(second.jobsWritten).toBe(1);
  });

  it("filters sites by --site equivalent siteIds filter", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-runner-"));
    const { sitesPath, rolesPath, jobsPath } = writeConfigs(dir);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ jobs: [] })));

    const summary = await runCollect(
      { sitesConfigPath: sitesPath, rolesConfigPath: rolesPath, jobsStorePath: jobsPath },
      { siteIds: ["acme-greenhouse"] },
    );

    expect(summary.sitesAttempted).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/runner/source-runner.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/runner/source-runner.ts`**

```ts
import type { BrowserContext } from "playwright";
import { loadCollectSettings, loadRolesConfig, loadSitesConfig } from "../config/loader.js";
import { launchPersistentChrome } from "../browser/launcher.js";
import { resolveAdapter } from "../adapters/registry.js";
import { loadJobs, saveJobs } from "../storage/jsonl-store.js";
import { mergeJobs } from "../dedup/deduplicator.js";
import type { GenericPlaywrightDeps } from "../adapters/generic-playwright.js";
import type { JobPosting, RoleSearch } from "../adapters/types.js";

export interface CollectPaths {
  sitesConfigPath: string;
  rolesConfigPath: string;
  jobsStorePath: string;
}

export interface CollectFilters {
  siteIds?: string[];
  profileIds?: string[];
  limit?: number;
}

export interface CollectSummary {
  sitesAttempted: number;
  sitesSucceeded: number;
  sitesFailed: number;
  listingsDiscovered: number;
  jdsExtracted: number;
  duplicatesRemoved: number;
  verificationPauses: number;
  jobsWritten: number;
  totalsByProfile: Record<string, number>;
  errors: { site: string; message: string }[];
}

function buildRoleSearches(
  roles: ReturnType<typeof loadRolesConfig>,
  profileFilter?: string[],
): RoleSearch[] {
  const byKeyword = new Map<string, Set<string>>();
  for (const role of roles) {
    if (profileFilter && !profileFilter.includes(role.profile)) continue;
    for (const keyword of role.keywords) {
      const key = keyword.toLowerCase();
      const set = byKeyword.get(key) ?? new Set<string>();
      set.add(role.profile);
      byKeyword.set(key, set);
    }
  }
  return [...byKeyword.entries()].map(([keyword, profiles]) => ({
    keyword,
    profileIds: [...profiles],
  }));
}

export async function runCollect(
  paths: CollectPaths,
  filters: CollectFilters = {},
): Promise<CollectSummary> {
  const sites = loadSitesConfig(paths.sitesConfigPath);
  const roles = loadRolesConfig(paths.rolesConfigPath);
  const settings = loadCollectSettings(paths.sitesConfigPath);
  const searches = buildRoleSearches(roles, filters.profileIds);

  const summary: CollectSummary = {
    sitesAttempted: 0,
    sitesSucceeded: 0,
    sitesFailed: 0,
    listingsDiscovered: 0,
    jdsExtracted: 0,
    duplicatesRemoved: 0,
    verificationPauses: 0,
    jobsWritten: 0,
    totalsByProfile: {},
    errors: [],
  };

  const targetSites = sites.filter(
    (site) => site.enabled && (!filters.siteIds || filters.siteIds.includes(site.id)),
  );

  let context: BrowserContext | undefined;
  async function ensureContext(): Promise<BrowserContext> {
    if (!context) context = await launchPersistentChrome();
    return context;
  }

  const collected: JobPosting[] = [];

  for (const site of targetSites) {
    summary.sitesAttempted += 1;
    try {
      let genericDeps: GenericPlaywrightDeps | undefined;
      if (site.adapter === "generic") {
        genericDeps = {
          context: await ensureContext(),
          onVerificationPause: () => {
            summary.verificationPauses += 1;
          },
        };
      }

      const adapter = resolveAdapter(site, genericDeps);
      const discovered = await adapter.discoverJobs(site, searches, settings);
      summary.listingsDiscovered += discovered.length;

      for (const job of discovered) {
        const rawDetail = await adapter.fetchJobDetails(job, site, settings);
        summary.jdsExtracted += 1;
        const normalized = adapter.normalize(rawDetail, site, job.matchedProfiles);
        collected.push(normalized);
        for (const profileId of normalized.matchedProfiles) {
          summary.totalsByProfile[profileId] = (summary.totalsByProfile[profileId] ?? 0) + 1;
        }
        if (settings.delayBetweenRequestsMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, settings.delayBetweenRequestsMs));
        }
      }

      summary.sitesSucceeded += 1;
    } catch (err) {
      summary.sitesFailed += 1;
      summary.errors.push({ site: site.id, message: (err as Error).message });
    }
  }

  const existing = loadJobs(paths.jobsStorePath);
  const merged = mergeJobs(existing, collected, new Date().toISOString());
  summary.duplicatesRemoved = existing.length + collected.length - merged.length;

  const limited = typeof filters.limit === "number" ? merged.slice(0, filters.limit) : merged;
  saveJobs(paths.jobsStorePath, limited);
  summary.jobsWritten = limited.length;

  return summary;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd F:/Jobs/Job_Search/job-hunter && npx vitest run tests/runner/source-runner.test.ts`
Expected: PASS (3 tests)

---

## Task 12: CLI + final verification

**Files:**
- Create: `src/runner/cli.ts`
- Modify: `package.json` (add `collect` script)

**Interfaces:**
- Consumes: `runCollect` (`runner/source-runner.js`).
- Produces: `npm run collect` executable entry point.

- [ ] **Step 1: Implement `src/runner/cli.ts`**

```ts
import path from "node:path";
import { runCollect, type CollectFilters, type CollectSummary } from "./source-runner.js";

function parseArgs(argv: string[]): CollectFilters {
  const result: CollectFilters = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--site") {
      const value = argv[++i] ?? "";
      result.siteIds = (result.siteIds ?? []).concat(value.split(",").filter(Boolean));
    } else if (arg === "--profile") {
      const value = argv[++i] ?? "";
      result.profileIds = (result.profileIds ?? []).concat(value.split(",").filter(Boolean));
    } else if (arg === "--limit") {
      const value = argv[++i];
      result.limit = Number(value);
    }
  }
  return result;
}

function printSummary(summary: CollectSummary): void {
  console.log("\n=== Collection summary ===");
  console.log(`Sites attempted: ${summary.sitesAttempted}`);
  console.log(`Sites succeeded: ${summary.sitesSucceeded}`);
  console.log(`Sites failed: ${summary.sitesFailed}`);
  console.log(`Listings discovered: ${summary.listingsDiscovered}`);
  console.log(`Full JDs extracted: ${summary.jdsExtracted}`);
  console.log(`Duplicates removed: ${summary.duplicatesRemoved}`);
  console.log(`Verification pauses: ${summary.verificationPauses}`);
  console.log(`Jobs written: ${summary.jobsWritten}`);
  console.log("Totals by matched profile:");
  for (const [profile, count] of Object.entries(summary.totalsByProfile)) {
    console.log(`  ${profile}: ${count}`);
  }
  if (summary.errors.length) {
    console.log("Errors:");
    for (const err of summary.errors) {
      console.log(`  ${err.site}: ${err.message}`);
    }
  }
  console.log("===========================\n");
}

async function main(): Promise<void> {
  const filters = parseArgs(process.argv.slice(2));
  const summary = await runCollect(
    {
      sitesConfigPath: path.resolve("config/sites.yml"),
      rolesConfigPath: path.resolve("config/roles.yml"),
      jobsStorePath: path.resolve("data/jobs.jsonl"),
    },
    filters,
  );
  printSummary(summary);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add the `collect` script to `package.json`**

In the `"scripts"` block, add (alongside existing `dev`/`build`/`typecheck`/`test`):

```json
"collect": "tsx src/runner/cli.ts"
```

- [ ] **Step 3: Run full verification**

Run: `cd F:/Jobs/Job_Search/job-hunter && npm run typecheck`
Expected: no TS errors.

Run: `cd F:/Jobs/Job_Search/job-hunter && npm test`
Expected: all tests pass — Phase 1's original 14 plus every test added in Tasks 1–11.

- [ ] **Step 4: Sanity-check the CLI wires together (no live network/browser required)**

Run: `cd F:/Jobs/Job_Search/job-hunter && npm run collect -- --site does-not-exist`
Expected: exits cleanly, prints a summary with `Sites attempted: 0` (no site in `config/sites.yml` is both `enabled: true` and matches the filter, since all shipped examples are `enabled: false`) — confirms the CLI, config loading, and summary printer all wire together without needing a real site enabled.

---

## Self-Review Notes

- **Spec coverage:** every GOAL/ARCHITECTURE/ADAPTER-CONTRACT/ROLE-SEARCHING/PAGINATION/dedup/storage/CLI/output-summary/test item from the user's Phase 2 request maps to a task above. The one deliberate interpretation: API-based adapters (Greenhouse/Lever/Workday) treat a detected verification challenge as a per-site hard failure (caught by the runner, logged in `summary.errors`) rather than an interactive pause, since there is no live page for the user to complete a challenge on through a raw HTTP call — the interactive pause-and-resume flow applies to the generic Playwright adapter, which does have a live page. This is called out as a known limitation in the final report to the user.
- **Placeholder scan:** no TBDs; every step has runnable code.
- **Type consistency:** `JobPosting`, `DiscoveredJob`, `RawJobDetail`, `RoleSearch`, `SourceAdapter`, `CollectSettings`, `WorkdayConfig`, `GenericSelectors` are defined once (Tasks 1 & 3) and reused verbatim (same field names/types) by every later task.
- **Scope:** single cohesive subsystem (the collect pipeline); no decomposition needed.
