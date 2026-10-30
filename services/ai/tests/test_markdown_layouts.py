"""One test per confirmed layout defect from the 10-PDF batch. Inputs are synthetic Markdown shaped like Marker output
(no private resume text); expectations are written by hand from the source lines, not produced by the parser."""
from __future__ import annotations

from app.parse_markdown import clean_line, parse_markdown
from app.resume_schema import evidence_valid


def parse(md: str):
    ex = parse_markdown(md, source_hash="0" * 64)
    assert all(evidence_valid(f.evidence, ex.text) for f in ex.facts)  # quotes and offsets stay valid in every layout
    return ex


def emp(ex):
    return [(e.employer, e.title, e.start.value, e.end.value or e.end.precision) for e in ex.candidate.experience]


# ---- employment layouts ------------------------------------------------------------------------------------------

def test_layout1_bold_title_employer_italic_dates_on_one_line_without_separator():
    ex = parse("# **Pat Doe**\n\n# **Experience**\n\n**QA Automation Engineer** Fabrikam Software *Sep 2022 – May 2023*\n\n- Wrote tests.\n")
    assert emp(ex) == [("Fabrikam Software", "QA Automation Engineer", "2022-09", "2023-05")]
    assert ex.candidate.experience[0].ambiguity == []  # the emphasis boundary decided it, not a keyword guess


def test_layout1b_plain_unseparated_line_uses_title_keywords_and_is_flagged_medium():
    ex = parse("Pat Doe\n\n# EXPERIENCE\n\nSoftware Test Engineer II Contoso Labs Jan 2020 – Present\n")
    e = ex.candidate.experience[0]
    assert (e.employer, e.title, e.confidence) == ("Contoso Labs", "Software Test Engineer II", "medium") and e.ambiguity


def test_layout2_title_and_dates_on_one_line_employer_on_the_next_line():
    ex = parse("# Pat Doe\n\n## EXPERIENCE\n\n# Automation Testing Intern (Selenium + Java) Aug 2022 – Mar 2023\n\nCognizant Technology Solutions\n\n- Automated tests.\n")
    assert emp(ex) == [("Cognizant Technology Solutions", "Automation Testing Intern (Selenium + Java)", "2022-08", "2023-03")]


def test_layout3_employer_line_then_title_and_dates_line():
    ex = parse("Pat Doe\n\nWORK EXPERIENCE\n\nAdventure Works\nNetwork Operations Technician    Oct 2021 – Sep 2023\n- Monitored links.\nTailspin Toys\nJunior Network Analyst    Oct 2023 – Present\n")
    assert emp(ex) == [("Adventure Works", "Network Operations Technician", "2021-10", "2023-09"), ("Tailspin Toys", "Junior Network Analyst", "2023-10", "present")]


def test_layout4_title_heading_then_date_line_then_employer_below():
    ex = parse("# Pat Doe\n\n## **Experience**\n\n#### **Security Operations Analyst Intern**\n\n*Sep 2022 – May 2023*\n\n*Cognizant Technology Solutions*\n\n- Performed assessments.\n")
    assert emp(ex) == [("Cognizant Technology Solutions", "Security Operations Analyst Intern", "2022-09", "2023-05")]


def test_layout5_two_headings_above_date_line_with_bullets_and_year_only_dates():
    ex = parse("# PAT DOE\n\n# EXPERIENCE\n\n## Senior Full stack Developer\n\n#### **Boyle**\n\n2023 - 2025 San Fransisco, CA\n\n- Led a team.\n\n## Full Stack Developer\n\n#### **Lauzon**\n\n2019 - 2023 San Fransisco, CA\n")
    assert emp(ex) == [("Boyle", "Senior Full stack Developer", "2023", "2025"), ("Lauzon", "Full Stack Developer", "2019", "2023")]
    assert all(e.start.precision == "year" for e in ex.candidate.experience)  # no month invented


def test_layout6_separators_and_comma_form_still_work():
    ex = parse("Pat Doe\n\nEXPERIENCE\n\nQA Analyst | Acme Corp | Jan 2020 – Dec 2021\nTest Analyst, Litware Inc., Austin, TX   Jun 2019 – Feb 2020\n")
    assert emp(ex) == [("Acme Corp", "QA Analyst", "2020-01", "2021-12"), ("Litware Inc.", "Test Analyst", "2019-06", "2020-02")]


