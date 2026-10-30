"""Candidate-fact proposals for an intake draft.

The grouping rules live in app/parse_markdown.py and have their own layout suite
(tests/test_markdown_layouts.py). These tests cover the join this module adds - which
page a record belongs to, what reaches the draft, and that a refusal is reported rather
than dropped - and the layouts the local intake path has to survive, over text and
fixtures built here. Expected values are written from those inputs, not from output.
"""
from __future__ import annotations

from app.candidate_reading import read_resume
from app.local_intake import intake_bytes
from tests.synthetic_pdfs import (
    linkedin_export,
    multipage_resume,
    plain_resume,
    projects_resume,
    two_column_resume,
    two_column_with_banner,
)


def reading_of(text: str):
    return read_resume(text)


def fields(reading) -> list[tuple[str, str, str, str]]:
    return [
        (c.employer, c.title, f"{c.start.precision}:{c.start.value}", f"{c.end.precision}:{c.end.value}")
        for c in reading.employment
    ]


def draft_reading(pdf: bytes):
    """What the worker would record for this document, pages included."""
    result = intake_bytes(pdf, "pdf")
    return result, read_resume(result.text, pages=[(p.index, p.start, p.end) for p in result.pages])


# ---------------------------------------------------------------------------------------------------------------------
# Layouts
# ---------------------------------------------------------------------------------------------------------------------

def test_single_line_employment():
    _, reading = draft_reading(plain_resume())
    assert fields(reading) == [
        ("Thistledown Analytics", "Senior QA Engineer", "month:2021-03", "present:None"),
        ("Fernbrook Systems", "QA Analyst", "month:2018-06", "month:2021-02"),
    ]
    assert reading.refused == []


def test_three_line_employment_company_then_title_then_dates():
    _, reading = draft_reading(two_column_resume())
    assert fields(reading) == [
        ("Umbral Defence Partners", "Security Analyst, Tier 2", "month:2022-05", "present:None"),
        ("Castellan Managed Services", "SOC Analyst, Tier 1", "month:2020-07", "month:2022-04"),
    ]


def test_reversed_order_title_then_company_then_dates():
    text = "EXPERIENCE\nSenior QA Engineer\nThistledown Analytics\nMarch 2021 - Present\n"
    reading = reading_of(text)
    # The title is found by its keywords, not by which line came first.
    assert fields(reading) == [("Thistledown Analytics", "Senior QA Engineer", "month:2021-03", "present:None")]


def test_multiple_consecutive_positions_in_one_section():
    text = (
        "EXPERIENCE\n"
        "Pallisade Cloudworks\nStaff Platform Engineer\nJanuary 2022 - Present\n"
        "Quillon Data Group\nSite Reliability Engineer\nAugust 2019 - December 2021\n"
        "Fernbrook Systems\nJunior Developer\nJune 2017 - July 2019\n"
    )
    assert [(e, t) for e, t, _, _ in fields(reading_of(text))] == [
        ("Pallisade Cloudworks", "Staff Platform Engineer"),
        ("Quillon Data Group", "Site Reliability Engineer"),
        ("Fernbrook Systems", "Junior Developer"),
    ]


def test_linkedin_style_export():
    _, reading = draft_reading(linkedin_export())
    assert fields(reading) == [
        ("Pallisade Cloudworks", "Staff Platform Engineer", "month:2022-01", "present:None"),
        ("Quillon Data Group", "Site Reliability Engineer", "month:2019-08", "month:2021-12"),
    ]


def test_two_column_resume_under_a_full_width_banner():
    _, reading = draft_reading(two_column_with_banner())
    assert [e for e, _, _, _ in fields(reading)] == ["Pallisade Cloudworks", "Quillon Data Group"]


# ---------------------------------------------------------------------------------------------------------------------
# What is refused
# ---------------------------------------------------------------------------------------------------------------------

def test_an_entry_without_dates_proposes_nothing():
    text = "EXPERIENCE\nPallisade Cloudworks\nStaff Platform Engineer\nBuilt the release tooling.\n"
    reading = reading_of(text)
    assert reading.employment == []
    # No date range, so there is nothing to anchor an entry on and no date is invented.
    assert all("present" not in str(c) for c in reading.employment)


def test_a_vague_date_line_anchors_nothing_and_invents_no_date():
    # "Sometime 2022 - whenever" is not a date range, so it never becomes an entry anchor and
    # the entry above it stays unimported. A refusal warning needs a range the parser matched
    # but could not read, which its range pattern does not produce from text like this.
    text = "EXPERIENCE\nPallisade Cloudworks\nStaff Platform Engineer\nSometime 2022 - whenever\n"
    reading = reading_of(text)
    assert reading.employment == []
    assert reading.refused == []


