import { describe, expect, it, vi } from "vitest";
import { resolveAdapter } from "../../src/adapters/registry.js";
import type { SiteConfig } from "../../src/types.js";

function site(overrides: Partial<SiteConfig>): SiteConfig {
  return {
    id: "s",
    name: "S",
    url: "https://example.com",
    adapter: "greenhouse",
    enabled: true,
    ...overrides,
  };
}

describe("resolveAdapter", () => {
  it("resolves greenhouse", () => {
    expect(resolveAdapter(site({ adapter: "greenhouse" })).sourceType).toBe("greenhouse");
  });

  it("resolves lever", () => {
    expect(resolveAdapter(site({ adapter: "lever" })).sourceType).toBe("lever");
  });

  it("resolves workday", () => {
    expect(resolveAdapter(site({ adapter: "workday" })).sourceType).toBe("workday");
  });

  it("resolves generic when deps are provided", () => {
    const deps = { context: { newPage: vi.fn() } as never };
    expect(resolveAdapter(site({ adapter: "generic" }), deps).sourceType).toBe("generic");
  });

  it("throws for generic without deps", () => {
    expect(() => resolveAdapter(site({ adapter: "generic" }))).toThrow(/requires a browser context/);
  });
});
