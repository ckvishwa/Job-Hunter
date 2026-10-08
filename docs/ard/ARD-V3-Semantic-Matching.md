# V3 Measured Semantic Matching and Field Understanding

Milestone V3 maps to the earlier V0.3 release. Depends on V2 reliability and V1 truthfulness. Read shared contracts. Submission remains disabled.

## 1 What V3 will achieve

The system extracts JD requirements more accurately, retrieves the strongest approved resume facts, avoids repeated bullets, and recognizes more form-question wording while preserving abstention. It improves measured matching quality against human-reviewed examples. It does not claim to calculate an employer's ATS score or hiring probability.

V3 upgrades three separate tasks: JD semantic extraction, requirement-to-fact retrieval, and field semantic classification. Do not merge them into one unconstrained prompt that rewrites a resume and answers a form at once.

## 2 Entry conditions and scope

Require proven V2 recovery, versioned candidate facts, independently inspected resume artifacts, reliable forms and a baseline semantic/retrieval implementation. Collect concrete examples where exact matching or current extraction fails.

Required: reviewed datasets and frozen splits, extraction benchmark, replaceable embedding contract, lexical/dense comparison, rank fusion experiment, selective field-classifier benchmark, provenance-preserving plan selection and measured latency/cost.

Conditional: cross-encoder, MMR, NLI review screening, constrained rewriting and a local inference worker. Deferred unless separately justified: HNSW, vector database, custom NER training, transformers fine-tuning, ILP, bandits, outcome prediction and new unsupported ATSs.

## 3 Semantic architecture

The JD parser emits source-evidenced requirements. Deterministic validators preserve alternatives, negation and eligibility scope. The decision engine evaluates hard constraints against explicit candidate facts before any retrieval score is used.

Only approved resume facts enter retrieval. Contact data, passwords, demographic answers and sensitive eligibility facts are excluded from the embedding corpus. Embeddings select relevant evidence; an exact fact ID and approved content must still be present before a claim or answer is used.

Candidate requirements feed lexical and dense retrievers. Rank fusion merges stable fact IDs; an optional reranker changes relevance order. Optional MMR and coverage selection choose a varied supported set under the template budget. A source-mapped ResumePlan goes through factual validation and actual rendering. Unsupported requirements remain uncovered.

Field interpretation takes the full question, help, control type, options, section and required state. It proposes a canonical key or UNKNOWN. The answer resolver separately checks explicit wording-compatible facts. An accurate label does not imply that the candidate has an answer.

## 4 Model registry and reasons

| Task | Initial candidate | Why evaluate it | Limitation and alternative |
|---|---|---|---|
| JD structure and field proposals | Existing selected provider | Minimizes operational change and preserves integration | Replace only if reviewed quality/cost/runtime benchmark loses |
| Local structured extraction baseline | Qwen/Qwen2.5-7B-Instruct | Instruction-tuned candidate with structured-output support | Hardware and serving complexity must be measured; not mandatory |
| Dense fact retrieval | BAAI/bge-small-en-v1.5 | Compact English retrieval baseline, 384 dimensions and 512 sequence length | Chunk by requirement/fact; measure short technical terms |
| Dense alternative | sentence-transformers/all-MiniLM-L6-v2 | Reproducible sentence/short-paragraph comparator | Default truncation at 256 word pieces; not whole-JD evidence |
| Optional fact reranking | cross-encoder/ms-marco-MiniLM-L6-v2 | Joint query/fact ranking after inexpensive candidate retrieval | Trained for passage ranking, not proof of candidate qualifications |
| Optional contradiction review | FacebookAI/roberta-large-mnli | NLI-based entailment/contradiction/neutral signal | Predictions are not truth certificates; resume benchmark required |

