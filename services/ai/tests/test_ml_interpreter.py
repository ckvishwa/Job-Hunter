"""Offline tests for the experiment's interpreter validation and scoring. Fake model responses; no Ollama, no network, no private resumes."""
from __future__ import annotations

import json

import pytest

from app.ml_interpreter import EvidenceIndex, ModelCall, OllamaInterpreter, validate
from eval.ml_score import aggregate, hallucinations, score_document, score_education, score_employment, score_names, score_skills

MD = ("# **Pat Doe**\n\npat@example.com +1 (555) 010-1234\n\n## **Experience**\n\n**Staff Engineer** Acme Corp *Jan 2020 – Dec 2022*\n\n- Built things.\n\n"
      "## **Skills**\n\n- **Languages:** Python, Java\n\n## **Projects**\n\n#### **Graph Tool** *2021*\n\n## **Education**\n\n**B.S. Computer Science** 2014 – 2018\n\n*State University, Ohio*\n")


def call(obj) -> ModelCall:
    return ModelCall(json.dumps(obj), 1.0, 10, 20)


def test_correct_values_with_a_misplaced_quote_are_supported_by_derived_evidence():
    r = validate(MD, call({"employment": [{"employer": "Acme Corp", "title": "Staff Engineer", "start": "Jan 2020", "end": "Dec 2022", "quote": "pat@example.com"}]}))
    assert r.validated["experience"] == [{"employer": "Acme Corp", "title": "Staff Engineer", "start": "Jan 2020", "end": "Dec 2022"}]
    assert r.validated["_modelQuoteSupport"] == {"checked": 1, "supported": 0}  # the model's own quote did not contain the values
    ev = r.evidence[0]
    assert MD[ev["start"]:ev["end"]] == ev["quote"] and "Acme Corp" in ev["quote"] and "Staff Engineer" in ev["quote"]


def test_invented_employer_or_dates_never_reach_validated_output():
    r = validate(MD, call({"employment": [{"employer": "Globex", "title": "Staff Engineer", "start": "2020", "end": "2022", "quote": "x"}],
                           "skills": [{"name": "Rust"}, {"name": "Python"}], "certifications": [{"name": "Invented Cert", "quote": "Invented Cert"}]}))
    assert r.validated["experience"] == [] and r.validated["skills"] == ["Python"] and r.validated["certifications"] == []
    assert len(r.unsupported) == 3 and r.status == "REVIEW"


def test_values_that_exist_but_are_far_apart_are_not_an_association():
    filler = "\n\n".join(f"Line {i} " + "x" * 80 for i in range(8))
    md = f"Staff Engineer\n\n{filler}\n\nAcme Corp 2020 - 2022\n"
    r = validate(md, call({"employment": [{"employer": "Acme Corp", "title": "Staff Engineer", "start": "2020", "end": "2022", "quote": "q"}]}))
    assert r.validated["experience"] == [] and r.unsupported


def test_review_required_records_are_kept_apart_from_validated_facts():
    r = validate(MD, call({"employment": [{"employer": "Acme Corp", "title": "Staff Engineer", "quote": "q", "status": "REVIEW_REQUIRED", "reason": "ambiguous"}]}))
    assert r.validated["experience"] == [] and r.review_required[0]["reason"] == "ambiguous" and r.status == "REVIEW"


def test_schema_errors_and_model_errors_are_typed_and_do_not_raise():
    assert validate(MD, ModelCall("not json", 1.0, None, None)).status == "SCHEMA_INVALID"
    assert validate(MD, call({"employment": [{"employer": "A", "title": "B", "quote": "q", "surprise": 1}]})).status == "SCHEMA_INVALID"  # extra=forbid
    assert validate(MD, ModelCall("", 5.0, None, None, "TimeoutError: timed out")).status == "MODEL_ERROR"


