# Career Ops reuse — M5.1-D

Upstream: https://github.com/career-ops-hq/career-ops
Pinned commit: `dff9703a092e2872245aef09b096edcee054ac69`
License: MIT. Copyright (c) 2026 Santiago Fernández de Valderrama. The notice is kept in `docs/discovery/THIRD-PARTY-NOTICES.md`. The checkout used for reading is `F:\Jobs\Job_Search\career-ops-pin`. No upstream install script was executed.

| Component | Decision | Why |
| --- | --- | --- |
| `scan-ats-full.mjs` child process | KEEP_EXISTING | Job Hunter already spawns it with `--dry-run`, schema validation, and preflight. |
| ATS allowlist | ADAPT | The pinned scanner accepts `bamboohr` in addition to greenhouse, lever, ashby, workday, and icims. |
| stdout handling | ADAPT | The runner now caps stdout, emits heartbeats, and honors cancellation. |
| Offer ingestion | ADAPT | Schema-valid offers are retained before relevance filtering. Descriptions stay null until a JD is fetched. |
| `providers/_ip-guard.mjs` | REIMPLEMENT_SMALL_PORTION | A local HTTPS and private-address check. The upstream process-wide DNS patch was not copied. |
| `providers/google.mjs` | REIMPLEMENT_SMALL_PORTION | One first-page careers URL, without the `page` parameter robots.txt disallows. |
| `providers/amazon.mjs` | REIMPLEMENT_SMALL_PORTION | One 10-row `amazon.jobs` JSON page for the United States. |
| `providers/workday.mjs` | REIMPLEMENT_SMALL_PORTION | Tenant, instance, site, and hostname are accepted only when a redirect or stored URL contains all four. |
| Remaining provider modules | REJECT | Existence of a module is not live coverage. They were not copied. |
| M3 resume, M4 matching, PostgreSQL | KEEP_EXISTING | This change does not replace them. |

A guessed board token stays a failed probe. Google's stored Greenhouse token `google` remains HTTP 404 and is not used.
