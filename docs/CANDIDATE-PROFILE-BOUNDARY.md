# Candidate-profile boundary (P0)

Career scoring (S2 now, S4 later) reads candidate evidence **only** through `loadScopedEvidence` (`src/db/profile-repo.ts`). A fact is evidence only if:

1. it comes from a résumé that is **authorized** for the **active profile** with the provenance that profile accepts
   (personal profile ← `personal` résumés; demo profile ← `fixture` résumés). A résumé with no classification is **unverified** and excluded; unknown
   provenance is never assumed synthetic and never assumed personal. Attested user statements (no résumé) stay in.
2. if approved, its quotation really backs it. Otherwise it is kept out (`SOURCE_EVIDENCE_BROKEN`) until the fact is corrected
   (`npm run facts:correct`) and approved again. This is why a certificate whose quote is only `Basics` cannot support `SUPPORTED`.
3. if it is employment, it does not contradict the candidate's **confirmed employment** for the same employer
   (`CONFLICTS_WITH_CONFIRMED_EMPLOYMENT`).
4. alternate copies of the same approved employment (other résumé versions) count once (`DUPLICATE_EMPLOYMENT`; earliest upload is kept).

Rejected and pending facts never count (S2 already ignores them; a test proves it). Nothing is deleted and no review history changes. Tables (migration
`0004_profile_boundary`, additive): `candidate_profiles`, `profile_sources`, `profile_source_events` (append-only), `profile_confirmed_employment`.
Rollback: `db/migrations/down/0004_profile_boundary.down.sql` (manual, destructive to those four tables only).

## Commands

```powershell
npm run profile -- status                         # active profile, every résumé's classification, what was kept out and why
npm run profile -- init --kind personal --label "<name>"
npm run profile -- suggest [--owner-email <e>]    # evidence-based suggestions; dry run
npm run profile -- suggest --apply                # records fixture/unverified suggestions only, never authorized; personal is never auto-applied
npm run profile -- classify --resume <id> --as personal --authorize --basis "<evidence>"
npm run profile -- confirm-employment --employer "<>" --title "<>" --start YYYY-MM --end YYYY-MM|current --category professional --statement "<how confirmed>"
```

Every classification change recomputes S2: recommendations that rested on evidence that left the profile are superseded and any decision on them is shown as stale.

* **Suggestion rules:** `fixture` only on proof (every non-trivial line identical to a known fixture and no substantial extra content); `personal` only when
  the owner's email is in the document, and then a person still has to authorize it; everything else is `unverified`.
* **Confirmed employment** is the candidate's own statement. It is a *reference*: it has no source quotation, is not a fact and never counts as experience.
  Experience comes only from approved, source-backed facts, so a corrected résumé must be uploaded and its employment reviewed
  (`facts:review`). Until then professional experience is 0, and any résumé employment that disagrees with the statement is flagged `EMPLOYMENT_CONFLICT`,
  refused at approval unless `--accept-employment-conflicts`, and excluded from scoring even if forced through.
* **Demo mode:** `JH_DEMO_PROFILE=1` (tests only) makes uploads join an active *demo* profile as fixtures. It never touches an existing personal profile.

## S4 gate

`tests/api/profile-isolation.test.ts` is the gate. Static half: only the repositories read `candidate_facts`, and S2 reads through `loadScopedEvidence`.
An S4 matcher must read evidence from `loadScopedEvidence` as well and may use `factResume` to name the contributing résumé for every match.
