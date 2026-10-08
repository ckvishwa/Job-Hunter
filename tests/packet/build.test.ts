import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadJobs, saveJobs } from "../../src/storage/job-store.js";
import { appendApproval } from "../../src/packet/approvals.js";
import { buildPacket, type Packet } from "../../src/packet/build.js";
import { main as packetMain } from "../../src/packet/cli.js";
import { buildTrackerRows } from "../../src/tracker/rows.js";
import { buildDashboardSnapshot } from "../../src/dashboard/model.js";
import { AS_OF, SENTINEL_EMAIL, makeWorkspace, type Workspace } from "./helpers/scaffold.js";

// Integration: the packet is built from real artifacts on real temporary storage (saved job, structured job, the
// deterministic decision, a rendered PDF, a resume plan, a pipeline checkpoint, verification and form evidence).
// The substituted boundaries are the LLM (no extraction runs) and the live browser (see form-fill.e2e.test.ts).

const build = (w: Workspace): Promise<Packet> => buildPacket({ jobId: w.jobId, dataDir: w.dataDir, outputDir: w.outputDir, packetRoot: w.packetRoot, profilePath: w.profilePath, asOf: AS_OF, resumePolicyPath: w.policyPath, now: () => "2026-10-09T12:00:00.000Z" });
const bind = (p: Packet, kind: "eligibility" | "resume" | "form" | "final") => {
  const h = p.hashes;
  const all = { jdHash: h.jdHash!, profileDigest: h.profileDigest, resumeSha256: h.resumeSha256!, formFingerprint: h.formFingerprint!, answersDigest: h.answersDigest! };
  const pick = { eligibility: ["jdHash", "profileDigest"], resume: ["jdHash", "resumeSha256"], form: ["jdHash", "formFingerprint", "answersDigest", "resumeSha256"], final: Object.keys(all) }[kind] as Array<keyof typeof all>;
  return Object.fromEntries(pick.map((k) => [k, all[k]]));
};
const approveAll = (w: Workspace, p: Packet) => {
  for (const kind of ["eligibility", "resume", "form", "final"] as const) appendApproval(w.packetDir, { kind, reviewer: "Test Applicant", reviewedAt: "2026-10-09T12:00:00.000Z", bound: bind(p, kind) as never });
};

afterEach(() => vi.restoreAllMocks());

