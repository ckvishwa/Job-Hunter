import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSearchDiscovery } from "../../src/discovery/browser-search.js";
import type { ResolvedSearchTarget } from "../../src/config/search-input.js";
import type { CompanyRegistryEntry } from "../../src/config/schema.js";
import type { EmbeddingResult, LocalTransformerEncoder } from "../../src/nlu/local-transformer.js";
import { FixtureJobSemanticProvider } from "../../src/semantic/provider.js";
import { validateStructuredProposal, STRUCTURED_PARSER_VERSION } from "../../src/domain/structured-job.js";
import { structuredExtractionDigest } from "../../src/decision/evaluate.js";
import { runPipeline, type PipelineArgs } from "../../src/pipeline/run.js";
import { loadJobs } from "../../src/storage/job-store.js";
import { buildDocx } from "../helpers/docx.js";
import { createRunEventLog, readRunEvents } from "../../src/events/run-events.js";
import { closePersistentChrome, launchPersistentChrome } from "../../src/browser/launcher.js";

// Everything here is synthetic and lives in a temporary directory: no private-runtime or candidate file is read,
// so the test runs unchanged on a clean checkout. Employer, title and dates are invented.
const EMPLOYER = "Example Systems Inc";
const TITLE = "QA Analyst";
const DATE_LABEL = "March 2020 – June 2022";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

function approvedFact(factId: string, kind: string, value: string, detail?: string, attrs: Record<string, unknown> = {}) {
  return {
    factId, kind, value, attributes: detail ? { detail, ...attrs } : attrs,
    source: { kind: "user-statement", reference: "offline synthetic fixture" },
    verification: { verifiedBy: "offline test fixture", verifiedAt: "2026-10-07", validUntil: null },
    approvalStatus: "approved", sensitivity: ["legal_name", "email", "phone", "work_authorization", "sponsorship_need"].includes(kind) ? "sensitive" : "normal",
  };
}

function syntheticProfile() {
  return {
    schemaVersion: 1, candidateId: "offline-fixture", profileVersion: "synthetic-e2e-1", updatedAt: "2026-10-07",
    employmentHistoryComplete: null, preferences: {},
    facts: [
      approvedFact("employment-example", "employment", TITLE, "Quality engineering professional experience.", { employer: EMPLOYER, title: TITLE, startDate: "2020-03", endDate: "2022-06", roleTags: ["Quality Engineering", "QA"] }),
      approvedFact("skill-python", "skill", "Python", "Python test automation.", { matchTerms: ["Python"] }),
      approvedFact("name", "legal_name", "Offline Test Applicant"),
      approvedFact("email", "email", "applicant@example.test"),
      approvedFact("auth", "work_authorization", "Yes"),
      approvedFact("sponsor", "sponsorship_need", "No"),
    ],
  };
}

function fakeEncoder(): LocalTransformerEncoder {
  const embed = async (text: string): Promise<EmbeddingResult> => {
    const lower = text.toLowerCase();
    const vector = lower.includes("software development engineer in test") || lower.includes("quality engineering") || lower.includes("sdet") || lower.includes("test automation") || lower.includes("functional and regression")
      ? [1, 0, 0, 0]
      : lower.includes("cybersecurity analyst") ? [0, 1, 0, 0]
        : lower.includes("cloud and platform") ? [0, 0, 1, 0]
          : lower.includes("network and network-security") ? [0, 0, 0, 1]
            : [1, 0, 0, 0];
    return { vector, chunks: [{ text, start: 0, end: text.length, section: null, tokenCount: Math.min(254, text.split(/\s+/).length + 2) }], model: { modelId: "offline-test-prototype", revision: "synthetic", maxSequenceLength: 256, embeddingDimensions: 4, cacheVersion: "test-only" }, runtime: "test-double", device: "cpu", hardware: "synthetic", elapsedMs: 0 };
  };
  return { embed } as unknown as LocalTransformerEncoder;
}

