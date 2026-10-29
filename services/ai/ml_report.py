"""Render private-runtime/resume-ml-experiment-01/report.md from results.json + freeze.json. No model calls; no new measurements."""
from __future__ import annotations

import json
import sys
from pathlib import Path

NM = "NOT_MEASURED"
PRIMARY = "ml_v1"  # the first configuration run, fixed before the others; the rest are ablations
UPSTREAM = {
    "doc-02": "Marker dropped the 'EDUCATION' heading (education appears as a stray heading under Experience); e-mail is only the hyperlink label 'Email'.",
    "doc-03": "Marker lost the line-wrap hyphen in 'post-incident reporting' (emitted 'postincident').",
    "doc-04": "Marker emitted both institution lines AFTER both degree lines, in the opposite order to the PDF; pairing degree to institution from the Markdown is impossible.",
    "05-new-resume-2": "Skill chips were classified as Figure and dropped by Marker (recovered by the harness's figure-text step); e-mail is only a hyperlink label.",
    "06-profile": "Sidebar-first layout; Marker joined employer / title / dates into one line, merged the three Top Skills into one line and the two certifications into one.",
    "07-rendercv-sb2nov-theme-6": "Marker merged the two certification lines and joined skill category lines into one paragraph (glued labels); right-aligned 'Independent Project' tag is on the project title line.",
}


def f(x, pct=True, nd=3):
    if x is None:
        return NM
    return f"{x * 100:.1f}%" if pct else f"{x:.{nd}f}"


