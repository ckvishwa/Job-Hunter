# LayoutLMv3 résumé NER — pilot training & evaluation harness

Fine-tunes `microsoft/layoutlmv3-base` for token classification over résumé
PDFs, with a PaddleOCR fallback for scanned (image-only) files, and scores the
result against the deterministic **Rules v2** baseline on held-out template
families.

This is a **pilot harness**, not a production path. Project policy
(`../../CLAUDE.md`, §6) keeps extraction deterministic until a challenger model
shows measured improvement on reviewed held-out data; the earlier diagnostic
(`.claude/worktrees/universal-job-discovery/private-runtime/resume-ml-experiment-01/report.md`)
decided **KEEP RULES**. Nothing here promotes a model — it produces the
evidence a promotion decision would need.

## Layout

```
ml/resume-layoutlmv3/
├── data/
│   ├── raw_pdfs/          # source PDFs (gitignored — private candidate data)
│   ├── annotations/       # labelled JSON, one file per document (gitignored)
│   └── splits.json        # train 70 / val 15 / test 15, grouped by template family
├── src/
│   ├── parser.py          # PyMuPDF words+boxes, PaddleOCR fallback for scans
│   ├── dataset.py         # schema, BIO taxonomy, splits, LayoutLMv3 dataset
│   ├── train.py           # HF Trainer pipeline, seqeval metrics, early stopping
│   └── evaluate.py        # held-out scoring + Rules v2 side-by-side comparison
├── tests/test_harness.py  # unit tests for the pure contracts (no downloads)
├── models/                # checkpoints (gitignored)
└── requirements.txt
```

Why not `project_root/src/`: the repository root `src/` is the TypeScript
discovery app (`src/discovery`, `src/adapters`, …) and is covered by
`tsconfig.json` / `vitest.config.ts`. Python modules of the same name there
would collide, so the harness keeps the requested internal layout inside its
own subproject.

## Install

```bash
cd ml/resume-layoutlmv3
pip install -r requirements.txt            # pick a torch wheel first if you need CUDA
python -m pytest tests -q                  # 22 tests, no model download
```

The OCR fallback (`paddlepaddle`, `paddleocr`) is only imported the first time a
scanned page is hit — parsing searchable PDFs never loads it. If PaddleOCR is
not installed, native parsing still works and a scan raises a clear
`ParserError`.

All commands below run from `ml/resume-layoutlmv3/`.

## 1. Parse

```bash
python -m src.parser --sample_pdf data/raw_pdfs/example.pdf
python -m src.parser --sample_pdf scan.pdf --force-ocr --json /tmp/parse.json
```

* Native path: PyMuPDF `get_text("words")` in block/line order, which keeps
  multi-column layouts in reading order.
* Fallback: a page with fewer than 10 native words is rendered at 150 DPI and
  sent to PaddleOCR; polygons become `[x0, y0, x1, y1]`, lines are ordered by
  detected column gutter then top-down, and each line is split into words by
  character offset.
* Every box is scaled to the integer `0–1000` grid, clamped, and de-inverted;
  a zero-size page yields `(0, 0, 0, 0)` instead of a division error.

## 2. Annotate

Emit an all-`O` stub, then label it:

```bash
python -m src.parser --sample_pdf data/raw_pdfs/example.pdf \
    --emit-annotation data/annotations/example.json --template-family rendercv
python -m src.dataset --inspect data/annotations/example.json
```

Tags (BIO, 15 classes): `O`, and `B-`/`I-` for `NAME`, `EMPLOYER`,
`JOB_TITLE`, `DATE`, `SKILL`, `DEGREE`, `SCHOOL`.

`template_family` matters: it is the unit of splitting. Give every visually
distinct layout its own family name (`rendercv`, `sidebar-2col`,
`workday-export`, …) and reuse a name only for files that really share a
template. `--inspect` reports tag counts and flags any `I-X` that does not
continue an `X` span.

Label discipline, from the earlier experiment: a single-reviewer label set over
documents already used to tune the rules is **not** generalisation evidence.
Keep held-out families untouched while iterating.

## 3. Split

```bash
python -m src.dataset --build-splits --annotations-dir data/annotations --out data/splits.json
```

Whole families go to one split, largest family first into whichever split is
furthest below quota. `validate_splits` raises on unknown ids, documents in two
splits, or a family spanning splits — so a leaking `splits.json` fails the run
rather than inflating the score. With fewer than three families it warns that a
70/15/15 family-grouped split is not achievable.

