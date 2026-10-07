import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JobPosting } from "../../src/adapters/types.js";
import { runDecide } from "../../src/decision/cli.js";
import { computeJdContentHash } from "../../src/domain/canonical-job.js";
import { parseCanonicalJob } from "../../src/semantic/parse-job.js";
import { FixtureJobSemanticProvider } from "../../src/semantic/provider.js";
import { saveJobs } from "../../src/storage/job-store.js";
import { loadDecisions } from "../../src/storage/decision-store.js";
import { fact, profile, review } from "../helpers/decision-fixtures.js";

// Production decide command over real temp files: a saved job, a StructuredJob produced by the production
// parse-jd boundary from a stored (manual) annotation, a candidate profile file and an extraction review.
// Substituted boundary: the semantic provider is the fixture provider; no model is involved.

const JD = "Acme builds payment systems. We need a QA engineer. You must know Python. Familiarity with Kubernetes is a plus. Pay is competitive and benefits are listed below.";
const REQUIRED = "You must know Python.";
const PLUS = "Familiarity with Kubernetes is a plus.";

function annotation(jd: string, hash: string) {
  const span = (quote: string) => ({ quote, start: jd.indexOf(quote), end: jd.indexOf(quote) + quote.length });
  return {
    sourceJdHash: hash,
    requirements: [
      { id: "r1", type: "language", value: "Python", level: "required", evidence: [span(REQUIRED)] },
      { id: "r2", type: "tool", value: "Kubernetes", level: "preferred", evidence: [span(PLUS)] },
    ],
  };
}

function savedJob(jd = JD, over: Partial<JobPosting> = {}): JobPosting {
  return {
    id: "d3d33fcaf016628e",
    source: "company-careers::acme",
    sourceType: "company-careers",
    company: "Acme",
    title: "SDET II",
    location: "Remote",
    remoteType: null,
    employmentType: null,
    department: null,
    requisitionId: "1",
    postingDate: null,
    discoveredAt: "2026-10-07T10:00:00.000Z",
    lastSeenAt: "2026-10-07T10:00:00.000Z",
    canonicalUrl: "https://boards.greenhouse.io/acme/jobs/1",
    applyUrl: "https://boards.greenhouse.io/acme/jobs/1",
    descriptionText: jd,
    descriptionHtml: null,
    requiredYears: null,
    salaryText: null,
    matchedProfiles: ["sdet"],
    discoveredFrom: ["company-careers"],
    schemaVersion: 1,
    jdContentHash: computeJdContentHash(jd),
    extractedAt: "2026-10-07T10:00:00.000Z",
    resolutionStatus: "resolved",
    atsIdentity: "greenhouse:acme:1",
    rawMetadata: {},
    ...over,
  };
}

async function setup(jd = JD) {
  const dir = mkdtempSync(path.join(tmpdir(), "jh-decide-"));
  const job = savedJob(jd);
  saveJobs(path.join(dir, "jobs.jsonl"), [job]);
  const provider = new FixtureJobSemanticProvider(
    { fixtureSchemaVersion: 1, provenance: "MANUAL_ANNOTATION", annotator: "test", annotatedAt: "2026-10-07", entries: [{ sourceJdHash: job.jdContentHash, output: annotation(jd, job.jdContentHash!) }] },
    "seed",
  );
  const parsed = await parseCanonicalJob(job, provider, { structuredPath: path.join(dir, "structured-jobs.jsonl") });
  expect(parsed.ok).toBe(true);
  const write = (name: string, value: unknown) => {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify(value, null, 2));
    return file;
  };
  const python = fact({ factId: "f-python", kind: "skill", value: "Python" });
  return { dir, job, write, profileFile: write("profile.json", profile([python])), reviewFile: write("review.json", review({ jdHash: job.jdContentHash! })), python };
}

const args = (s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) => ({ dataDir: s.dir, job: "greenhouse:acme:1", profile: s.profileFile, review: s.reviewFile, asOf: "2026-10-07", json: false, ...over });
const run = async (a: ReturnType<typeof args>) => {
  const lines: string[] = [];
  const code = await runDecide(a, (l) => lines.push(l));
  return { code, text: lines.join("\n") };
};