def main() -> int:
    exp = Path(sys.argv[1])
    res = json.loads((exp / "results.json").read_text(encoding="utf-8"))
    fr = json.loads((exp / "freeze.json").read_text(encoding="utf-8"))
    labels = json.loads((exp / "labels" / "labels.json").read_text(encoding="utf-8"))
    docs = list(labels["documents"])
    n_exp = {k: sum(len(labels["documents"][d][k]) for d in docs) for k in ("experience", "education", "skills", "certifications", "projects")}
    cols = [("rules@2 prod", "prod_rules"), ("Rules v2", "rules_v2"), ("ML " + PRIMARY, PRIMARY)]
    A = {k: res[v]["aggregate"] for _, k in [(a, b) for a, b in cols] for v in [k]}
    out = []
    w = out.append
    w("# Experiment 01 — pretrained model vs deterministic rules (private)\n")
    w("**Diagnostic only.** These ten PDFs already shaped Parser v2 and the Marcus Hall file is a development benchmark, so nothing here is independent generalization evidence. "
      "Labels were typed from the rendered original PDFs by the same Claude session that ran the experiment (single reviewer, not a human label set); the model under test never saw them.\n")
    w("## Frozen setup\n")
    w(f"- Branch `{fr['branch']}` HEAD `{fr['head'][:10]}`; {len(fr['worktreeStatus'])} untracked/changed paths preserved.")
    w(f"- Production parser: {fr['parsers']['production']} (reported revision `{fr['parsers'].get('productionRevisionReported')}`).")
    w(f"- Deterministic: {fr['parsers']['deterministicV2']}.")
    m = fr["model"]
    w(f"- Model: `{m['name']}` digest `{(m['digest'] or '')[:16]}`, {m['details'].get('parameter_size')} {m['details'].get('quantization_level')}, Ollama {m['ollama']}; temperature 0, seed 0, num_ctx 8192, num_predict 4096, local loopback only.")
    w(f"- Input: {fr['inputExtraction']}. Labels sha256 `{fr['labelsSha256'][:16]}`.")
    w("- Input PDF hashes (all 10 matched the frozen manifest):\n")
    w("| Document | SHA-256 |\n|---|---|")
    for d, h in fr["hashes"].items():
        w(f"| {h['filename']} | `{h['actual']}` |")
    w(f"\nLabeled denominators: employment records {n_exp['experience']}, education records {n_exp['education']}, skills {n_exp['skills']}, certifications {n_exp['certifications']}, projects {n_exp['projects']} across {len(docs)} documents.\n")

    w("## Comparison (like-for-like Markdown input: Rules v2 vs ML; production rules@2 uses pdfplumber text and is separate)\n")
    w("| Metric | rules@2 (prod, pdfplumber) | Rules v2 (Markdown) | ML " + PRIMARY + " (Markdown) |\n|---|---|---|---|")

    def row(name, fn):
        w(f"| {name} | " + " | ".join(fn(res[k]) for _, k in cols) + " |")

    row("Employment precision", lambda r: f(r["aggregate"]["employment"]["precision"]))
    row("Employment recall", lambda r: f(r["aggregate"]["employment"]["recall"]))
    row("Association accuracy (employer+title+dates)", lambda r: f(r["aggregate"]["employment"]["associationAccuracy"]))
    row("Skills precision", lambda r: f(r["aggregate"]["skills"]["precision"]))
    row("Skills recall", lambda r: f(r["aggregate"]["skills"]["recall"]))
    row("Category labels emitted as skills", lambda r: str(r["aggregate"]["categoryLabelsAsSkills"]))
    row("Education accuracy (degree+institution)", lambda r: f(r["aggregate"]["education"]["accuracy"]))
    row("Certification precision / recall", lambda r: f"{f(r['aggregate']['certifications']['precision'])} / {f(r['aggregate']['certifications']['recall'])}")
    row("Project precision / recall", lambda r: f"{f(r['aggregate']['projects']['precision'])} / {f(r['aggregate']['projects']['recall'])}")
    row("Hallucinated values (not in source text)", lambda r: str(r["aggregate"]["hallucinations"]))
    row("Schema validation", lambda r: f"{r['schemaValid']}/10")
    row("Evidence validation", lambda r: f"{r['evidenceValid']}/{r['evidenceChecked']}" if r["evidenceChecked"] else NM)
    row("Average latency per PDF", lambda r: f"{r['avgSeconds']:.3f} s" if r["avgSeconds"] is not None else NM)
    row("p95 latency", lambda r: f"{r['p95Seconds']:.3f} s" if r["p95Seconds"] is not None else NM)
    row("Peak memory", lambda r: (f"Ollama {r['peakMemory']['ollamaPeakWorkingSetMiB']} MiB RAM, GPU {r['peakMemory']['gpuUsedMiBMax']} MiB / 4096" if "ollamaPeakWorkingSetMiB" in r["peakMemory"] else f"{r['peakMemory']['peakPythonKiBMax']} KiB (Python heap, tracemalloc)"))
    w("\nHallucinated values are counted by checking each predicted value against the source text, independent of the evidence gate. The ML column is AFTER the evidence gate; "
      "before it, the model's own claims that could not be located were: " + ", ".join(f"{k}: {res[k]['rawUnsupportedClaims']}" for k in res if k.startswith("ml_")) + ".\n")
    w("Production rules@2 note: it emits no structured education fields (one text line), so education is matched by containment and scores 0 by design; its year-only employment dates are skipped by policy.\n")

    w("## All model configurations (ablations)\n")
    w("| Config | Employment P / R | Skills P / R | Edu acc | Certs P / R | Projects P / R | Labels-as-skills | Schema valid | Review-required records | Failed docs | Avg s |\n|---|---|---|---|---|---|---|---|---|---|---|")
    for k in [k for k in res if k.startswith("ml_")]:
        r = res[k]
        a = r["aggregate"]
        w(f"| {k} | {f(a['employment']['precision'])} / {f(a['employment']['recall'])} | {f(a['skills']['precision'])} / {f(a['skills']['recall'])} | {f(a['education']['accuracy'])} | "
          f"{f(a['certifications']['precision'])} / {f(a['certifications']['recall'])} | {f(a['projects']['precision'])} / {f(a['projects']['recall'])} | {a['categoryLabelsAsSkills']} | {r['schemaValid']}/10 | {r['reviewRequiredRecords']} | {r['failedDocuments']} | {r['avgSeconds']:.1f} |")
    w("\nv1/v2 = prompt versions (v2 adds generic clarifications); `_req` = every JSON key required in the decoding schema. Four configurations were run in total; no other tuning happened.\n"
      "Contacts (name/email/phone): the model returned none in any configuration (null or omitted), so contact extraction by the model is 0 of the labeled values.\n")

    w("## Per PDF\n")
    for d in docs:
        w(f"### {d}\n")
        w("| Method | Employment TP/FP/FN | Incorrect associations | Skills TP/FP/FN | Edu correct | Certs TP/FP/FN | Projects TP/FP/FN | Contacts | Hallucinated | Status/failure |\n|---|---|---|---|---|---|---|---|---|---|")
        for label, k in cols + [("ML v2 (ablation)", "ml_v2")]:
            x = res[k]["documents"][d]
            s = x["score"]
            e, sk, ce, pr = s["employment"], s["skills"], s["certifications"], s["projects"]
            w(f"| {label} | {e['tp']}/{e['fp']}/{e['fn']} | {len(e['incorrectAssociations'])} | {sk['tp']}/{sk['fp']}/{sk['fn']} | {s['education']['correct']}/{s['education']['expected']} | {ce['tp']}/{ce['fp']}/{ce['fn']} | {pr['tp']}/{pr['fp']}/{pr['fn']} | "
              f"{'/'.join(v[0] for v in s['contacts'].values())} | {len(s['hallucinations'])} | {x['status'] or 'ok'}{(' ' + x['error']) if x['error'] else ''} |")
        mlx = res[PRIMARY]["documents"][d]["score"]["employment"]
        if mlx["falsePositiveRecords"]:
            w(f"\nML false-positive employment records: {mlx['falsePositiveRecords']}")
        if d in UPSTREAM:
            w(f"\nUpstream Markdown limitation: {UPSTREAM[d]}")
        w("")

    w("## Observations\n")
    w("- The 3B model reads simple layouts well: on documents with one clearly written job it returned the right employer/title/dates (13 of 14 employment records matched), and project names were mostly right.")
    w("- It fails on the relationships that matter for the product: it repeatedly listed degrees as employment (university as employer), returned education without institutions, "
      "skipped whole sections (contacts, certifications) and emitted category labels as skills (39 in v1). Prompt v2 improved skills precision but made it drop employment in 9 of 10 documents.")
    w("- Requiring every key in the decoding schema (`_req`) made it worse: it marked nearly every record REVIEW_REQUIRED with incoherent reasons, and 3–4 documents failed schema validation (for example output truncated at 4096 tokens).")
    w("- Evidence gate: the model's own quotes supported their records in only a small minority of cases (see `modelQuoteSupport` in results.json), so evidence had to be derived by locating the model's values together in the source; nothing unsupported reached the validated output.")
    w("- Rules v2 numbers are inflated for these files: they were used to build and tune it. The production rules@2 numbers are the honest baseline for 'what runs today'.")
    w("- Not run: per-section prompting, a larger model, a different small model (phi4-mini and llama3.2:3b are installed but were not tested), or fine-tuning.\n")

    w("## Decision\n")
    w("**KEEP RULES** (deterministic Parser v2 as the extraction path; resume-rules@2 remains what production runs until v2 is wired in and tested on unseen templates).\n")
    w("- The pretrained model did not demonstrate improvement: employment precision 76.5% vs 100.0%, skills recall 22.4% vs 97.2%, education 0/18 vs 16/18, certifications recall 5.6% vs 88.9%, and it extracted no contacts. It is also ~600x slower (10.2 s vs 0.016 s per PDF) and uses ~4 GB RAM / the full 4 GB GPU.")
    w("- Fine-tuning is not justified yet: only 10 PDFs from about 4 template families are labeled (14 employment records), all already used in development; there is no train/validation/held-out split, and the failures are partly upstream (Marker joins and reorders lines) rather than model-correctable. "
      "A fine-tuning candidate decision needs at least: a few dozen independently human-labeled résumés across 8+ template families, frozen held-out templates, a per-section prompting baseline, and a second model (e.g. phi4-mini) compared on the same labels.")
    w("- Before any production migration, run a separate evaluation on previously unseen résumé templates with human labels.\n")
    w("## Evidence paths\n")
    w("- `freeze.json`, `results.json`, `labels/labels.json`, `inputs/*.md`, `rules_v2/`, `prod_rules/all.json`, `ml_v1|ml_v2|ml_v1_req|ml_v2_req/<doc>/{raw_response,validated,run}.json`, `run.log`, `run_req.log`.")
    (exp / "report.md").write_text("\n".join(out) + "\n", encoding="utf-8")
    print("report written", exp / "report.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