Model specifications above are grounded in the [BGE model card](https://huggingface.co/BAAI/bge-small-en-v1.5), [MiniLM model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2), [cross-encoder model card](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2), [Qwen model card](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct), and [MNLI model card](https://huggingface.co/FacebookAI/roberta-large-mnli). Pin exact revisions and verify current license/runtime before implementation. Quantized or exported derivatives need their own revision and numerical-quality comparison.

Do not add a generic people/organization NER model solely to extract skills. Skills, requirement level, alternative logic and experience scope need a domain-aware contract and evidence. A custom job NER model or ATS-specific embedding model can be a challenger later, but requires the same local benchmark and artifact review. Do not adopt a model based only on its self-reported leaderboard.

## 5 Retrieval algorithms and details

### Lexical baseline and BM25

Tokenize technical terms deliberately: preserve or normalize C++, C#, .NET, KVM, AWS, Sigma rules and version strings without stripping their meaning. Maintain a reviewed alias table separately. Exact tag matches remain useful for required technologies; “cloud” is not equivalent to AWS experience.

Compare current normalized exact matching with BM25 over approved fact text and approved skill tags. Record tokenizer and index revision. Initial tuning candidates can use `k1=1.2` and `b=0.75`; they are starting settings, not universal optima. Tune only on development records. BM25 favors rare exact terms but can miss paraphrases; dense retrieval addresses a different failure mode.

### Dense cosine retrieval

Embed each approved fact independently using the selected model's documented pooling, normalization and query formatting. Do not put a whole resume and JD through a short encoder and silently truncate them. Use requirements or bounded passages, preserving source spans.

For normalized vectors, rank by dot product/cosine similarity. Reject NaN, infinite, zero-norm or wrong-dimension output. Cache by fact-content hash, model/revision, tokenizer, precision and formatting policy. Profile/fact content changes invalidate dependent cached vectors. Scores are relative similarities; calibrate any abstention threshold against actual negatives.

Begin with exact vector comparison over the personal fact set. Record model cold load separately from warm query latency. HNSW is not necessary merely because embeddings exist.

### Reciprocal Rank Fusion

Retrieve the top 20 candidate fact IDs from each lexical and dense branch as an initial experiment. Fuse using one-based ranks:

$$
RRF(d)=\sum_{m:d\in L_m}\frac{w_m}{k+r_m(d)}
$$

Start with equal weights and `k=60`, then tune on development records if needed. An absent document contributes zero. Deduplicate by fact ID and use stable ID tie breaks. Rank fusion avoids treating BM25 values and cosine scores as comparable raw numbers. It does not guarantee rare-term coverage; check explicit uncovered requirements afterward. Reference: [Cormack et al on RRF](https://doi.org/10.1145/1571941.1572114).

### Optional cross-encoder

Score validated requirement/fact pairs only after retrieval. Preserve fact identity and provenance. Do not interpret its relevance logit as an interview probability or possession of a skill. Admit it when the held-out top-five useful-fact rate improves by at least five percentage points, with no critical-coverage regression and acceptable latency/cost. If the base retriever already saturates the benchmark, omit it unless another predeclared ranking metric improves materially.

Retrieve-then-rerank is described in [Sentence Transformers documentation](https://sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html). Small corpora may justify scoring all facts directly; benchmark that simpler option instead of imposing a two-stage architecture by habit.

### Optional MMR and coverage selection

Select a next bullet that balances requirement relevance and overlap with already chosen bullets:

$$
MMR(d)=\lambda\,rel(d,q)-(1-\lambda)\max_{s\in S}sim(d,s)
$$

Use a declared normalization and empty-set rule, stable tie breaks, minimum relevance and fact association constraints. Tune lambda on development data. Compare against simpler duplicate-claim filtering. Required supported evidence and readable experience sections take precedence over diversity. Two different tools can be relevant despite similar wording; do not drop them just to increase novelty.

Start page fitting with deterministic greedy selection and actual render validation. ILP is deferred until simple selection has demonstrated coverage failures that a solver can improve without distorting factual wording.

## 6 Extraction and field classification

Extraction must retain exact evidence, offsets, alternatives, required/preferred wording, tool versus role years and explicit/unknown constraints. Ensure the model cannot introduce a requirement whose quote does not support it. Structural checks alone are insufficient; evaluate semantic labels manually.

Classify whole form questions, not just random input IDs. This is field/sequence classification. Token classification would label spans and is a different task. Use deterministic mappings first for proven controls; model proposals handle observed wording gaps.

Return canonical key, required context, candidate alternatives and abstention reason. A model's self-reported confidence is not a calibrated probability. Evaluate selective precision versus coverage and tune any threshold on development labels. Sensitive categories have separate tests for negation, current/future distinction, consent, optional response and conflicting options. Fuzzy matches may propose labels, never resolve sensitive answers alone.

## 7 Constrained generation and NLI

Use provider-supported JSON schema/grammar generation where available, then runtime validation. Limit fact/bullet IDs to known approved candidates if the decoder supports enumeration. Valid structure still permits false claims and wrong evidence; [structured generation documentation](https://huggingface.co/learn/cookbook/structured_generation) demonstrates why syntax and substance are separate.

Keep approved wording as the default. Optional rewrites must reference atomic source claims and pass deterministic checks for names, dates, quantities, tools and employment association. New or stronger claims require review. Example: a source saying “tested APIs” does not support “led API automation for 20 teams.”

NLI can flag a rewrite for review using source facts as premises and proposed claims as hypotheses. Neutral is unsupported by that comparison, not automatically fabricated. Entailment may be wrong. It cannot certify a resume. Compare multi-fact support and attribution; a skill from one project cannot be relocated to another employer. Use NLI only if it catches reviewed errors missed by simpler validation at acceptable cost.

## 8 Datasets and leakage controls

Minimum initial reviewed pool: 100 JDs, 100 requirement/fact retrieval cases and 200 field observations. Reserve at least 30 JDs, 30 retrieval cases and 60 fields held out. Split by company/template and posting/semantic family. Keep duplicated or paraphrased siblings in one split. Store label status, reviewer, provenance, family, split, model proposal and approved label separately.

Annotate required/preferred, alternatives, years scope, critical constraints, correct fact IDs, graded relevance if feasible, uncovered requirements and field keys. Include no-support cases and hard negatives, not only easy successful matches. Include enough sensitive-field examples to make the test informative; increase sample size when coverage is thin.

Do not tune prompts, thresholds, alias maps or ranks using held-out labels. Freeze hashes before experiments. Model proposals cannot approve themselves into gold. Do not train a custom transformer in this version unless an explicit bounded experiment and data adequacy review justifies a departure from the default.

## 9 E2E and model evaluation plan

Offline E2E uses recorded model outputs and actual downstream retrieval/validation/workflow. A separate real-model evaluation runs pinned artifacts on frozen examples and records accuracy/latency. Live API/inference tests are opt-in. Offline corpus benchmarks may run without network after models are deliberately provisioned; normal tests must never download them.

| Test ID | Trigger | Required oracle |
|---|---|---|
| V3-E01 | JD paraphrases an approved responsibility | Retrieval returns human-labeled useful fact IDs; plan provenance intact |
| V3-E02 | Rare terms such as KVM/C++/Sigma rules | Exact-term cases retained or surfaced as uncovered |
| V3-E03 | Fact is semantically related but lacks required tool | No invented tool claim or eligibility upgrade |
| V3-E04 | Required alternative vs preferred skill | Logical group and requirement levels preserved |
| V3-E05 | Long JD/fact exceeds encoder budget | Declared chunking; no silent loss of mandatory evidence |
| V3-E06 | Retrieval returns repeated evidence | Dedup/MMR reduces redundant claims without losing coverage |
| V3-E07 | No approved fact supports requirement | Explicit uncovered requirement; no generated substitute |
| V3-E08 | Fact edited or approval revoked | Cache invalidation; revoked content not selected/uploaded |
| V3-E09 | Model outputs wrong dimensions or invalid vector | Typed provider failure; no arbitrary ranking |
| V3-E10 | Reranker times out | Documented fallback to validated baseline or review; event recorded |
| V3-E11 | Ambiguous authorization/sponsorship wording | Abstention; sensitive answer remains unresolved |
| V3-E12 | Legal question label predicted correctly but fact absent | WAITING_FOR_USER; no guessed answer |
| V3-E13 | Valid JSON contains invented quote/claim | Evidence/factual validator rejects it |
| V3-E14 | Rewrite changes quantity, seniority or employer association | Rejected/reviewed; original approved wording retained |
| V3-E15 | NLI predicts entailment for an invalid rewrite | Independent fact gate still blocks the claim |
| V3-E16 | New semantic plan reaches form | Correct approved resume and controls; READY_TO_SUBMIT; zero submit |
| V3-E17 | Prompt injection in JD or field help | No unauthorized facts/actions; record source as data |

## 10 Metrics and admission gates

Report schema-and-evidence-valid JD fraction; required-skill precision and recall separately; alternative/scope accuracy; critical-constraint errors; retrieval Hit@5, Recall@10 and nDCG where labels support it; field selective precision and coverage; uncovered/no-support behavior; warm/cold p50/p95 latency, peak memory and per-job cost.

Proposed release targets: at least 95 percent structurally and evidence-valid JD outputs; at least 90 percent required-skill precision and recall; Hit@5 at least 90 percent on cases with useful approved evidence; field selective precision at least 95 percent with coverage disclosed; zero observed critical sensitive errors on held-out tests and complete abstention behavior for the tested unsupported cases. Report sample counts and uncertainty; a small zero-error sample is not a guarantee.

Set a measured hardware-specific latency budget before model comparison. An initial planning target is warm retrieval plus optional reranking p95 at or below one second, excluding cold loading/JD generation. If infeasible, prefer a simpler model or explicitly revise the budget based on user need. Do not claim sub-millisecond performance without measurement.

## 11 Required agent reasoning and implementation order

First freeze labels and current baseline. Then benchmark exact versus BM25 versus dense, fuse only if useful, rerank only after ablation, add diversity only if redundancy exists, and upgrade field classification separately. Finally rerun the complete form path and V2 recovery suite.

Compare TypeScript/ONNX execution with a small Python JSON worker only if runtime needs justify it. Compare retrieval-all-facts with a staged pipeline for a small corpus. Compare NLI screening with source-ID and deterministic claim checks. Document rejected experiments as well as wins. Feature flags must disable new model stages while preserving approved facts and state.

Deliver dataset manifest, split hashes, benchmark report, model/config registry, admission/rejection decisions, E2E evidence, exact cost/latency and remaining failure families. Better models are admitted by measured usefulness, not by complexity of the architecture diagram.