def test_ambiguous_employer_title_is_skipped_with_warning_not_guessed():
    ex = parse("Pat Doe\n\nEXPERIENCE\n\nAcme Labs Globex Ltd Jan 2020 – Dec 2021\n")
    assert ex.candidate.experience == [] and {"EMPLOYMENT_ROLE_MISSING", "EMPLOYMENT_ROLE_AMBIGUOUS"} & {w.code for w in ex.warnings}


# ---- markdown cleaning --------------------------------------------------------------------------------------------

def test_clean_line_strips_bold_and_italic_markers_but_keeps_exact_evidence():
    raw = "#### **Enterprise SOC Lab** *Feb 2026*"
    c = clean_line(raw, 100)
    assert c.text == "Enterprise SOC Lab Feb 2026" and c.level == 4
    s, e = c.span(0, len("Enterprise SOC Lab"))
    assert raw[s - 100:e - 100] == "Enterprise SOC Lab"
    assert c.bold and c.italic
    assert clean_line("5*3 equals 15", 0).text == "5*3 equals 15"  # a star inside a word is not emphasis


def test_project_names_and_dates_do_not_leak_markers():
    ex = parse("Pat Doe\n\n# Projects\n\n#### **Enterprise SOC Detection Lab** *Feb 2026*\n\nSplunk — Sysmon — Kali Linux • [github.com/x/y](https://github.com/x/y)\n\n- Built a lab.\n")
    p = ex.candidate.projects[0]
    assert p.name == "Enterprise SOC Detection Lab" and p.start.value == "2026-02" and p.technologies == ["Splunk", "Sysmon", "Kali Linux"] and p.url == "github.com/x/y"


# ---- education --------------------------------------------------------------------------------------------------

def edu(ex):
    return [(e.degree, e.institution, e.graduation.value if e.graduation else None) for e in ex.candidate.education]


def test_education_degree_then_institution_pairs_and_dates_leave_the_degree_text():
    ex = parse("Pat Doe\n\n### **Education**\n\n**M.S. Cybersecurity & Networks** Aug 2023 – Dec 2025\n\n*University of New Haven, New Haven, CT*\n\n**B.Tech. Computer Science** Sep 2018 – May 2022\n\n*Malla Reddy College of Engineering, India*\n")
    assert edu(ex) == [("M.S. Cybersecurity & Networks", "University of New Haven", "2025-12"), ("B.Tech. Computer Science", "Malla Reddy College of Engineering", "2022-05")]


def test_education_institution_then_degree_pairs():
    ex = parse("Pat Doe\n\n#### EDUCATION\n\n## University of New Haven Aug 2023 – Dec 2025\n\nMaster of Science in Cybersecurity & Networks\n\n# Mallareddy College 2018 – 2022\n\nBachelor of Science in Computer Science\n")
    assert edu(ex) == [("Master of Science in Cybersecurity & Networks", "University of New Haven", "2025-12"), ("Bachelor of Science in Computer Science", "Mallareddy College", "2022")]


def test_education_institution_on_the_same_line_as_degree():
    ex = parse("Pat Doe\n\n## EDUCATION\n\nM.S. in Computer Science **Stanford Unversity**\n\n2015 Palo Alto, CA\n")
    assert edu(ex) == [("M.S. in Computer Science", "Stanford Unversity", "2015")]


def test_education_institution_in_italics_on_the_degree_line_drops_the_location():
    ex = parse("Pat Doe\n\n### **Education**\n\n**B.Tech. Computer Science** Sep 2018 – May 2022 *Malla Reddy College of Engineering, India*\n")
    assert edu(ex) == [("B.Tech. Computer Science", "Malla Reddy College of Engineering", "2022-05")]


def test_education_pairing_that_is_not_one_to_one_is_left_unassigned():
    ex = parse("Pat Doe\n\n### **Education**\n\n**M.S. Cybersecurity** Aug 2023 – Dec 2025\n\n**B.Tech. Computer Science** Sep 2018 – May 2022\n\n*Malla Reddy College of Engineering, India*\n\n*University of New Haven, New Haven, CT*\n")
    assert [e.institution for e in ex.candidate.education] == [None, None]
    assert "EDUCATION_PAIRING_AMBIGUOUS" in {w.code for w in ex.warnings} and all(e.ambiguity for e in ex.candidate.education)


