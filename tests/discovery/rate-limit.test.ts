import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withRetry, pacer } from "../../src/discovery/rate-limit.js";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds immediately when fn never fails", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn, { retries: 2, backoffMs: 500 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("succeeds on the 2nd attempt after 1 failure", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("first fails"))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { retries: 2, backoffMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws the LAST error", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("attempt 1 failed"))
      .mockRejectedValueOnce(new Error("attempt 2 failed"))
      .mockRejectedValueOnce(new Error("attempt 3 failed"));

    const promise = withRetry(fn, { retries: 2, backoffMs: 500 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await promise;

    expect(fn).toHaveBeenCalledTimes(3);
    expect((err as Error).message).toBe("attempt 3 failed");
  });
});

describe("pacer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays a second call to the same hostname within the delay window", async () => {
    const pace = pacer(1000);

    await pace("https://example.com/a");

    let resolved = false;
    const promise = pace("https://example.com/b").then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    await promise;
    expect(resolved).toBe(true);
  });

  it("does not delay a call to a different hostname", async () => {
    const pace = pacer(1000);

    await pace("https://example.com/a");

    let resolved = false;
    const promise = pace("https://other.com/b").then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    await promise;
    expect(resolved).toBe(true);
  });
});