describe("application packet", () => {
  it("writes every required artifact and, with no approvals, stays in a review state", async () => {
    const w = await makeWorkspace();
    const p = await build(w);
    const names = readdirSync(w.packetDir).sort();
    for (const f of ["application-packet.json", "application-packet.md", "eligibility.json", "form-answers.json", "job.json", "requirements.json", "resume-claim-map.json", "review-questions.json", "evidence"]) expect(names).toContain(f);
    expect(readdirSync(path.join(w.packetDir, "evidence"))).toEqual(expect.arrayContaining(["job-description.txt", "official-job-verification.json", "form-evidence.json"]));
    expect(p.readiness.state).toBe("FORM_VERIFIED");
    expect(p.readiness.reviewsOutstanding).toEqual(["eligibility", "resume", "form", "final"]);
    expect(p.submission).toMatchObject({ status: "NOT_SUBMITTED", submitCount: 0 });
    expect(p.counts).toMatchObject({ requiredRequirements: 1, unsupportedClaims: 0 });
    expect(JSON.parse(readFileSync(path.join(w.packetDir, "eligibility.json"), "utf8")).outcome).toBe("ELIGIBLE");
  });

  it("separates verified text clauses, model inference and unknowns, and surfaces JD-stated authorization clauses as questions", async () => {
    const w = await makeWorkspace();
    await build(w);
    const reqs = JSON.parse(readFileSync(path.join(w.packetDir, "requirements.json"), "utf8"));
    expect(reqs.required[0].basis).toBe("INFERENCE");
    const kinds = reqs.jdTextClauses.map((c: { kind: string }) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["work_authorization_required", "sponsorship_unavailable", "minimum_years"]));
    const text = readFileSync(path.join(w.packetDir, "evidence", "job-description.txt"), "utf8");
    for (const c of reqs.jdTextClauses) expect(text.slice(c.start, c.end)).toBe(c.quote); // exact UTF-16 offsets
    const elig = JSON.parse(readFileSync(path.join(w.packetDir, "eligibility.json"), "utf8"));
    expect(elig.jdStatedClausesNeedingApplicantFacts.every((c: { candidateFactStatus: string }) => c.candidateFactStatus === "UNKNOWN")).toBe(true);
    const questions = JSON.parse(readFileSync(path.join(w.packetDir, "review-questions.json"), "utf8")).questions as Array<{ source: string; question: string }>;
    expect(questions.some((q) => q.source === "jd" && /authorized to work/.test(q.question))).toBe(true);
  });

  it("reports required and preferred qualifications separately, and an unmet preferred one never blocks readiness", async () => {
    const w = await makeWorkspace({ extraRequirements: [{ value: "Kubernetes", type: "skill", level: "preferred" }] });
    approveAll(w, await build(w));
    const p = await build(w);
    const reqs = JSON.parse(readFileSync(path.join(w.packetDir, "requirements.json"), "utf8"));
    expect(reqs.required.map((r: { value: string }) => r.value)).toEqual(["Python"]);
    expect(reqs.preferred.map((r: { value: string; decision: { status: string } }) => [r.value, r.decision.status])).toEqual([["Kubernetes", "UNKNOWN"]]);
    expect(p.counts).toMatchObject({ requiredRequirements: 1, preferredRequirements: 1 });
    expect(p.readiness.state).toBe("READY_TO_SUBMIT");
  });

  it("reaches READY_TO_SUBMIT only with all four bound human approvals, and that is still NOT submitted", async () => {
    const w = await makeWorkspace();
    const first = await build(w);
    approveAll(w, first);
    const p = await build(w);
    expect(p.readiness.state).toBe("READY_TO_SUBMIT");
    expect(p.readiness.blockers).toEqual([]);
    expect(p.submission.status).toBe("NOT_SUBMITTED");
    expect(readFileSync(path.join(w.packetDir, "application-packet.md"), "utf8")).toContain("NOT SUBMITTED");
  });

  it("stays out of READY_TO_SUBMIT while coverage is not independently attested, even with every approval", async () => {
    const w = await makeWorkspace({ coverage: "partial" });
    const first = await build(w);
    approveAll(w, first);
    const p = await build(w);
    expect(p.readiness.state).not.toBe("READY_TO_SUBMIT");
    expect(p.readiness.blockers.join(" ")).toContain("REVIEW");
  });

  it("voids approvals and drops out of readiness when the saved job description changes", async () => {
    const w = await makeWorkspace();
    approveAll(w, await build(w));
    expect((await build(w)).readiness.state).toBe("READY_TO_SUBMIT");
    const [job] = loadJobs(w.jobsPath);
    saveJobs(w.jobsPath, [{ ...job!, descriptionText: `${job!.descriptionText} A new paragraph was added.`, jdContentHash: "c".repeat(64) }]);
    const p = await build(w);
    expect(p.readiness.state).not.toBe("READY_TO_SUBMIT");
    expect(p.readiness.validApprovals).toEqual([]);
    expect(p.readiness.invalidatedApprovals.length).toBe(4);
  });

  it("blocks and voids approvals when the resume file is altered after rendering", async () => {
    const w = await makeWorkspace();
    approveAll(w, await build(w));
    appendFileSync(w.pdfPath, "\n% tampered");
    const p = await build(w);
    expect(p.readiness.state).toBe("BLOCKED");
    expect(p.readiness.validApprovals).not.toContain("resume");
    expect(JSON.parse(readFileSync(path.join(w.packetDir, "resume-claim-map.json"), "utf8")).artifactNote).toContain("changed after rendering");
  });

  it("changes in the candidate profile void the eligibility approval", async () => {
    const w = await makeWorkspace();
    approveAll(w, await build(w));
    const prof = JSON.parse(readFileSync(w.profilePath, "utf8"));
    prof.profileVersion = "changed.2";
    prof.facts.push({ ...prof.facts[1], factId: "f-extra", kind: "skill", value: "Selenium", attributes: {} });
    writeFileSync(w.profilePath, JSON.stringify(prof));
    const p = await build(w);
    expect(p.readiness.validApprovals).not.toContain("eligibility");
    expect(p.readiness.state).toBe("BLOCKED");
  });

  it("keeps applicant values out of the report, packet summary, requirements, eligibility and review questions", async () => {
    const w = await makeWorkspace();
    approveAll(w, await build(w));
    await build(w);
    for (const f of ["application-packet.md", "application-packet.json", "requirements.json", "eligibility.json", "review-questions.json", "job.json"]) {
      expect(readFileSync(path.join(w.packetDir, f), "utf8"), f).not.toContain(SENTINEL_EMAIL);
    }
    // The values appear only where the applicant reviews them, in the private answers file.
    expect(readFileSync(path.join(w.packetDir, "form-answers.json"), "utf8")).toContain(SENTINEL_EMAIL);
  });

  it("makes no network request while building", async () => {
    const w = await makeWorkspace();
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
    await build(w);
    expect(spy).not.toHaveBeenCalled();
  });

  it("flags a resume when excluded experience appears in the rendered text", async () => {
    const w = await makeWorkspace();
    writeFileSync(w.policyPath, JSON.stringify({ excludedTerms: ["Python test scripts"] }));
    const p = await build(w);
    expect(p.counts.unsupportedClaims).toBeGreaterThan(0);
    expect(p.readiness.state).toBe("BLOCKED");
  });
});

