# Job Hunter Five Version Architecture Pack

Prepared on 7 October 2026. Status: proposed implementation requirements, pending repository audit.

Copy this `docs/ard` folder into the existing Job Hunter repository. Read this file and `00-SHARED-CONTRACTS.md` before any version ARD. The actual repository path was not supplied; these documents do not claim that the source, tests, or dependencies have been inspected.

## Version names and outcomes

The requested V1 through V5 names are milestone names. This mapping preserves the earlier release plan and avoids treating the fifth milestone as a different product.

| Milestone | Earlier release name | Document | What it achieves |
|---|---|---|---|
| V1 | V0.1 | ARD-V1-Working-Vertical-Slice.md | One real job reaches a truthful, filled READY_TO_SUBMIT application |
| V2 | V0.2 | ARD-V2-Reliable-Automation.md | Greenhouse and Lever recover from interruptions and export accurate status |
| V3 | V0.3 | ARD-V3-Semantic-Matching.md | Measured JD parsing, hybrid fact retrieval, and semantic field classification |
| V4 | V0.4 | ARD-V4-Guarded-Autonomous-Apply.md | Explicitly enabled submission with confirmation and ambiguous-outcome recovery |
| V5 | V1.0 | ARD-V5-Operational-Learning-Agent.md | Scheduled operation, broader proven adapters, outcomes and justified optimization |

Each version is cumulative. Preserve earlier gates and behavior. A version is not complete because folders exist, tests pass against mocks, or the planned features were coded. It needs the exact release evidence described in its ARD.

## Product and business scope

Build for one candidate first. The useful output is a correct application to a suitable job, followed by a recruiter response or interview. A personal assistant does not need a vector database, a fleet of agents, or an enterprise platform by default. A commercial version would require separate customer validation, security/support obligations, and a viable operating model.

Keep TypeScript and the audited Playwright foundation if they exist and work. Reuse discovery, resolver, extraction, dedupe, provider and storage modules. Build one supported ATS flow at a time. Models interpret text and rank evidence; approved candidate facts and deterministic workflow rules own answers and actions.

The old combined `Job-Hunter-ARD-and-Agent-Prompts.md` is background. For this requested five-version handoff, the documents in this folder govern the new milestone names and detailed gates. Actual repository instructions and explicit user instructions still apply. If a real conflict affects correctness or scope, identify it before dependent changes rather than silently choosing incompatible contracts.

## How the coding agent must reason

For a meaningful architectural or algorithm decision, write a short Decision Note before implementing it:

1. Observed problem: the specific failure, metric, user outcome, source path and test.
2. Current approach: whether it actually exists and what evidence supports it.
3. Options: current/simple baseline and at least one credible alternative.
4. Tradeoff: correctness, latency, cost, memory, operational burden and reversal cost.
5. Choice: why it fits this version, including the cases it will not solve.
6. Proof: the independent test or frozen benchmark that would accept or reject it.
7. Reversal: how the feature can be disabled or rolled back without corrupting state.

The agent may choose a simpler or better implementation than the proposed default within the current bounded task when source evidence and tests justify it. Record the deviation. Do not ask for approval for routine reversible implementation choices already within scope. Changes to candidate facts, real submission permission, outreach sending, or a materially different objective require the relevant explicit instruction. Do not reinterpret architectural freedom as permission to build later versions early.

Time box routine option evaluation to about 20 minutes. Escalate the design effort only for a demonstrated risk. Do not write an ADR for every helper function. Create ADRs for persistent identity, storage transactions, browser ownership, model admission, or submission policy changes.

## Model and algorithm progression

| Version | Models used | Algorithms used | Why now |
|---|---|---|---|
| V1 | Existing validated semantic provider; Qwen2.5-7B-Instruct as an optional local benchmark | Schema/evidence checks, normalized exact fact matching, deterministic rules | Prove truth and end-to-end behavior without inference infrastructure creep |
| V2 | Same selected provider, with cache/version controls | Checkpoints, typed state transitions, bounded read retries, stable field mapping | Operational failures cannot be fixed by adding more models |
| V3 | Selected structured LLM; BGE-small benchmark; MiniLM alternative; optional cross-encoder and NLI screening | BM25, cosine, RRF, optional MMR and reranking, selective field classification | Improve observed semantic failures against reviewed labels |
| V4 | Reuse V3 winners; no model chooses submission | Fresh validation, durable action intent, reconciliation, unique application ownership | The important problem is uncertainty and duplicate prevention |
| V5 | Same core; optional simple outcome model only after enough evidence | Scheduling, cohorts, temporal validation; gated HNSW, ILP or bandits | Optimize a working agent using actual bottlenecks and mature outcomes |

