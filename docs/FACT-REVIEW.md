# Fast fact review (JSON + PowerShell)

Review many extracted résumé facts in the terminal instead of clicking in the browser. The browser reviewer still works and uses the same
database, the same approval rules and the same history. Only two decisions exist: `approve` and `reject`. Skipping leaves a fact exactly as it is.

Nothing here approves anything automatically, edits a fact, or corrects employment titles. Warnings only ask you to look.

All files stay in `private-runtime/fact-review/` (Git-ignored). Contact data (name, email, phone) is masked in the file and on screen unless
you export with `--reveal`.

## Workflow (PowerShell, from the repository root, stack running)

```powershell
# 1. List résumé IDs, with pending/approved/rejected counts
npm run facts:list

# 2. Export one résumé's facts (every decision starts as null)
npm run facts:export -- --resume <resume-id>
#    -> private-runtime\fact-review\<resume-id>.review.json
#    (refuses to overwrite an existing file, which may hold your decisions; --force replaces it)

# 3. Optional: edit the JSON by hand. Change ONLY "decision" ("approve" | "reject" | null) and optionally "reason".
code private-runtime\fact-review\<resume-id>.review.json

# 4. Interactive reviewer: A approve, R reject, Enter skip, B back, S summary, Q quit. Progress saves after every key.
npm run facts:review -- --resume <resume-id>
npm run facts:review -- --resume <resume-id> --filter warnings    # only facts with quality warnings
npm run facts:review -- --resume <resume-id> --filter all --redo   # revisit decided facts too
#    filters: pending (default) | undecided | warnings | all. Re-running resumes at the next undecided fact.

# 5. Preview exactly what would change. Changes nothing.
npm run facts:apply -- --resume <resume-id> --dry-run

# 6. Apply. Shows the same diff, then asks you to type APPLY (use --yes only after reading a dry run).
npm run facts:apply -- --resume <resume-id>

# 7. Check the result
npm run facts:list
#    and in the browser: http://127.0.0.1:4321/review?id=<resume-id>
```

Check PostgreSQL directly (no secrets printed):

```powershell
docker exec jobhunter-s1-pg psql -U $env:JH_PG_USER -d $env:JH_PG_DB -c "select approval_status, count(*) from candidate_facts where resume_version_id in (select id from resume_versions where resume_id='<resume-id>') group by 1;"
docker exec jobhunter-s1-pg psql -U $env:JH_PG_USER -d $env:JH_PG_DB -c "select action, actor, snapshot->'review' as review from fact_revisions order by id desc limit 5;"
```

## What apply checks before it changes anything

- The file matches a runtime schema; decisions are only `approve`, `reject` or `null`; unknown fields are refused.
- The résumé belongs to the user, its extraction is the one you exported (version id and text SHA-256), fact IDs are unique and exist.
- Each fact's content digest and revision are unchanged since export. A changed fact is `STALE_CONTENT`; a fact changed by someone else is
  `STALE_REVISION`. A repeat of a decision already applied is `ALREADY_APPLIED` (no new history).
- The existing rules decide the rest: sensitive facts need `--confirm-sensitive`; citizenship/clearance/authorization/sponsorship can never be
  approved from a résumé.
- Any conflict aborts the whole batch with nothing changed. `--skip-conflicts` applies only the clean decisions and still reports the run as
  incomplete.
- Each decision is its own database transaction through the same code as the browser reviewer. If one fails midway, the report says which
  ones applied and which did not; re-running is safe and finishes only the rest.

Every change appends a revision (`actor user:<handle>`, plus the batch id, reason and `cli-json` channel) and a profile revision, so the S2
role recommendations that depended on that evidence are recomputed and stale decisions are marked, exactly as for a browser decision.

## Warnings

`BROKEN_LINE` (word split by a line wrap), `POSSIBLE_DUPLICATE`, `EMPLOYMENT_REVIEW` (title/employer combined or missing, internship or
contract wording, dates to verify), `INSUFFICIENT_CONTEXT` (a lone generic term), `SOURCE_MISMATCH` (quotation does not back the value).
If a fact needs correcting, use the evidence-backed edit in the browser (`/review`), then export again. The export also reports how many
long text lines have no extracted fact, so missed achievements are visible; they are not turned into facts automatically.

## Correcting a fact: `npm run facts:correct`

`facts:correct` is a planning layer in front of the same `edit` review action the browser uses (revision-locked, digest-locked, append-only,
provenance span kept). It never approves anything and never writes an approval status itself.

```powershell
# 1. Look first (nothing is written)
npm run facts:correct -- --resume <resumeId> --fact <factId> --dry-run --reason "offer letter dated ..." `
  --employer "Acme Systems" --title "Security Operations Vulnerability Analyst Intern" --start 2022-09 --end 2023-05 --category none

# 2. Apply: each changed employer / title / start / end / category / evidence field is confirmed by name
npm run facts:correct -- --resume <resumeId> --fact <factId> --reason "offer letter dated ..." `
  --employer "Acme Systems" --title "..." --confirm-fields employer,title
```

* Fields: `--value`, `--employer`, `--title`, `--start YYYY-MM`, `--end YYYY-MM|current`, `--category professional|internship|academic|volunteer|none`.
  A month is never guessed; unset fields keep their current value.
* `--quote "event corre-\nlation"` widens the source quotation to exact text of the extracted résumé (`\n` is a line break). It must occur once,
  overlap the current quotation and contain the value, so an edit can make a fact source-verifiable but never point it at unrelated text.
  The previous quotation is kept in the revision snapshot (`previousSpan`).
* The fact returns to PENDING. An APPROVED fact is edited only with `--allow-approved-edit`; its approval is withdrawn and every S2
  recommendation that rested on it is recomputed and superseded immediately (the command prints how many).
* Interactive runs ask you to type each changed field name; non-interactive runs need `--confirm-fields` listing exactly those fields.
* `--reason` is required and is stored in the revision.

### Open employment conflicts

`facts:export` and `resumes:diagnose` compare every employment record (all uploaded résumés plus, if present, the newest
`private-runtime/candidate/candidate-profile.reviewed-N.json`, or `--prior-profile <file>`; `--no-prior-profile` disables it). Two records for the same
employer whose month ranges can coincide but that disagree on title, dates or category get an `EMPLOYMENT_CONFLICT` warning. Neither side is chosen.
`facts:apply` refuses to **approve** a disputed employment fact unless `--accept-employment-conflicts` is given after you have confirmed the truth from
documents; rejecting never needs it. A later promotion at the same employer (non-overlapping dates) is not a conflict.
