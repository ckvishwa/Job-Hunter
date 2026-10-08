import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JobPosting } from "../../src/adapters/types.js";
import { computeJdContentHash } from "../../src/domain/canonical-job.js";
import { OllamaJobSemanticProvider } from "../../src/semantic/ollama-provider.js";
import { parseCanonicalJob } from "../../src/semantic/parse-job.js";
import { buildExtractionCoverage, inventorySource } from "../../src/semantic/source-coverage.js";

// Saved public posting texts (Greenhouse board API) whose qualification headings are inline or marked
// "*Required:" / "Desired:". Expected item lists below are hand-read from the postings, not produced by the code.
const fixture = (name: string) => readFileSync(path.join(__dirname, "../fixtures", name), "utf8");
const EXPEL = fixture("expel-8588028002.jd.txt");
const TWILIO = fixture("twilio-7808464.jd.txt");
const texts = (jd: string, section: string) => inventorySource(jd).items.filter((i) => i.section === section).map((i) => i.text);

describe("inline and marker headings", () => {
  it("Expel: 'What You Should Bring With You' opens the required list and 'Additional notes' closes it", () => {
    expect(texts(EXPEL, "required")).toEqual([
      "Integrity, curiosity, and a client-first mindset.",
      "Strong written communication, you can adapt tone and detail whether you’re messaging a teammate or writing a customer report.",
      "A fundamental understanding of TCP/IP, operating systems, and common network protocols.",
      "Experience with Windows, macOS, and Linux systems, including command-line familiarity.",
      "Awareness of cloud applications (O365, Okta) and cloud infrastructure (AWS, Azure, GCP).",
      "Familiarity with detection and response tools like SIEM, EDR, and IDS/IPS.",
      "A curiosity about attacker techniques, the MITRE ATT&CK framework, and how defenders can outsmart them.",
    ]);
    // An item that calls itself preferred is preferred even inside the required list.
    expect(texts(EXPEL, "preferred")).toEqual([
      "1–2 years of IT or security experience is preferred, but if you’ve got passion, potential, and a compelling story, we want to hear it.",
    ]);
    // Salary, benefits and EEO text after "Additional notes" is not a requirement.
    expect(texts(EXPEL, "required").join(" ")).not.toMatch(/salary|PTO|Equal Opportunity/i);
    expect(texts(EXPEL, "work")).toEqual(["We’re only hiring those authorized to work in the United States.", "We do not currently sponsor immigration visas."]);
  });

  it("Twilio: '*Required:' and 'Desired:' open the required and preferred lists", () => {
    expect(texts(TWILIO, "required")).toEqual([
      "3+ years of experience in a GSOC working environment",
      "Experience with physical safety and security technology, systems (ACS, IDS, VSS, VMS), travel safety, and mass notification tools",
      "Experience with open-source intelligence (OSINT) research tools",
      "Strong critical thinking and problem-solving skills",
      "Proven ability to follow standard operating procedures and playbooks",
      "Ability to prioritize tasks in a fast-paced environment",
      "Ability to stay calm, professional, and think clearly in high-stress situations",
      "Ability to communicate clearly and concisely; verbal and written",
      expect.stringMatching(/^Ability to work .non-standard. shift hours, to overlap as needed .* weekend and holiday hours( English Language Proficiency)?$/),
    ]);
    expect(texts(TWILIO, "preferred").slice(0, 4)).toEqual([
      "Customer service mindset",
      "Comfortable with a high-tech work environment",
      "Eager to learn new tools and processes",
      "Ability to work independently and as part of a team",
    ]);
    expect(texts(TWILIO, "work")).toContain("This role will be remote, but is not eligible to be hired in CA, CT, NJ, NY, PA, WA.");
  });

  it("the Sparksoft inventory is unchanged by the new headings (14 required, 9 preferred)", () => {
    const sparksoft = fixture("sparksoft-5259170007.jd.txt");
    expect([texts(sparksoft, "required").length, texts(sparksoft, "preferred").length]).toEqual([14, 9]);
  });
});

function replayFetch(responses: unknown[]) {
  const queue = [...responses];
  return vi.fn(async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) return Response.json({ models: [{ name: "m", digest: "abc" }] });
    if (u.endsWith("/api/show")) return Response.json({ details: { quantization_level: "Q4_K_M" }, model_info: { "qwen2.context_length": 32768 } });
    if (u.endsWith("/api/ps")) return Response.json({ models: [] });
    if (u.endsWith("/api/generate")) return Response.json({ done: true, load_duration: 1 });
    JSON.parse(init.body);
    const out = queue.length > 1 ? queue.shift() : queue[0];
    return Response.json({ model: "m", done: true, done_reason: "stop", prompt_eval_count: 500, eval_count: 150, message: { content: JSON.stringify(out) } });
  }) as unknown as typeof fetch;
}