async function readMultipart(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function multipartFileBytes(req: IncomingMessage, body: Buffer): Buffer {
  const boundary = /boundary=([^;]+)/i.exec(req.headers["content-type"] ?? "")?.[1]?.replace(/^"|"$/g, "");
  if (!boundary) throw new Error("Multipart upload did not contain a boundary.");
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"));
  const fileEnd = body.lastIndexOf(Buffer.from(`\r\n--${boundary}`));
  if (headerEnd < 0 || fileEnd <= headerEnd + 4) throw new Error("Multipart file payload was not found.");
  return body.subarray(headerEnd + 4, fileEnd);
}

describe("offline headed discovery-to-form pipeline", () => {
  it("persists one canonical JD, renders sourced PDF, fills and reconciles the local ATS form without submit", async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), "job-hunter-offline-e2e-"));
    let submitRequests = 0;
    let uploadHealthy = false;
    const uploads: Array<{ sha256: string; bytes: number }> = [];
    const uploadMarkup = `<section data-upload-state><label for="resume">Resume (PDF)</label><input id="resume" name="resume" type="file" accept="application/pdf" required></section>`;
    const postingMarkup = `<!doctype html><html><head><title>SDET Engineer | Demo Careers</title></head><body><main><h1>SDET Engineer</h1><h2>About the role</h2><p>Example Corporation is hiring an SDET Engineer. The engineer will create functional and regression tests, validate REST APIs, and investigate defects with the software team. Python is required. Candidates collaborate with engineering and deliver release validation for enterprise applications. This position is junior level and is open to internship, new graduate, and entry-level applicants.</p></main><form id="apply"><label for="name">Full name</label><input id="name" type="text" required><label for="email">Email</label><input id="email" type="email" required><label for="auth">Are you authorized to work in the United States?</label><select id="auth" required><option value="">Choose</option><option>Yes</option><option>No</option></select><label for="sponsor">Will you require sponsorship?</label><select id="sponsor" required><option value="">Choose</option><option>Yes</option><option>No</option></select>${uploadMarkup}<button type="submit">Submit application</button></form><script>
document.querySelector('#apply').addEventListener('submit',e=>{e.preventDefault();fetch('/submit',{method:'POST'});});
document.querySelector('#resume').addEventListener('change',async e=>{const f=e.target.files[0];const d=new FormData();d.append('resume',f,f.name);const r=await fetch('/upload',{method:'POST',body:d});const j=await r.json();const s=document.querySelector('[data-upload-state]');s.dataset.uploadedFileName=f.name;s.dataset.uploadedSha256=j.sha256;});
</script></body></html>`;
    const description = "Example Corporation is hiring an SDET Engineer. The engineer will create functional and regression tests, validate REST APIs, and investigate defects with the software team. Python is required. Candidates collaborate with engineering and deliver release validation for enterprise applications. This position is junior level and is open to internship, new graduate, and entry-level applicants.";
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname === "/careers/search") {
        res.setHeader("content-type", "text/html");
        res.end(`<!doctype html><title>Careers Search</title><form><label for="q">Search for a role</label><input id="q" type="search"><button>Search</button></form><ul id="results"></ul><script>document.querySelector('#q').closest('form').addEventListener('submit',e=>{e.preventDefault();document.querySelector('#results').innerHTML='<li><a href="/job?gh_jid=1234567">SDET Engineer</a><span>Engineering</span><span>Remote</span></li>';});</script>`);
      } else if (url.pathname === "/job") {
        res.setHeader("content-type", "text/html"); res.end(postingMarkup);
      } else if (url.pathname === "/upload" && req.method === "POST") {
        const body = await readMultipart(req); const fileBytes = multipartFileBytes(req, body); const digest = sha(fileBytes); uploads.push({ sha256: digest, bytes: fileBytes.length });
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ sha256: uploadHealthy ? digest : "0".repeat(64) }));
      } else if (url.pathname === "/submit" && req.method === "POST") {
        submitRequests += 1; res.statusCode = 204; res.end();
      } else { res.statusCode = 404; res.end(); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const company = "Example Corporation";
    const entry = {
      company, fortuneRank: null, corporateDomain: "127.0.0.1", careersUrl: `${origin}/careers/search`, careersUrlOriginal: null, careersUrlFinal: null,
      atsType: "greenhouse", atsTenantOrBoardId: "demo", atsWorkdaySite: null, atsWorkdayHostname: null, enabled: true, verificationStatus: "verified", verificationNote: "offline fixture", sourceProvenance: ["offline-test"], lastVerifiedAt: "2026-10-07",
    } as CompanyRegistryEntry;
    const resolved: ResolvedSearchTarget = {
      entry,
      target: {
        company, careersUrl: `${origin}/careers/search`, queries: ["SDET"], maxJobs: 1, registry: "synthetic", selection: { openReview: false, reviewByTeam: true },
        selectors: { searchBoxName: "Search for a role", resultLink: "a[href*='gh_jid']", emptyStateText: "no results", descriptionContainer: "main", descriptionRemove: [] },
      },
    };

    try {
      const syntheticProfilePath = path.join(work, "synthetic-profile.json");
      const profileBytes = Buffer.from(`${JSON.stringify(syntheticProfile(), null, 2)}\n`);
      await writeFile(syntheticProfilePath, profileBytes);
      const upper = (value: Buffer) => sha(value).toUpperCase();
      const pendingPath = path.join(work, "synthetic-pending-facts.json");
      const pendingBytes = Buffer.from(`${JSON.stringify({ synthetic: true, facts: [] })}
`);
      await writeFile(pendingPath, pendingBytes);
      const lanes: Record<string, { resume: string; coverLetter: string; sha256Resume: string; sha256CoverLetter: string }> = {};
      for (const lane of ["cybersecurity", "sdet", "cloud", "network"]) {
        const resumeBytes = buildDocx([`Synthetic ${lane} resume`, `${EMPLOYER}	${DATE_LABEL}`, TITLE]);
        const coverBytes = buildDocx([`Synthetic ${lane} cover letter`]);
        const resume = path.join(work, `${lane}-resume.docx`);
        const coverLetter = path.join(work, `${lane}-cover-letter.docx`);
        await writeFile(resume, resumeBytes);
        await writeFile(coverLetter, coverBytes);
        lanes[lane] = { resume, coverLetter, sha256Resume: upper(resumeBytes), sha256CoverLetter: upper(coverBytes) };
      }
      const registry = {
        version: 1, status: "canonical", candidate: "offline-fixture", lanes,
        candidateProfile: { path: syntheticProfilePath, sha256: upper(profileBytes) },
        pendingFacts: { path: pendingPath, sha256: upper(pendingBytes) },
      };
      const syntheticRegistryPath = path.join(work, "synthetic-registry.json");
      await writeFile(syntheticRegistryPath, `${JSON.stringify(registry, null, 2)}\n`);

      const args: PipelineArgs = {
        mode: "offline", company, searchInput: "local-fixture", maxJobs: 1, dataDir: path.join(work, "data"), evidenceDir: path.join(work, "evidence"), outputDir: path.join(work, "job-specific"),
        profilePath: syntheticProfilePath, registryPath: syntheticRegistryPath, provider: "fixture", jsonModeVerified: false, browserProfileDir: path.join(work, "chrome-form"), headed: true,
      };
      const deps: NonNullable<Parameters<typeof runPipeline>[1]> = {
        encoder: fakeEncoder(),
        formPage: async (url, profileDir) => {
          const context = await launchPersistentChrome(profileDir, { headless: false, args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
          await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
          const page = context.pages()[0] ?? await context.newPage();
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
          return { page, close: () => closePersistentChrome(context, profileDir) };
        },
        discover: async () => {
          const summary = await runSearchDiscovery(resolved, { dataDir: args.dataDir, evidenceDir: args.evidenceDir, typingDelayMs: 0, holdMs: 0, settleTimeoutMs: 5_000, navigationTimeoutMs: 15_000, maxJobs: 1, profileDir: path.join(work, "chrome-search") }, {
            verify: async () => ({ detected: false }), log: () => {},
            launchFn: async (profileDir, launchOptions) => {
              const context = await launchPersistentChrome(profileDir, { ...launchOptions, headless: false, args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
              await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
              return context;
            },
          });
          expect(summary.persistedCount).toBe(1);
          expect(summary.browserClosed).toBe(true);
          expect(summary.queries[0]?.typedValue).toBe("SDET");
          const job = loadJobs(path.join(args.dataDir, "jobs.jsonl"))[0]!;
          const quote = "Python is required.";
          const quoteStart = job.descriptionText.indexOf(quote);
          expect(quoteStart).toBeGreaterThanOrEqual(0);
          const proposal = { requirements: [{ id: "python-required", type: "skill", value: "Python", level: "required", minimumYears: null, scope: { kind: "unspecified", value: null }, groupId: null, evidence: [{ quote, start: quoteStart, end: quoteStart + quote.length }] }], responsibilities: [], constraints: [], alternativeGroups: [] };
          deps.provider = new FixtureJobSemanticProvider({ fixtureSchemaVersion: 1, provenance: "MANUAL_ANNOTATION", annotator: "offline synthetic annotation", annotatedAt: "2026-10-07", entries: [{ sourceJdHash: job.jdContentHash, output: proposal }] }, "offline-e2e");
          const checked = validateStructuredProposal(job.descriptionText, { jobId: job.id, jdHash: job.jdContentHash!, parserVersion: STRUCTURED_PARSER_VERSION, providerRevision: deps.provider.revision, now: '2026-10-07T00:00:00.000Z' }, proposal);
          if (!checked.ok) throw new Error('Synthetic proposal failed production validation.');
          args.reviewPath = path.join(work, "synthetic-review.json");
          await writeFile(args.reviewPath, `${JSON.stringify({ schemaVersion: 1, jobId: job.id, structuredId: checked.job.id, extractionDigest: structuredExtractionDigest(checked.job), jdHash: job.jdContentHash, provenance: "MANUAL_ANNOTATION", coverage: "complete", reviewedBy: "offline synthetic reviewer", reviewedAt: "2026-10-07", omissions: [], notes: "Synthetic fixture only; not a real JD review." }, null, 2)}\n`);
          return { job, searchRunId: summary.runId, browserClosed: summary.browserClosed, evidencePaths: [summary.jobsPath, summary.shortlistPath] };
        },
      };
      const eventsPath = path.join(work, "run-events.jsonl");
      deps.events = createRunEventLog("pipeline", { filePath: eventsPath });
      const failedUpload = await runPipeline(args, deps);
      expect(failedUpload.outcome).toBe("WAITING_FOR_USER");
      expect(failedUpload.extraction.status).toBe("VALIDATED");
      expect(failedUpload.application?.unresolved.join(" ")).toContain("did not confirm its content hash");
      args.jobId = failedUpload.job.id;
      uploadHealthy = true;
      deps.events = createRunEventLog("pipeline", { filePath: eventsPath });
      const result = await runPipeline(args, deps);
      expect(result.outcome).toBe("READY_TO_SUBMIT");
      expect(result.job.title).toBe("SDET Engineer");
      expect(result.lane?.status).toBe("PROPOSED");
      expect(result.lane?.lane).toBe("sdet");
      expect(result.extraction.status).toBe("REUSED");
      expect(result.decision?.outcome).toBe("ELIGIBLE");
      expect(result.decision?.rules.filter((rule) => rule.subject.kind === "requirement").every((rule) => rule.status === "PASS")).toBe(true);
      expect(result.factCandidates.map((fact) => fact.factId)).toContain("skill-python");
      expect(result.artifact?.inspection).toBe("PASS");
      expect(result.artifact?.pageCount).toBeGreaterThan(0);
      expect(result.artifact?.extractedText).toContain(TITLE);
      expect(result.artifact?.extractedText).toContain(EMPLOYER);
      expect(result.artifact?.extractedText).toContain(DATE_LABEL);
      expect(result.artifact?.extractedText).toContain("Python test automation.\nEvidence:");
      expect(result.application?.state).toBe("READY_TO_SUBMIT");
      expect(result.application?.readback.map((item) => item.controlId)).toEqual(expect.arrayContaining(["name", "email", "auth", "sponsor"]));
      expect(uploads).toHaveLength(2);
      expect(uploads.at(-1)?.sha256).toBe(result.artifact?.sha256);
      expect(result.application?.upload?.sha256).toBe(uploads.at(-1)?.sha256);
      expect(submitRequests).toBe(0);
      const records = (await import("node:fs/promises")).readdir(path.dirname(result.applicationRecordPath));
      expect((await records).filter((name) => name.startsWith("application-") && name.endsWith(".json"))).toHaveLength(1);
      const checkpoint = JSON.parse(await readFile(result.checkpointPath, "utf8"));
      expect(checkpoint.stages.search.status).toBe("DONE");
      expect(checkpoint.stages.application.state).toBe("READY_TO_SUBMIT");
      expect(checkpoint.stages.final.submitCount).toBe(0);
      deps.events = createRunEventLog("pipeline", { filePath: eventsPath });
      const rerun = await runPipeline(args, deps);
      expect(rerun.outcome).toBe("READY_TO_SUBMIT");
      // Run events: three runs in write order, each a balanced run.start .. run.end with ordered stages.
      const logged = readRunEvents(eventsPath);
      expect(logged.skippedLines).toBe(0);
      const runIds = [...new Set(logged.events.map((e) => e.runId))];
      expect(runIds).toHaveLength(3);
      const summarize = (runId: string) => logged.events.filter((e) => e.runId === runId && e.kind === "stage.end").map((e) => `${e.stage}:${e.outcome}`);
      expect(summarize(runIds[0]!)).toEqual(["lane:OK", "extraction:VALIDATED", "decision:ELIGIBLE", "resume_plan:OK", "application:OK"]);
      expect(summarize(runIds[1]!)).toEqual(["lane:OK", "extraction:REUSED", "decision:ELIGIBLE", "resume_plan:OK", "application:OK"]);
      expect(summarize(runIds[2]!)).toEqual(["lane:OK", "extraction:REUSED", "decision:ELIGIBLE", "resume_plan:OK"]);
      for (const [i, expectedOutcome] of ["WAITING_FOR_USER", "READY_TO_SUBMIT", "READY_TO_SUBMIT"].entries()) {
        const mine = logged.events.filter((e) => e.runId === runIds[i]);
        expect(mine[0]).toMatchObject({ kind: "run.start", runType: "pipeline" });
        expect(mine.at(-1)).toMatchObject({ kind: "run.end", outcome: expectedOutcome });
        expect(mine.filter((e) => e.kind === "stage.start")).toHaveLength(mine.filter((e) => e.kind === "stage.end").length);
        expect(mine.filter((e) => e.stage).every((e) => e.jobId === result.job.id && e.company === result.job.company)).toBe(true);
      }
      const rawEvents = await readFile(eventsPath, "utf8");
      expect(rawEvents).not.toContain("Python is required");
      expect(rawEvents).not.toContain("applicant@example.test");
      expect(uploads).toHaveLength(2);
      expect(submitRequests).toBe(0);
      expect((await (await import("node:fs/promises")).readdir(path.dirname(rerun.applicationRecordPath))).filter((name) => name.startsWith("application-") && name.endsWith(".json"))).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 180_000);
});