def test_a_refusal_carries_its_offsets_so_a_reviewer_can_find_it():
    text = "EXPERIENCE\nBrindlewick Holdings\nThistledown Group\nMarch 2021 - Present\n"
    reading = reading_of(text)
    refusal = next(r for r in reading.refused if r.code == "EMPLOYMENT_ROLE_AMBIGUOUS")
    assert refusal.start is not None and refusal.end is not None and refusal.end > refusal.start
    assert text[refusal.start : refusal.end].startswith("Brindlewick Holdings")


def test_an_ambiguous_employer_and_title_are_refused_not_guessed():
    # Neither line carries a title keyword, so which is the employer cannot be told.
    text = "EXPERIENCE\nBrindlewick Holdings\nThistledown Group\nMarch 2021 - Present\n"
    reading = reading_of(text)
    assert reading.employment == []
    assert "EMPLOYMENT_ROLE_AMBIGUOUS" in [r.code for r in reading.refused]


def test_an_inverted_year_range_is_refused():
    text = "EXPERIENCE\nDunsmere Payments\nSoftware Engineer II\nMarch 2021 - January 2019\n"
    reading = reading_of(text)
    assert reading.employment == []
    assert "EMPLOYMENT_INVALID" in [r.code for r in reading.refused]


def test_a_placeholder_entry_is_refused():
    text = "EXPERIENCE\n[Employer] - [Job Title] March 2021 - Present\n"
    reading = reading_of(text)
    assert reading.employment == []
    assert "PLACEHOLDER_SKIPPED" in [r.code for r in reading.refused]


def test_no_entry_is_built_across_a_section_boundary():
    # The employer-looking line belongs to EDUCATION. It must not be pulled into the job above.
    text = (
        "EXPERIENCE\n"
        "Staff Platform Engineer\nJanuary 2022 - Present\n"
        "EDUCATION\n"
        "Marchmont College\nBachelor of Engineering\n"
    )
    reading = reading_of(text)
    assert all(c.employer != "Marchmont College" for c in reading.employment)


# ---------------------------------------------------------------------------------------------------------------------
# Dates and evidence
# ---------------------------------------------------------------------------------------------------------------------

def test_a_year_only_range_keeps_year_precision_and_invents_no_month():
    text = "EXPERIENCE\nPallisade Cloudworks\nStaff Platform Engineer\n2019 - 2022\n"
    reading = reading_of(text)
    assert fields(reading) == [("Pallisade Cloudworks", "Staff Platform Engineer", "year:2019", "year:2022")]
    for candidate in reading.employment:
        assert candidate.start.value is not None and "-" not in candidate.start.value


def test_every_field_is_quoted_from_the_document():
    result, reading = draft_reading(two_column_resume())
    for candidate in reading.employment:
        for span in (candidate.evidence, candidate.employer_evidence, candidate.title_evidence):
            units = result.text.encode("utf-16-le")
            assert units[span.start * 2 : span.end * 2].decode("utf-16-le") == span.quote
        assert candidate.employer in candidate.employer_evidence.quote
        assert candidate.title in candidate.title_evidence.quote
        # The whole-record span covers the lines the entry was read from.
        assert candidate.employer in candidate.evidence.quote and candidate.title in candidate.evidence.quote


def test_a_record_is_attributed_to_the_page_it_was_printed_on():
    result, reading = draft_reading(multipage_resume())
    assert [c.page for c in reading.employment] == [1, 1]  # both jobs are on page 2 of the fixture
    assert all(result.pages[c.page].start <= c.evidence.start < result.pages[c.page].end for c in reading.employment)


def test_a_record_with_no_page_information_is_not_guessed_onto_page_one():
    reading = reading_of("EXPERIENCE\nPallisade Cloudworks\nStaff Platform Engineer\nJanuary 2022 - Present\n")
    assert [c.page for c in reading.employment] == [None]


def test_the_parser_revision_is_recorded():
    assert reading_of("EXPERIENCE\n").parser_revision == "marker-deterministic-v2"


def test_empty_text_proposes_nothing():
    assert read_resume("   ").employment == []
    assert read_resume("   ").refused == []


# ---------------------------------------------------------------------------------------------------------------------
# Skills, education, certifications, projects
# ---------------------------------------------------------------------------------------------------------------------

def test_grouped_technical_skills_keep_their_group_label():
    _, reading = draft_reading(plain_resume())
    assert [(s.value, s.category) for s in reading.skills] == [
        ("Playwright", "Automation"),
        ("Selenium", "Automation"),
        ("Cypress", "Automation"),
        ("Pytest", "Automation"),
        ("TypeScript", "Languages"),
        ("Python", "Languages"),
        ("SQL", "Languages"),
    ]


def test_linkedin_style_rail_skills_are_read_one_per_line():
    _, reading = draft_reading(linkedin_export())
    assert [s.value for s in reading.skills] == ["Kubernetes", "Terraform", "Go"]
    # No group label was printed, so none is invented.
    assert {s.category for s in reading.skills} == {None}


