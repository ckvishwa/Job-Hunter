# Local candidate-document pipeline: privacy model and runbook

This file owns the local candidate intake path end to end: where documents may live, how they
are extracted, how a fact is proposed, what the offline guard does and does not prove, and the
commands to run on Windows.

Scope: intake only. Nothing here approves a candidate fact, trains a model, or sends anything
anywhere. Decisions and their reasoning are in `docs/DECISIONS.md` (ADR-0004 and amendments
B.1 to B.4); this file is the operating description.

## 0 Status

| | |
|---|---|
| Stages built | B (intake), B.1 (reading order), B.2 (multi-line employment), B.3 (all fact categories) |
| Last run | 20 synthetic profiles from `HIGH_CONFIDENT/PROFILES`, output in `F:\JobHunterPrivate
un-b3` |
| Result | 20 of 20 extracted, 20 isolated candidates, 373 PENDING facts, 0 approved, 0 evidence failures |
| Not started | Stage C (fact review and approval), PostgreSQL, any model training |

The B.2 run (`F:\JobHunterPrivate\candidates`, 80 employment facts) is kept beside it as the
accepted baseline; B.3 was written to a new directory rather than over it.

**Firewall waiver on the record.** The run above happened without the OS-level outbound rule in
section 6. The owner authorized that explicitly on the grounds that all 20 documents are
synthetic test data they created. For real candidate documents the rule in section 6 applies:
without it, the only thing standing between a library and the network is an in-process guard,
and section 6 says plainly why that is not a boundary.

## 1 Where data lives

| Data | Location | Why |
|---|---|---|
| Source documents (PDF/DOCX) | wherever you keep them; `HIGH_CONFIDENT/PROFILES/` inside the checkout is gitignored | left in place: moving or untracking someone's files is their decision |
| Extracted drafts, text, manifests, salt | `%JH_PRIVATE_ROOT%` (e.g. `F:\JobHunterPrivate`) | outside every Git checkout, so no `git add -A` can reach them |
| Pending facts from a PDF | under `%JH_PRIVATE_ROOT%`, enforced | a PDF can carry real contact details |
| Pending facts from the owner's own `Resume*.docx` | `private-runtime/` (gitignored) | unchanged from the existing workflow |

Set the root once per shell, or in the user environment:

```powershell
$env:JH_PRIVATE_ROOT = "F:\JobHunterPrivate"
```

`src/candidate/private-paths.ts` enforces the rule: a target inside a Git checkout is refused
(`INSIDE_GIT_CHECKOUT`), and when `JH_PRIVATE_ROOT` is set, a target outside it is refused
(`OUTSIDE_PRIVATE_ROOT`). The Python worker makes the same check before it reads a single byte
(`PRIVACY_VIOLATION PRIVATE_OUTPUT_INSIDE_REPO`, exit 5).

## 2 Runbook (Windows PowerShell)

Extraction. One process, local, offline by default. Output is pseudonymous document ids,
status codes, counts and timings; no file name and no document text:

```powershell
cd F:\Jobs\Job_Search\job-hunter\.claude\worktrees\universal-job-discovery
$env:JH_PRIVATE_ROOT = "F:\JobHunterPrivate"
services\ai\.venv\Scripts\python.exe -I services\ai\local_intake_cli.py `
  --input-dir "F:\Jobs\Job_Search\job-hunter\HIGH_CONFIDENT\PROFILES" `
  --out-dir   "$env:JH_PRIVATE_ROOT\drafts"
```

Add `--show-names` only on a private terminal, `--force` to re-extract a document whose draft
already exists, `--file "<path>"` (repeatable) instead of `--input-dir` for single documents.

For a corpus of **unrelated people**, import one profile per document. Without this flag every
document of the run lands in one profile and identical facts merge across them, which would
make two candidates who worked for the same employer share one employment fact:

```powershell
npm run candidate:import -- `
  --intake-dir "$env:JH_PRIVATE_ROOT\drafts" `
  --out-dir    "$env:JH_PRIVATE_ROOT\candidates" `
  --per-candidate
```

Each profile is named by the document's own pseudonymous candidate id, has its own
deduplication scope, and is never overwritten without `--force`.

For **one person's own several resumes**, import them together so a repeated fact is one fact
that records where else it appeared. Nothing is approved either way:

```powershell
npm run candidate:import -- `
  --intake-dir "$env:JH_PRIVATE_ROOT\drafts" `
  --out        "$env:JH_PRIVATE_ROOT\facts\pending-facts.json" `
  --candidate-id cand-1
```

