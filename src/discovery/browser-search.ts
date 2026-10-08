import { mkdirSync, writeFileSync } from "node:fs";
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
  extractGreenhouseJidParam,
  hostMatchesDomain,
  parseAtsPostingUrl,
  stampResolution,
  type JobFailure,
  type JobFailureCode,
} from "../domain/canonical-job.js";
import { extractRequiredYears } from "../extraction/metadata.js";
import { loadJobs, updateJobs } from "../storage/job-store.js";
import { appendJobFailures } from "../storage/jsonl-store.js";
import { classifyResultTitle, type TitleClass } from "./title-targeting.js";

// Visible-browser search discovery (one company). In an owned, headed Chrome it:
//   opens the official careers/search page -> focuses the real search field -> types the query
//   key by key -> executes the search with the page's own control (Enter / its submit button)
//   -> waits for the RESULTS TO CHANGE (or the page's own empty state)
//   -> classifies every result TITLE against config/roles.yml (MATCH / REVIEW / NO_MATCH)
//   -> clicks only MATCH results (REVIEW only when configured) up to maxJobs
//   -> extracts title / location / URL / the cleaned, rendered job description FROM THE DOM
//   -> validates through the canonical gate -> saves through the protected store (updateJobs).
// No API call and no background HTTP request produces any saved content. (The one HTTP call is an
// identity check for company-hosted numeric ids, see confirmGreenhouseListing.)

const POLL_MS = 120;
const STABLE_MS = 400;
const STALE_EMPTY_GRACE_MS = 1200;

// Page chrome hidden before the description text is read. Page-specific extras come from the input's
// selectors.descriptionRemove. The title <h1> and action links (Apply / Save / Share) are handled separately.
const DEFAULT_NOISE_SELECTORS = [
  "nav",
  "[aria-label*='readcrumb' i]",
  "[class*='readcrumb']",
  "aside",
  "[role='complementary']",
  "[role='navigation']",
  "button",
  "form",
  "footer",
];
const ACTION_LABEL_SOURCE = "^(apply( now| for this role| here| to this (job|role))?|save( job)?|share( this (job|role))?)$";

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
  /** Confirms a numeric Greenhouse id found in a company-hosted URL against the employer's registered board. */
  confirmListing?: (board: string, jobId: string, corporateDomain: string | null) => Promise<boolean>;
  log?: (line: string) => void;
  now?: () => string;
}

/**
 * Identity evidence for company-hosted listings: the id must exist on the employer's registered Greenhouse
 * board and that listing's URL must belong to the employer (its domain or the board itself). This is the only
 * non-browser request in the flow and it never supplies any saved content, only a yes/no about identity.
 */
export async function confirmGreenhouseListing(board: string, jobId: string, corporateDomain: string | null): Promise<boolean> {
  try {
    const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { id?: unknown; absolute_url?: unknown };
    if (String(body.id) !== jobId || typeof body.absolute_url !== "string") return false;
    const host = new URL(body.absolute_url).hostname;
    const hostedBoard = parseAtsPostingUrl(body.absolute_url);
    return (corporateDomain !== null && hostMatchesDomain(host, corporateDomain)) || hostedBoard?.board?.toLowerCase() === board.toLowerCase();
  } catch {
    return false;
  }
}

export interface QueryOutcome {
  query: string;
  status: "results" | "empty" | "failed";
  resultCount: number;
  matchCount: number;
  reviewCount: number;
  noMatchCount: number;
  typedValue: string | null;
  urlAfterSearch: string | null;
  failure?: JobFailure;
}

export interface ShortlistEntry {
  query: string;
  title: string;
  company: string;
  team: string | null;
  location: string | null;
  url: string;
  classification: TitleClass;
  profile: string | null;
  rule: string;
  reason: string;
  /** Why a result was or was not opened. */
  selection: string;
  opened: boolean;
  extracted: boolean;
  saved: boolean;
  failureCode?: string;
}

