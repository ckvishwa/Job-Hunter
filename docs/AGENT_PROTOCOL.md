# Job Hunter — Mandatory Agent Execution Protocol

## Mission
Maintain one unambiguous direction from baseline PRD through signed-off delivery. **Never claim a phase is green just because code was written, local tests were run once, or another agent said it works.**

## Canonical files
1. `docs/PRD.md` — the frozen requirements baseline; do not silently rewrite.
2. `docs/PROGRESS_LEDGER.json` — the only writable source of truth for task statuses.
3. `docs/PROGRESS.md` — generated readable dashboard; NEVER manually edit.
4. `docs/DECISIONS.md` — ADR log for approved requirement changes.
5. `scripts/sync_progress.py` — validator and dashboard generator.

## Every session
1. Read all five files and inspect git status, branch, HEAD SHA and current CI evidence.
2. Run `python scripts/sync_progress.py --check` and `python scripts/sync_progress.py --next`.
3. Verify PRD checksum; if changed, STOP and request documented approved ADR and coordinated hash update.
4. Pick **one** dependency-unblocked task, announce its task ID, PRD references, acceptance test, and scoped files. If P0 Gate A remains blocked, audit/repair P0 first; isolated branch experiments are allowed but cannot be merged as verified releases.
5. Set task `IN_PROGRESS`, update ledger and run `python scripts/sync_progress.py --write`. Implement minimal changes, preserve baseline data, run focused tests.
6. Before moving to `QA_REVIEW`, attach candidate commit SHA, exact test command, test outcome and log/CI evidence. Tests should cover negative cases; don't invent logs, SHA or counts.
7. **Only an independent QA reviewer**, with recorded reviewer ID/time and the required reproducible evidence, marks individual tasks `VERIFIED`. QA can send a task back to `IN_PROGRESS` if proof is insufficient.
8. A phase becomes green **automatically**, and only if all of its tasks are VERIFIED, every dependency is VERIFIED, its blocker is cleared, and its QA phase sign-off is present.
9. Record newly discovered drift as a task blocker or ADR, rather than overwriting the PRD or declaring it out-of-scope.
10. End each session with a short handoff: *task ID; commit SHA; tests; evidence; blockers; exactly one next task*. Include any uncommitted changes.

## Agent authority matrix
| Actor | May modify code | May propose task done | May set VERIFIED | May change PRD |
|---|---|---|---|---|
| Implementing agent | Yes, scoped | Yes, QA_REVIEW | No | Only through approved ADR |
| Independent QA agent/reviewer | Tests and fixtures | Yes | Yes, with recorded evidence | Only through approved ADR |
| Product owner | Product decisions | Yes | May approve release, not fabricate QA | Yes, with recorded ADR |

An automated checker validates structure, but does not prove tests actually passed. Verification requires real test logs, CI runs, correct HEAD/worktree context and human or independent QA review.

## Allowed task statuses
- `PLANNED` — not started.
- `REPORTED_UNVERIFIED` — previous checkpoint says it exists; current repo evidence missing.
- `IN_PROGRESS` — actively worked on; cannot count green.
- `BLOCKED` — stopped on explicit reason.
- `QA_REVIEW` — work submitted; proof is being independently checked.
- `VERIFIED` — QA accepted commit-specific test/acceptance evidence.

## Non-negotiable controls
- Gate A: no weakening or skipping the full regression gate to claim success.
- Candidate consent, multi-candidate isolation and truthful actor attribution.
- No unsupported material resume claims; every claim has provenance.
- Job pages, resumes and JDs are untrusted inputs.
- ML relevance cannot override deterministic eligibility; new classifiers remain shadow-only until formally promoted.
- Independently test ATS document recovery and browser field read-back; don't invent a universal ATS score.
- Playwright does **not** auto-submit.

## Handoff format
```text
SESSION HANDOFF
Task: P#-## — <title>
PRD FRs: ...
Branch/commit: ...
Changes made: ...
Tests run: <exact commands + passed/failed/skipped>
Evidence path/CI URL: ...
QA status: ...
Blocker or uncertainty: ...
Next single task: P#-## — ...
```

## Copy/paste bootstrap prompt for coding agents
```text
You are an implementing agent for Job Hunter. Before editing files, read docs/PRD.md, docs/AGENT_PROTOCOL.md, docs/PROGRESS_LEDGER.json, docs/PROGRESS.md and docs/DECISIONS.md. Run python scripts/sync_progress.py --check and --next. Verify live repository evidence; do not infer code exists because the PRD describes it. Pick the earliest feasible dependency-unblocked task, preserve existing working code and tests, and implement only that task. Update the ledger and regenerate the board as described. You may move a task to QA_REVIEW with genuine commit and test evidence; only independent QA marks VERIFIED. Do not mark a phase green yourself. Respect Gate A and human-only application submission. Finish with a complete handoff and one next task.
```
