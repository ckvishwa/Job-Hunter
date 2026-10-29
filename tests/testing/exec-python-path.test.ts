import { describe, expect, test } from "vitest";
import { pythonTarget } from "../../src/testing/exec.js";

describe("Python suite path mapping", () => {
  test("maps the whole AI suite to its working directory", () => {
    expect(pythonTarget("python:services/ai")).toBe(".");
  });

  test("strips the AI root from per-file paths run inside services/ai", () => {
    expect(pythonTarget("python:services/ai/tests/test_service.py")).toBe("tests/test_service.py");
  });
});
