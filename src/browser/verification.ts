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
  const haystack = `${input.title ?? ""}\n${input.html}`;
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

async function defaultWaitForEnter(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter once verification is complete to continue...");
  rl.close();
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
