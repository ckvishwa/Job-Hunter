### ADR-0005 — Integrated baseline: M5.1 is the trunk, project-command-center merges in with one true merge commit

**Status:** Accepted 2026-10-29 under the JH-REPO-001 standing approval (OWNER MAY VETO). ADR-0004 is reserved for the uncommitted candidate-PDF decision currently in the project-command-center working tree (ported in R2.5).

**Context.** Two lines diverge from `ba55c90`: the M5.1 line (`a5f96da`: M2, M3, M4 matching, discovery work; 124 paths, 9 commits) and the project-command-center line (`5889221`: governance, tiered CI, PRD lock, project API/UI, ML engine, migrations 0006-0011; 150 paths, 16 commits). `main` (`2d07906`) is neither. R1.1 found one matching engine with identical exported API on both lines; each line refines it in separate hunks and neither is a strict superset (M5.1: `intelligence.ts`, clearance-level matching, store/pipeline changes, `ConditionDecision.jd.start/end`; PCC: ubiquitous-term guard, 2000-char evidence-span cap). R1.2 dry-run merge: 5 content conflicts, all inside the ten known paths, plus one silent clash: both lines add a `db/migrations/0006_*` file.

**Options.** (A) M5.1 trunk, merge PCC in with one true merge commit. (B) PCC trunk, merge M5.1 in. (C) Port path by path without a merge commit. (D, do less) leave two lines alive.

**Decision.** (A). Branch `recovery/jh-integrated-baseline` starts at `a5f96da`; `5889221` is merged with `git merge --no-ff`, so both tips stay ancestors of the result. The PCC strict-superset test failed, so the default stands.

**Consequences.** Both histories remain reachable; no tip is orphaned; the recovery branch is disposable and `main` changes only through a reviewed PR. PCC's two engine refinements are re-applied on the surviving files, not kept as a second engine. Migration order is fixed as: 0001-0005 (base), 0006_m4_decision_intelligence (M5.1, unchanged), then PCC's ML migrations renumbered 0007-0012 (up and down), unless R2.2 finds a dependency that forces otherwise. What this does not solve: the `services/ai` resume pipeline, live-print code, and dirty files are classified separately in R2.5.

**Rollback.** Delete the recovery branch/worktree; every prior tip is tagged (`preserve/*` locally, archive tags in Phase 5) and in the H: bundle.

**Check that proves it.** `git log -1 --format=%P` shows both line tips; exactly one engine under `src/match`; typecheck, `test:fast`, matching suite, link check green on the merged tree.

| Overlapping path | Mode | Resolution |
| --- | --- | --- |
| `package.json` | Union | Union of deps and scripts from both lines; one regenerated lockfile. (Textual conflict in dry run.) |
| `src/api/server.ts` | Union | Auto-merged; verify each route is registered exactly once. |
| `src/db/candidate-repo.ts` | Contract decides | Auto-merged; schema and migration order win; both callers must compile. |
| `src/jobs/runner.ts` | Behavior review | Textual conflict; keep behavior proven by a test; record anything dropped. |
| `src/match/decide.ts` | Pick one | Survivor: the M5.1-trunk file (auto-merged with PCC's ubiquitous-term guard kept). No second copy. |
| `src/match/rules-provider.ts` | Pick one | Same survivor; keep M5.1's unknown-level and clearance-level logic and PCC's `fitSpan`; `RULES_EXTRACTOR_REVISION` becomes one new combined value. |
| `src/testing/fingerprint.ts` | Determinism test | Keep the version whose output is stable across reruns; prove with a rerun test. |
| `tests/api/s3-api.test.ts` | Keep both if distinct | Merge cases; delete only exact duplicates. |
| `tests/match/extract-and-decide.test.ts` | Follows engine | Union of both sides' added cases (auto-merged). |
| `tests/testing/engine.test.ts` | Keep both if distinct | Same as `s3-api`. |