## 4. Train

```bash
python -m src.train --dry-run      # model init + one forward pass, no optimisation
python -m src.train                # full run
```

Defaults: lr `3e-5`, train batch 4, gradient accumulation 2 (effective 8),
warm-up ratio `0.1`, eval each epoch, `save_strategy=epoch`, early stopping
patience 3 on `eval_f1`, best checkpoint reloaded and saved to
`models/layoutlmv3-resume-pilot/` together with `train_metrics.json` and
`run_config.json`.

Metrics are `seqeval` entity-level **strict** IOB2 precision/recall/F1 plus
per-entity F1 and support. Label alignment is explicit: special tokens, padding
and non-initial subwords get `-100`, so `CrossEntropyLoss` ignores them
(`--label-all-subwords` relabels continuations `I-` instead).

Long pages are windowed at the word level (`--window-words`, default 350, with
`--window-stride` 64 overlap) so nothing is silently truncated at 512 tokens;
if a window still overflows, the dataset warns once with the word count lost.

## 5. Evaluate against Rules v2

```bash
python -m src.evaluate --model-dir models/layoutlmv3-resume-pilot --split test \
    --out results.json --failures-out failures.jsonl
python -m src.evaluate --rules-only --split test          # baseline alone
python -m src.evaluate --model-dir models/... --rules-adapter app.parse_resume:RulesV2
```

Prints overall strict P/R/F1 per system, per-entity F1 (with `EMPLOYER`,
`JOB_TITLE`, `DATE` first), and a span-level failure breakdown — `missed`,
`spurious`, `boundary`, `type` — with the count landing on OCR-parsed pages,
since OCR word boxes are interpolated from line boxes and are the likely source
of boundary/reading-order damage. `--failures-out` writes one JSON object per
failure for inspection.

### Plugging in the real Rules v2

`--rules-adapter module:attribute` loads an instance, class or factory that
implements:

```python
class RulesBaseline(Protocol):
    name: str
    def predict_page(self, words: Sequence[str], boxes: Sequence[Sequence[int]]) -> list[str]:
        ...  # exactly one BIO tag per input word
```

Both systems are then scored on identical sequences. Without an adapter the
built-in `StubRulesV2Baseline` runs (keyword/regex rules over the same words).
It exists so the harness is runnable end to end; its numbers are **not** the
production baseline, and the CLI prints that warning.

The production parser **is** available in this checkout, at
`.claude/worktrees/universal-job-discovery/services/ai/app/parse_resume.py`
(`resume-rules@2`). `src/rules_v2_adapter.py` wires it in:

```bash
python -m src.rules_v2_adapter --self-test
python -m src.evaluate --model-dir models/... \n    --rules-adapter src.rules_v2_adapter:RulesV2Adapter
```

It imports with `pydantic` alone (no FastAPI, no pdfplumber), takes text and
returns `ProposedFact` records whose spans are UTF-16 code units, which the
adapter maps back onto words. Two limits are structural, not bugs: Rules v2 has
no NAME fact and no school attribute, so `NAME` and `SCHOOL` are never proposed
and a fair comparison scores it only on `EMPLOYER`, `JOB_TITLE`, `DATE`,
`DEGREE` and `SKILL`; and production feeds it pdfplumber or Marker text, so
numbers measured on PyMuPDF-rebuilt text are not its production numbers.


## Validation and promotion gate

`src/validate_annotations.py` is the only route from a reviewed draft into
`data/annotations/`. It separates *structure* from *authority*: a file can be
perfectly well formed and still not be authorised to train on.

```bash
PY=.venv/Scripts/python
$PY -m src.pilot --package "../../data/Resumes/<file>.pdf" \
    --out private-runtime/dataset-01/review-package \
    --template-family <family> --content-kind <kind>      # build the review package
$PY -m src.validate_annotations --draft <draft.json>                      # check
$PY -m src.validate_annotations --draft <draft.json> --promote --to data/annotations
```

Statuses, and what each one means:

