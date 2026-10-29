import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CandidateRepo } from "../src/db/candidate-repo.js";
import { JobsRepo, type PersistItem } from "../src/db/jobs-repo.js";
import { createPool, DEFAULT_ENV_FILE, loadEnvFile, pgSettingsFromEnv } from "../src/db/pool.js";
import { toPersistItem } from "../src/discovery/collection/postgres-items.js";
import { classifyBoardFailure, confirmOwnership, loadLiveBoards, selectBatches, type LiveBoard, type Ownership } from "../src/discovery/live-print/boards.js";
import { assessQaJob, isQaTitle } from "../src/discovery/live-print/qa-rank.js";
import { ALL_ATS, locationVerdict, partitionShortlist, summarizeCoverage, type BoardOutcome } from "../src/discovery/live-print/report.js";
import { evaluatePersistable, stampResolution } from "../src/domain/canonical-job.js";
import { buildEvidenceCorpus } from "../src/match/evidence.js";
import { runMatch } from "../src/match/pipeline.js";
import { decideMatch } from "../src/match/intelligence.js";
import { RulesJobSemanticProvider } from "../src/match/rules-provider.js";
import { postingFromStoredJob } from "../src/match/jd-source.js";
import { boardApiUrl, fetchBoardPostings, registryEntryFor, toPosting } from "../src/pipeline/discovery/board-discoverer.js";
import type { DiscoveryPlan } from "../src/jobs/planner.js";

// Live, read-only ATS feed retrieval in small configured batches; persistence uses the S3 canonical PostgreSQL repository.
// A board is persisted only after its employer-to-ATS relationship is confirmed (see src/discovery/live-print/boards.ts).
// Usage: npm run live-jobs -- [--batch baseline,qa-1] [--max-boards 20] [--limit 20] [--config config/live-boards.json] [--delay-ms 600]
const OUT = path.resolve("output/m5.2-live-jobs.json");
const iso = () => new Date().toISOString();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function intArg(name: string, fallback: number, min: number, max: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  return n;
}

async function verifyUrl(url: string): Promise<{ status: number | null; finalUrl: string | null; checkedAt: string; error?: string }> {
  const checkedAt = iso();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal, headers: { accept: "text/html,application/xhtml+xml" } });
    await response.arrayBuffer();
    return { status: response.status, finalUrl: response.url, checkedAt };
  } catch (error) {
    return { status: null, finalUrl: null, checkedAt, error: error instanceof Error ? error.name : "fetch failed" };
  } finally { clearTimeout(timer); }
}

async function mapLimit<T, R>(rows: T[], width: number, fn: (row: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(rows.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, rows.length) }, async () => { while (true) { const i = next++; if (i >= rows.length) return; out[i] = await fn(rows[i]!); } }));
  return out;
}

function locationCondition(text: string): string[] {
  const m = text.match(/.{0,80}\b(remote in [A-Za-z ]+|must be located in [A-Za-z ,]+|must reside in [A-Za-z ,]+|work from (?:the )?(?:office|location)[^.!\n]{0,60})/i);
  return m ? [m[0].replace(/\s+/g, " ").trim()] : [];
}

const ok2xx3xx = (status: number | null) => status !== null && status >= 200 && status < 400;