def test_skills_listed_individually_in_a_sidebar():
    _, reading = draft_reading(two_column_resume())
    assert [s.value for s in reading.skills] == ["Splunk", "Microsoft Sentinel", "KQL", "Incident triage"]


def test_a_bare_line_above_a_list_is_still_a_group_label_not_a_skill():
    # The rule that protects "Development Operations" from becoming a skill still holds when
    # the section does contain item-bearing lines.
    reading = reading_of("SKILLS\nDevelopment Operations\nJUnit, Jest, Mockito\n")
    assert [s.value for s in reading.skills] == ["JUnit", "Jest", "Mockito"]
    assert "Development Operations" not in {s.value for s in reading.skills}
    assert {s.category for s in reading.skills} == {"Development Operations"}


def test_an_employer_or_title_is_never_imported_as_a_skill():
    text = (
        "EXPERIENCE\nUmbral Defence Partners\nSecurity Analyst, Tier 2\nMay 2022 - Present\n"
        "SKILLS\nSplunk\nUmbral Defence Partners\nKQL\n"
    )
    values = {s.value for s in reading_of(text).skills}
    assert "Splunk" in values and "KQL" in values
    assert "Umbral Defence Partners" not in values


def test_a_placeholder_skill_is_refused_and_reported():
    reading = reading_of("SKILLS\nAutomation: Playwright, [Tool], Pytest\n")
    assert [s.value for s in reading.skills] == ["Playwright", "Pytest"]
    assert "PLACEHOLDER_SKIPPED" in [r.code for r in reading.refused]


def test_education_degree_and_institution_are_quoted_separately():
    _, reading = draft_reading(linkedin_export())
    assert len(reading.education) == 1
    record = reading.education[0]
    assert record.degree == "Bachelor of Engineering, Computer Engineering"
    assert record.institution == "Alderbury State University"
    assert record.graduation is not None and record.graduation.precision == "year" and record.graduation.value == "2019"
    assert record.institution_evidence is not None
    assert record.institution in record.institution_evidence.quote


def test_education_on_one_line_keeps_the_text_as_printed_without_splitting_it():
    # The institution is not separated on this layout. The degree text is what the document
    # printed, and no institution is guessed out of it.
    _, reading = draft_reading(plain_resume())
    record = reading.education[0]
    assert record.degree == "Bachelor of Science, Computer Science - Alderbury State University, 2018"
    assert record.institution is None


def test_certifications_drop_a_trailing_date_from_the_name():
    _, reading = draft_reading(plain_resume())
    assert [c.name for c in reading.certifications] == ["ISTQB Certified Tester Foundation Level"]


def test_a_repeated_page_footer_is_not_a_certification():
    _, reading = draft_reading(multipage_resume())
    names = [c.name for c in reading.certifications]
    assert names == ["SnowPro Core Certification"]
    assert not any("Page" in name for name in names)


def test_projects_carry_their_technologies_and_link():
    _, reading = draft_reading(projects_resume())
    assert [(p.name, p.technologies) for p in reading.projects] == [
        ("Threat Graph Explorer", ["Python", "NetworkX", "MITRE ATT&CK"]),
        ("Sigma Rule Linter", ["Python", "PyYAML", "Sigma"]),
    ]
    assert [p.url for p in reading.projects] == ["github.com/example/threat-graph", "github.com/example/sigma-linter"]
    assert all(p.description for p in reading.projects)


def test_a_project_with_no_technology_line_gets_an_empty_list_not_a_guess():
    reading = reading_of("PROJECTS\nThreat Graph Explorer\nMaps technique coverage across a detection library.\n")
    assert [p.name for p in reading.projects] == ["Threat Graph Explorer"]
    assert reading.projects[0].technologies == []


def test_every_category_quotes_its_own_text():
    result, reading = draft_reading(projects_resume())
    units = result.text.encode("utf-16-le")

    def slice_of(span) -> str:
        return units[span.start * 2 : span.end * 2].decode("utf-16-le")

    for record in reading.skills:
        assert slice_of(record.evidence) == record.evidence.quote
        assert record.value in record.evidence.quote
    for record in reading.education:
        assert slice_of(record.evidence) == record.evidence.quote
        assert record.degree in record.evidence.quote
    for record in reading.certifications:
        assert slice_of(record.evidence) == record.evidence.quote
        assert record.name in record.evidence.quote
    for record in reading.projects:
        assert slice_of(record.evidence) == record.evidence.quote
        assert record.name in record.evidence.quote


def test_every_category_is_attributed_to_a_page():
    _, reading = draft_reading(multipage_resume())
    assert [s.page for s in reading.skills] == [0, 0, 0, 0, 0]
    assert [e.page for e in reading.education] == [2]
    assert [c.page for c in reading.certifications] == [2]


def test_counts_cover_every_category():
    _, reading = draft_reading(projects_resume())
    assert reading.counts == {"employment": 1, "skills": 4, "education": 1, "certifications": 1, "projects": 2, "refused": 0}
