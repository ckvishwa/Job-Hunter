# Local dashboard

`npm run dashboard [-- --data-dir data --output-dir private-runtime/job-specific --boards config/company-boards.json --port 4317]`

Read-only page on `http://127.0.0.1:<port>/`. GET/HEAD only (other methods get 405), Host header must be loopback (403 otherwise), no CORS, no auth, never deployable. It reads `jobs.jsonl` and the per-run `application-*.json`, `resume-plan.json` and `pipeline-checkpoint.json` through the tracker's `buildTrackerRows`, plus the company boards file. It never writes. The page and `/api/snapshot` carry a whitelist of fields only: no candidate facts, answers, resume text or blocking-reason prose.

## Decision Note: no framework

- Problem: one local page, five small panels, a filterable table.
- Options: React/Vite (build step, new deps); `node:http` plus one inline HTML page (no deps).
- Choice: `node:http` plus DOM calls with `textContent` (no `innerHTML`, so JD text cannot inject markup). Limits: no live push; the page polls (3 s while a checkpoint is under 10 minutes old, 20 s otherwise).
- Proof: `tests/dashboard/dashboard.test.ts` (loopback bind, 405/403/404, store digest unchanged, headless Chrome render of fixture data with zero external requests).
- Reversal: delete `src/dashboard`, `tests/dashboard` and the `dashboard` script.

## Run events (`private-runtime/run-events.jsonl`)

`src/events/run-events.ts` is an append-only JSONL writer. Override the path with `JOB_HUNTER_RUN_EVENTS` (or `--events` on the dashboard). One line per event: `run.start`, `run.end`, `stage.start`, `stage.end`, with `seq`, `at`, `runId`, `runType`, and optional `stage`, `company`, `jobId`, `outcome`, `errorCode`, `durationMs`.

- **Redaction is structural.** There is no free-text field. Stage, outcome and error values must be plain codes (`[A-Za-z][A-Za-z0-9_.:-]{0,63}`); anything else becomes `UNTYPED_ERROR`. Error messages are never recorded. Company is stripped of control characters and capped at 120; job id must be a plain id. The reader re-sanitizes every line.
- **Crash recovery.** Earlier bytes are never rewritten. If the file does not end in a newline (a torn write), the next process starts its first event on a fresh line; readers skip unparseable lines and report the count.
- **Logging never breaks a run.** A failed write increments `failedWrites` and is otherwise ignored. Library callers get a no-op log unless they pass one; only the CLI entry points create the real file log, so tests do not write to `private-runtime/`.

| Entry point | Events | Not covered |
|---|---|---|
| `npm run boards:discover` | run, one `board` stage per company (typed code on failure) | per-posting rejections (still in `job-failures.jsonl`) |
| `npm run discover` (`runDiscover`) | run, `source:<id>` stage per source+keyword, `resolution`, `resolve_job` per listing, typed rejections | |
| `npm run pipeline` (`runPipeline`) | run, `lane`, `extraction`, `decision`, `resume_plan`, `application` with company and job id | `application` is absent when a valid READY record is reused |
| LinkedIn / search discovery, `boards:verify`, tracker | none | follow-up |

Known limits: one process writes one run; concurrent writers interleave whole lines (small appends) but are not otherwise coordinated. A run that crashes never writes `run.end`; the dashboard treats it as active for 10 minutes after its last event, then as stale. The daily queue (30/day: 24 SECURITY / 6 QA) still has no stored counter and shows "no data". Board health still shows ledger counts, not verification, because `boards:verify` stores nothing.

The pipeline wiring lives in `src/pipeline/run.ts` and `src/pipeline/cli.ts`, which are not yet committed in this branch.

## Test prerequisite

The render test uses the Chromium bundled with the pinned Playwright (1.62.0, revision 1234). If it reports a missing executable after a Playwright upgrade, run `npx playwright install chromium`.