describe("tracker and dashboard show the truthful packet state", () => {
  it("shows the packet readiness only for the matching JD revision", async () => {
    const w = await makeWorkspace();
    const p = await build(w);
    const rows = () => buildTrackerRows({ jobsPath: w.jobsPath, outputDir: w.outputDir, packetsDir: w.packetRoot }).rows;
    expect(rows()[0]).toMatchObject({ state: p.readiness.state });
    expect(rows()[0]!.blockingReason).not.toBe("");
    const snapshot = buildDashboardSnapshot({ dataDir: w.dataDir, outputDir: w.outputDir, packetsDir: w.packetRoot });
    expect(snapshot.funnel.find((f) => f.stage === "FORM_VERIFIED")!.count).toBe(1);
    expect(snapshot.jobs[0]!.state).toBe("FORM_VERIFIED");
    // A different JD revision must not inherit the old packet's state.
    const [job] = loadJobs(w.jobsPath);
    saveJobs(w.jobsPath, [{ ...job!, jdContentHash: "d".repeat(64) }]);
    const stale = buildTrackerRows({ jobsPath: w.jobsPath, outputDir: w.outputDir, packetsDir: w.packetRoot }).rows.find((r) => r.jdHash === "d".repeat(64))!;
    expect(stale.state).toBe("RESOLVED");
    expect(stale.blockingReason).toContain("different job description revision");
  });
});

describe("packet CLI approval safety", () => {
  const run = (w: Workspace, args: string[]) => packetMain(["approve", "--job-id", w.jobId, "--data-dir", w.dataDir, "--output-dir", w.outputDir, "--packet-root", w.packetRoot, "--profile", w.profilePath, "--policy", w.policyPath, ...args], () => {});

  it("refuses to record an approval without the explicit review confirmation or a reviewer", async () => {
    const w = await makeWorkspace();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(w, ["--kind", "resume", "--reviewer", "Test Applicant"])).toBe(1);
    expect(await run(w, ["--kind", "resume", "--confirm", "I-HAVE-REVIEWED-THIS"])).toBe(1);
    expect(readdirSync(w.packetDir)).not.toContain("approvals.json");
  });

  it("records an approval bound to the current hashes when the applicant confirms, and refuses to approve a resume with unsupported claims", async () => {
    const w = await makeWorkspace();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(w, ["--kind", "resume", "--reviewer", "Test Applicant", "--confirm", "I-HAVE-REVIEWED-THIS"])).toBe(0);
    const saved = JSON.parse(readFileSync(path.join(w.packetDir, "approvals.json"), "utf8")).approvals;
    expect(saved).toHaveLength(1);
    expect(saved[0].bound.resumeSha256).toMatch(/^[0-9a-f]{64}$/);
    // Now make the resume unsupported and try again.
    writeFileSync(w.policyPath, JSON.stringify({ excludedTerms: ["Python test scripts"] }));
    expect(await run(w, ["--kind", "resume", "--reviewer", "Test Applicant", "--confirm", "I-HAVE-REVIEWED-THIS"])).toBe(1);
    expect(JSON.parse(readFileSync(path.join(w.packetDir, "approvals.json"), "utf8")).approvals).toHaveLength(1);
  });
});
