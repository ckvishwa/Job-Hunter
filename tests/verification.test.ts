import { describe, expect, it, vi } from "vitest";
import { detectVerification, pauseForVerification, type PageLike } from "../src/browser/verification.js";

describe("detectVerification", () => {
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