Exit codes: `0` wrote a file, `2` usage or nothing importable, `3` a PDF was found with no
`--intake-dir` (the worker command is printed), `4` the output path is not private.

Check what a commit is about to include:

```powershell
npm run ci:private-staged
```

## 3 Extraction conditions

The worker reports one of four conditions per document. Only the first two carry text, and a
scan is never reported as an empty resume.

| Condition | Meaning | What to do |
|---|---|---|
| `EXTRACTED` | text layer present, spans verified, no confidence warning | import and review |
| `LOW_TEXT_CONFIDENCE` | text present, but something is off: replacement characters, many one- or two-character lines, thin text on every page, no resume section words, a page whose span could not be verified, or a column rebuild that had to be discarded | compare against the source page before approving anything |
| `NEEDS_LOCAL_OCR` | no usable text layer and an image is drawn: a scan | run local OCR; none is performed by this pipeline, and no cloud OCR is permitted |
| `EXTRACTION_FAILED` | `UNREADABLE_FILE`, `ENCRYPTED_PDF`, `TOO_MANY_PAGES`, `EMPTY_DOCUMENT` (no text and no images), `UNSUPPORTED_FILE_TYPE`, `SPAN_VERIFICATION_FAILED` | fix or exclude the document; the code says which |

### Reading order

A two-column page extracts top-to-bottom across the gutter, so a sidebar entry lands between
two body lines and a heading is glued to whatever was printed beside it. Where a gutter is
found, the page is rebuilt from word coordinates: full-width rows (a name banner, a footer) are
boundaries, and within a band the left column is emitted before the right one. The draft records
`readingOrder: "columns"`, the page records its `column_gutter`, and the warning is
`READING_ORDER_RECONSTRUCTED`.

What stops a rebuild from inventing anything:

* the unit is the printed row, never the word, so a banner is not cut in half and a date never
  leaves the entry it was printed under;
* the rebuilt page must hold exactly the same non-whitespace characters as the extractor's own
  text for that page. One character out and the rebuild is discarded, the native order is kept,
  and the document is marked `LOW_TEXT_CONFIDENCE` with `REFLOW_REJECTED_CONTENT_MISMATCH`;
* each line keeps `native_index` (the row of the extractor's own output), `bbox` (its box on the
  page) and `column`, so a reordered line can be checked against the page itself.

A row counts as two column entries only when its words leave a clear gap at the gutter of at
least 10 points or 2% of the page width; otherwise it is one line of continuous text that
happens to span the gutter, and it is kept whole.

## 4 Offsets and provenance

The canonical text of a document is `normalize_text("\n".join(page_texts))` — the same string
the HTTP service already returns, so one document has one text. Every line span is stored in
**UTF-16 code units** (`docs/ard/00-SHARED-CONTRACTS.md`), verified twice: in Python against
the code-point string, and again in TypeScript by re-slicing `draft.text`. A span that does
not reproduce its own text fails the document rather than being repaired.

Page spans are found by locating each page's normalized text in the canonical string.
Normalization does not distribute over the join, so a page that cannot be verified is marked
`resolved: false` with `PAGE_SPAN_UNRESOLVED` instead of being given a guessed range.

A fact imported from a PDF carries `source.reference = <pseudonymous document id>` and
`source.locator = "page N, line M, chars A-B"`. The id-to-file-name map is in
`intake-manifest.json` in the private directory, and nowhere else.

## 5 Candidate facts

All five categories are read by the existing deterministic parser,
`services/ai/app/parse_markdown.py` (`marker-deterministic-v2`), over the text this extraction
produced. `app/candidate_reading.py` is only the join: it runs that parser, attributes each
record to the page it was printed on, and passes the parser's own refusals along with the
records. No extraction rule lives in the adapter or in TypeScript.

| category | what the parser reads | fact kind |
|---|---|---|
| employment | an entry over one to three lines, either order of employer and title, the title side chosen by its keywords rather than its position | `employment` |
| skills | comma lists, one-per-line items, bold chips, and the group label printed above or beside them; employer and title names are excluded | `skill` |
| education | degree, with institution and graduation where the document separates them | `education` |
| certifications | the name, with a trailing date or issuer stripped off it | `certification` |
| projects | name, description, link, and the technologies listed on an explicit `Technologies:` / `Tech stack:` line | `project` |

