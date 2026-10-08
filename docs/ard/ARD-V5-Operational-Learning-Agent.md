# V5 Operational Job Agent and Outcome Learning

Milestone V5 maps to the earlier V1.0 release. Depends on prior version gates for every enabled capability. Read shared contracts. This document defines future scheduling; it does not itself schedule tasks or authorize additional submissions/outreach.

## 1 What V5 will achieve

The agent can operate repeatedly on the available machine, prioritize suitable opportunities, maintain current candidate facts, recover safely, report costs and outcomes, and expand only through proven adapters. It becomes a dependable personal operating workflow. Optimization focuses on useful applications, recruiter screens, interviews and time saved.

V5 is not automatically an enterprise SaaS product. Multiple candidates, hosted browser fleets, tenant isolation, support, billing and commercial compliance require a separate architecture and customer evidence. Do not let a personal tool inherit those costs before demand exists.

## 2 Entry conditions and scope

Require V2 recovery and backup evidence, V3 admitted model registry, V4 guard/confirmation evidence for any enabled submission target, accurate records and explicit scheduling/submission settings. Manual review and disabled submission remain valid operating modes.

Required: scheduled bounded runs, locks/caps, stale-posting checks, fact freshness, restore drills, health/operational reports, outcome lifecycle, reproducible exports, cost budgets and adapter capability management. New ATSs begin disabled and must pass their own earlier gates.

Optional by evidence: Workday adapter, approved resume variant experiments, outreach drafts, semantic-model refresh, HNSW, ILP, bandits and outcome prediction. Sending outreach remains separately authorized. No algorithm is required merely because it appears in a reference list.

## 3 Repeated operation and orchestration

Choose the simplest scheduler compatible with the actual machine and headed Chrome requirement. A local Windows/Linux scheduler invoking the existing CLI may be sufficient. Do not introduce a distributed queue before a single-machine limitation is demonstrated.

Before a scheduled run, validate profile availability, display/headed capability, authoritative storage, config, permission, remaining caps and candidate freshness. If the machine is unavailable, the profile is locked or headed Chrome cannot launch, record a missed/blocked run. Do not silently switch to headless remote automation.

Run bounded discovery, resolver and expiry checks. Apply the dedupe and decision contracts. Continue eligible work under existing permission; pause unknown forms and sensitive facts. Persist progress before each consequential stage. At the end, close owned resources, export redacted results and leave review tasks with exact reasons.

Scheduled and manual runs share ownership, unique keys and cap accounting. A missed schedule does not authorize an unlimited catch-up burst. Limit backlogs by configured source/time/job budgets. Confirmed submissions remain terminal; unknown outcomes remain blocked.

## 4 Posting and candidate freshness

Recheck official posting availability before a stale plan becomes an application. Store checked timestamp and content hash. An expired posting is skipped with reason. Changed JD requirements invalidate dependent decisions and plans while preserving original evidence.

Require current verification for expiring work authorization, certification status and other material facts according to candidate policy. Do not infer legal changes. Newly imported achievements are pending until approved. Profile updates identify which plans/forms must be revalidated; confirmed applications remain immutable historical snapshots.

An outcome or preference change can adjust future ranking policy through a versioned decision. It must not rewrite what the system believed or sent at an earlier time.

## 5 Additional ATS support

Add one named variant at a time. For Workday, audit account/tenant flow, multi-step navigation, session expiry, custom questions, attachment behavior and confirmation signals using legitimate candidate access. Do not assume credentials or store passwords in source.

Build sanitized local fixtures and pass V1 readiness, V2 recovery and V4 submission gates before enabling the relevant mode. Form resemblance to Greenhouse/Lever is not sufficient. Leave unproven controls as manual steps. Update capability registry with adapter revision, known limitations and live evidence.

Compare maintaining a custom adapter with a clear human handoff when the supported volume is low. A brittle full automation path can cost more manual recovery time than a reliable partial fill.

## 6 Outcome lifecycle and metrics

Create an OutcomeEvent separate from application workflow state: application ID, type, observed date, effective date, source, reviewer, linked evidence and correction history. Types can include recruiter screen, interview, offer, explicit rejection, withdrawn and observation-window-matured-no-response. Pending is not rejection.

