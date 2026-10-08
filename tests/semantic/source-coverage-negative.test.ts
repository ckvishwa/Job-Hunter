import { describe, expect, it } from "vitest";
import { inventorySource } from "../../src/semantic/source-coverage.js";

describe("source-grounded negative extraction cases v1", () => {
  it("keeps a mandatory years clause under Required Skills and Experience", () => {
    const jd = "Required Skills and Experience:\n* 2+ years building production threat intelligence pipelines.\n* Python development in production.";
    const items = inventorySource(jd).items;
    expect(items.filter(item => item.section === "required")).toHaveLength(2);
    expect(items[0]?.text).toContain("2+ years");
    expect(items[0]?.boundary).toBe("explicit");
  });

  it("does not absorb a mandatory authorization restriction into preferred skills", () => {
    const jd = "Preferred qualifications:\n* Familiarity with cloud security.\nWork arrangements:\n* Applicants must be authorized to work in the United States without sponsorship.";
    const items = inventorySource(jd).items;
    expect(items.find(item => item.text.includes("without sponsorship"))?.section).toBe("work");
    expect(items.find(item => item.text.includes("without sponsorship"))?.boundary).toBe("explicit");
  });
  it("stops a required list before the position identifier and pay notice", () => {
    const jd = "Required Skills and Experience:\n- Uses AI responsibly.\nPosition ID: P78174\nPay Transparency Notice: Compensation varies by location.";
    const required = inventorySource(jd).items.filter(item => item.section === "required");
    expect(required).toHaveLength(1);
    expect(required[0]?.text).toBe("Uses AI responsibly.");
  });
});