export interface ExtractedJobSummary {
  title: string | null;
  employer: string;
  employerSeenOnPage: boolean;
  location: string | null;
  url: string;
  query: string;
  jdChars: number;
  jdHash?: string;
  sections: string[];
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
  shortlist: ShortlistEntry[];
  jobs: ExtractedJobSummary[];
  failures: JobFailure[];
  persistedCount: number;
  outcome: "PERSISTED" | "NO_MATCH" | "NO_RESULTS" | "FAILED";
  jobsPath: string;
  failuresPath: string;
  shortlistPath: string;
  browserClosed: boolean;
}

interface ResultItem {
  href: string;
  text: string;
  index: number;
  team: string;
  location: string;
}
interface Snapshot {
  items: ResultItem[];
  empty: boolean;
  url: string;
}
interface ResultSelectors {
  resultLink: string;
  emptyStateText: string;
  resultTeam?: string;
  resultLocation?: string;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "query";
}

function collapse(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function snapshot(page: Page, cfg: ResultSelectors): Promise<Snapshot> {
  return page.evaluate(
    ({ sel, emptyRe, teamSel, locSel }) => {
      const visible = (el: Element): boolean => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
      };
      const clean = (t: string | null | undefined): string => (t || "").replace(/\s+/g, " ").trim();
      const all = Array.from(document.querySelectorAll<HTMLAnchorElement>(sel));
      const seen = new Set<string>();
      const items: { href: string; text: string; index: number; team: string; location: string }[] = [];
      all.forEach((a, index) => {
        if (!visible(a) || seen.has(a.href)) return;
        seen.add(a.href);
        const text = clean(a.innerText || a.textContent);
        // Team and location come from the result row (closest li / tr / article): configured sub-selectors when
        // given, else the row's other text lines (first = team, last = location when there are two or more).
        const row = a.closest("li, tr, [role=row], article") as HTMLElement | null;
        let team = "";
        let location = "";
        if (row) {
          if (teamSel) team = clean(row.querySelector<HTMLElement>(teamSel)?.innerText);
          if (locSel) location = clean(row.querySelector<HTMLElement>(locSel)?.innerText);
          if (!teamSel && !locSel) {
            const lines = row.innerText.split("\n").map(clean).filter((l) => l && l !== text);
            if (lines.length >= 2) {
              team = lines[0]!;
              location = lines[lines.length - 1]!;
            } else if (lines.length === 1) {
              location = lines[0]!;
            }
          }
        }
        items.push({ href: a.href, text, index, team, location });
      });
      const scope = (document.querySelector("main") as HTMLElement | null) ?? document.body;
      return { items, empty: new RegExp(emptyRe, "i").test(scope.innerText), url: location.href };
    },
    { sel: cfg.resultLink, emptyRe: cfg.emptyStateText, teamSel: cfg.resultTeam ?? "", locSel: cfg.resultLocation ?? "" },
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

async function waitForResultsChange(page: Page, cfg: ResultSelectors, before: Snapshot, typingFinishedAt: number, timeoutMs: number): Promise<Snapshot | null> {
  const beforeSig = before.empty ? "EMPTY" : before.items.map((i) => i.href).join("|");
  const deadline = Date.now() + timeoutMs;
  let lastSig: string | null = null;
  let stableSince = 0;
  for (;;) {
    const snap = await snapshot(page, cfg);
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
  sections: string[];
  strategy: {
    container: string;
    removedSelectors: Record<string, number>;
    actionLinksRemoved: number;
    titleHeadingRemoved: boolean;
  };
}

/**
 * Reads the posting from the live DOM. Location is read first (it sits in the page's fact panel); then page
 * chrome (breadcrumb, nav, fact sidebar, buttons, action links, the duplicate <h1> title) is hidden with inline
 * display:none, the text/HTML/section headings are read, and the page is restored. What remains is the
 * substantive description: sections such as responsibilities, qualifications, compensation and benefits.
 */
async function extractPostingFromDom(page: Page, container: string, removeSelectors: string[]): Promise<DomExtraction> {
  return page.evaluate(
    ({ sel, removers, actionSource }) => {
      const root = document.querySelector<HTMLElement>(sel);
      const h1 = document.querySelector<HTMLElement>("h1");
      const clean = (t: string | null | undefined): string => (t || "").replace(/\s+/g, " ").trim();
      const strategy = { container: sel, removedSelectors: {} as Record<string, number>, actionLinksRemoved: 0, titleHeadingRemoved: false };
      if (!root) {
        return { rootFound: false, title: h1 ? clean(h1.innerText) : null, location: null, text: "", html: "", sections: [] as string[], strategy };
      }

      // Location = the value shown right after a visible label such as "Office locations" / "Remote
      // location" / "Location", in document order. A label with no value before the next label is skipped.
      const labelRe = /^(office |remote |job )?locations?$/i;
      const values: string[] = [];
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("h2,h3,h4,h5,dt,th,label,dd,td"));
      nodes.forEach((el, i) => {
        if (el.children.length > 0 || !labelRe.test(clean(el.textContent))) return;
        const next = nodes[i + 1];
        if (!next || !["DD", "TD"].includes(next.tagName)) return;
        const value = clean(next.textContent);
        if (value && !values.includes(value)) values.push(value);
      });

      const hidden: { el: HTMLElement; previous: string }[] = [];
      const hide = (el: HTMLElement): boolean => {
        if (el === root || el.contains(root) || el.style.display === "none") return false;
        hidden.push({ el, previous: el.style.display });
        el.style.display = "none";
        return true;
      };
      for (const selector of removers) {
        let n = 0;
        root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
          if (hide(el)) n += 1;
        });
        strategy.removedSelectors[selector] = n;
      }
      const actionRe = new RegExp(actionSource, "i");
      root.querySelectorAll<HTMLElement>("a").forEach((a) => {
        if (actionRe.test(clean(a.textContent)) && hide(a)) strategy.actionLinksRemoved += 1;
      });
      const rootH1 = root.querySelector<HTMLElement>("h1");
      if (rootH1 && hide(rootH1)) strategy.titleHeadingRemoved = true;

      const sections = Array.from(root.querySelectorAll<HTMLElement>("h2,h3,h4"))
        .filter((h) => h.getClientRects().length > 0)
        .map((h) => clean(h.innerText))
        .filter(Boolean);
      // Preserve list item boundaries in the text artifact. `innerText` needs a rendered node to
      // retain block newlines, so mark list items on the live DOM synchronously, read it, then
      // remove every marker before returning control to the page.
      const markers: Text[] = [];
      for (const item of Array.from(root.querySelectorAll("li"))) {
        const marker = document.createTextNode("• ");
        item.insertBefore(marker, item.firstChild);
        markers.push(marker);
      }
      const text = root.innerText;
      markers.forEach((marker) => marker.remove());
      const clone = root.cloneNode(true) as HTMLElement;
      clone.querySelectorAll<HTMLElement>("[style*='display: none']").forEach((e) => e.remove());
      const html = clone.innerHTML;
      for (const { el, previous } of hidden) el.style.display = previous;

      return { rootFound: true, title: h1 ? clean(h1.innerText) : null, location: values.length > 0 ? values.join("; ") : null, text, html, sections, strategy };
    },
    { sel: container, removers: removeSelectors, actionSource: ACTION_LABEL_SOURCE },
  );
}

