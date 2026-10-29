# Documentation path for JH-MATCH-001

Start with the [locked AIM and active checkpoint](ACTIVE-FEATURE.md). This index maps the existing proof path; links show where to inspect a contract or implementation, not proof that a gate passed.

1. **AIM → PRD:** [Active feature](ACTIVE-FEATURE.md) → [approved, hash-locked V1 PRD](PRD.md) (Stages 3–4, matching requirements, UI acceptance, quality gates). The [draft SaaS PRD](product/PRD-JOB-HUNTER-SAAS.md) is separate.
2. **PRD → contracts and decisions:** [shared contracts](ard/00-SHARED-CONTRACTS.md), [V1 vertical-slice contract](ard/ARD-V1-Working-Vertical-Slice.md), [V3 matching contract](ard/ARD-V3-Semantic-Matching.md), and [ADR-0001 / ADR-0004 decisions](DECISIONS.md). [S4A matching notes](S4A-MATCHING.md) describe the current slice.
3. **Contracts → matching code:** [candidate evidence boundary](../src/match/evidence.ts) → [JD analysis](../src/match/analyze.ts) → [match pipeline](../src/match/pipeline.ts) and [decisions](../src/match/decide.ts) → [API routes](../src/api/match-routes.ts). Gold-set scoring: [gold set](../src/match/gold.ts) and [its CLI](../src/match/gold-cli.ts). M4 decision projection: [decision intelligence](../src/match/intelligence.ts), described in [M4 matching notes](M4-MATCHING.md).
4. **Code → tests → UI:** [API match integration tests](../tests/api/match-e2e.test.ts) and [route tests](../tests/api/match-routes.test.ts) → [matching page](../web/src/pages/matches.astro) → [offline browser test](../tests/e2e/offline/matches-ui.e2e.test.ts). Unit coverage: [gold-set tests](../tests/match/gold.test.ts) and [decision-intelligence tests](../tests/match/decision-intelligence.test.ts).
5. **UI → release gate:** [PRD acceptance gates](PRD.md), [CI tiers](sdlc/CI-TIERS.md), [QA sign-off](qa/QA_SIGNOFF.md), [Gate A evidence](qa/GATE_A_REPORT.md), and [PR checklist](../.github/pull_request_template.md). A passing local documentation check is not feature or release acceptance.

Repository consolidation (JH-REPO-001): [runbook and status board](aim/JH-REPO-001.md) and [per-task evidence](evidence/repo-consolidation/R2.1.md).

Run `node scripts/check-markdown-links.mjs` from the repository root to check local Markdown links. It reports missing targets and documented core references with no inbound link; it does not change files.