| status | meaning | exit |
|---|---|---|
| `SOURCE_CHANGED` | the PDF, extraction revision or signed TSV is not the one reviewed | 4 |
| `REJECTED` | structural defect, a REJECTED manifest, or an unversioned overwrite | 3 |
| `RELATIONSHIP_INVALID` | a reviewed relationship points at the wrong entity type or a missing required field | 5 |
| `REVIEW_PENDING` | structurally fine, not authorised: no manifest, unreviewed tokens or a stale approval | 2 |
| `STRUCTURALLY_VALID` | structure passed, reported on its own | 2 |
| `APPROVED` | source, structure, relationships and a fresh signed manifest all agree | 0 |
| `PROMOTED` | written atomically into the training directory with provenance | 0 |

What it checks:

* **TSV schema** - `token_id`/`index`, `text`, `box`, `label`/`final_label` and
  `page`; duplicate headers, missing columns, blank or duplicate token ids
  (per page), extra cells and missing values.
* **Boxes** - four integers, inside the 0-1000 grid, positive area, and equal
  to the box the extraction saved. A geometrically valid box that differs from
  the source is still a failure.
* **Alignment** - source SHA-256, extraction revision, token count, order, ids,
  text and page. Text is compared exactly: nothing is trimmed, lowercased or
  normalised to make a mismatch pass.
* **BIO** - orphan `I-*` tags, invalid labels, with the sequence reset at every
  page boundary. A blank label is a *pending* token, not an invalid one.
* **Relationships** - employment (employer, job title, start, end) and
  education (degree, school) spans must exist, quote their own words, carry the
  matching entity labels, start at a `B-` tag, and not take two different roles
  in different records. Dates stay optional; `AMBIGUOUS` is how a reviewer says
  the document does not say. Entity-level and relationship-level results are
  reported separately and never merged into one score.
* **Authority** - a manifest naming the reviewer, the time, the source hash,
  the extraction revision and the exact `annotation_revision` they approved.
  Edit one label afterwards and the revision changes, which makes the approval
  stale. An all-`O` document needs `empty_document_confirmed: true`.

Promotion reuses the existing `src.annotate.promote` gate, writes through a
temporary file and `os.replace`, is a no-op when the same revision is already
promoted, and refuses to overwrite a different revision unless `--replace` is
given, in which case the previous annotation is archived as
`<doc>.<revision>.superseded.json`.

## Verified in this environment (2026-10-28)

Python 3.12.10, torch 2.14.0+cpu, transformers 5.21.0, PyMuPDF 2.0,
paddleocr 3.7.0.

| Check | Command | Result |
|---|---|---|
| Unit tests | `python -m pytest tests -q` | 22 passed |
| Native parse | `python -m src.parser --sample_pdf <repo PDF>` | 234 words, `source=native`, boxes in grid |
| OCR fallback | same, on an image-only PDF | 237 words, `source=ocr`, PaddleOCR loaded lazily |
| Dataset + alignment | `python -m src.dataset --self-test` | shapes `input_ids/bbox/pixel_values/labels`, first subword labelled, continuations `IGNORED` |
| Splits | `python -m src.dataset --build-splits` (6 synthetic families) | 4/1/1 docs, no family leakage |
| Model init + forward | `python -m src.train --dry-run` | logits `(2, 29, 15)`, loss 2.70, 125.9M params |
| Full training loop | `python -m src.train --epochs 1` | ran, checkpoint + metrics written |
| Comparison | `python -m src.evaluate --model-dir <ckpt>` | side-by-side table, per-entity F1, failure breakdown |

Those runs used synthetic annotations in a scratch directory; the scores they
printed are plumbing evidence only, not model quality. No real résumé was
labelled or trained on.

Environment notes:

* `enable_mkldnn` is off by default in the OCR path: this machine's CPU paddle
  build raises `ConvertPirAttribute2RuntimeAttribute not support` with oneDNN
  enabled. `--ocr-mkldnn` turns it back on where it works.
* Installing `paddleocr` upgraded `opentelemetry-api` to 1.44.0, which the
  separately installed `google-adk` 2.6.3 pins at `<=1.42.1`. Pin it back or
  install this harness in a virtualenv if that matters.

## Known limitations

* **OCR word boxes are interpolated.** PaddleOCR returns line polygons; words
  are cut by character offset, which is approximate for proportional fonts.
  Boundary errors on OCR pages should be read with that in mind.
* **No span-level fact association.** A token classifier marks which words are
  an `EMPLOYER` or a `DATE`; it does not establish *whose* experience it is, or
  that a title belongs to a specific employer. That pairing - the thing the
  earlier 3B-model experiment failed at - still needs deterministic logic on
  top of these spans.
