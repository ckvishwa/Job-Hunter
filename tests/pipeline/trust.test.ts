import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CandidateFact } from "../../src/domain/candidate-profile.js";
import { loadVerifiedInputs, protectedEmploymentOf } from "../../src/pipeline/trust.js";
import { fact, profile } from "../helpers/decision-fixtures.js";
import { buildDocx } from "../helpers/docx.js";

// Synthetic employer/title/dates only. The protected employment identity must come from the approved
// profile, never from constants in the source, and every canonical lane resume must carry it.
const job = (over: Record<string, unknown> = {}, pending = false): CandidateFact =>
  fact({ factId: "emp-1", kind: "employment", value: "QA Analyst", pending, attributes: { employer: "Example Systems Inc", title: "QA Analyst", startDate: "2020-03", endDate: "2022-06", roleTags: ["QA"], ...over } });

describe("protectedEmploymentOf", () => {
  it("derives the label from the fact's own months, with Present for a current job", () => {
    const [closed, current] = protectedEmploymentOf([job(), fact({ factId: "emp-2", kind: "employment", value: "SDET", attributes: { employer: "Other LLC", title: "SDET", startDate: "2022-07", endDate: null } })]);
    expect(closed).toMatchObject({ factId: "emp-1", employer: "Example Systems Inc", title: "QA Analyst", dateLabel: "March 2020 – June 2022", roleTags: ["QA"] });
    expect(current).toMatchObject({ dateLabel: "July 2022 – Present", roleTags: [] });
  });

  it("ignores non-employment facts and employment facts missing employer, title or start month", () => {
    const incomplete = fact({ factId: "emp-3", kind: "employment", value: "x", attributes: { employer: "NoTitle Co", startDate: "2020-01" } });
    expect(protectedEmploymentOf([fact({ factId: "s-1", kind: "skill", value: "Python" }), incomplete])).toEqual([]);
  });
});

describe("loadVerifiedInputs", () => {
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").toUpperCase();

  function setup(opts: { facts?: CandidateFact[]; resumeParagraphs?: (lane: string) => string[] } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), "job-hunter-trust-"));
    const write = (name: string, bytes: Buffer) => { const p = path.join(dir, name); writeFileSync(p, bytes); return { path: p, sha: sha(bytes) }; };
    const profileFile = write("profile.json", Buffer.from(JSON.stringify(profile(opts.facts ?? [job()]))));
    const pending = write("pending.json", Buffer.from("{}"));
    const lanes: Record<string, unknown> = {};
    for (const lane of ["cybersecurity", "sdet", "cloud", "network"]) {
      const resume = write(`${lane}.docx`, buildDocx(opts.resumeParagraphs?.(lane) ?? [`Example Systems Inc\tMarch 2020 – June 2022`, "QA Analyst"]));
      const cover = write(`${lane}-cover.docx`, buildDocx(["Cover letter"]));
      lanes[lane] = { resume: resume.path, coverLetter: cover.path, sha256Resume: resume.sha, sha256CoverLetter: cover.sha };
    }
    const registry = write("registry.json", Buffer.from(JSON.stringify({ version: 1, status: "canonical", candidate: "synthetic", lanes, candidateProfile: { path: profileFile.path, sha256: profileFile.sha }, pendingFacts: { path: pending.path, sha256: pending.sha } })));
    return { dir, registryPath: registry.path, profilePath: profileFile.path };
  }
  const load = (s: ReturnType<typeof setup>) => loadVerifiedInputs({ registryPath: s.registryPath, profilePath: s.profilePath, asOf: "2026-10-01" });

  it("accepts a profile and canonical resumes that agree, and exposes the protected employment", () => {
    const inputs = load(setup());
    expect(inputs.protectedEmployment.map((e) => e.dateLabel)).toEqual(["March 2020 – June 2022"]);
    expect(Object.keys(inputs.laneFiles).sort()).toEqual(["cloud", "cybersecurity", "network", "sdet"]);
  });

  it("rejects a profile with no approved current employment fact (a pending one does not count)", () => {
    expect(() => load(setup({ facts: [job({}, true)] }))).toThrow(/at least one approved, current employment fact/);
    expect(() => load(setup({ facts: [fact({ factId: "s-1", kind: "skill", value: "Python" })] }))).toThrow(/at least one approved/);
  });

  it("rejects a canonical resume that lacks the employer, the title or the dates from the profile", () => {
    expect(() => load(setup({ resumeParagraphs: () => ["Other Company\tMarch 2020 – June 2022", "QA Analyst"] }))).toThrow(/missing the protected employment identity/);
    expect(() => load(setup({ resumeParagraphs: () => ["Example Systems Inc\tMarch 2020 – June 2022", "Tester"] }))).toThrow(/missing the protected employment identity/);
    expect(() => load(setup({ resumeParagraphs: (lane) => [`Example Systems Inc\t${lane === "cloud" ? "March 2019" : "March 2020"} – June 2022`, "QA Analyst"] }))).toThrow(/cloud canonical resume is missing/);
  });

  it("accepts a hyphen between the dates and rejects a tampered profile by hash", () => {
    expect(() => load(setup({ resumeParagraphs: () => ["Example Systems Inc, March 2020 - June 2022", "QA Analyst"] }))).not.toThrow();
    const s = setup();
    writeFileSync(s.profilePath, JSON.stringify(profile([job({ employer: "Tampered Co" })])));
    expect(() => load(s)).toThrow(/hash mismatch/);
  });
});