Named models are reproducible benchmark candidates, not a claim that they are the newest or best models available. The agent must verify current artifacts, licenses, revision, runtime and hardware before admission. Never install every candidate simultaneously just to complete a list.

## Test layers

All versions have four explicit proof layers:

- Unit: schemas, rules, identities, pure state transitions and failure policies. No browser or network.
- Integration: module-to-module workflow with synthetic candidate facts, recorded provider outputs and temporary real storage. No external requests.
- Offline browser E2E: actual headed Chrome against a loopback fixture server, exercising the production inspector/filler/workflow and reading controls back. This proves wiring and failure behavior, not remote ATS compatibility.
- Live proof: official job pages, optional real model calls and authorized real form interactions. Explicit manual/opt-in commands, private evidence, never ordinary unit tests.

Record which boundary is substituted in every test. A stored model response validates parsing and pipeline behavior, not live model accuracy. Live inference accuracy has its own evaluation command. A fixture submit is a local test action, not a real application.

## Proposed repository structure

```text
docs/ard/
  00-START-HERE.md
  00-SHARED-CONTRACTS.md
  ARD-V1-Working-Vertical-Slice.md
  ARD-V2-Reliable-Automation.md
  ARD-V3-Semantic-Matching.md
  ARD-V4-Guarded-Autonomous-Apply.md
  ARD-V5-Operational-Learning-Agent.md
docs/decisions/                     use existing ADR folder if present
docs/evidence/                     redacted summaries only
tests/fixtures/                    synthetic or sanitized data
tests/e2e/offline/                 real browser against localhost
tests/live/                       opt-in explicit execution
private-runtime/                  ignored profiles facts resumes and evidence
```

This is a responsibility map. Locate existing equivalents before creating or moving directories. Never replace the current file tree solely to match the example.

## Copyable starting instruction

Paste this into the coding agent while it is open in the existing Job Hunter directory:

```text
Read docs/ard/00-START-HERE.md, docs/ard/00-SHARED-CONTRACTS.md and
docs/ard/ARD-V1-Working-Vertical-Slice.md, plus all applicable repository
instructions. Treat V1 through V5 as cumulative milestones, not permission to
implement everything at once.

First perform V1 Slice 0 only: a read-only audit. Confirm repository root, branch,
working-tree state, current entry points, browser lifecycle, discovery, resolver,
JD extraction, dedupe, storage, checkpoints, provider, tests and any existing
resume/application modules. Run the actual offline baseline where available.
Do not infer implementation from directory names or historical test counts.

Return source paths, symbols, tests, actual gaps, a KEEP/EXTEND/CREATE/MOVE/REMOVE
map, architecture corrections and the smallest next discovery-proof task.
Compare real alternatives for important choices using the Decision Note format.
Do not blindly install named models or implement advanced algorithms.

No source/config/doc changes, dependency upgrades, commit, push, merge, or live
application submission during the audit. Preserve existing dirty work. Stop
after reporting the audit. The next coding task is one real company -> official
posting -> full JD -> canonical JSON -> durable save -> clean headed Chrome exit.
```

After the audit, instruct the agent: “Implement V1 Slice 1 only using the audited entry points. Prove it live in headed Chrome, preserve the baseline, record evidence, and stop.” Continue one bounded slice at a time. Commit validated task changes only when instructed or already authorized; this documentation request itself does not commit or push a repository.

## Release evidence format

Maintain a release checklist with requirement ID, source/test path, test layer, expected oracle, command, actual result, commit/environment, evidence path and pass/fail/pending. Include exclusions and blockers. Do not count a pending live gate as passed.

Default priority: truthful answers, durable progress, correct form actions, useful targeting, then semantic quality and speed. If an algorithm adds complexity without changing an observed result, keep the simpler baseline.