describe("decide command", () => {
  it("evaluates a saved job against approved facts, stores a derived decision and never touches jobs.jsonl or structured data", async () => {
    const s = await setup();
    const jobsBefore = readFileSync(path.join(s.dir, "jobs.jsonl"));
    const structuredBefore = readFileSync(path.join(s.dir, "structured-jobs.jsonl"));
    const { code, text } = await run(args(s));

    expect(code).toBe(0);
    expect(text).toContain("Decision: ELIGIBLE");
    expect(text).toContain("MANUAL_ANNOTATION");
    expect(text).toContain("facts: f-python");
    expect(text).toContain('evidence [');
    const [decision] = loadDecisions(path.join(s.dir, "decisions.jsonl"));
    expect(decision).toMatchObject({ outcome: "ELIGIBLE", jobId: s.job.id, jdHash: s.job.jdContentHash, profileVersion: "test.1", policyVersion: "decision-policy@1" });
    expect(decision!.rules.map((r) => [r.ruleId, r.status])).toEqual([["req:r1", "PASS"], ["req:r2", "UNKNOWN"], ["coverage:extraction", "PASS"]]);
    expect(readFileSync(path.join(s.dir, "jobs.jsonl")).equals(jobsBefore)).toBe(true);
    expect(readFileSync(path.join(s.dir, "structured-jobs.jsonl")).equals(structuredBefore)).toBe(true);
  });

  it("a title MATCH plays no part: changing the saved title and matched profiles changes nothing, and a MATCH title with no approved facts is still REVIEW", async () => {
    const s = await setup();
    const withFacts = await run(args(s));
    expect(withFacts.code).toBe(0);
    const first = loadDecisions(path.join(s.dir, "decisions.jsonl"))[0]!;

    saveJobs(path.join(s.dir, "jobs.jsonl"), [savedJob(JD, { title: "Totally Different Title", matchedProfiles: [], relevanceReason: "none" })]);
    await run(args(s));
    const again = loadDecisions(path.join(s.dir, "decisions.jsonl"));
    expect(again).toHaveLength(1); // same key: same inputs
    expect({ ...again[0]!, evaluatedAt: "" }).toEqual({ ...first, evaluatedAt: "" });

    // "SDET II" is a MATCH title (title targeting), yet with zero approved facts the decision is REVIEW.
    const empty = s.write("empty-profile.json", profile([]));
    const { text } = await run(args(s, { profile: empty }));
    expect(text).toContain("Decision: REVIEW");
    expect(text).toContain("title targeting and MATCH results play no part");
  });

  it("is idempotent for identical inputs and appends a new record, flagging the old one stale, when the profile changes", async () => {
    const s = await setup();
    await run(args(s));
    await run(args(s));
    expect(loadDecisions(path.join(s.dir, "decisions.jsonl"))).toHaveLength(1);

    const edited = s.write("profile-edited.json", profile([s.python, fact({ factId: "f-k8s", kind: "skill", value: "Kubernetes" })], { profileVersion: "test.2" }));
    const { text } = await run(args(s, { profile: edited }));
    expect(text).toContain("is stale: the candidate profile changed");
    const all = loadDecisions(path.join(s.dir, "decisions.jsonl"));
    expect(all).toHaveLength(2);
    expect(all.map((d) => d.profileVersion).sort()).toEqual(["test.1", "test.2"]);
    expect(all.find((d) => d.profileVersion === "test.2")!.counts.preferred.pass).toBe(1);
  });

  it("does not call another candidate's decision stale", async () => {
    const s = await setup();
    await run(args(s));
    const other = s.write("other.json", profile([s.python], { candidateId: "someone-else" }));
    const { text } = await run(args(s, { profile: other }));
    expect(text).not.toContain("is stale");
    expect(loadDecisions(path.join(s.dir, "decisions.jsonl"))).toHaveLength(2);
  });

  it("refuses to decide a job whose JD changed after it was parsed, and writes nothing", async () => {
    const s = await setup();
    const editedJd = `${JD} Updated posting text.`;
    saveJobs(path.join(s.dir, "jobs.jsonl"), [savedJob(editedJd)]);
    const { code, text } = await run(args(s));
    expect(code).toBe(2);
    expect(text).toContain("none for its current JD revision");
    expect(existsSync(path.join(s.dir, "decisions.jsonl"))).toBe(false);
  });

  it("fails clearly with no structured extraction, an unknown job, missing arguments, or an invalid profile or review", async () => {
    const s = await setup();
    const bare = mkdtempSync(path.join(tmpdir(), "jh-decide-bare-"));
    saveJobs(path.join(bare, "jobs.jsonl"), [savedJob()]);
    expect((await run({ ...args(s), dataDir: bare })).text).toContain("No validated structured extraction exists");

    expect((await run(args(s, { job: "nope" }))).code).toBe(2);
    expect((await runDecide({ dataDir: s.dir, json: false }, vi.fn()))).toBe(2);

    const badProfile = s.write("bad-profile.json", { schemaVersion: 1, candidateId: "c", profileVersion: "v", updatedAt: "2026-01-01", facts: [{ factId: "x", kind: "skill", value: "Python", approvalStatus: "approved" }] });
    const bad = await run(args(s, { profile: badProfile }));
    expect(bad.code).toBe(2);
    expect(bad.text).toContain("candidate profile is not valid");

    const badReview = s.write("bad-review.json", { jdHash: "short" });
    expect((await run(args(s, { review: badReview }))).text).toContain("extraction review is not valid");
    expect(existsSync(path.join(s.dir, "decisions.jsonl"))).toBe(false);
  });

  it("a pending-only profile (as the resume importer produces) can never produce ELIGIBLE", async () => {
    const s = await setup();
    const pendingOnly = s.write("pending.json", profile([fact({ factId: "f-python", kind: "skill", value: "Python", pending: true })]));
    const { text } = await run(args(s, { profile: pendingOnly }));
    expect(text).toContain("Decision: REVIEW");
    expect(text).toContain("pending approval");
  });

  it("--json prints the full decision", async () => {
    const s = await setup();
    const { text } = await run(args(s, { json: true }));
    expect(JSON.parse(text.slice(0, text.lastIndexOf("}") + 1))).toMatchObject({ outcome: "ELIGIBLE", schemaVersion: 1 });
  });
});
