import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import type { JobPosting } from "../adapters/types.js";
import { closePersistentChrome, launchPersistentChrome, registerShutdownOnSignal } from "../browser/launcher.js";
import { pauseForVerification, type VerificationResult } from "../browser/verification.js";
import { loadRolesConfig } from "../config/loader.js";
import type { ResolvedSearchTarget } from "../config/search-input.js";
import { computeJobId } from "../dedup/canonicalize-url.js";
import { mergeJobs } from "../dedup/deduplicator.js";
import {
  buildJobFailure,
  evaluatePersistable,
  extractTrailingNumericId,
  stampResolution,
  type JobFailure,
  type JobFailureCode,
} from "../domain/canonical-job.js";
import { extractRequiredYears } from "../extraction/metadata.js";
import { loadJobs, updateJobs } from "../storage/job-store.js";
import { appendJobFailures } from "../storage/jsonl-store.js";
import { evaluateRelevance } from "./relevance.js";

// Visible-browser search discovery (one company). In an owned, headed Chrome it:
//   opens the official careers/search page -> focuses the real search field -> types the query
//   key by key -> executes the search with the page's own control (Enter / its submit button)
//   -> waits for the RESULTS TO CHANGE (or the page's own empty state) -> clicks a real result
//   -> extracts title / location / URL / the rendered job description FROM THE DOM
//   -> validates through the canonical gate -> saves through the protected store (updateJobs).
// No API call and no background HTTP request produces any of the saved content.

const POLL_MS = 120;
const STABLE_MS = 400;
const STALE_EMPTY_GRACE_MS = 1200;

export interface SearchRunOptions {
  dataDir: string;
  /** Delay between typed keys, so a person watching can see the input. 0 in automated tests. */
  typingDelayMs: number;
  /** Pause after each visible stage purely so a human can look at it. Never used for synchronization. */
  holdMs: number;
  settleTimeoutMs: number;
  navigationTimeoutMs: number;
  evidenceDir?: string;
  rolesConfigPath?: string;
  /** Overrides the input file's maxJobs. */
  maxJobs?: number;
  profileDir?: string;
}

export interface SearchRunDeps {
  launchFn?: typeof launchPersistentChrome;
  closeFn?: typeof closePersistentChrome;
  registerShutdown?: typeof registerShutdownOnSignal;
  verify?: (page: Page) => Promise<VerificationResult>;
  log?: (line: string) => void;
  now?: () => string;
}

export interface QueryOutcome {
  query: string;
  status: "results" | "empty" | "failed";
  resultCount: number;
  typedValue: string | null;
  urlAfterSearch: string | null;
  failure?: JobFailure;
}

export interface ExtractedJobSummary {
  title: string | null;
  employer: string;
  employerSeenOnPage: boolean;
  location: string | null;
  url: string;
  query: string;
  jdChars: number;
  extractionMethod: "browser-dom";
  status: "persisted" | "rejected";
  jobId?: string;
  atsIdentity?: string;
  failure?: JobFailure;
}

export interface SearchRunSummary {
  company: string;
  careersUrl: string;
  runId: string;
  queries: QueryOutcome[];
  jobs: ExtractedJobSummary[];
  failures: JobFailure[];
  persistedCount: number;
  outcome: "PERSISTED" | "NO_RESULTS" | "FAILED";
  jobsPath: string;
  failuresPath: string;
  browserClosed: boolean;
}

interface ResultItem {
  href: string;
  text: string;
  index: number;
}
interface Snapshot {
  items: ResultItem[];
  empty: boolean;
  url: string;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "query";
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function snapshot(page: Page, resultLink: string, emptyStateText: string): Promise<Snapshot> {
  return page.evaluate(
    ({ sel, emptyRe }) => {
      const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      };
      const all = Array.from(document.querySelectorAll<HTMLAnchorElement>(sel));
      const seen = new Set<string>();
      const items: { href: string; text: string; index: number }[] = [];
      all.forEach((a, index) => {
        if (!visible(a) || seen.has(a.href)) return;
        seen.add(a.href);
        items.push({ href: a.href, text: (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160), index });
      });
      const scope = (document.querySelector("main") as HTMLElement | null) ?? document.body;
      return { items, empty: new RegExp(emptyRe, "i").test(scope.innerText), url: location.href };
    },
    { sel: resultLink, emptyRe: emptyStateText },
  );
}