Use one predeclared primary outcome for an experiment, such as recruiter screen within 30 days of confirmed submission. Keep later events and corrections. An application awaiting that window is right-censored/pending for this metric, rather than an immediate failure.

Operational report: jobs discovered/resolved, duplicates, eligible/review/rejected counts, plans/artifacts, readiness, confirmed submissions, unknown outcomes, field coverage, manual minutes, stage p50/p95 latency, token/compute cost, errors by adapter and stale-fact blocks. Outcome report: mature applications, screens/interviews/offers/rejections, response delay, role family, source, employer mix and resume variant.

Report counts and uncertainty with percentages. Compare similar role families, seniority, location, time period and source. A semantic fit score or model confidence is not an interview probability. Increased volume with worse targeting is not success.

## 7 Models and algorithms

Reuse proven V3 models. Reevaluate candidates only when a recurring error family, cost change or runtime limitation appears. Pin revisions; evaluate a challenger on frozen data, then canary it on a small authorized scope with rollback. Current-model verification is required; this pack does not freeze a model forever.

### Exact search versus HNSW

Keep exact vector comparison for a modest fact corpus. Admit HNSW only if measured search time exceeds the declared budget at actual scale and the approximate index retains acceptable recall. Test build/update costs, memory and cache invalidation. An approximate graph adds a recall/operations tradeoff, not a guaranteed universal speedup. Reference: [HNSW paper](https://arxiv.org/abs/1603.09320).

### Greedy fitting versus ILP

Keep approved text and rendered-layout inspection. Consider ILP/knapsack only when greedy selection repeatedly loses supported requirement coverage within the chosen template. Objective should reward the union of covered requirements, relevant role evidence and readability, not repeated keywords. Costs must estimate rendered lines/section overhead, and the final artifact still needs visual inspection.

### Approved variant experiments before bandits

Begin with two approved plan/template variants and simple randomized allocation within comparable cohorts. Record allocation policy and variant revision before rendering. Do not change factual claims to explore a variant. No experiment alters sensitive answers or eligibility.

Bandits are optional after enough comparable mature outcomes. For a Beta-Bernoulli Thompson sampler:

$$
\theta_k \sim Beta(\alpha_{0,k}+s_k,\beta_{0,k}+f_k)
$$

Separate prior parameters from counted outcomes; do not double-update posterior parameters. Treat pending outcomes according to a declared delayed-reward policy. A late positive result updates the application outcome and experiment record. Silence after a defined observation window is a metric result, not an explicit employer rejection. Nonstationary market/employer mix and sparse rewards can invalidate a simple bandit assumption. Reference: [Thompson sampling tutorial](https://arxiv.org/abs/1707.02038).

Use descriptive cohorts and ordinary randomization if the evidence is thin. This personal search may never justify reinforcement-learning infrastructure.

### Predictive outcome models

Start with a constant-rate baseline and, if sufficient labels exist, regularized logistic regression. A provisional review trigger is 500 mature records with at least 50 positive outcomes; it is not proof of adequacy. Validate on later time periods and hold out repeated employer/template families where needed. Exclude information learned after application, such as later recruiter contact or eventual status.

Measure calibration, precision/recall under class imbalance, uncertainty and usefulness for ranking against the baseline. Add XGBoost only if it improves future-period performance without unstable slices or excessive maintenance. Never let an outcome predictor override hard eligibility or permanently exclude unfamiliar job types. Avoid sensitive attributes and unsupported proxy features. This is candidate prioritization, not a hiring decision system.

## 8 Dataset and experiment governance

Keep immutable raw observations, reviewed labels, model proposals, versioned approved facts, split manifests and outcome events. New outcomes do not contaminate the earlier held-out requirement/field labels. Private applicant data must not enter shared public datasets automatically.

Every experiment states hypothesis, baseline, data slice, frozen labels, success metric, latency/cost budget, stop rule and rollback before execution. Avoid repeated tuning until a small held-out sample happens to pass. Create a new independent validation slice when the original holdout has become part of the development process.

Record negative experiments. A model or algorithm that loses is a useful decision, not an excuse to hide results. Maintain one selected production path per task rather than running all challengers on every application.

## 9 Operations, backups and privacy

Back up authoritative ledger/events, approved profile versions, relevant artifacts, policies and model/adapter registry. Browser profiles and credentials require separate protected treatment. Do not print cookies/tokens into health logs or archive them as repository artifacts.

Verify restore into an isolated private test environment with synthetic or explicitly permitted protected data. Confirm unique identity, terminal/unknown states, artifact hashes, cap accounting and export reproducibility. Restore must not trigger a browser run or submission automatically.

Track storage health, free space, model/provider errors, profile lock, missed schedules, version mismatch and review backlog. Health summaries should make corrective action clear without exposing full sensitive answers. Set retention for screenshots/DOM captures and limit access.

Outreach drafts, if added, use verified contacts and approved facts. Save drafts for review. Sending emails/messages is a separate user-directed action, not a side effect of an application status change.

## 10 E2E operational and learning tests

Use synthetic data for failure/restore/learning tests. Real operational evidence is collected during normal authorized use, not fabricated applications. Run all prior version suites.

| Test ID | Trigger | Required oracle |
|---|---|---|
| V5-E01 | Scheduled run overlaps manual run | Shared ownership/caps; no duplicate application or profile writer |
| V5-E02 | Machine/display/profile unavailable | Recorded blocked run; no hidden headless fallback |
| V5-E03 | Missed schedules create backlog | Bounded catch-up; caps persist across restarts |
| V5-E04 | Official posting expires or JD changes | Skip/invalidate correct dependent stage; history preserved |
| V5-E05 | Sensitive fact expires before submission | User review; no stale answer or click |
| V5-E06 | Restore ledger and artifacts to isolated store | Correct unique keys/states/hashes; no automatic actions |
| V5-E07 | Export regenerated after workbook loss | Same authoritative status/date interpretation |
| V5-E08 | New ATS adapter is unproven | Disabled automation; manual handoff with reason |
| V5-E09 | Model revision changes vector dimension/behavior | Cache invalidation and challenger gate; no mixed vectors |
| V5-E10 | Cost budget exhausted mid-run | Safe checkpoint and budget reason; no uncontrolled fallback spend |
| V5-E11 | Pending then late recruiter response | Corrected outcome; no premature rejection label |
| V5-E12 | Experiment allocates a variant | Pre-recorded approved variant; truthful plan and matching artifact |
| V5-E13 | Bandit posterior updated twice for same event | Idempotent outcome update; no duplicate reward |
| V5-E14 | Predictor feature includes future outcome | Validation rejects leakage; no production model admission |
| V5-E15 | HNSW/ILP experiment does not improve declared metric | Baseline retained; rejection report saved |
| V5-E16 | Operator disables submission or a provider stage | Subsequent actions honor disable; state remains recoverable |
| V5-E17 | Logs/exports/traces inspected for sensitive leakage | Redaction/retention rules enforced; secrets absent from Git |
| V5-E18 | Outreach draft generated after application | Draft saved only; zero outbound messages |

For candidate model refreshes, run V3 frozen evaluations and task-specific canaries. For broader ATSs, repeat local readiness, recovery, ambiguity and real-authorized proof. New capability cannot inherit another adapter's live gate.

## 11 Release evidence and measurable outcome

Collect at least four weeks of observable use. Report supported admitted attempts, completed paths, correct pauses, true failures, unknown outcomes and exclusions separately. Target at least 95 percent handling into a confirmed intended terminal state or correctly categorized actionable pause; also report completion alone so a high pause rate cannot masquerade as automation quality.

Zero unauthorized submissions, duplicate submissions, fabricated claims or critical sensitive-answer errors remain hard gates. Verify a restore drill, stable exports, fresh-fact checks, caps, scheduled locks and per-ATS evidence. Track recruiter/interview conversion and manual time; claim improvement only when comparable cohorts and uncertainty support it.

If outcomes do not improve, examine role targeting, resume evidence, timing and application quality before adding a predictor. A working personal agent can be valuable without a learned outcome model.

## 12 Agent decision requirements and work order

Choose one measured operational bottleneck per turn. Compare scheduler invocation versus distributed orchestration, partial ATS handoff versus full custom support, exact search versus approximate indexing, greedy coverage versus solver, random allocation versus bandit, simple reporting versus prediction.

Document the evidence, alternatives, tradeoff and rollback. Implement a bounded improvement, verify relevant prior gates and observe the operational result. Deliver capability registry, four-week report, restore evidence, outcome definitions, experiment registry, retained/rejected algorithms and exact next highest-leverage task.