def test_education_without_a_heading_needs_degree_line_plus_institution_line():
    ex = parse("Pat Doe\n\n# EXPERIENCE\n\n# Master of Science in Computer Science\n\nStanford University 2018 Stanford, California\n")
    assert edu(ex) == [("Master of Science in Computer Science", "Stanford University", "2018")]
    assert ex.candidate.education[0].confidence == "medium" and ex.candidate.education[0].ambiguity
    lone = parse("Pat Doe\n\n# EXPERIENCE\n\n# Master of Science in Computer Science\n\n- Mentored students.\n")
    assert lone.candidate.education == []  # a degree phrase alone is not enough evidence


# ---- sidebar and skills -----------------------------------------------------------------------------------------

def test_sidebar_before_the_name_does_not_leak_into_certifications_and_name_is_found():
    md = "### Contact\n\n8605550100 (Mobile) [a@b.example](mailto:a@b.example)\n\n### Certifications\n\nNetworking Basics\n\n# Jordan Rivers\n\nSOC Analyst | Detection Engineering | Splunk, Python\n\nNew York City Metropolitan Area\n\n# Experience\n"
    ex = parse(md)
    assert ex.candidate.name.value == "Jordan Rivers" and "sidebar" in ex.candidate.name.ambiguity[0]
    assert [c.name for c in ex.candidate.certifications] == ["Networking Basics"]
    assert ex.candidate.email.value == "a@b.example"


def test_bold_category_labels_are_never_skills_and_items_keep_their_category():
    ex = parse("Pat Doe\n\n## **Technical Skills**\n\n- **Security Engineering:** attack-path modeling, IAM design • **Cloud/IAM:** AWS IAM, zero-trust concepts\n- **Networking:** Wireshark, Nmap **Ticketing:** Jira\n")
    pairs = [(s.value, s.category) for s in ex.candidate.skills]
    assert pairs == [("attack-path modeling", "Security Engineering"), ("IAM design", "Security Engineering"), ("AWS IAM", "Cloud/IAM"), ("zero-trust concepts", "Cloud/IAM"),
                     ("Wireshark", "Networking"), ("Nmap", "Networking"), ("Jira", "Ticketing")]
    assert not {"Security Engineering", "Cloud/IAM", "Networking", "Ticketing"} & {s.value for s in ex.candidate.skills}


def test_parenthetical_detail_does_not_swallow_the_skill_name():
    ex = parse("Pat Doe\n\n## Skills\n\n- **Tools:** Python (NetworkX, graph algorithms, automated test suites), PowerShell\n")
    assert [s.value for s in ex.candidate.skills] == ["Python", "PowerShell"]


def test_labels_glued_by_markdown_split_on_acronyms_and_otherwise_warn_instead_of_guessing():
    ex = parse("Pat Doe\n\n# TECHNICAL SKILLS\n\nLanguages: Python, Java, SQL Test Automation: Selenium WebDriver\nOffensive: Burp Suite, Nmap Malware & RE: Ghidra, YARA\n")
    pairs = [(s.value, s.category) for s in ex.candidate.skills]
    assert ("SQL", "Languages") in pairs and ("Selenium WebDriver", "Test Automation") in pairs  # acronym first word is its own skill
    assert ("Ghidra", None) in pairs and "Nmap" not in {v for v, _ in pairs}  # "Nmap Malware & RE" is not split by guesswork
    assert "SKILL_LABEL_GLUED" in {w.code for w in ex.warnings}


def test_bare_group_heading_lines_are_categories_not_skills():
    ex = parse("Pat Doe\n\n## SKILLS\n\nDevelopment Operations\n\n**JUnit** , **Jest**\n")
    assert [(s.value, s.category) for s in ex.candidate.skills] == [("JUnit", None), ("Jest", None)] or [s.value for s in ex.candidate.skills] == ["JUnit", "Jest"]
    assert "Development Operations" not in {s.value for s in ex.candidate.skills}