async function main(): Promise<void> {
  const limit = intArg("limit", 20, 1, 100);
  const maxBoards = intArg("max-boards", 20, 1, 40);
  const delayMs = intArg("delay-ms", 600, 0, 10_000);
  const batchNames = arg("batch")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
  const boards = selectBatches(loadLiveBoards(path.resolve(arg("config") ?? "config/live-boards.json")), batchNames, maxBoards);

  if (!loadEnvFile(DEFAULT_ENV_FILE)) throw new Error("infra/.env missing; refusing to use an alternate database.");
  const pool = createPool(pgSettingsFromEnv(), { max: 5, connectTimeoutMs: 15_000 });
  const errors: string[] = [];
  try {
    const candidates = new CandidateRepo(pool);
    const user = await candidates.findUser(process.env.JH_USER_HANDLE ?? "local");
    if (!user) throw new Error("Expected existing candidate handle 'local' was not found; refusing to create candidate data.");
    const jobsRepo = new JobsRepo(pool);
    const dbIdentity = (await pool.query<{ db: string; host: string | null }>("SELECT current_database() AS db, inet_server_addr()::text AS host")).rows[0]!;
    const before = Number((await pool.query("SELECT count(*)::int AS n FROM jobs")).rows[0]!.n);

    // ---- 1. ownership + retrieval, one board at a time with failure isolation ----
    const fetchedAt = iso();
    const outcomes: BoardOutcome[] = [];
    const boardRecords: Array<{ board: LiveBoard; ownership: Ownership; providerHttpStatus: number | null; listings: number; qaCandidates: number; failure: BoardOutcome["failure"] }> = [];
    const itemsByBoard = new Map<string, PersistItem[]>();
    const rejected: Array<{ board: string; requisitionId: string; title: string; reason: string }> = [];
    const urlStatus = new Map<string, boolean>();
    for (const [index, entry] of boards.entries()) {
      if (index > 0) await sleep(delayMs);
      const boardKey = `${entry.ats}:${entry.board}`;
      const outcome: BoardOutcome = { company: entry.company, ats: entry.ats, board: entry.board, ownership: "UNCONFIRMED", failure: null, listings: 0, qaCandidates: 0, canonicalJobs: 0, fullJds: 0, urlsVerified: 0 };
      let providerHttpStatus: number | null = null;
      let ownership: Ownership = { status: "UNCONFIRMED", method: "none", detail: "not checked" };
      try {
        ownership = await confirmOwnership(entry, fetch);
        outcome.ownership = ownership.status;
        if (ownership.status !== "CONFIRMED") {
          outcome.failure = { kind: "UNCONFIRMED_OWNER", detail: ownership.detail };
        } else {
          const rows = await fetchBoardPostings(entry, async (input, init) => {
            const response = await fetch(input, init);
            if (String(input) === boardApiUrl(entry)) providerHttpStatus = response.status;
            return response;
          }, 30_000);
          outcome.listings = rows.length;
          const qaRows = rows.filter((r) => isQaTitle(r.title));
          outcome.qaCandidates = qaRows.length;
          const checks = await mapLimit(qaRows, 4, (r) => verifyUrl(r.url));
          const items: PersistItem[] = [];
          for (const [i, r] of qaRows.entries()) {
            const checked = checks[i]!;
            urlStatus.set(`${entry.ats}:${entry.board}:${r.externalId}`, ok2xx3xx(checked.status));
            if (ok2xx3xx(checked.status)) outcome.urlsVerified += 1;
            if (!r.descriptionText.trim()) { rejected.push({ board: boardKey, requisitionId: r.externalId, title: r.title, reason: "EMPTY_DESCRIPTION" }); continue; }
            outcome.fullJds += 1;
            const posting = toPosting(entry, r, [], [], "", fetchedAt);
            const stamped = stampResolution(posting, { sourceKind: "m52-live-ats-api", observedUrl: r.url, observedAt: fetchedAt, finalUrl: r.url,
              extractionMethod: "ats-api", discoveredCompany: entry.company, registryEntry: registryEntryFor(entry), apiJobId: r.externalId, now: fetchedAt });
            const gate = evaluatePersistable(stamped);
            const item = gate.ok ? toPersistItem(gate.posting, fetchedAt) : null;
            if (!item) { rejected.push({ board: boardKey, requisitionId: r.externalId, title: r.title, reason: gate.ok ? "canonical mapper rejected record" : gate.failure.code }); continue; }
            item.observation.sourceKind = "m52-live-ats-api";
            item.observation.verification = { liveConfirmed: ok2xx3xx(checked.status),
              providerFeedHttpStatus: providerHttpStatus ?? 200, postingHttpStatus: checked.status, postingFinalUrl: checked.finalUrl, postingUrl: r.url,
              board: entry.board, ats: entry.ats, feedFetchedAt: fetchedAt, postingCheckedAt: checked.checkedAt, descriptionSha256: sha(r.descriptionText),
              employerCareersUrl: entry.employerCareersUrl, ownershipMethod: ownership.method };
            items.push(item);
            outcome.canonicalJobs += 1;
          }
          itemsByBoard.set(boardKey, items);
        }
      } catch (error) {
        outcome.failure = classifyBoardFailure(error);
      }
      outcomes.push(outcome);
      boardRecords.push({ board: entry, ownership, providerHttpStatus, listings: outcome.listings, qaCandidates: outcome.qaCandidates, failure: outcome.failure });
      console.log(`[board] ${entry.company} ${boardKey}: ${outcome.failure ? `${outcome.failure.kind} (${outcome.failure.detail})` : `listings=${outcome.listings} qaTitles=${outcome.qaCandidates} jds=${outcome.fullJds}`}`);
    }

    // ---- 2. persistence through the existing repository; repeat pass proves dedupe ----
    const trusted = boardRecords.filter((b) => !b.failure && itemsByBoard.has(`${b.board.ats}:${b.board.board}`));
    const refs = trusted.map((b) => ({ boardKey: `${b.board.ats}:${b.board.board}`, company: b.board.company, ats: b.board.ats, board: b.board.board }));
    const plan: DiscoveryPlan = { selectionRevisionNo: 1, catalogVersion: 1, roles: [{ roleSlug: "qa-sdet", title: "QA/SDET", phrases: ["QA", "SDET", "Software Test Engineer", "QA Automation Engineer"] }],
      locations: [], workModes: [], seniorityLevels: [], searchBand: { minYears: 0, maxYears: 40 } };
    const totalItems = [...itemsByBoard.values()].reduce((n, rows) => n + rows.length, 0);
    const budget = { maxBoards: Math.max(1, refs.length), maxCandidates: Math.max(200, totalItems), maxMatchedPerBoard: 200 };
    const persistPass = async (): Promise<{ runId: string; results: Array<{ boardKey: string; stored: number; newJobs: number; changedJd: number; unchanged: number; duplicates: number }> }> => {
      const { runId } = await jobsRepo.createRun(user.id, plan, refs, budget, "import");
      await jobsRepo.markRunning(runId);
      const results = [];
      for (const ref of refs) {
        await jobsRepo.startBoard(runId, ref.boardKey);
        const items = itemsByBoard.get(ref.boardKey) ?? [];
        const rec = boardRecords.find((b) => `${b.board.ats}:${b.board.board}` === ref.boardKey)!;
        const result = await jobsRepo.persistBoard(runId, ref.boardKey, { fetched: rec.listings, titleMatched: items.length, locationExcluded: 0, seniorityExcluded: 0 }, items, []);
        results.push({ boardKey: ref.boardKey, ...(result ?? { stored: 0, newJobs: 0, changedJd: 0, unchanged: 0, duplicates: 0 }) });
      }
      await jobsRepo.finishRun(runId, "COMPLETED");
      return { runId, results };
    };
    const first = refs.length ? await persistPass() : { runId: null as string | null, results: [] };
    const repeat = refs.length ? await persistPass() : { runId: null as string | null, results: [] };
    const sum = (rows: Array<Record<string, number | string>>, k: string) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);

    // ---- 3. read back from the database; evaluation is DB-backed ----
    const storedRows = refs.length ? await pool.query<{ id: string; company: string; ats: string; board: string; requisition_id: string; title: string; location: string | null; canonical_url: string; first_seen_at: Date; last_seen_at: Date; description_text: string; verification: Record<string, unknown> }>(
      `SELECT j.id,j.company,j.ats,j.board,j.requisition_id,j.title,j.location,j.canonical_url,j.first_seen_at,j.last_seen_at,r.description_text,o.verification
       FROM jobs j JOIN job_revisions r ON r.id=j.current_revision_id JOIN LATERAL (SELECT verification FROM job_observations WHERE job_id=j.id ORDER BY observed_at DESC,id DESC LIMIT 1) o ON true
       WHERE (j.ats,j.board) IN (SELECT * FROM unnest($1::text[], $2::text[])) ORDER BY j.company,j.title,j.requisition_id`,
      [refs.map((r) => r.ats), refs.map((r) => r.board)]) : { rows: [] };
    const candidateEvidence = await buildEvidenceCorpus({ pool, candidates, userId: user.id, asOf: new Date().toISOString().slice(0, 10) });
    const approvedFacts = candidateEvidence.units.map((unit) => unit.text);
    const qaRows = storedRows.rows.map((row) => ({ row, assessment: assessQaJob({ title: row.title, description: row.description_text, location: row.location, approvedFacts }) }))
      .filter(({ assessment }) => assessment.relevant);
    // Use the existing evidence-grounded matcher. Final eligibility comes only from the deterministic decision engine.
    const provider = new RulesJobSemanticProvider();
    const evaluations = [];
    for (const { row, assessment } of qaRows) {
      const fresh = row.verification.liveConfirmed === true;
      const stored = await jobsRepo.getJob(user.id, row.id);
      if (!stored) { errors.push(`Candidate-scoped job retrieval failed for ${row.ats}:${row.board}:${row.requisition_id}`); continue; }
      const report = await runMatch({ job: postingFromStoredJob(stored), provider, corpus: candidateEvidence, asOf: new Date().toISOString().slice(0, 10), selection: null });
      const matchDecision = decideMatch(report, { postingStatus: fresh ? "RECENT" : "UNKNOWN", rolePreference: "MATCH", locationCompatibility: "UNKNOWN" });
      const decision = matchDecision.hardReject ? "FAIL" : !fresh || matchDecision.outcome !== "SHORTLIST" ? "NEEDS_VERIFICATION" : "PASS";
      const profileEligibilityEvidence = candidateEvidence.eligibility.length
        ? candidateEvidence.eligibility.map((fact) => `Approved ${fact.kind} fact reference: ${fact.factId}`)
        : ["No approved candidate eligibility attestation is present in the scoped profile; verify manually."];
      const requirementEvidence = locationCondition(row.description_text);
      const extractionStatus = report.status === "COMPLETE" ? "COMPLETE" : "EXTRACTION_FAILED";
      evaluations.push({ jobId: row.id, company: row.company, title: row.title, location: row.location, locationVerdict: locationVerdict({ location: row.location }), ats: row.ats, requisitionId: row.requisition_id,
        url: row.canonical_url, sourceStatus: fresh ? `HTTP ${row.verification.postingHttpStatus}` : `UNVERIFIED (${row.verification.postingHttpStatus ?? "no HTTP response"})`,
        urlVerified: fresh, firstDiscovered: row.first_seen_at, lastVerified: row.verification.postingCheckedAt ?? null, descriptionLength: row.description_text.length,
        descriptionSha256: sha(row.description_text), requiredExperience: assessment.requiredExperience, requiredSkills: assessment.skills, explicitLocationEvidence: requirementEvidence,
        eligibility: decision as "PASS" | "FAIL" | "NEEDS_VERIFICATION", eligibilityEvidence: [...assessment.eligibilityEvidence, ...profileEligibilityEvidence], score: matchDecision.ranking?.score ?? null,
        relevanceScore: assessment.score, reasons: matchDecision.reason, relevanceReasons: assessment.reasons,
        matchOutcome: matchDecision.outcome, hardReject: matchDecision.hardReject, matchedRequirements: matchDecision.matched,
        missingRequirements: matchDecision.missing, uncertainRequirements: matchDecision.uncertain, blockingConditions: matchDecision.blocking,
        warnings: matchDecision.warnings, extractionStatus,
        extractionFailure: report.status === "EXTRACTION_FAILED" ? report.failure : null,
        extractedRequirements: report.status === "COMPLETE" ? report.requirements.map((r) => ({ type: r.type, value: r.value, level: r.effectiveLevel,
          status: r.status, evidence: r.jd.quote, start: r.jd.start, end: r.jd.end, candidateFactIds: r.matchedFactIds, missingEvidence: r.missingEvidence })) : [],
        decisionGroup: matchDecision.hardReject ? "confirmed_ineligible" : decision === "NEEDS_VERIFICATION" ? "verification_required" : "eligible_recommendation" });
    }
    const { actionable, diagnostic } = partitionShortlist(evaluations, limit);

    const countRows = await pool.query("SELECT count(*)::int AS n FROM jobs");
    const revisions = await pool.query("SELECT count(*)::int AS n FROM job_revisions");
    const duplicateIdentities = await pool.query("SELECT count(*)::int AS n FROM (SELECT ats_identity FROM jobs GROUP BY ats_identity HAVING count(*)>1) d");
    // Independent check: every shortlisted job id must exist in the database with the same requisition id and URL.
    const dbCheck = actionable.length ? (await pool.query<{ id: string; requisition_id: string; canonical_url: string }>("SELECT id,requisition_id,canonical_url FROM jobs WHERE id = ANY($1::uuid[])", [actionable.map((j) => j.jobId)])).rows : [];
    const jsonDbAgreement = actionable.every((j) => dbCheck.some((r) => r.id === j.jobId && r.requisition_id === j.requisitionId && r.canonical_url === j.url)) && dbCheck.length === actionable.length;

    const coverage = summarizeCoverage(outcomes);
    const unverifiedSourceRows = rejected.length + evaluations.filter((e) => e.extractionStatus !== "COMPLETE").length;
    const funnel = {
      companiesAttempted: outcomes.length,
      boardsValidated: outcomes.filter((o) => !o.failure).length,
      boardsUnavailable: outcomes.filter((o) => o.failure).length,
      listingsReturned: outcomes.reduce((n, o) => n + o.listings, 0),
      qaTitleCandidates: outcomes.reduce((n, o) => n + o.qaCandidates, 0),
      newCanonicalJobsInserted: sum(first.results, "newJobs"),
      existingCanonicalJobsReused: sum(first.results, "unchanged") + sum(first.results, "changedJd"),
      duplicateIdentitiesPrevented: sum(repeat.results, "unchanged") + sum(repeat.results, "duplicates") + sum(first.results, "duplicates"),
      fullJdsValidated: outcomes.reduce((n, o) => n + o.fullJds, 0),
      officialUrlsVerified: outcomes.reduce((n, o) => n + o.urlsVerified, 0),
      qaRelevant: evaluations.length,
      pass: evaluations.filter((j) => j.eligibility === "PASS").length,
      fail: evaluations.filter((j) => j.eligibility === "FAIL").length,
      needsVerification: evaluations.filter((j) => j.eligibility === "NEEDS_VERIFICATION").length,
      jdOrSourceValidationFailures: unverifiedSourceRows,
      actionablePass: actionable.filter((j) => j.eligibility === "PASS").length,
      reviewRecommendations: actionable.filter((j) => j.eligibility === "NEEDS_VERIFICATION").length,
      topJobsPrinted: actionable.length,
    };
    const output = { generatedAt: iso(), database: { name: dbIdentity.db, jobRowsBefore: before, jobRowsAfter: countRows.rows[0]!.n, revisions: revisions.rows[0]!.n,
        duplicateCanonicalIdentities: duplicateIdentities.rows[0]!.n }, runId: first.runId, repeatId: repeat.runId, fetchedAt, candidateHandle: "local", approvedFactCount: approvedFacts.length,
      batches: batchNames ?? "all", limits: { maxBoards, limit, delayMs }, funnel, coverage,
      unsupportedProviders: ALL_ATS.filter((a) => a !== "greenhouse" && a !== "lever").map((a) => ({ ats: a, status: "NOT_ATTEMPTED", reason: a === "workday" ? "Workday adapter is site-config/browser based and is not wired to the canonical live-print path" : "no adapter exists in this repository" })),
      boards: boardRecords.map((b) => ({ company: b.board.company, ats: b.board.ats, board: b.board.board, employerCareersUrl: b.board.employerCareersUrl, ownership: b.ownership,
        providerHttpStatus: b.providerHttpStatus, listings: b.listings, qaTitleCandidates: b.qaCandidates, failure: b.failure })),
      ingestion: { rejected, firstPass: first.results, repeatPass: repeat.results },
      jsonDatabaseAgreement: jsonDbAgreement,
      shortlist: actionable, diagnostics: diagnostic.map(({ job, reasons }) => ({ reasons, job })), errors };
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(output, null, 2));

    console.log(`\nDatabase: ${dbIdentity.db} (jobs before ${before}, after ${countRows.rows[0]!.n}; duplicate canonical identities: ${duplicateIdentities.rows[0]!.n})`);
    for (const [i, j] of actionable.entries()) {
      console.log(`\nRANK: ${i + 1}\nCOMPANY: ${j.company}\nJOB TITLE: ${j.title}\nLOCATION: ${j.location ?? "Not specified"}\nATS PROVIDER: ${j.ats}\nREQUISITION ID: ${j.requisitionId}\nORIGINAL POSTING URL: ${j.url}\nSOURCE STATUS: ${j.sourceStatus}\nJD VALIDATION: ${j.extractionStatus} (${j.descriptionLength} chars, sha256 ${j.descriptionSha256.slice(0, 12)})\nREQUIRED EXPERIENCE: ${j.requiredExperience}\nREQUIRED SKILLS: ${j.requiredSkills.join(", ") || "Not stated"}\nELIGIBILITY: ${j.eligibility}\nELIGIBILITY EVIDENCE: ${j.eligibilityEvidence.join("; ")}\nMATCH SCORE: ${j.score === null ? "Not produced" : j.score}\nMATCH REASONS: ${[...(typeof j.reasons === "string" ? [j.reasons] : j.reasons), ...j.relevanceReasons].join("; ")}\nFIRST DISCOVERED: ${new Date(j.firstDiscovered).toISOString()}\nLAST VERIFIED: ${j.lastVerified ?? "not verified"}`);
    }
    if (actionable.length === 0) console.log("\nNo actionable QA/SDET opportunities qualified. See diagnostics below.");
    else if (actionable.length < limit) console.log(`\nOnly ${actionable.length} actionable QA/SDET posting(s) qualified (limit ${limit}); nothing was padded.`);
    if (diagnostic.length) {
      console.log("\nDIAGNOSTIC (not actionable):");
      for (const { job, reasons } of diagnostic) console.log(`- ${job.company} | ${job.title} | ${job.location ?? "n/a"} | ${job.ats}:${job.requisitionId} | ${reasons.join(",")} | ${job.eligibility}`);
    }
    const failedBoards = outcomes.filter((o) => o.failure);
    if (failedBoards.length) {
      console.log("\nBOARD FAILURES:");
      for (const o of failedBoards) console.log(`- ${o.company} (${o.ats}:${o.board}): ${o.failure!.kind} - ${o.failure!.detail}`);
    }
    const line = (ats: (typeof ALL_ATS)[number]) => { const c = coverage[ats]; return `${ats}: attempted ${c.companiesAttempted}, validated ${c.boardsValidated}, unavailable ${c.boardsUnavailable}, zero-openings ${c.zeroOpenings}, listings ${c.listingsReturned}, QA candidates ${c.qaCandidates}, canonical ${c.canonicalJobs}, full JDs ${c.fullJdsValidated}, URLs verified ${c.urlsVerified}`; };
    console.log(`\nM5.2 LIVE DISCOVERY REPORT\n\nCompanies attempted: ${funnel.companiesAttempted}\nBoards validated: ${funnel.boardsValidated}\nBoards unavailable: ${funnel.boardsUnavailable}\n`);
    for (const ats of ALL_ATS) console.log(`${line(ats)}${ats === "greenhouse" || ats === "lever" ? "" : " (not attempted: no live batch/adapter wiring)"}`);
    console.log(`\nReal postings retrieved: ${funnel.listingsReturned}\nNew canonical jobs inserted: ${funnel.newCanonicalJobsInserted}\nExisting canonical jobs reused: ${funnel.existingCanonicalJobsReused}\nDuplicate identities prevented: ${funnel.duplicateIdentitiesPrevented}\nFull JDs validated: ${funnel.fullJdsValidated}\nOfficial URLs verified: ${funnel.officialUrlsVerified}\n\nQA/SDET relevant: ${funnel.qaRelevant}\nEligibility PASS: ${funnel.pass}\nEligibility FAIL: ${funnel.fail}\nEligibility NEEDS_VERIFICATION: ${funnel.needsVerification}\nJD/source validation failures: ${funnel.jdOrSourceValidationFailures}\n\nActionable PASS recommendations: ${funnel.actionablePass}\nReview recommendations: ${funnel.reviewRecommendations}\nTop jobs printed: ${funnel.topJobsPrinted}\nJSON/database agreement: ${jsonDbAgreement}\nJSON output path: ${OUT}`);
    if (errors.length) console.error(`Errors: ${JSON.stringify(errors)}`);
  } finally { await pool.end().catch(() => undefined); }
}

await main();
