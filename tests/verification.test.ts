import { describe, expect, it, vi } from "vitest";
import { detectVerification, pauseForVerification, type PageLike } from "../src/browser/verification.js";

describe("detectVerification", () => {
  it("does not treat a loaded reCAPTCHA script or passive badge as a visible challenge", () => {
    const result = detectVerification({
      url: "https://job-boards.greenhouse.io/discord/jobs/8703614002",
      title: "Job Application for QA/DevOps Engineer at Discord",
      html: `<script src="https://www.google.com/recaptcha/api.js"></script><h1>QA/DevOps Engineer</h1><div class="grecaptcha-badge"><iframe title="reCAPTCHA"></iframe></div>`,
    });
    expect(result.detected).toBe(false);
  });
  it("still flags a visible reCAPTCHA v2 widget or challenge frame even when a badge and scripts are present", () => {
    const base = { url: "https://example.test/apply", title: "Apply" };
    const script = '<script src="https://www.google.com/recaptcha/api.js"></script><div class="grecaptcha-badge"><iframe title="reCAPTCHA"></iframe></div>';
    expect(detectVerification({ ...base, html: `${script}<form><div class="g-recaptcha" data-sitekey="k"></div></form>` })).toMatchObject({ detected: true, reason: "reCAPTCHA detected" });
    expect(detectVerification({ ...base, html: `${script}<iframe src="https://www.google.com/recaptcha/api2/bframe"></iframe>` })).toMatchObject({ detected: true });
  });
  it("still flags visible human-verification text on a page that also loads scripts", () => {
    const html = '<script src="/app.js"></script><h1>Please verify you are human to continue</h1>';
    expect(detectVerification({ url: "https://example.test/", html })).toMatchObject({ detected: true, reason: "Generic human-verification phrasing detected" });
  });
  it("ignores challenge-provider names that appear only inside script or style content", () => {
    const html = '<script>window.hcaptcha = {}; var cfg = "cf-turnstile";</script><style>.cf-turnstile{display:none}</style><p>Open roles</p><script src="https://js.hcaptcha.com/1/api.js"></script>';
    expect(detectVerification({ url: "https://example.test/careers", html })).toEqual({ detected: false });
  });
  it("flags reCAPTCHA", () => {
    const result = detectVerification({
      html: `<div class="g-recaptcha" data-sitekey="abc"></div>`,
      url: "https://example.com/careers",
    });
    expect(result.detected).toBe(true);
    expect(result.reason).toMatch(/recaptcha/i);
  });

  it("flags hCaptcha", () => {
    const result = detectVerification({
      html: `<iframe src="https://newassets.hcaptcha.com/captcha/v1/frame"></iframe>`,
      url: "https://example.com/careers",
    });
    expect(result.detected).toBe(true);
    expect(result.reason).toMatch(/hcaptcha/i);
  });

  it("flags Cloudflare Turnstile / browser-check challenge", () => {
    const result = detectVerification({
      html: `<title>Just a moment...</title><body>Checking your browser before accessing example.com.</body>`,
      url: "https://example.com/careers",
    });
    expect(result.detected).toBe(true);
    expect(result.reason).toMatch(/cloudflare/i);
  });

  it("flags generic human-verification phrasing", () => {
    const result = detectVerification({
      html: `<p>Please verify you are human to continue.</p>`,
      url: "https://example.com/careers",
    });
    expect(result.detected).toBe(true);
  });

  it("does not flag a normal careers page", () => {
    const result = detectVerification({
      html: `<html><body><h1>Open Roles</h1><ul><li>SDET</li></ul></body></html>`,
      url: "https://example.com/careers",
      title: "Careers - Example Co",
    });
    expect(result.detected).toBe(false);
    expect(result.reason).toBeUndefined();
  });
});

describe("pauseForVerification", () => {
  function makeFakePage(html: string, url: string, title = ""): PageLike {
    return {
      url: () => url,
      content: async () => html,
      title: async () => title,
    };
  }

  it("calls waitForEnter and returns detected result when verification is present", async () => {
    const waitForEnter = vi.fn().mockResolvedValue(undefined);
    const page = makeFakePage(
      `<div class="g-recaptcha"></div>`,
      "https://example.com/careers",
    );

    const result = await pauseForVerification(page, waitForEnter);

    expect(result.detected).toBe(true);
    expect(waitForEnter).toHaveBeenCalledTimes(1);
  });

  it("does not call waitForEnter when no verification is present", async () => {
    const waitForEnter = vi.fn().mockResolvedValue(undefined);
    const page = makeFakePage(
      `<html><body>Open Roles</body></html>`,
      "https://example.com/careers",
    );

    const result = await pauseForVerification(page, waitForEnter);

    expect(result.detected).toBe(false);
    expect(waitForEnter).not.toHaveBeenCalled();
  });
});
