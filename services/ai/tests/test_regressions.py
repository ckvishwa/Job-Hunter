"""Regression cases from the first real cybersecurity resume review, rebuilt as SYNTHETIC text (no real person's data).
Expected values are hand-written from the text below, not produced by the parser."""
from __future__ import annotations

import json

from app.linebreaks import normalize_line_breaks
from app.offsets import Utf16Map
from app.parse_resume import PARSER_REVISION, parse_resume

SKILLS_WRAPPED = "\n".join([
    "Alex Sample",
    "alex@example.com",
    "Summary",
    "Security engineer with foundational knowledge of IAM and Ku-",
    "bernetes.",
    "Technical Skills",
    "Detection: Splunk, SPL, alert triage, detection engineering, event corre-",
    "lation, threat hunting, false-positive tuning, IOC extraction",
    "Automation: Python, PowerShell, security automa-",
    "tion, REST APIs, self-service portals, scripting, false-",
    "positive review, xylo-",
    "phone mapping, containers, network segmentation, log analysis, LLM agent",
    "orchestration, prompt engineering",
])


def facts_of(text: str, kind: str):
    return [f for f in parse_resume(text).facts if f.kind == kind]


def values(text: str, kind: str) -> set[str]:
    return {f.value for f in facts_of(text, kind)}


def test_parser_identifies_itself_with_the_new_revision():
    assert PARSER_REVISION == "resume-rules@3"


def test_broken_words_are_rejoined_and_quotes_stay_verbatim():
    out = parse_resume(SKILLS_WRAPPED)
    skills = {f.value: f for f in out.facts if f.kind == "skill"}
    assert "event correlation" in skills and "security automation" in skills
    assert "event corre-" not in skills and "lation" not in skills and "automa-" not in skills and "tion" not in skills
    # value is repaired; the quote is the exact original characters including the hyphen and line break
    assert skills["event correlation"].span.quote == "event corre-\nlation"
    assert skills["security automation"].span.quote == "security automa-\ntion"
    for f in out.facts:
        assert SKILLS_WRAPPED[f.span.start:f.span.end] == f.span.quote  # BMP-only text: UTF-16 == code point offsets


def test_wrap_without_hyphen_continues_the_last_list_item():
    skills = values(SKILLS_WRAPPED, "skill")
    assert "LLM agent orchestration" in skills
    assert "orchestration" not in skills and "LLM agent" not in skills
    quote = next(f for f in facts_of(SKILLS_WRAPPED, "skill") if f.value == "LLM agent orchestration").span.quote
    assert quote == "LLM agent\norchestration"


def test_legitimate_hyphens_survive_and_only_the_line_is_joined():
    skills = values(SKILLS_WRAPPED, "skill")
    assert "false-positive tuning" in skills  # hyphenated elsewhere mid-line
    assert "self-service portals" in skills  # normally-hyphenated prefix
    assert "false-positive review" in skills  # break after a hyphen the document itself uses mid-line


def test_ambiguous_break_is_left_alone_and_reported_never_guessed():
    out = parse_resume(SKILLS_WRAPPED)
    codes = [w.code for w in out.warnings]
    assert codes.count("LINE_HYPHEN_AMBIGUOUS") == 1
    w = next(w for w in out.warnings if w.code == "LINE_HYPHEN_AMBIGUOUS")
    assert SKILLS_WRAPPED[w.start:w.end] == "-\nphone"
    assert not any("xylophone" in f.value.lower() for f in out.facts)
    # the text is kept exactly as written (hyphen intact), never "repaired" into a word the document does not contain
    assert any(f.span.quote == "xylo-\nphone mapping" for f in out.facts if f.kind == "skill")


def test_normalizer_maps_every_view_character_back_to_the_original():
    nt = normalize_line_breaks(SKILLS_WRAPPED)
    assert nt.original == SKILLS_WRAPPED  # never mutated
    assert "event correlation" in nt.text and "event corre-" not in nt.text
    i = nt.text.index("event correlation")
    a, b = nt.to_original(i, i + len("event correlation"))
    assert SKILLS_WRAPPED[a:b] == "event corre-\nlation"
    # untouched text maps one to one
    j = nt.text.index("Splunk")
    assert nt.to_original(j, j + 6) == (SKILLS_WRAPPED.index("Splunk"), SKILLS_WRAPPED.index("Splunk") + 6)


def test_text_without_breaks_is_returned_unchanged():
    text = "Skills\nPython, SQL\nExperience\nNothing hyphenated here."
    nt = normalize_line_breaks(text)
    assert nt.text == text and nt.repaired == 0 and nt.origin == tuple(range(len(text) + 1))


EMPLOYMENT = "\n".join([
    "Alex Sample",
    "Experience",
    "Security Operations Vulnerability Analyst Intern Acme Systems Sep 2022 – May 2023",
    "◦ Assessed applications.",
    "Senior Support Engineer Support Services Group Jan 2020 - Mar 2021",
    "Globex Corp | Platform Engineer | Jun 2019 – Dec 2019",
])


