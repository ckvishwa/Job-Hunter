import { describe, expect, it, vi } from "vitest";
import type { JobPosting } from "../../src/adapters/types.js";
import { computeJdContentHash } from "../../src/domain/canonical-job.js";
import { fetchGreenhouseJob, OfficialJobError, parseGreenhouseIdentity, refreshJobFromOfficial } from "../../src/packet/official-job.js";

// Offline: the only boundary substituted is the network.
const BODY = "<p>We are hiring a security analyst to triage alerts, investigate incidents and write clear reports for customers every day. ".repeat(1) + "You will work with engineers in an Agile team, improve detections and document findings. Experience with SIEM tools is helpful for this position and training is provided. We value curiosity, clear writing and careful judgement, and you will be mentored by experienced analysts who review your first investigations with you. The role includes a rotating on-call schedule, regular team retrospectives, and time each week for learning new detection techniques.</p>".repeat(1);
const official = (over: Record<string, unknown> = {}) => ({ id: 42, title: "Security Analyst", absolute_url: "https://acme.example/jobs/42", location: { name: "Remote" }, updated_at: "2026-10-01T00:00:00Z", content: BODY.replace(/</g, "&lt;").replace(/>/g, "&gt;"), ...over });
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as unknown as typeof fetch;
const saved = (over: Partial<JobPosting> = {}): JobPosting => ({ id: "j1", source: "boards", sourceType: "company-careers", company: "Acme", title: "Security Analyst", location: "Remote", remoteType: null, employmentType: null, department: null, requisitionId: "42", postingDate: null, discoveredAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-01T00:00:00Z", canonicalUrl: "https://acme.example/jobs/42", applyUrl: "https://acme.example/jobs/42", descriptionText: "old text", descriptionHtml: null, requiredYears: null, salaryText: null, matchedProfiles: [], discoveredFrom: [], schemaVersion: 1, jdContentHash: "0".repeat(64), extractedAt: "2026-09-01T00:00:00Z", resolutionStatus: "resolved", atsIdentity: "greenhouse:acme:42", rawMetadata: {}, ...over } as JobPosting);

describe("official posting verification", () => {
  it("parses only a Greenhouse identity", () => {
    expect(parseGreenhouseIdentity("greenhouse:acme:42")).toEqual({ board: "acme", jobId: 42 });
    expect(() => parseGreenhouseIdentity("lever:acme:42")).toThrow(OfficialJobError);
    expect(() => parseGreenhouseIdentity(null)).toThrow(OfficialJobError);
  });

  it("requests only the employer's board API for the exact job, read-only", async () => {
    const f = reply(200, official());
    const r = await fetchGreenhouseJob("acme", 42, { fetchImpl: f, now: () => "2026-10-09T00:00:00Z" });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs/42?content=true");
    expect(r.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.fetchedAt).toBe("2026-10-09T00:00:00Z");
  });

  it("reports a closed posting (404) as POSTING_CLOSED, not as an empty job", async () => {
    await expect(fetchGreenhouseJob("acme", 42, { fetchImpl: reply(404, "{}") })).rejects.toMatchObject({ code: "POSTING_CLOSED" });
  });

  it("types network failures, server errors and malformed payloads", async () => {
    const down = vi.fn(async () => { throw new TypeError("network down"); }) as unknown as typeof fetch;
    await expect(fetchGreenhouseJob("acme", 42, { fetchImpl: down })).rejects.toMatchObject({ code: "OFFICIAL_FETCH_FAILED" });
    await expect(fetchGreenhouseJob("acme", 42, { fetchImpl: reply(500, "{}") })).rejects.toMatchObject({ code: "OFFICIAL_FETCH_FAILED" });
    await expect(fetchGreenhouseJob("acme", 42, { fetchImpl: reply(200, "not json") })).rejects.toMatchObject({ code: "OFFICIAL_RESPONSE_INVALID" });
    await expect(fetchGreenhouseJob("acme", 42, { fetchImpl: reply(200, { id: 42 }) })).rejects.toMatchObject({ code: "OFFICIAL_RESPONSE_INVALID" });
  });

  it("rejects a payload for a different job id and an unsafe board token", async () => {
    await expect(fetchGreenhouseJob("acme", 42, { fetchImpl: reply(200, official({ id: 43 })) })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
    await expect(fetchGreenhouseJob("../evil", 42, { fetchImpl: reply(200, official()) })).rejects.toMatchObject({ code: "IDENTITY_MISMATCH" });
  });

  it("rebuilds the saved job from the live JD and flags a changed revision with a new hash", async () => {
    const fetched = await fetchGreenhouseJob("acme", 42, { fetchImpl: reply(200, official()), now: () => "2026-10-09T00:00:00Z" });
    const r = refreshJobFromOfficial(saved(), fetched);
    expect(r.jdChanged).toBe(true);
    expect(r.job.jdContentHash).toBe(computeJdContentHash(r.job.descriptionText));
    expect(r.job.jdContentHash).not.toBe("0".repeat(64));
    expect(r.job.sourceObservations!.at(-1)).toMatchObject({ extractionMethod: "ats-api", observedAt: "2026-10-09T00:00:00Z" });
    // Refreshing again with the same payload is stable: not changed.
    const again = refreshJobFromOfficial(r.job, fetched);
    expect(again.jdChanged).toBe(false);
  });

  it("refuses to refresh when the official title differs (a different posting) or the JD is too short", async () => {
    const other = await fetchGreenhouseJob("acme", 42, { fetchImpl: reply(200, official({ title: "Account Executive" })) });
    expect(() => refreshJobFromOfficial(saved(), other)).toThrow(/different posting/);
    const stub = await fetchGreenhouseJob("acme", 42, { fetchImpl: reply(200, official({ content: "&lt;p&gt;Apply now&lt;/p&gt;" })) });
    expect(() => refreshJobFromOfficial(saved(), stub)).toThrow(/too short/);
  });
});