def test_evidence_ignores_markdown_markers_but_maps_back_to_the_stored_text():
    ix = EvidenceIndex.build("**Staff Engineer** Acme Corp *Jan 2020*")
    span = ix.locate("Staff Engineer Acme Corp Jan 2020")
    assert span is not None and ix.raw_slice(span) == "Staff Engineer** Acme Corp *Jan 2020"


def test_model_endpoint_must_be_loopback():
    with pytest.raises(ValueError):
        OllamaInterpreter(endpoint="https://api.example.com").call("text")


def test_skill_scoring_head_inner_label_and_false_positives():
    exp = ["Splunk (SPL, correlation, alert triage)", "Python", "Wireshark"]
    s = score_skills(["Splunk", "SPL", "Python", "Languages", "Ghost"], exp, ["Languages"])
    assert (s["tp"], s["fp"], s["fn"], s["innerTerms"], s["categoryLabelsAsSkills"]) == (2, 2, 1, 1, 1)
    assert s["missingItems"] == ["Wireshark"] and score_skills([], [], [])["precision"] is None  # zero denominators are not 0 or 1


def test_employment_scoring_requires_all_four_fields_and_reports_wrong_association():
    exp = [{"employer": "Acme", "title": "QA Engineer", "start": "2020-01", "end": "2021-12"}, {"employer": "Beta", "title": "Tester", "start": "2018", "end": "2019"}]
    pred = [{"employer": "Acme", "title": "QA Engineer", "start": "Jan 2020", "end": "Dec 2021"}, {"employer": "Beta", "title": "Tester", "start": "2018", "end": "2020"}]
    s = score_employment(pred, exp)
    assert (s["tp"], s["fp"], s["fn"]) == (1, 1, 1) and s["associationAccuracy"] == 0.5 and len(s["incorrectAssociations"]) == 1


def test_education_scoring_separates_wrong_and_missing_institution():
    exp = [{"degree": "M.S. Cyber", "institution": "University of A"}, {"degree": "B.Tech. CS", "institution": "College of B"}]
    s = score_education([{"degree": "M.S. Cyber", "institution": "College of B"}, {"degree": "B.Tech. CS", "institution": None}], exp)
    assert (s["correct"], s["wrongInstitution"], s["missingInstitution"]) == (0, 1, 1) and s["accuracy"] == 0.0
    c = score_education([{"combined": "M.S. Cyber, University of A, 2020"}], exp)
    assert c["correct"] == 1


def test_projects_match_on_the_title_head_and_hallucinations_use_the_source_text():
    assert score_names(["MalTrace"], ["MalTrace — Behavioral Pipeline"], True)["tp"] == 1
    bad = hallucinations({"skills": ["Python", "Cobol"], "experience": [{"employer": "Acme Corp", "title": "Ghost Title"}]}, MD)
    assert set(bad) == {"skill: Cobol", "title: Ghost Title"}


def test_document_and_aggregate_scoring_round_trip():
    label = {"name": "Pat Doe", "email": "pat@example.com", "phone": "+1 (555) 010-1234", "experience": [{"employer": "Acme Corp", "title": "Staff Engineer", "start": "2020-01", "end": "2022-12"}],
             "education": [{"degree": "B.S. Computer Science", "institution": "State University"}], "skills": ["Python", "Java"], "categories": ["Languages"], "certifications": [], "projects": ["Graph Tool"]}
    pred = {"name": "Pat Doe", "email": "pat@example.com", "phone": "+1 (555) 010-1234", "experience": [{"employer": "Acme Corp", "title": "Staff Engineer", "start": "Jan 2020", "end": "Dec 2022"}],
            "education": [{"degree": "B.S. Computer Science", "institution": "State University"}], "skills": ["Python", "Java"], "certifications": [], "projects": ["Graph Tool"]}
    d = score_document(pred, label, MD)
    agg = aggregate([d])
    assert agg["employment"]["f1"] == 1.0 and agg["skills"]["recall"] == 1.0 and agg["education"]["accuracy"] == 1.0 and agg["hallucinations"] == 0
    assert agg["certifications"]["precision"] is None  # nothing expected, nothing predicted -> NOT_MEASURED
