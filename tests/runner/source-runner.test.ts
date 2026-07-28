import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCollect } from "../../src/runner/source-runner.js";
import { loadJobs } from "../../src/storage/jsonl-store.js";

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
    expect(summary.errors[0]!.site).toBe("acme-workday");
    expect(summary.errors[0]!.message).toMatch(/no workday config/);
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

  it("does not truncate the persisted store when a run-level limit caps new intake", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-runner-"));
    const { sitesPath, rolesPath, jobsPath } = writeConfigs(dir);

    // Same 3 jobs are returned by the board every time this test calls fetch --
    // the second run's "newly collected" jobs are therefore duplicates of what's
    // already in the store, which is exactly the scenario that exposed the bug:
    // slicing the *merged* (existing + incoming) array truncated pre-existing data.
    const boardResponse = jsonResponse({
      jobs: [
        {
          id: 1,
          title: "SDET II",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/1",
          content: "<p>5 years required. Role focuses on API test automation.</p>",
        },
        {
          id: 2,
          title: "SDET III",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/2",
          content: "<p>6 years required. Role focuses on mobile test automation.</p>",
        },
        {
          id: 3,
          title: "Staff SDET",
          absolute_url: "https://boards.greenhouse.io/acme/jobs/3",
          content: "<p>8 years required. Role focuses on performance test automation.</p>",
        },
      ],
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("boards-api.greenhouse.io")) {
          return Promise.resolve(boardResponse.clone());
        }
        return Promise.reject(new Error("workday not configured"));
      }),
    );

    const first = await runCollect({
      sitesConfigPath: sitesPath,
      rolesConfigPath: rolesPath,
      jobsStorePath: jobsPath,
    });
    expect(first.jobsWritten).toBe(3);

    const second = await runCollect(
      { sitesConfigPath: sitesPath, rolesConfigPath: rolesPath, jobsStorePath: jobsPath },
      { limit: 1 },
    );

    // `limit` must only cap how many newly-collected jobs get merged in --
    // it must never cause previously-persisted jobs to be dropped from the store.
    expect(second.jobsWritten).toBe(3);

    const onDisk = loadJobs(jobsPath);
    expect(onDisk).toHaveLength(3);
  });

  it("launches the browser context lazily for a generic-adapter site and closes it exactly once after the run", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-runner-"));
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
  - id: acme-generic
    name: Acme Generic
    url: "https://acme.com/careers"
    adapter: generic
    enabled: true
    generic:
      searchInputSelector: "#search"
      searchButtonSelector: "#go"
      resultCardSelector: ".card"
      jobLinkSelector: ".card a"
      titleSelector: "h1"
      locationSelector: ".loc"
      descriptionSelector: ".desc"
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

    // Minimal fake Page/BrowserContext (never a real Playwright browser) --
    // discoverJobs only calls $$eval/$/content/title/url; fetchJobDetails only
    // calls $eval sequentially for title, location, descriptionHtml (no
    // applyLinkSelector configured above, so applyUrl falls back to job.url).
    const page = {
      url: () => "https://acme.com/careers",
      content: async () => "<html>no captcha here</html>",
      title: async () => "Careers",
      goto: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      click: vi.fn().mockResolvedValue(undefined),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      $$eval: vi.fn().mockResolvedValue(["https://acme.com/jobs/1"]),
      $eval: vi
        .fn()
        .mockResolvedValueOnce("SDET II")
        .mockResolvedValueOnce("Remote")
        .mockResolvedValueOnce("<p>5 years required</p>"),
      $: vi.fn().mockResolvedValue(null),
    };

    const contextClose = vi.fn().mockResolvedValue(undefined);
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      close: contextClose,
    };
    const launchFn = vi.fn().mockResolvedValue(context);
    // Real closePersistentChrome spawns a real subprocess to confirm OS process exit, and
    // expects a real BrowserContext shape (context.pages()) this fake object doesn't have --
    // never acceptable in a test. Shutdown mechanics are covered in isolation by
    // tests/browser/launcher.test.ts; this test only needs to prove runCollect calls its
    // close function exactly once with the launched context.
    const closeFn = vi.fn().mockResolvedValue(undefined);

    const summary = await runCollect(
      { sitesConfigPath: sitesPath, rolesConfigPath: rolesPath, jobsStorePath: jobsPath },
      {},
      launchFn as never,
      closeFn as never,
    );

    expect(launchFn).toHaveBeenCalledTimes(1);
    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(closeFn).toHaveBeenCalledWith(context);
    expect(summary.sitesSucceeded).toBe(1);
    expect(summary.jobsWritten).toBe(1);
  });
});
