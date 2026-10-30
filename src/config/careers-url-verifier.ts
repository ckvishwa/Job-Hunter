// Classifies the outcome of live-fetching a candidate career URL. Pure and network-free --
// callers (a live-fetch script, a future adapter) do the actual HTTP work and pass in the
// observed result; this module only judges what it means. That split is what makes it testable
// with mocked HTTP data instead of live network access.

export interface CareersUrlFetchResult {
  statusCode: number | null;
  finalUrl: string;
  finalHost: string;
  title: string | null;
  bodySnippet: string;
  redirectCount: number;
  chain: string[];
  error?: string;
}

export type VerificationOutcome = "verified" | "unreachable" | "verification-required" | "wrong-company" | "not-a-careers-page" | "pending";

export interface ClassificationResult {
  outcome: VerificationOutcome;
  detail: string;
}

const MAX_REDIRECTS = 5;

// Only true legal-entity suffixes are stripped -- NOT generic industry words ("business",
// "machines", "international", etc). An earlier version of this list stripped those too, which
// silently broke identity matching for companies whose only public brand words ARE industry
// words (e.g. "International Business Machines" -> IBM's site says only "IBM", but stripping
// "international"/"business"/"machines" left zero tokens to match anything against).
const STOPWORDS = new Set(["inc", "incorporated", "corp", "corporation", "group", "company", "co", "the", "holdings", "holding", "ltd", "llc", "plc"]);

// Generic hostname labels that never identify a specific company -- stripped before comparing
// a hostname's "brand" labels against the company name.
const GENERIC_HOST_LABELS = new Set([
  "www", "careers", "career", "jobs", "job", "talent", "search", "en", "us", "global", "com",
  "net", "org", "main", "home",
]);

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[&']/g, "") // "AT&T" -> "att" (a space here would leave two useless 1-2 char tokens)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function hostBrandWords(host: string): string[] {
  return host
    .toLowerCase()
    .split(".")
    .filter((label) => label.length > 0 && !GENERIC_HOST_LABELS.has(label));
}

const CHALLENGE_SIGNATURES = [
  /cloudflare/i,
  /cf-ray/i,
  /checking your browser/i,
  /just a moment/i,
  /akamai/i,
  /access denied/i,
  /reference #\d/i,
  /perimeterx/i,
  /datadome/i,
  /captcha/i,
  /verify you are human/i,
];

function looksLikeChallengePage(result: CareersUrlFetchResult): boolean {
  const haystack = `${result.title ?? ""} ${result.bodySnippet}`;
  return CHALLENGE_SIGNATURES.some((re) => re.test(haystack));
}

const CAREERS_KEYWORDS = /career|jobs?|hiring|employment|join (our|the) team|open positions?/i;

function looksLikeCareersPage(result: CareersUrlFetchResult): boolean {
  return CAREERS_KEYWORDS.test(result.title ?? "") || CAREERS_KEYWORDS.test(result.bodySnippet);
}

function companyIdentityMatches(company: string, result: CareersUrlFetchResult): boolean {
  const toks = tokens(company);
  if (toks.length === 0) return false;
  const haystack = `${result.title ?? ""} ${result.finalHost} ${result.bodySnippet}`.toLowerCase();

  // 1. Direct substring: a company word appears verbatim somewhere in title/host/body.
  if (toks.some((t) => haystack.includes(t))) return true;

  // 2. Acronym: multi-word companies are sometimes branded only by their initials (IBM, ADM).
  //    Only matched as a standalone word (in the title or as its own hostname label) -- never
  //    as a bare substring, since 2-3 letter acronyms collide with too much incidental text.
  if (toks.length >= 2) {
    const acronym = toks.map((t) => t[0]).join("");
    const titleWords = (result.title ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/);
    if (titleWords.includes(acronym) || hostBrandWords(result.finalHost).includes(acronym)) return true;
  }

  // 3. Truncated brand: some companies are branded by a shortened form of their legal name on
  //    their own domain (Citigroup -> "citi"). A hostname's brand label counts only if it's a
  //    genuine prefix of the company's smashed-together name, at least 4 characters long.
  const smashed = toks.join("");
  if (hostBrandWords(result.finalHost).some((w) => w.length >= 4 && smashed.startsWith(w))) return true;

  return false;
}

