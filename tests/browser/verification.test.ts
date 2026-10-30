import { describe, expect, it, vi, beforeEach } from "vitest";

// Regression coverage for a real bug found live during Task 4 acceptance testing: bounded
// resolution (concurrency > 1) let multiple jobs hit a verification pause at the same time,
// each creating its own readline.Interface on the SAME shared process.stdin -- confirmed to
// produce a MaxListenersExceededWarning and, worse, exit the whole run with a non-zero code
// via an abandoned interface's later error surfacing as a process-level uncaughtException,
// well after every job had actually finished successfully. defaultWaitForEnter now serializes
// calls so only one readline.Interface is ever alive at once.

const { createInterfaceMock, questionMock, closeMock } = vi.hoisted(() => ({
  createInterfaceMock: vi.fn(),
  questionMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock("node:readline/promises", () => ({
  createInterface: createInterfaceMock,
}));

const { defaultWaitForEnter } = await import("../../src/browser/verification.js");

describe("defaultWaitForEnter", () => {
  beforeEach(() => {
    createInterfaceMock.mockReset();
    questionMock.mockReset();
    closeMock.mockReset();
    createInterfaceMock.mockImplementation(() => ({ question: questionMock, close: closeMock }));
  });

  it("serializes concurrent calls -- never more than one readline.Interface open on stdin at once", async () => {
    let activeInterfaces = 0;
    let maxConcurrentInterfaces = 0;
    const releasers: (() => void)[] = [];

    createInterfaceMock.mockImplementation(() => {
      activeInterfaces += 1;
      maxConcurrentInterfaces = Math.max(maxConcurrentInterfaces, activeInterfaces);
      return {
        question: () =>
          new Promise<string>((resolve) => {
            releasers.push(() => resolve(""));
          }),
        close: () => {
          activeInterfaces -= 1;
        },
      };
    });

    const call1 = defaultWaitForEnter();
    const call2 = defaultWaitForEnter();
    const call3 = defaultWaitForEnter();

    // Let microtasks flush so any (buggy) concurrent createInterface calls would have happened
    // by now.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(createInterfaceMock).toHaveBeenCalledTimes(1); // only the FIRST call has opened an interface so far
    expect(maxConcurrentInterfaces).toBe(1);

    releasers[0]!(); // let call 1's question() resolve
    await call1;
    await Promise.resolve();
    await Promise.resolve();
    expect(createInterfaceMock).toHaveBeenCalledTimes(2); // call 2's interface only opens now

    releasers[1]!();
    await call2;
    await Promise.resolve();
    await Promise.resolve();
    expect(createInterfaceMock).toHaveBeenCalledTimes(3);

    releasers[2]!();
    await call3;

    expect(maxConcurrentInterfaces).toBe(1); // never more than one alive at any point
  });

  it("still resolves every call even if question() is instant (non-interactive stdin EOF case)", async () => {
    questionMock.mockResolvedValue("");
    await Promise.all([defaultWaitForEnter(), defaultWaitForEnter(), defaultWaitForEnter()]);
    expect(createInterfaceMock).toHaveBeenCalledTimes(3);
    expect(closeMock).toHaveBeenCalledTimes(3);
  });

  it("releases the chain even if question() rejects, so a later call is never stuck waiting forever", async () => {
    questionMock.mockRejectedValueOnce(new Error("stdin exploded")).mockResolvedValue("");

    await expect(defaultWaitForEnter()).rejects.toThrow("stdin exploded");
    await expect(defaultWaitForEnter()).resolves.toBeUndefined();
  });
});