Where the schema has no field, the value is recorded as printed and labelled as such: an
education fact carries its institution and graduation in `detail`, and says when the document
stated neither; a project's technologies stay empty when none were listed. No proficiency,
duration or seniority is derived anywhere, and a skill mention is never evidence of years.

A document that carries a reading stands the template line rules down for that document, so
nothing is imported twice. An empty reading does not: there would be nothing to double-import.

What it refuses, with the code it reports:

| code | meaning |
|---|---|
| `EMPLOYMENT_ROLE_AMBIGUOUS` | neither side (or both) look like a job title, so which is the employer cannot be told |
| `EMPLOYMENT_ROLE_MISSING` | a date range with no separable employer and title near it |
| `EMPLOYMENT_INVALID` | the record fails its own validation, e.g. the range ends before it starts |
| `EDUCATION_PAIRING_AMBIGUOUS` | degrees and institutions in the section do not pair one to one |
| `EDUCATION_INVALID` | the education record fails its own validation |
| `SKILL_LABEL_GLUED` | a category label ran into the previous item; the boundary is uncertain |
| `PLACEHOLDER_SKIPPED` | the entry still holds a `[placeholder]` |
| `SENSITIVE_TERM_NOT_IMPORTED` | a citizenship, clearance, authorization or sponsorship mention was found and deliberately not made a fact |
| `INSTRUCTION_LIKE_TEXT` | the document contains text shaped like an instruction; it is data, and is reported |

A refusal is reported as an import note with its page and character offsets, so an entry that
was considered and rejected is visible rather than missing.

Dates are carried only at the precision the document stated:

* month precision becomes `startDate` / `endDate`, and "Present" becomes `endDate: null`;
* a **year-only start** cannot be imported at all, because `candidate-profile.ts` requires
  `YYYY-MM` on an employment fact. The entry is reported with its dates quoted verbatim and
  left for a person. No month is invented to satisfy the schema;
* a year-only **end** with a month start keeps the start and records the end verbatim in
  `detail`, leaving `endDate` unset rather than rounding it to a month.

A document that brings an employment reading does not also run the single-line rule, so one job
is never imported twice. An entry printed identically in two documents of the same batch is one
fact, with a note naming the other document - the existing merge behaviour.

Every record quotes its own text. `verifyReadingSpans` re-slices every span of every category
against the draft text and requires each value - employer, title, skill, degree, institution,
certification name, project name - to appear inside the evidence it claims. A draft that fails
is not imported.

### Candidate isolation

Each document becomes its own candidate under `--per-candidate`: its own profile file, its own
pseudonymous id, and its own deduplication scope. Two unrelated people who worked for the same
employer therefore keep two separate employment facts. Without the flag every document of the
run collects into one profile and identical facts merge across them, which is right for one
person's several resumes and wrong for a corpus of different people.

## 6 What the offline guard proves, and what it does not

`services/ai/app/offline_guard.py` does two things before any document library is imported:

1. refuses to run unless every required module is already importable (`DEPENDENCY_UNAVAILABLE`,
   exit 3) — it installs nothing and downloads nothing;
2. replaces the socket factory, `getaddrinfo` and `create_connection` so that a connection or
   name lookup for anything other than loopback raises `NetworkBlocked`.

**It is not a security boundary.** It is an in-process tripwire inside one Python interpreter.
It does not constrain:

- a subprocess, or any program started by one;
- a C extension that calls the operating system's socket API directly;
- DNS performed inside the C library rather than through `socket.getaddrinfo`;
- a file written to a synced folder (OneDrive, Dropbox) — which is an upload with extra steps;
- anything else running on the machine, including the Node process.

Its value is that an accidental upload becomes a crash with a stack trace instead of a silent
success. For an actual guarantee the process must be confined from outside.

### Windows Firewall, per-executable (verifiable, reversible)

```powershell
# Run as Administrator. Blocks all outbound traffic from the intake interpreter.
New-NetFirewallRule -DisplayName "JobHunter intake python: no outbound" `
  -Direction Outbound -Action Block -Enabled True `
  -Program "F:\Jobs\Job_Search\job-hunter\.claude\worktrees\universal-job-discovery\services\ai\.venv\Scripts\python.exe"
```

Verify the rule actually bites, with the guard switched off so the firewall is what is being
tested:

```powershell
services\ai\.venv\Scripts\python.exe -I -c "import socket; socket.create_connection(('1.1.1.1',53),3)"
# expected: a timeout or 'An attempt was made to access a socket in a way forbidden by its access permissions'
```