def test_employment_splits_employer_title_and_dates_without_choosing_a_category():
    emp = {f.value: f for f in facts_of(EMPLOYMENT, "employment")}
    cognate = emp["Acme Systems — Security Operations Vulnerability Analyst Intern"]
    a = cognate.attributes.model_dump(exclude_none=True)
    assert {k: v for k, v in a.items() if k != "fieldSpans"} == {"employer": "Acme Systems", "title": "Security Operations Vulnerability Analyst Intern", "startDate": "2022-09", "endDate": "2023-05"}
    assert a["fieldSpans"]["title"]["quote"] == "Security Operations Vulnerability Analyst Intern"
    assert "employmentType" not in a  # "Intern" in a title never assigns a category
    assert "NOT assigned" in (cognate.notes or "") and "Verify the split" in (cognate.notes or "")
    assert EMPLOYMENT[cognate.span.start:cognate.span.end] == cognate.span.quote


def test_unclear_split_stays_unsplit_with_a_note():
    f = next(f for f in facts_of(EMPLOYMENT, "employment") if "Support Services Group" in f.value)
    assert f.attributes.employer is None and f.attributes.title is None
    assert f.value == "Senior Support Engineer Support Services Group"
    assert "could not be separated" in (f.notes or "")


def test_separated_employment_still_parses():
    f = next(f for f in facts_of(EMPLOYMENT, "employment") if f.value.startswith("Globex"))
    assert f.attributes.employer == "Globex Corp" and f.attributes.title == "Platform Engineer"


def test_internship_category_only_from_an_explicit_section_heading():
    text = "Alex Sample\nInternship Experience\nSOC Intern | Initech | Jun 2023 – Aug 2023"
    f = facts_of(text, "employment")[0]
    assert f.attributes.employmentType == "internship"
    assert "section heading" in (f.notes or "")


ACHIEVEMENT_SECTIONS = "\n".join([
    "Alex Sample",
    "Security Engineering Projects",
    "MalTrace — Automated Detection Platform 2026",
    "Python — Flask — SHAP — MITRE ATT&CK •github.com/example/maltrace",
    "◦ Built a detector; mapped 19 techniques.",
    "Detection Lab Feb 2026",
    "Splunk Enterprise — SPL — Sysmon — Active Directory — Windows — Kali Linux •github.com/example/soc-analyst-portfolio",
    "Certifications & Training",
    "CompTIA Security+ •MITRE ATT&CK Fundamentals •TryHackMe Top 5•HackTheBox Active Labs •Cisco Networking",
    "Basics",
    "Education",
    "M.S. Cybersecurity & Networks Aug 2023 – Dec 2025 Example University, CT[1pt]",
    "B.Tech. Computer Science Sep 2018 – May 2022 Example College, India",
])


def test_projects_with_mixed_case_heading_get_names_and_technologies_not_dates():
    projects = {f.value: f for f in facts_of(ACHIEVEMENT_SECTIONS, "project")}
    assert set(projects) == {"MalTrace", "Detection Lab"}
    assert projects["MalTrace"].attributes.technologies == ["Python", "Flask", "SHAP", "MITRE ATT&CK"]
    assert projects["Detection Lab"].attributes.technologies == ["Splunk Enterprise", "SPL", "Sysmon", "Active Directory", "Windows", "Kali Linux"]
    assert all(f.attributes.startDate is None for f in projects.values())  # a project is never employment time


def test_inline_bullet_certifications_and_wrapped_last_item():
    certs = {f.value: f for f in facts_of(ACHIEVEMENT_SECTIONS, "certification")}
    assert set(certs) == {"CompTIA Security+", "MITRE ATT&CK Fundamentals", "TryHackMe Top 5", "HackTheBox Active Labs", "Cisco Networking Basics"}
    assert certs["Cisco Networking Basics"].span.quote == "Cisco Networking\nBasics"
    assert "verify" in (certs["Cisco Networking Basics"].notes or "").lower()


def test_education_with_btech_and_latex_spacing_artifact():
    edu = values(ACHIEVEMENT_SECTIONS, "education")
    assert "M.S. Cybersecurity & Networks Aug 2023 – Dec 2025 Example University, CT" in edu
    assert "B.Tech. Computer Science Sep 2018 – May 2022 Example College, India" in edu
    assert not any(w.code == "PLACEHOLDER_SKIPPED" for w in parse_resume(ACHIEVEMENT_SECTIONS).warnings)


def test_non_bmp_text_keeps_utf16_offsets_after_a_repair():
    text = "Skills\nDetection: \U0001f600 SPL, event corre-\nlation, threat hunting"
    f = next(f for f in parse_resume(text).facts if f.value == "event correlation")
    units = text.encode("utf-16-le")
    assert units[2 * f.span.start:2 * f.span.end].decode("utf-16-le") == f.span.quote == "event corre-\nlation"
    assert Utf16Map(text).to_u16(text.index("event")) == f.span.start


def test_facts_are_json_serialisable_for_the_wire():
    json.dumps([f.model_dump(mode="json") for f in parse_resume(SKILLS_WRAPPED).facts])
