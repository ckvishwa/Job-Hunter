import { describe, expect, it } from "vitest";
import { apiErrorBody, classifyNetworkFailure, classifyResponse } from "../../web/src/lib/errors.js";

describe("API failure classification (drives the dashboard's distinct error states)", () => {
  it("treats the API's own JSON error as the API speaking, with its code", () => {
    const e = classifyResponse({ status: 409, json: { error: { code: "STALE_SELECTION", message: "Stale." } } });
    expect([e.kind, e.code, e.status]).toEqual(["client", "STALE_SELECTION", 409]);
  });

  it("401 is unauthenticated, with or without a body", () => {
    expect(classifyResponse({ status: 401, json: { error: { code: "UNAUTHENTICATED", message: "Sign in first." } } }).kind).toBe("unauthenticated");
    expect(classifyResponse({ status: 401, json: null }).kind).toBe("unauthenticated");
  });

  it("a 5xx with no API error body (the dev proxy's answer when the API is down) is unavailable, not a server bug", () => {
    for (const status of [500, 502, 503, 504]) expect(classifyResponse({ status, json: null }).kind).toBe("unavailable");
    expect(classifyResponse({ status: 500, json: "plain text" }).kind).toBe("unavailable");
    expect(classifyResponse({ status: 500, json: { unrelated: true } }).kind).toBe("unavailable");
  });

  it("a 5xx WITH the API's JSON body is a genuine server error", () => {
    const e = classifyResponse({ status: 500, json: { error: { code: "INTERNAL_ERROR", message: "Something went wrong." } } });
    expect([e.kind, e.code]).toEqual(["server", "INTERNAL_ERROR"]);
  });

  it("a gateway status is unavailable even if a body is present", () => {
    expect(classifyResponse({ status: 503, json: { error: { code: "X", message: "y" } } }).kind).toBe("unavailable");
  });

  it("a thrown fetch is offline when the browser says so, otherwise unavailable", () => {
    expect(classifyNetworkFailure(false).kind).toBe("offline");
    expect(classifyNetworkFailure(true).kind).toBe("unavailable");
  });

  it("only reads a well-formed error object", () => {
    expect(apiErrorBody({ error: { code: 1, message: "x" } })).toBeNull();
    expect(apiErrorBody({ error: "nope" })).toBeNull();
    expect(apiErrorBody(null)).toBeNull();
    expect(apiErrorBody({ error: { code: "A", message: "b" } })).toEqual({ code: "A", message: "b" });
  });
});
