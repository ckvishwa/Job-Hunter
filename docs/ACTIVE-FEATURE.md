# Active AIM: JH-REPO-001 (repository consolidation)

**Locked AIM:** Consolidate six worktrees and eleven local branches into one verified `main` with a mechanical privacy boundary, one documented structure and enforced CI, without losing any existing work, then resume JH-MATCH-001 on the integrated baseline. The runbook, task order and status board are in [the runbook](aim/JH-REPO-001.md); redacted per-task evidence is under [docs/evidence/repo-consolidation](evidence/repo-consolidation/R2.1.md).

**Status:** IN_PROGRESS on branch `recovery/jh-integrated-baseline`. Phase 0 (freeze and preserve) and Phase 1 (decide the trunk) are done; Phase 2 (reconcile histories) is under way. Nothing has been pushed. Decisions: [ADR-0005](DECISIONS.md).

**Next action (one):** Run the next `Ready` row of the status board in [the runbook](aim/JH-REPO-001.md), starting from the lowest-numbered one.

## Paused: JH-MATCH-001

**Locked AIM:** Prove truthful resume-to-JD matching through the existing UI. The general IT pilot must show supported, partial, unknown, and uncovered JD requirements with exact approved candidate evidence.

**Status:** IN_PROGRESS, paused. Task R7.1 of JH-REPO-001 resumes it on the integrated baseline. Stage B.3 is an accepted intake slice, not a matching or UI acceptance pass. PR, independent review, and release gates remain pending.

### Accepted checkpoint

- Stage B.3: 20 authorized synthetic resumes produced 20 isolated candidate profiles and **373 PENDING facts** (80 employment, 81 skill, 33 education, 179 certification; 0 project), with 0 approved facts and 0 verifiers. Source-locator integrity checks passed as recorded in [ADR-0004 amendment B.4](DECISIONS.md). These counts are accepted prior evidence, not a rerun here.
- Certification fragmentation remains a known risk: 179 records came from 124 source lines; many may be fragments. Keep them pending for review. Do not treat any as approved match evidence.
- Existing matching code, API, page, and browser tests are mapped in [the documentation index](INDEX.md). Their presence does not prove the locked AIM.

### Last JH-MATCH-001 checkpoint (before the pause)

- **Decisions:** Reuse the existing candidate, JD, match, API, and UI path. PRD changes require [ADR-0001](DECISIONS.md). The approved [PRD](PRD.md) and separate [draft SaaS PRD](product/PRD-JOB-HUNTER-SAAS.md) were not edited.
- **Risks/blocker:** No approved facts in the accepted Stage B.3 corpus; certification fragmentation remains. Positive evidence must be independently expected and explicitly approved in a synthetic fixture.
- **Resume with:** one independently expected positive-evidence candidate-to-JD match through the existing production API and matching UI, with an approved synthetic fact and exact JD requirement evidence (R7.1).