* **Reading order is heuristic.** One gutter is detected per page (two columns
  max); heavier sidebar layouts may still interleave.
* **A blank page image is substituted** when `pdf_path` is missing, so a
  mislaid PDF degrades quality instead of crashing. Pass `--require-images` to
  make it an error.
* **Validation metrics are not held-out evidence.** Early stopping selects on
  `eval_f1`; report `src.evaluate --split test` numbers only, from families
  never seen in training.

## Dataset preparation (real corpus)

Five modules turn a directory of résumés into reviewable annotation drafts.
Everything they write is private evidence and gitignored.

```bash
# isolated environment (global packages are left alone)
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.txt

PY=.venv/Scripts/python
$PY -m src.inventory --pdf-dir ../../data/Resumes --out private-runtime/dataset-01
$PY -m src.review    --pdf-dir ../../data/Resumes --out private-runtime/dataset-01/review-columns                      --reading-order columns --contact-sheet
$PY -m src.annotate  --build --pdf-dir ../../data/Resumes                      --families private-runtime/dataset-01/families.json                      --out private-runtime/dataset-01/annotations --one-per-family
$PY -m src.pilot     --annotations private-runtime/dataset-01/annotations                      --review private-runtime/dataset-01/review-columns                      --inventory private-runtime/dataset-01/inventory.json                      --out private-runtime/dataset-01/pilot
```

* **`src/inventory.py`** - read-only: SHA-256, pages, page size, native word
  counts, OCR need, box validity (grid range, inversion, zero area, overlap),
  gutter and reading-order observations, exact/near duplicates (5-gram Jaccard
  + layout signature) and a *provisional* layout family. Writes
  `inventory.json` + `inventory.md`.
* **`src/review.py`** - page previews, box overlays drawn from the normalised
  boxes, a reading-order path, `lines.txt` reading-order dump and contact
  sheets for grouping families by eye.
* **`src/annotate.py`** - the draft format: per word `suggested` / `label` /
  `status`, plus employment and education **relation records** with their own
  status and an `AMBIGUOUS` state. Proposals come from the rules stand-in and
  are always `UNREVIEWED`; `--promote` refuses to emit a training annotation
  until every word has a reviewed label and a reviewer is recorded.
* **`src/pilot.py`** - per-document review bundles: preview, overlay, warnings,
  suggestion table, relation tables and a signed checklist.
* **`src/rules_v2_adapter.py`** - the production Rules v2 parser as an
  evaluation baseline (see above).

### Review workflow

1. `--build` writes `<doc>.json` and `<doc>.review.tsv`.
2. A human fills `final_label` for every TSV row against the overlay.
3. `python -m src.annotate --apply <doc>.json --tsv <doc>.review.tsv --reviewer <name>`
   writes the labels back; mismatched text or unknown tags are rejected, not applied.
4. `--validate` checks boxes, BIO well-formedness and that every relation span
   still quotes the words it points at.
5. `--promote` moves fully reviewed drafts into `data/annotations/`, which is
   the only input `src.train` reads.

### Findings from the first corpus (13 PDFs, 1 PNG)

* **Reading order.** PyMuPDF block order interleaves sidebar and body on
  two-column templates: 106 reading-order backsteps across the corpus, all of
  them removed by `--reading-order columns`. Verified visually on the overlays,
  not only by the metric. Side-by-side sub-columns (a two-up REFERENCES block)
  are still interleaved: the model detects one gutter per page.
* **Content.** Eleven of the thirteen PDFs are Canva template exports with
  fictional people and placeholder contacts, two of them lorem ipsum; they are
  valid *layout* evidence and poor *entity* evidence.
* **PNG input.** `src.parser` accepts PDFs only. The PNG is recorded as
  unsupported and needs a separate image adapter (render → OCR path → normalise).
* **oneDNN crash.** Root cause isolated: paddlepaddle 3.3.1's PIR executor with
  oneDNN v3.6.2 raises `ConvertPirAttribute2RuntimeAttribute not support
  [pir::ArrayAttribute<pir::DoubleAttribute>]` at `onednn_instruction.cc:118`.
  Deterministic; the default `enable_mkldnn=False` avoids it, `--ocr-mkldnn`
  reproduces it.
* **Environment.** `.venv` pins `torch==2.14.0`; torch `2.15.0+cpu` from the
  PyTorch CPU index fails to load (`WinError 127`, `shm.dll`) on this machine.
