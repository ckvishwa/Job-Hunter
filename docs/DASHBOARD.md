# Local dashboard

`npm run dashboard [-- --data-dir data --output-dir private-runtime/job-specific --boards config/company-boards.json --port 4317]`

Read-only page on `http://127.0.0.1:<port>/`. GET/HEAD only (other methods get 405), Host header must be loopback (403 otherwise), no CORS, no auth, never deployable. It reads `jobs.jsonl` and the per-run `application-*.json`, `resume-plan.json` and `pipeline-checkpoint.json` through the tracker's `buildTrackerRows`, plus the company boards file. It never writes. The page and `/api/snapshot` carry a whitelist of fields only: no candidate facts, answers, resume text or blocking-reason prose.

## Decision Note: no framework

- Problem: one local page, five small panels, a filterable table.
- Options: React/Vite (build step, new deps); `node:http` plus one inline HTML page (no deps).
- Choice: `node:http` plus DOM calls with `textContent` (no `innerHTML`, so JD text cannot inject markup). Limits: no live push; the page polls (3 s while a checkpoint is under 10 minutes old, 20 s otherwise).
- Proof: `tests/dashboard/dashboard.test.ts` (loopback bind, 405/403/404, store digest unchanged, headless Chrome render of fixture data with zero external requests).
- Reversal: delete `src/dashboard`, `tests/dashboard` and the `dashboard` script.

## What emits data (verified in source)

| Stage | Run events | What is stored |
|---|---|---|
| board discovery | no | `jobs.jsonl` only; run totals are printed |
| JD resolution | no | `jobs.jsonl` (`resolutionStatus`, `jdContentHash`) |
| extraction / decision / resume / form | no | `pipeline-checkpoint.json` (written once at run end), `resume-plan.json`, `application-*.json` |
| board verify | no | nothing (stdout JSON) |

No run-event log exists, so "last 20 events" and live stage show "no data". "Typed errors" are `errorCode` fields in the latest checkpoints. "Active run" only means a checkpoint was updated under 10 minutes ago. The daily queue (30/day: 24 SECURITY / 6 QA) has no stored counter, so progress shows "no data" and the targets are labelled targets. Board health shows ledger job counts per configured company, labelled as not verification, because `boards:verify` persists nothing.

Next gate if live panels are wanted: add an append-only run-event writer in the pipeline and discovery stages (separate task; not done here).

## Test prerequisite

The render test uses the Chromium bundled with the pinned Playwright (1.62.0, revision 1234). If it reports a missing executable after a Playwright upgrade, run `npx playwright install chromium`.
