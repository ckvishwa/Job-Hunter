import { describe, expect, it } from "vitest";
import { ExtractionQueue, type ExtractionEvent } from "../../src/api/extraction.js";

// No database needed: a stub repository that throws proves an unexpected worker error is reported and does not stall the queue.
describe("ExtractionQueue error handling", () => {
  it("reports an unexpected error as WORKER_ERROR and keeps processing later items", async () => {
    const events: ExtractionEvent[] = [];
    let calls = 0;
    const repo = {
      getVersionWithResume: async (id: string) => {
        calls += 1;
        if (id === "boom") throw new Error("connection terminated");
        return null; // nothing to do: SKIPPED
      },
    };
    const queue = new ExtractionQueue({ repo: repo as never, ai: {} as never, files: {} as never, onEvent: (e) => events.push(e) });
    queue.enqueue("boom");
    queue.enqueue("later");
    queue.enqueue("later"); // duplicate while queued is ignored
    await queue.idle();
    expect(events).toEqual([
      { versionId: "boom", outcome: "WORKER_ERROR", code: "Error" },
      { versionId: "later", outcome: "SKIPPED" },
    ]);
    expect(calls).toBe(2);
    queue.enqueue("later"); // can be queued again once finished
    await queue.idle();
    expect(calls).toBe(3);
  });
});
