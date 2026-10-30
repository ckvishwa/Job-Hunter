"""Batch runner selection and reporting helpers (pure functions; no Marker, no PDFs from the user's folders)."""
from __future__ import annotations

from batch_resumes import NA, doc_id, fmt_date, location_after_range, md_cell, select, structural_flags


def entries(*names: str) -> list[dict]:
    return [{"filename": n} for n in names]


def test_selection_is_case_insensitive_alphabetical_and_substitutes_the_preferred_file():
    names = [f"r{i:02d}.pdf" for i in range(12)] + ["Cloud_Resume.pdf", "zzz.pdf"]
    chosen, notes = select(entries(*names), 10, "cloud_resume.pdf")
    got = [c["filename"] for c in chosen]
    assert got[0] == "Cloud_Resume.pdf" and len(got) == 10 and not notes[0].startswith("Substitution")  # 'C' sorts before 'r'
    chosen, notes = select(entries(*[f"a{i}.pdf" for i in range(12)], "Zeta_Cloud.pdf"), 10, "Zeta_Cloud.pdf")
    assert chosen[-1]["filename"] == "Zeta_Cloud.pdf" and notes[0].startswith("Substitution") and "a7.pdf" in notes[0]


def test_selection_takes_all_when_fewer_than_requested_and_reports_missing_preferred():
    chosen, notes = select(entries("b.pdf", "a.pdf"), 10, "Cloud_Resume.pdf")
    assert [c["filename"] for c in chosen] == ["a.pdf", "b.pdf"] and "no substitution" in notes[0]


def test_report_helpers_use_not_found_and_escape_tables():
    assert fmt_date(None) == NA and fmt_date({"precision": "present", "value": None}) == "Present"
    assert md_cell("a|b\nc") == "a\\|b c"
    assert location_after_range("Acme 06/2021 - Present Remote") == "Remote" and location_after_range("no dates here") == NA
    assert doc_id(3, "My Resume (2).pdf") == "03-my-resume-2"


def test_structural_flags_mark_empty_results_for_review():
    empty = {"name": None, "email": None, "phone": None, "skills": [], "experience": [], "education": [], "certifications": [], "projects": []}
    flags = structural_flags(empty, "# EXPERIENCE\n\nstuff")
    assert {"NAME_MISSING", "NO_EMPLOYMENT", "NO_EDUCATION", "NO_SKILLS", "EXPERIENCE_SECTION_BUT_NO_RECORDS"} <= set(flags)
