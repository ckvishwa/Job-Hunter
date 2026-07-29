import { afterEach, beforeEach, describe, expect, test } from "vitest";
import path from "node:path";
import { resolveCareerOpsHome } from "../../../src/sources/careerops/careerops-config.js";

const ORIGINAL_ENV = process.env.CAREER_OPS_HOME;

describe("resolveCareerOpsHome", () => {
  beforeEach(() => {
    delete process.env.CAREER_OPS_HOME;
  });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CAREER_OPS_HOME;
    else process.env.CAREER_OPS_HOME = ORIGINAL_ENV;
  });

  test("CLI option takes precedence over everything", () => {
    process.env.CAREER_OPS_HOME = "C:/env/career-ops";
    expect(resolveCareerOpsHome("C:/cli/career-ops")).toBe("C:/cli/career-ops");
  });

  test("falls back to CAREER_OPS_HOME env var when no CLI option given", () => {
    process.env.CAREER_OPS_HOME = "C:/env/career-ops";
    expect(resolveCareerOpsHome()).toBe("C:/env/career-ops");
  });

  test("falls back to the documented sibling default when neither is given", () => {
    const result = resolveCareerOpsHome();
    expect(result).toBe(path.resolve(process.cwd(), "..", "career-ops"));
  });
});
