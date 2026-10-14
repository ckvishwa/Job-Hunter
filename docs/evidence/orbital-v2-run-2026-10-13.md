# Orbital V2 execution run — 2026-10-13/14 (redacted summary)

Branch `careerops-integration`, HEAD `ba55c90` plus pre-existing uncommitted WIP (preserved, untouched by this run). No push, commit, reset or delete.

## Résumé ingestion (S1)
- Corrected source: `<candidate SOC résumé PDF>` found in the parent checkout root (untracked), NOT in `F:\Jobs\Resumes\SOC_DFIR\RESUMES\` (that folder holds only a placeholder DOCX template). No `.tex` exists anywhere under `F:\Jobs`.
- SHA-256 `769a0e78c0293f56bde23f3671062dc04498380616b39ea58afd67edb609f11c`, 205,446 bytes. Not previously ingested; original file untouched.
- Content check: Cognizant Technology Solutions, Programmer Analyst, Quality Engineering / QA Automation, Jan 2022 – Jul 2023; SOC lab and MalTrace under "Cybersecurity Projects". No internship line.
- Outdated variant: stored résumé `f3df6157…` (sha `06c098e7…`) contains "Security Operations Vulnerability Analyst Intern Cognizant … Sep 2022 – May 2023". Its employment fact is already `rejected`. That résumé is still AUTHORIZED as profile evidence with 12 approved facts — left unchanged, flagged for the owner.
- Ingested as resume `a4d3a9b3…` / version `b9997890…`: `resume-rules@2`, 50 deterministic facts, all PENDING, Qwen not required.
- Extractor defect found: employer on the line after the title was not captured. Corrected via `facts:correct` (rev 2, evidence quotation widened, fact back to PENDING, nothing approved).
- Classified `personal`, AUTHORIZED (basis recorded in `profile_sources`).

## Role selection (S2)
Saved selection revision 1 = `iam-analyst` only (US, remote, entry, 0–3 y). No recorded approval for the 8 proposed roles → not saved. WAITING_FOR_USER.

## Discovery (S3), run `f1ea6417…`
25 official boards (23 Greenhouse, 2 Lever), all OK: fetched 5,999; title-matched 0 via title path; location-excluded 1; seniority-excluded 0; verified 9; new 0; changed JD 0; unchanged 9; rejected 0; failures 0.

## Matching (S4A/S4B)
34 stored jobs recomputed (MiniLM encoder, deterministic decisions): 25 COMPLETE, 9 EXTRACTION_FAILED (fail-closed). New résumé facts are pending, so UNSUPPORTED here means "no approved evidence", not verified mismatch. Sponsorship stays UNKNOWN/needs candidate answer. All accuracy metrics NOT_EVALUATED (no independent labels). Qwen not invoked for JDs in this run.

## Browser
Managed headed Chrome (`orbital-default`, created on first use): read-only visit to Cloudflare "IAM Security Engineer" (HTTP 200, title/employer match, official Greenhouse host); no Apply click, no form write. Second launch read back a localStorage probe (persistence proven, probe then removed); owner lock released after each run.

## Verification
- `npx tsc --noEmit`: exit 0.
- `npm run test:full` (serialized): 137 units, 1,512 tests, 0 failed, 0 skipped, 472 s.
- Gate record `status: fail` despite zero failed units: `tests/testing/engine.test.ts` has an uncertain fingerprint ("dynamic import with a computed specifier") and the gate's "every unit holds a receipt on the current tree" condition was not met. PENDING: diagnose in `src/testing/engine.ts` (`gateStatus`/run-end check).
- Submissions: 0.

## Not done / blocked
Fact approval (human), role-selection approval (human), tailored résumé, application packet, JD-level human gold labels, Qwen shadow run.
