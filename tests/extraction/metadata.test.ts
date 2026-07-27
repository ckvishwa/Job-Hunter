import { describe, expect, it } from "vitest";
import { extractRequiredYears } from "../../src/extraction/metadata.js";

describe("extractRequiredYears", () => {
  it("extracts a plain years requirement", () => {
    expect(extractRequiredYears("Requires 5 years of experience in QA.")).toBe(5);
  });

  it("extracts a plus-years requirement", () => {
    expect(extractRequiredYears("3+ years of Python required.")).toBe(3);
  });

  it("returns null when no years phrasing is present", () => {
    expect(extractRequiredYears("We are looking for a great engineer.")).toBeNull();
  });
});