export async function runSearchDiscovery(resolved: ResolvedSearchTarget, options: SearchRunOptions, deps: SearchRunDeps = {}): Promise<SearchRunSummary> {
  const { target, entry } = resolved;
  const log = deps.log ?? ((line: string) => console.log(line));
  const launchFn = deps.launchFn ?? launchPersistentChrome;
  const closeFn = deps.closeFn ?? closePersistentChrome;
  const registerShutdown = deps.registerShutdown ?? registerShutdownOnSignal;
  const verify = deps.verify ?? ((page: Page) => pauseForVerification(page));
  const confirmListing = deps.confirmListing ?? confirmGreenhouseListing;
  const nowIso = deps.now ?? (() => new Date().toISOString());
  const maxJobs = options.maxJobs ?? target.maxJobs;
  const jobsPath = path.join(options.dataDir, "jobs.jsonl");
  const failuresPath = path.join(options.dataDir, "job-failures.jsonl");
  const shortlistPath = path.join(options.dataDir, "search-shortlist.json");
  const runId = `search-${nowIso().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;

  const summary: SearchRunSummary = {
    company: entry.company,
    careersUrl: target.careersUrl,
    runId,
    queries: [],
    shortlist: [],
    jobs: [],
    failures: [],
    persistedCount: 0,
    outcome: "NO_RESULTS",
    jobsPath,
    failuresPath,
    shortlistPath,
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
    const resultCfg: ResultSelectors = { resultLink: cfg.resultLink, emptyStateText: cfg.emptyStateText, resultTeam: cfg.resultTeam, resultLocation: cfg.resultLocation };

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
    log(`Found search field: "${(await box.getAttribute("aria-label")) ?? (await box.getAttribute("placeholder")) ?? "search"}"`);

    for (const query of target.queries) {
      if (summary.persistedCount >= maxJobs) break;
      const outcome: QueryOutcome = { query, status: "failed", resultCount: 0, matchCount: 0, reviewCount: 0, noMatchCount: 0, typedValue: null, urlAfterSearch: null };
      summary.queries.push(outcome);

      // 3. Focus the field and type visibly.
      const before = await snapshot(page, resultCfg);
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
      const snap = await waitForResultsChange(page, resultCfg, before, typingFinishedAt, options.settleTimeoutMs);
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
      await shot(page, query, "02-results");

      // 6. Classify every result TITLE before anything is opened.
      const decided = snap.items.map((item) => ({
        item,
        decision: classifyResultTitle({ title: item.text, team: item.team || null }, roles, { reviewByTeam: target.selection.reviewByTeam }),
      }));
      const openable = (c: TitleClass): boolean => c === "MATCH" || (c === "REVIEW" && target.selection.openReview);
      outcome.matchCount = decided.filter((d) => d.decision.classification === "MATCH").length;
      outcome.reviewCount = decided.filter((d) => d.decision.classification === "REVIEW").length;
      outcome.noMatchCount = decided.filter((d) => d.decision.classification === "NO_MATCH").length;
      log(`${snap.items.length} result(s) for "${query}": ${outcome.matchCount} MATCH, ${outcome.reviewCount} REVIEW, ${outcome.noMatchCount} NO_MATCH`);
      const entries = new Map<string, ShortlistEntry>();
      for (const { item, decision } of decided) {
        const existing = summary.shortlist.find((e) => e.url === item.href);
        if (existing) {
          entries.set(item.href, existing);
          continue;
        }
        const entryRow: ShortlistEntry = {
          query,
          title: item.text,
          company: entry.company,
          team: item.team || null,
          location: item.location || null,
          url: item.href,
          classification: decision.classification,
          profile: decision.profile,
          rule: decision.rule,
          reason: decision.reason,
          selection: openable(decision.classification) ? "eligible to open" : decision.classification === "REVIEW" ? "not opened: REVIEW results open only with selection.openReview" : "not opened: no role match",
          opened: false,
          extracted: false,
          saved: false,
        };
        summary.shortlist.push(entryRow);
        entries.set(item.href, entryRow);
        log(`  ${decision.classification.padEnd(8)} ${item.text}${item.team ? ` [${item.team}]` : ""}${item.location ? ` - ${item.location}` : ""}`);
      }
      await hold();

      const candidates = decided.filter((d) => openable(d.decision.classification) && !entries.get(d.item.href)!.opened);
      if (candidates.length === 0) {
        log(`Nothing to open for "${query}": no result title matches a configured role${outcome.reviewCount > 0 ? ` (${outcome.reviewCount} left for review)` : ""}.`);
        continue;
      }

      // 7. Open selected results, one at a time, until maxJobs are saved.
      const listUrl = snap.url;

      // Back on the results list (browser Back first, which keeps a page's own filter state; a reload of
      // the list URL only as a fallback), find the wanted result again BY HREF: positions can shift.
      async function returnToResults(href: string): Promise<ResultItem | null> {
        const find = async (): Promise<ResultItem | null> => {
          const again = await waitForResultsChange(page, resultCfg, { items: [], empty: false, url: "" }, Date.now(), options.settleTimeoutMs);
          return again?.items.find((i) => i.href === href) ?? null;
        };
        await page.goBack({ waitUntil: "domcontentloaded", timeout: options.navigationTimeoutMs }).catch(() => undefined);
        const viaBack = await find();
        if (viaBack) return viaBack;
        await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: options.navigationTimeoutMs }).catch(() => undefined);
        return find();
      }

      let onPostingPage = false;
      for (const { item } of candidates) {
        const row = entries.get(item.href)!;
        if (summary.persistedCount >= maxJobs) {
          row.selection = "not opened: maxJobs reached";
          continue;
        }
        let wanted: ResultItem | null = item;
        if (onPostingPage) {
          wanted = await returnToResults(item.href);
          if (!wanted) {
            row.selection = "not opened: results list could not be restored";
            recordFailure("NAVIGATION_FAILED", "the results list could not be restored after viewing a posting", listUrl, item.text);
            break;
          }
        }
        onPostingPage = true;
        const job = await openAndPersist(wanted, row);
        if (job) summary.jobs.push(job);
      }

      async function openAndPersist(item: ResultItem, row: ShortlistEntry): Promise<ExtractedJobSummary | null> {
        const link = page.locator(cfg.resultLink).nth(item.index);
        const fail = (code: JobFailureCode, detail: string, url: string, title: string, id: string | null = null): JobFailure => {
          row.failureCode = code;
          return recordFailure(code, detail, url, title, id);
        };
        try {
          await link.scrollIntoViewIfNeeded();
          if ((await link.evaluate((a) => (a as HTMLAnchorElement).href)) !== item.href) {
            fail("NAVIGATION_FAILED", "the result list changed before the result could be opened", listUrl, item.text);
            return null;
          }
          log(`Opening [${row.classification}]: ${item.text}`);
          await Promise.all([page.waitForURL((u) => u.href !== listUrl, { timeout: options.navigationTimeoutMs }), link.click()]);
          await page.waitForLoadState("domcontentloaded", { timeout: options.navigationTimeoutMs });
        } catch (err) {
          fail("NAVIGATION_FAILED", `could not open the result (${err instanceof Error ? err.name : "error"})`, item.href, item.text);
          return null;
        }
        row.opened = true;
        if (page.url().startsWith("chrome-error:")) {
          fail("NAVIGATION_FAILED", "the browser could not load the posting page", item.href, item.text);
          return null;
        }
        const verifiedAgain = await verify(page);
        if (verifiedAgain.detected) log(`Verification handled by a person: ${verifiedAgain.reason}`);
        await page.locator("h1").first().waitFor({ state: "visible", timeout: options.navigationTimeoutMs }).catch(() => undefined);
        await shot(page, query, "03-posting");
        await hold();

        // 8. Extract the cleaned description from the rendered DOM.
        const finalUrl = page.url();
        const dom = await extractPostingFromDom(page, cfg.descriptionContainer, [...DEFAULT_NOISE_SELECTORS, ...cfg.descriptionRemove]);
        const descriptionText = collapse(dom.text);
        row.extracted = dom.rootFound && descriptionText.length > 0;
        const employerSeen = descriptionText.toLowerCase().includes(entry.company.toLowerCase());
        const title = dom.title && dom.title.length > 0 ? dom.title : null;
        const now = nowIso();

        // Identity for a company-hosted listing without gh_jid: only a configured URL shape whose id is
        // confirmed on the employer's registered Greenhouse board. A bare number is never an identity.
        let confirmedId: string | null = null;
        if (cfg.listingIdPattern && entry.atsType === "greenhouse" && entry.atsTenantOrBoardId) {
          const candidateId = new RegExp(cfg.listingIdPattern).exec(new URL(finalUrl).pathname)?.[1] ?? null;
          if (candidateId) {
            if (await confirmListing(entry.atsTenantOrBoardId, candidateId, entry.corporateDomain)) confirmedId = candidateId;
            else {
              fail("JOB_ID_MISSING", `id ${candidateId} from the URL is not a job on ${entry.company}'s registered Greenhouse board; no identity assigned`, finalUrl, title ?? item.text, candidateId);
            }
          }
        }
        const relevance = classifyResultTitle({ title: title ?? item.text, team: row.team }, roles, { reviewByTeam: target.selection.reviewByTeam });
        const posting: JobPosting = {
          id: computeJobId(finalUrl),
          source: `company-careers::${entry.company.toLowerCase()}`,
          sourceType: "company-careers",
          company: entry.company,
          title: title ?? "",
          location: dom.location ?? row.location,
          remoteType: null,
          employmentType: null,
          department: row.team,
          requisitionId: confirmedId ?? extractGreenhouseJidParam(finalUrl),
          postingDate: null,
          discoveredAt: now,
          lastSeenAt: now,
          canonicalUrl: finalUrl,
          applyUrl: finalUrl,
          descriptionText,
          descriptionHtml: dom.html || null,
          requiredYears: extractRequiredYears(descriptionText),
          salaryText: null,
          matchedProfiles: relevance.classification === "MATCH" && relevance.profile ? [relevance.profile] : [],
          discoveredFrom: ["browser-search"],
          discoveredUrl: item.href,
          matchedKeywords: relevance.matchedKeywords,
          relevanceReason: relevance.reason,
          rawMetadata: {
            searchQuery: query,
            extraction: "browser-dom",
            extractionStrategy: { ...dom.strategy, sections: dom.sections },
            titleTargeting: { classification: relevance.classification, rule: relevance.rule },
          },
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
          confirmedGreenhouseJobId: confirmedId,
          now,
        });

        const base: ExtractedJobSummary = {
          title,
          employer: entry.company,
          employerSeenOnPage: employerSeen,
          location: posting.location,
          url: finalUrl,
          query,
          jdChars: descriptionText.length,
          jdHash: stamped.jdContentHash,
          sections: dom.sections,
          extractionMethod: "browser-dom",
          status: "rejected",
        };
        if (row.failureCode) return base; // identity confirmation already failed above
        if (!title) {
          base.failure = fail("EMPTY_DESCRIPTION", "the posting page has no visible title heading", finalUrl, item.text, confirmedId);
          return base;
        }
        if (!dom.rootFound) {
          base.failure = fail("EMPTY_DESCRIPTION", "no description container was found on the posting page", finalUrl, title, confirmedId);
          return base;
        }
        const gate = evaluatePersistable(stamped);
        if (!gate.ok) {
          base.failure = fail(gate.failure.code as JobFailureCode, gate.failure.detail, finalUrl, title, confirmedId);
          return base;
        }

        // 9. Durable save through the protected store.
        await updateJobs(jobsPath, (current) => mergeJobs(current, [gate.posting], now));
        summary.persistedCount += 1;
        row.saved = true;
        base.status = "persisted";
        base.jobId = gate.posting.id;
        base.atsIdentity = gate.posting.atsIdentity;
        return base;
      }
    }

    const sawResults = summary.queries.some((q) => q.status === "results");
    summary.outcome = summary.persistedCount > 0 ? "PERSISTED" : summary.failures.length > 0 ? "FAILED" : sawResults ? "NO_MATCH" : "NO_RESULTS";
    return summary;
  } finally {
    unregister?.();
    try {
      mkdirSync(options.dataDir, { recursive: true });
      writeFileSync(
        shortlistPath,
        JSON.stringify(
          {
            runId,
            generatedAt: nowIso(),
            company: entry.company,
            careersUrl: target.careersUrl,
            note: "Title-based targeting against config/roles.yml. Not candidate eligibility and not a hiring probability.",
            queries: summary.queries.map((q) => ({ query: q.query, status: q.status, results: q.resultCount, match: q.matchCount, review: q.reviewCount, noMatch: q.noMatchCount })),
            entries: summary.shortlist,
          },
          null,
          2,
        ) + "\n",
      );
    } catch {
      // the shortlist is a derived report; a write problem must not mask the run's own outcome
    }
    if (context) {
      await closeFn(context, options.profileDir);
      summary.browserClosed = true;
    }
  }
}