Remove it with `Remove-NetFirewallRule -DisplayName "JobHunter intake python: no outbound"`.

Caveats worth knowing before relying on it: the rule is keyed to that exact executable path, so
recreating the virtual environment elsewhere leaves it unprotected; a different Python on the
machine is unaffected; and loopback traffic is not blocked by default, so a local proxy would
still be reachable.

### Container with no network (stronger, more setup)

`docker run --network=none` removes the interface rather than filtering it, which also covers
subprocesses and C extensions. It needs the Docker daemon running and the private directory
bind-mounted, and the daemon is not required by anything else in this stage — so it is the
right answer for a batch run, not for day-to-day use.

### What is checked automatically

`tests/test_local_intake.py` asserts the guard blocks a non-loopback connect and a non-loopback
`getaddrinfo`, allows loopback, and restores itself afterwards. No test asserts that the
machine is isolated, because no test can.

## 7 Git safeguards

Three layers, in order of strength:

1. **Outside the repository.** Drafts, text and PDF-derived facts live under
   `%JH_PRIVATE_ROOT%`, which is in no working tree. Enforced in code, by both the worker and
   `candidate:import`.
2. **`.gitignore`.** `HIGH_CONFIDENT/` (both checkouts), `private-runtime/`, `pending-facts*.json`,
   `candidate-profile.reviewed*.json`, generated resumes, `*.xlsx`.
3. **`npm run ci:private-staged`.** Reads the index and reports, per path:
   - `BLOCK` for a candidate profile directory, the resume corpus, `private-runtime/`, a
     `*.draft.json` / `intake-manifest.json` / `.intake-salt`, a candidate fact file, a document
     inside a `*profile*` / `*resume*` / `*candidate*` / `*cv*` directory, or **anything forced
     past `.gitignore` with `git add -f`**;
   - `WARN` for an ordinary `.pdf`, `.docx`, `.xlsx` or `.csv` — reported, not blocked, so that a
     legitimate document does not teach anyone to reach for `--no-verify`.

   Deletions are never blocked: removing private data from the tree must stay easy. Paths and
   rule names are printed; file contents never are.

`scripts/hooks/pre-commit` runs that same check. **It is not installed by anything in this
repository** — installing a hook would replace whatever hook you already have. To use it:

```powershell
# inspect .git\hooks\pre-commit first; this repository has none at the time of writing
Copy-Item scripts\hooks\pre-commit .git\hooks\pre-commit
# or, replacing the hooks path for the whole repository:
git config core.hooksPath scripts/hooks
```

## 8 Limits

- **No OCR.** `NEEDS_LOCAL_OCR` is a label, not a fallback. A scanned document yields no facts.
- **One gutter per page.** A page with a sidebar *and* a two-up sub-block inside a column gets
  the main split only; the sub-block stays interleaved.
- **Certification records can be fragments.** On the 20-profile run, 179 certification records
  came from 124 source lines: 41 of them from lines the parser split into more than three items
  on `•·|;`, 52 names are a single word and 10 are under four characters. The section scoping is
  right, so the suspicion is per-line splitting. Nothing was filtered on a hunch - the records
  are PENDING with evidence, and a reviewer should expect fragments among them.
- **A category with no section yields nothing, which is not a failure.** No profile in the
  20-document corpus has a projects section, so project facts are 0. The `projects_resume()`
  fixture exercises that path end to end.
- **Project technologies need an explicit label.** `Technologies:`, `Tech stack:`, `Tools:`,
  `Stack:` or `Built with:`. A stack written as a bare dash-separated bullet is read as the
  project's link and description, not as technologies.
- **The template line rules still exist** for a document with no reading: `TECHNICAL SKILLS`
  with `Label: a, b` items, `PERSONAL PROJECTS`, `CERTIFICATION`, and a single-line employment
  form. They are the owner's own resume shape and are what the `.docx` path uses.
- **The .docx path is unchanged.** It still matches `Resume*.docx` only, so cover letters are
  never read, and its facts still carry paragraph locators.
- **No duration, proficiency or seniority is ever derived.** An employment fact arrives with no
  `roleTags`, so role-years requirements cannot use it until a person says what it counts as.
- **Classification can say "not a resume".** A draft whose text classifies as a job description,
  an interview guide or nothing in particular is skipped with `NOT_A_RESUME` and reported.
- **PostgreSQL is not needed for intake**, and no test in this stage touches it. Recording an
  *approval* does need it: `facts:apply` and the candidate repository are Postgres-backed.
