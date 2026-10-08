import { createInterface } from "node:readline/promises";

export interface VerificationCheckInput {
  html: string;
  url: string;
  title?: string;
}

export interface VerificationResult {
  detected: boolean;
  reason?: string;
}

interface Signal {
  reason: string;
  pattern: RegExp;
}

// Heuristic-only: text/markup signals for known CAPTCHA and anti-bot
// challenge providers, plus generic human-verification phrasing.
// Never attempts to solve or bypass anything it detects.
const SIGNALS: Signal[] = [
  { reason: "reCAPTCHA detected", pattern: /recaptcha/i },
  { reason: "hCaptcha detected", pattern: /hcaptcha/i },
  { reason: "Cloudflare Turnstile / challenge detected", pattern: /cf-turnstile|checking your browser|cloudflare.*challenge/i },
  { reason: "PerimeterX detected", pattern: /perimeterx|_px-captcha/i },
  { reason: "DataDome detected", pattern: /datadome/i },
  { reason: "Generic human-verification phrasing detected", pattern: /verify you are human|are you a robot|unusual traffic from your network|complete the security check|please confirm you are a human/i },
  { reason: "Access-denied / bot-block page detected", pattern: /access denied[\s\S]{0,80}(bot|automated)|automated (queries|requests) detected/i },
];

/**
 * Pure heuristic check — no Playwright dependency, so it's testable with
 * plain strings. Feed it real page.content()/page.url()/page.title() from
 * the wrapper below.
 */
export function detectVerification(input: VerificationCheckInput): VerificationResult {
  // Loaded CAPTCHA libraries and a passive reCAPTCHA badge are common on ordinary
  // application pages. They are not evidence that a challenge is being shown.
  const visibleMarkup = input.html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*class=["'][^"']*grecaptcha-badge[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, "");
  const haystack = `${input.title ?? ""}\n${visibleMarkup}`;
  for (const signal of SIGNALS) {
    if (signal.pattern.test(haystack)) {
      return { detected: true, reason: signal.reason };
    }
  }
  return { detected: false };
}

export interface PageLike {
  url(): string;
  content(): Promise<string>;
  title(): Promise<string>;
}

// Serializes real stdin prompts across concurrent callers. Bounded resolution (Task 4) runs
// multiple jobs concurrently, and more than one can hit a verification pause at once -- without
// this, each would create its own readline.Interface on the SAME shared process.stdin stream.
// Confirmed live: that produced a real MaxListenersExceededWarning and, worse, an abandoned
// interface's later error surfaced as a process-level uncaughtException well after the job that
// triggered it had already timed out and moved on -- exiting the whole run with a non-zero code
// despite every job having actually completed. Also just makes real interactive use sane: a
// human operator sees one prompt at a time instead of several stacked/interleaved ones.
let waitChain: Promise<void> = Promise.resolve();

// Exported for direct testability (the serialization property below can't be observed through
// pauseForVerification's public surface without mocking readline itself either way).
export async function defaultWaitForEnter(): Promise<void> {
  const previous = waitChain;
  let release: () => void = () => {};
  waitChain = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter once verification is complete to continue...");
    rl.close();
  } finally {
    release();
  }
}

/**
 * Checks the current page for verification/anti-bot signals. If detected,
 * pauses (browser stays open) and prints a message, then waits for the
 * caller-supplied waitForEnter (default: real stdin prompt) before
 * returning control to the caller.
 */
export async function pauseForVerification(
  page: PageLike,
  waitForEnter: () => Promise<void> = defaultWaitForEnter,
): Promise<VerificationResult> {
  const [html, title] = await Promise.all([page.content(), page.title()]);
  const result = detectVerification({ html, url: page.url(), title });

  if (result.detected) {
    console.log("\n=== Verification required ===");
    console.log(`URL: ${page.url()}`);
    console.log(`Reason: ${result.reason}`);
    console.log("Automation paused. Complete verification manually in the open Chrome window.");
    console.log("==============================\n");
    await waitForEnter();
  }

  return result;
}