async function locateSearchBox(page: Page, name: string | undefined, timeoutMs: number): Promise<{ box: Locator } | { error: string }> {
  const nameMatcher: string | RegExp = name ?? /search/i;
  const strategies: { role: "searchbox" | "textbox" | "combobox"; label: string }[] = [
    { role: "searchbox", label: "searchbox" },
    { role: "textbox", label: "textbox" },
    { role: "combobox", label: "combobox" },
  ];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const s of strategies) {
      const candidates = page.getByRole(s.role, { name: nameMatcher });
      const count = await candidates.count();
      const visibleOnes: Locator[] = [];
      for (let i = 0; i < count; i += 1) {
        if (await candidates.nth(i).isVisible()) visibleOnes.push(candidates.nth(i));
      }
      if (visibleOnes.length === 1) return { box: visibleOnes[0]! };
      if (visibleOnes.length > 1) return { error: `ambiguous: ${visibleOnes.length} visible ${s.label} controls match the search label` };
    }
    if (Date.now() >= deadline) return { error: "no visible search field with a search-like accessible name" };
    await sleep(POLL_MS);
  }
}

async function waitForResultsChange(
  page: Page,
  cfg: { resultLink: string; emptyStateText: string },
  before: Snapshot,
  typingFinishedAt: number,
  timeoutMs: number,
): Promise<Snapshot | null> {
  const beforeSig = before.empty ? "EMPTY" : before.items.map((i) => i.href).join("|");
  const deadline = Date.now() + timeoutMs;
  let lastSig: string | null = null;
  let stableSince = 0;
  for (;;) {
    const snap = await snapshot(page, cfg.resultLink, cfg.emptyStateText);
    const sig = snap.empty ? "EMPTY" : snap.items.map((i) => i.href).join("|");
    const hasState = snap.empty || snap.items.length > 0;
    let changed = sig !== beforeSig || snap.url !== before.url;
    // An empty state that was already showing for the previous query proves nothing unless the
    // page also moved (URL changed) or enough time passed for it to have re-rendered.
    if (snap.empty && before.empty && snap.url === before.url && Date.now() - typingFinishedAt < STALE_EMPTY_GRACE_MS) changed = false;
    if (hasState && changed) {
      if (sig === lastSig) {
        if (Date.now() - stableSince >= STABLE_MS) return snap;
      } else {
        lastSig = sig;
        stableSince = Date.now();
      }
    } else {
      lastSig = null;
    }
    if (Date.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

interface DomExtraction {
  rootFound: boolean;
  title: string | null;
  location: string | null;
  text: string;
  html: string;
}

async function extractPostingFromDom(page: Page, descriptionContainer: string): Promise<DomExtraction> {
  return page.evaluate((sel) => {
    const root = document.querySelector<HTMLElement>(sel);
    const h1 = document.querySelector<HTMLElement>("h1");
    // Location = the value shown right after a visible label such as "Office locations" / "Remote
    // location" / "Location", in document order. A label with no value before the next label is skipped.
    const labelRe = /^(office |remote |job )?locations?$/i;
    const values: string[] = [];
    if (root) {
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("h2,h3,h4,h5,dt,th,label,dd,td"));
      nodes.forEach((el, i) => {
        if (el.children.length > 0 || !labelRe.test((el.textContent || "").trim())) return;
        const next = nodes[i + 1];
        if (!next || !["DD", "TD"].includes(next.tagName)) return;
        const value = (next.textContent || "").replace(/\s+/g, " ").trim();
        if (value && !values.includes(value)) values.push(value);
      });
    }
    return {
      rootFound: root !== null,
      title: h1 ? (h1.innerText || "").replace(/\s+/g, " ").trim() : null,
      location: values.length > 0 ? values.join("; ") : null,
      text: root ? root.innerText : "",
      html: root ? root.innerHTML : "",
    };
  }, descriptionContainer);
}

export async function runSearchDiscovery(
  resolved: ResolvedSearchTarget,
  options: SearchRunOptions,
  deps: SearchRunDeps = {},
): Promise<SearchRunSummary> {
  const { target, entry } = resolved;
  const log = deps.log ?? ((line: string) => console.log(line));
  const launchFn = deps.launchFn ?? launchPersistentChrome;
  const closeFn = deps.closeFn ?? closePersistentChrome;
  const registerShutdown = deps.registerShutdown ?? registerShutdownOnSignal;
  const verify = deps.verify ?? ((page: Page) => pauseForVerification(page));
  const nowIso = deps.now ?? (() => new Date().toISOString());
  const maxJobs = options.maxJobs ?? target.maxJobs;
  const jobsPath = path.join(options.dataDir, "jobs.jsonl");
  const failuresPath = path.join(options.dataDir, "job-failures.jsonl");
  const runId = `search-${nowIso().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;

  const summary: SearchRunSummary = {
    company: entry.company,
    careersUrl: target.careersUrl,
    runId,
    queries: [],
    jobs: [],
    failures: [],
    persistedCount: 0,
    outcome: "NO_RESULTS",
    jobsPath,
    failuresPath,
    browserClosed: false,
  };

  // A corrupt authoritative store blocks the run before any browser opens.
  loadJobs(jobsPath);
  const roles = loadRolesConfig(path.resolve(options.rolesConfigPath ?? "config/roles.yml"));

  const recordFailure = (code: JobFailureCode, detail: string, targetUrl: string, title = "(search)", sourceJobId: string | null = null): JobFailure => {
    const failure = buildJobFailure({ code, stage: "search", runId, targetUrl, company: entry.company, title, sourceJobId, detail });
    summary.failures.push(failure);
    appendJobFailures(failuresPath, [failure]);
    log(`  FAILED ${failure.category}/${failure.code}: ${failure.detail}`);
    return failure;
  };

  const hold = async (): Promise<void> => {
    if (options.holdMs > 0) await sleep(options.holdMs);
  };
  const shot = async (page: Page, query: string, stage: string): Promise<void> => {
    if (!options.evidenceDir) return;
    try {
      mkdirSync(options.evidenceDir, { recursive: true });
      await page.screenshot({ path: path.join(options.evidenceDir, `${slug(query)}-${stage}.png`) });
    } catch {
      // evidence is best-effort and must never fail the run
    }
  };

  let context: BrowserContext | undefined;
  let unregister: (() => void) | undefined;
  try {
    context = await launchFn(options.profileDir, { headless: false });
    unregister = registerShutdown(context, options.profileDir);
    const page = await context.newPage();
    // tsx/esbuild wraps named functions with a `__name` helper that does not exist inside the page;
    // this no-op shim lets the DOM helper functions below run under tsx as well as compiled JS.
    await page.addInitScript("window.__name = window.__name || ((fn) => fn);");
    const cfg = target.selectors;

    // 1. Open the official careers/search page.
    log(`Opening ${target.careersUrl} in visible Chrome`);
    try {
      await page.goto(target.careersUrl, { waitUntil: "domcontentloaded", timeout: options.navigationTimeoutMs });
    } catch (err) {
      recordFailure("NAVIGATION_FAILED", `could not open the careers page (${err instanceof Error ? err.name : "error"})`, target.careersUrl);
      summary.outcome = "FAILED";
      return summary;
    }
    const verification = await verify(page);
    if (verification.detected) log(`Verification handled by a person: ${verification.reason}`);

    // 2. Find the real, visible search field.
    const located = await locateSearchBox(page, cfg.searchBoxName, options.navigationTimeoutMs);
    if ("error" in located) {
      recordFailure("SEARCH_CONTROL_NOT_FOUND", located.error, page.url());
      summary.outcome = "FAILED";
      return summary;
    }
    const box = located.box;
    log(`Found search field: "${await box.getAttribute("aria-label") ?? await box.getAttribute("placeholder") ?? "search"}"`);

    for (const query of target.queries) {
      if (summary.persistedCount >= maxJobs) break;
      const outcome: QueryOutcome = { query, status: "failed", resultCount: 0, typedValue: null, urlAfterSearch: null };
      summary.queries.push(outcome);

      // 3. Focus the field and type visibly.
      const before = await snapshot(page, cfg.resultLink, cfg.emptyStateText);
      await box.scrollIntoViewIfNeeded();
      await box.click();
      const focused = await box.evaluate((el) => el === document.activeElement);
      if (!focused) {
        outcome.failure = recordFailure("SEARCH_CONTROL_NOT_FOUND", "the search field did not take focus when clicked", page.url());
        continue;
      }
      await box.fill("");
      log(`Typing "${query}" ...`);
      await box.pressSequentially(query, { delay: options.typingDelayMs });
      const typingFinishedAt = Date.now();
      outcome.typedValue = await box.inputValue();
      await shot(page, query, "01-typed");
      await hold();

      // 4. Execute the search with the page's own control: its form's submit button if there is one, else Enter.
      const submit = box.locator("xpath=ancestor::form[1]").getByRole("button", { name: /search|find|go/i });
      if ((await submit.count()) > 0 && (await submit.first().isVisible())) await submit.first().click();
      else await box.press("Enter");

      // 5. Wait for the page's real response: the result list changes, or its own empty state appears.
      const snap = await waitForResultsChange(page, cfg, before, typingFinishedAt, options.settleTimeoutMs);
      if (!snap) {
        outcome.failure = recordFailure("SEARCH_NO_RESPONSE", `results did not change within ${options.settleTimeoutMs} ms of searching`, page.url());
        continue;
      }
      outcome.urlAfterSearch = snap.url;
      if (snap.empty || snap.items.length === 0) {
        outcome.status = "empty";
        log(`No results for "${query}" (the page shows its own empty state).`);
        await shot(page, query, "02-empty-state");
        await hold();
        continue;
      }
      outcome.status = "results";
      outcome.resultCount = snap.items.length;
      log(`${snap.items.length} result(s) for "${query}": ${snap.items.slice(0, 3).map((i) => i.text.split(" ")[0] === "" ? i.href : i.text).join(" | ")}${snap.items.length > 3 ? " ..." : ""}`);
      await shot(page, query, "02-results");
      await hold();

      // 6. Open real results, one at a time, until maxJobs are saved.
      const listUrl = snap.url;

      // Back on the results list (browser Back first, which keeps a page's own filter state; a reload of
      // the list URL only as a fallback), find the wanted result again BY HREF: positions can shift.
      async function returnToResults(href: string): Promise<ResultItem | null> {
        const find = async (): Promise<ResultItem | null> => {
          const again = await waitForResultsChange(page, cfg, { items: [], empty: false, url: "" }, Date.now(), options.settleTimeoutMs);
          return again?.items.find((i) => i.href === href) ?? null;
        };
        await page.goBack({ waitUntil: "domcontentloaded", timeout: options.navigationTimeoutMs }).catch(() => undefined);
        const viaBack = await find();
        if (viaBack) return viaBack;
        await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: options.navigationTimeoutMs }).catch(() => undefined);
        return find();
      }

      let onPostingPage = false;
      for (const item of snap.items) {
        if (summary.persistedCount >= maxJobs) break;
        let wanted: ResultItem | null = item;
        if (onPostingPage) {
          wanted = await returnToResults(item.href);
          if (!wanted) {
            recordFailure("NAVIGATION_FAILED", "the results list could not be restored after viewing a posting", listUrl, item.text);
            break;
          }
        }
        onPostingPage = true;
        const job = await openAndPersist(wanted);
        if (job) summary.jobs.push(job);
      }

      async function openAndPersist(item: ResultItem): Promise<ExtractedJobSummary | null> {
        const link = page.locator(cfg.resultLink).nth(item.index);
        try {
          await link.scrollIntoViewIfNeeded();
          if ((await link.evaluate((a) => (a as HTMLAnchorElement).href)) !== item.href) {
            recordFailure("NAVIGATION_FAILED", "the result list changed before the result could be opened", listUrl, item.text);
            return null;
          }
          log(`Opening: ${item.text}`);
          await Promise.all([page.waitForURL((u) => u.href !== listUrl, { timeout: options.navigationTimeoutMs }), link.click()]);
          await page.waitForLoadState("domcontentloaded", { timeout: options.navigationTimeoutMs });
        } catch (err) {
          recordFailure("NAVIGATION_FAILED", `could not open the result (${err instanceof Error ? err.name : "error"})`, item.href, item.text);
          return null;
        }
        if (page.url().startsWith("chrome-error:")) {
          recordFailure("NAVIGATION_FAILED", "the browser could not load the posting page", item.href, item.text);
          return null;
        }
        const verifiedAgain = await verify(page);
        if (verifiedAgain.detected) log(`Verification handled by a person: ${verifiedAgain.reason}`);
        await page.locator("h1").first().waitFor({ state: "visible", timeout: options.navigationTimeoutMs }).catch(() => undefined);
        await shot(page, query, "03-posting");
        await hold();

        // 7. Extract from the rendered DOM.
        const finalUrl = page.url();
        const dom = await extractPostingFromDom(page, cfg.descriptionContainer);
        const descriptionText = collapse(dom.text);
        const employerSeen = descriptionText.toLowerCase().includes(entry.company.toLowerCase());
        const title = dom.title && dom.title.length > 0 ? dom.title : null;
        const now = nowIso();
        const idFromUrl = extractTrailingNumericId(finalUrl);
        const relevance = evaluateRelevance({ title: title ?? "", location: dom.location }, roles);
        const posting: JobPosting = {
          id: computeJobId(finalUrl),
          source: `company-careers::${entry.company.toLowerCase()}`,
          sourceType: "company-careers",
          company: entry.company,
          title: title ?? "",
          location: dom.location,
          remoteType: null,
          employmentType: null,
          department: null,
          requisitionId: idFromUrl,
          postingDate: null,
          discoveredAt: now,
          lastSeenAt: now,
          canonicalUrl: finalUrl,
          applyUrl: finalUrl,
          descriptionText,
          descriptionHtml: dom.html || null,
          requiredYears: extractRequiredYears(descriptionText),
          salaryText: null,
          matchedProfiles: relevance.matched ? relevance.matchedProfiles : [],
          discoveredFrom: ["browser-search"],
          discoveredUrl: item.href,
          rawMetadata: { searchQuery: query, extraction: "browser-dom" },
        };
        const stamped = stampResolution(posting, {
          sourceKind: "browser-search",
          observedUrl: item.href,
          observedAt: now,
          finalUrl,
          extractionMethod: "browser-dom",
          discoveredCompany: entry.company,
          registryEntry: entry,
          apiJobId: null,
          now,
        });

        const base: ExtractedJobSummary = {
          title,
          employer: entry.company,
          employerSeenOnPage: employerSeen,
          location: dom.location,
          url: finalUrl,
          query,
          jdChars: descriptionText.length,
          extractionMethod: "browser-dom",
          status: "rejected",
        };
        if (!title) {
          base.failure = recordFailure("EMPTY_DESCRIPTION", "the posting page has no visible title heading", finalUrl, item.text, idFromUrl);
          return base;
        }
        if (!dom.rootFound) {
          base.failure = recordFailure("EMPTY_DESCRIPTION", "no description container was found on the posting page", finalUrl, title, idFromUrl);
          return base;
        }
        const gate = evaluatePersistable(stamped);
        if (!gate.ok) {
          base.failure = recordFailure(gate.failure.code as JobFailureCode, gate.failure.detail, finalUrl, title, idFromUrl);
          return base;
        }

        // 8. Durable save through the protected store.
        await updateJobs(jobsPath, (current) => mergeJobs(current, [gate.posting], now));
        summary.persistedCount += 1;
        base.status = "persisted";
        base.jobId = gate.posting.id;
        base.atsIdentity = gate.posting.atsIdentity;
        return base;
      }
    }

    summary.outcome = summary.persistedCount > 0 ? "PERSISTED" : summary.failures.length > 0 ? "FAILED" : "NO_RESULTS";
    return summary;
  } finally {
    unregister?.();
    if (context) {
      await closeFn(context, options.profileDir);
      summary.browserClosed = true;
    }
  }
}