function postingFor(jd: string, id: string): JobPosting {
  return {
    id, source: "board-api::greenhouse::test", sourceType: "greenhouse", company: "Test", title: "Analyst", location: "Remote - US", remoteType: null, employmentType: null,
    department: null, requisitionId: "1", postingDate: null, discoveredAt: "2026-10-08T00:00:00.000Z", lastSeenAt: "2026-10-08T00:00:00.000Z",
    canonicalUrl: "https://boards.greenhouse.io/test/jobs/1", applyUrl: "https://boards.greenhouse.io/test/jobs/1", descriptionText: jd, descriptionHtml: null,
    requiredYears: null, salaryText: null, matchedProfiles: ["security"], discoveredFrom: ["board-api"], schemaVersion: 1, jdContentHash: computeJdContentHash(jd),
    extractedAt: "2026-10-08T00:00:00.000Z", resolutionStatus: "resolved", atsIdentity: `greenhouse:test:${id}`, rawMetadata: {},
  } as JobPosting;
}

// A distinct port per test: the provider's lock is keyed by endpoint, and test files run in parallel.
const provider = (responses: unknown[], port: number) =>
  new OllamaJobSemanticProvider({ baseUrl: `http://127.0.0.1:${port}`, model: "m", contextTokens: 8192, outputTokens: 2048, timeoutMs: 1000, fetchImpl: replayFetch(responses) });
const recorded = (name: string) => JSON.parse(fixture(name)) as { jdSha256: string; responses: unknown[] };

describe("extraction on the inline-heading postings (recorded live responses)", () => {
  it("Expel: accepted with 6 required items; the comma-and-'or' item and the years item stay unresolved", async () => {
    const rec = recorded("expel-8588028002.recorded-annotations.json");
    expect(rec.jdSha256).toBe(computeJdContentHash(EXPEL));
    const result = await parseCanonicalJob(postingFor(EXPEL, "expel"), provider(rec.responses, 19021), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.structured.requirements.filter((r) => r.level === "required")).toHaveLength(6);
    const coverage = buildExtractionCoverage({ rawJd: EXPEL, jdHash: computeJdContentHash(EXPEL), structured: result.structured });
    expect(coverage.sections.minimumQualifications).toMatchObject({ sourceItemCount: 7, extractedCount: 6, unresolvedCount: 1 });
    expect(coverage.sections.preferredQualifications).toMatchObject({ sourceItemCount: 1, extractedCount: 0, unresolvedCount: 1 });
  });

  it("Twilio: accepted; 3+ years is a role-scoped minimum; required and desired items are kept apart", async () => {
    const rec = recorded("twilio-7808464.recorded-annotations.json");
    expect(rec.jdSha256).toBe(computeJdContentHash(TWILIO));
    const result = await parseCanonicalJob(postingFor(TWILIO, "twilio"), provider(rec.responses, 19022), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const required = result.structured.requirements.filter((r) => r.level === "required");
    expect(required).toHaveLength(9);
    expect(required.find((r) => r.minimumYears)).toMatchObject({ minimumYears: 3, scope: { kind: "role" } });
    expect(result.structured.requirements.filter((r) => r.level === "preferred").length).toBeGreaterThanOrEqual(5);
  });
});

describe("zero extracted requirements is a failure", () => {
  const BLAND =
    "We are a fast growing company that values curiosity, teamwork and a strong sense of ownership across everything we build for our customers every single day. " +
    "Our people come from many backgrounds and we work hard to make everyone feel welcome, supported and able to do their best work with the tools they need. " +
    "Come and join our team and help us shape the future of how organizations around the world protect what matters most to them and their communities.";

  it("a posting whose qualification sections are not recognized fails as NO_REQUIREMENTS instead of passing as empty", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-zero-"));
    const structuredPath = path.join(dir, "structured.jsonl");
    const failuresPath = path.join(dir, "failures.jsonl");
    const result = await parseCanonicalJob(postingFor(BLAND, "bland"), provider([{ version: 1, annotations: [] }], 19023), { structuredPath, failuresPath });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ category: "SEMANTIC_PARSE_FAILED", code: "NO_REQUIREMENTS", retryable: false });
    expect(existsSync(structuredPath)).toBe(false);
    expect(readFileSync(failuresPath, "utf8")).toContain("NO_REQUIREMENTS");
  });
});
