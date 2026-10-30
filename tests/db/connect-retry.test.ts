import { describe, expect, it } from "vitest";
import { retryConnect } from "../../src/db/pool.js";

describe("PostgreSQL connect retry", () => {
  it("retries a loopback connect failure and then returns the query result", async () => {
    let calls = 0;
    const value = await retryConnect(async () => {
      calls += 1;
      if (calls < 3) throw new Error("connect ETIMEDOUT 127.0.0.1:55440");
      return 7;
    });
    expect(value).toBe(7);
    expect(calls).toBe(3);
  });

  it("does not retry a statement error", async () => {
    let calls = 0;
    await expect(retryConnect(async () => {
      calls += 1;
      throw new Error("column jr.sha256 does not exist");
    })).rejects.toThrow(/sha256/);
    expect(calls).toBe(1);
  });
});