// Pure classification -- given what was actually observed fetching `result.finalUrl` (or the
// error that stopped the fetch), decide what it means for this company's career-URL candidate.
// Never bypasses a detected challenge page -- it's reported as verification-required, not solved.
export function classifyCareersUrlVerification(company: string, result: CareersUrlFetchResult): ClassificationResult {
  if (result.redirectCount > MAX_REDIRECTS) {
    return { outcome: "unreachable", detail: `Exceeded ${MAX_REDIRECTS} redirects following the candidate URL -- treated as a redirect loop, not followed further.` };
  }
  if (result.error || result.statusCode === null) {
    return { outcome: "unreachable", detail: `Fetch failed: ${result.error ?? "no response"}.` };
  }
  if (result.statusCode >= 400) {
    if (looksLikeChallengePage(result)) {
      return { outcome: "verification-required", detail: `Site presented a bot-protection/challenge page (HTTP ${result.statusCode}) -- not bypassed.` };
    }
    return { outcome: "unreachable", detail: `HTTP ${result.statusCode} received; not a recognized challenge page.` };
  }

  // statusCode is a success/redirect-terminal 2xx-3xx at this point.
  const identityMatches = companyIdentityMatches(company, result);
  const isCareersPage = looksLikeCareersPage(result);

  if (!identityMatches) {
    return { outcome: "wrong-company", detail: `Final page (${result.finalHost}, title "${result.title ?? "(no title)"}") does not identify itself as belonging to "${company}".` };
  }
  if (!isCareersPage) {
    return { outcome: "not-a-careers-page", detail: `Final page (${result.finalHost}, title "${result.title ?? "(no title)"}") identifies as "${company}" but shows no careers/jobs content.` };
  }
  return { outcome: "verified", detail: `Live-fetched ${result.finalUrl} (HTTP ${result.statusCode}, ${result.redirectCount} redirect(s)) -- confirmed "${company}" careers content.` };
}

// The registry's verificationStatus enum has no "wrong-company" / "not-a-careers-page" values
// (none has been observed yet, and the schema should only grow when an observed outcome needs
// a value it doesn't have -- see fortune500-verification-status.test.ts for the same principle
// applied to "no-parent-careers-page"/"not-found"). Both map to "not-found": an attempt was
// made and no valid official careers page was confirmed at that URL, which is exactly what
// "not-found" already means. The distinct `outcome` and `detail` are preserved in the report/
// verificationNote so the specific reason is never lost, even though the stored status is
// shared.
export function outcomeToRegistryStatus(outcome: VerificationOutcome): "verified" | "unreachable" | "verification-required" | "not-found" | "pending" {
  switch (outcome) {
    case "verified":
      return "verified";
    case "unreachable":
      return "unreachable";
    case "verification-required":
      return "verification-required";
    case "wrong-company":
    case "not-a-careers-page":
      return "not-found";
    case "pending":
      return "pending";
  }
}

export interface VerifyBatchItem<T> {
  item: T;
  company: string;
}

export interface VerifyBatchResult<T> {
  item: T;
  outcome: VerificationOutcome | "error";
  detail: string;
  fetchResult?: CareersUrlFetchResult;
}

// Runs `fetcher` over every candidate, classifying each result. A fetcher rejection for one
// item never stops the rest of the batch -- it's recorded as its own failed outcome instead.
export async function verifyBatch<T>(
  candidates: VerifyBatchItem<T>[],
  fetcher: (item: T) => Promise<CareersUrlFetchResult>,
): Promise<VerifyBatchResult<T>[]> {
  const results: VerifyBatchResult<T>[] = [];
  for (const candidate of candidates) {
    try {
      const fetchResult = await fetcher(candidate.item);
      const { outcome, detail } = classifyCareersUrlVerification(candidate.company, fetchResult);
      results.push({ item: candidate.item, outcome, detail, fetchResult });
    } catch (e) {
      results.push({ item: candidate.item, outcome: "error", detail: `fetcher threw: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return results;
}
