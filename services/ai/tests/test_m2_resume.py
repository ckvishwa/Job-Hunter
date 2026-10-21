"""M2 behavior checks from independently specified synthetic text/PDF layouts."""
from __future__ import annotations

import hashlib
import io

from app.extract_text import extract_pdf
from app.parse_resume import parse_resume


def facts(text: str, kind: str):
    return [f for f in parse_resume(text).facts if f.kind == kind]


def assert_spans(text: str) -> None:
    for fact in parse_resume(text).facts:
        assert text.encode("utf-16-le")[2 * fact.span.start:2 * fact.span.end].decode("utf-16-le") == fact.span.quote


def test_combined_education_certification_has_stable_values_and_field_evidence():
    text = "\n".join(("Maya Brooks", "EDUCATION AND CERTIFICATIONS",
                      "B.S. Computer Science | Lakeshore State College | May 2026",
                      "ISTQB Certified Tester Foundation Level | ISTQB | Jul 2026"))
    education = facts(text, "education")
    certification = facts(text, "certification")
    assert [f.value for f in education] == ["B.S. Computer Science"]
    assert [f.value for f in certification] == ["ISTQB Certified Tester Foundation Level"]
    assert education[0].attributes.institution == "Lakeshore State College"
    assert education[0].attributes.graduationDate == "2026-05"
    assert certification[0].attributes.issuer == "ISTQB"
    assert certification[0].attributes.certificationDate == "2026-07"
    assert education[0].attributes.fieldSpans["institution"].quote == "Lakeshore State College"
    assert certification[0].attributes.fieldSpans["issuer"].quote == "ISTQB"
    assert_spans(text)


def test_standalone_education_associates_adjacent_institution_and_date():
    text = "Maya Brooks\nEDUCATION\nB.S. Information Systems\nFront Range Technical College\nDec 2019\nSKILLS\nPython"
    got = facts(text, "education")
    assert len(got) == 1
    assert got[0].attributes.institution == "Front Range Technical College"
    assert got[0].attributes.graduationDate == "2019-12"
    assert got[0].attributes.fieldSpans["institution"].quote == "Front Range Technical College"
    assert_spans(text)


def test_nested_slash_skills_keep_compound_names():
    text = "\n".join(("Ethan Vale", "CORE SKILLS", "Languages",
                      "Python / PowerShell / SQL / Bash", "Cloud & CI", "AWS / Docker / CI/CD / REST APIs",
                      "EXPERIENCE", "No dated employment stated."))
    assert {f.value for f in facts(text, "skill")} == {"Python", "PowerShell", "SQL", "Bash", "AWS", "Docker", "CI/CD", "REST APIs"}
    assert_spans(text)


def test_multiline_employment_ignores_location_and_continues_after_page_header():
    text = "\n".join(("Ethan Vale", "EXPERIENCE", "Security Automation Engineer",
                      "Redwood Signal Labs | Denver, CO | Feb 2023 - Present", "ETHAN VALE", "PAGE 2 OF 2",
                      "EXPERIENCE CONTINUED", "Junior SOC Analyst",
                      "Silvercrest Digital Services | Fort Collins, CO | Jan 2020 - May 2021"))
    got = facts(text, "employment")
    assert [(f.attributes.employer, f.attributes.title, f.attributes.startDate,
             f.attributes.endDate, f.attributes.current) for f in got] == [
                 ("Redwood Signal Labs", "Security Automation Engineer", "2023-02", None, True),
                 ("Silvercrest Digital Services", "Junior SOC Analyst", "2020-01", "2021-05", None)]
    assert got[0].attributes.fieldSpans["title"].quote == "Security Automation Engineer"
    assert got[0].attributes.fieldSpans["employer"].quote == "Redwood Signal Labs"
    assert_spans(text)


def test_three_line_employment_requires_title_company_and_month_dates():
    text = "Avery Kellan\nEXPERIENCE\nQuality Engineer\nHarborview Analytics\nMar 2022 - Jun 2025\nSKILLS\nPython"
    got = facts(text, "employment")
    assert [(f.attributes.employer, f.attributes.title, f.attributes.startDate, f.attributes.endDate) for f in got] == [
        ("Harborview Analytics", "Quality Engineer", "2022-03", "2025-06")]
    assert got[0].attributes.fieldSpans["employer"].quote == "Harborview Analytics"
    assert_spans(text)


def test_enterprise_program_and_wrapped_description_make_one_project():
    text = "\n".join(("Jordan Ellis", "ENTERPRISE PROGRAMS", "Cloud Control Evidence Pipeline",
                      "Compared inventory snapshots against approved baselines and generated human-readable",
                      "risk reports for misconfigured sandbox resources.", "Technologies: AWS, Terraform, Python",
                      "TECHNICAL & ORGANIZATIONAL EXPERTISE", "Engineering: Python, Go, SQL"))
    projects = facts(text, "project")
    assert [f.value for f in projects] == ["Cloud Control Evidence Pipeline"]
    assert projects[0].attributes.technologies == ["AWS", "Terraform", "Python"]
    assert projects[0].attributes.description.startswith("Compared inventory snapshots")
    assert {f.value for f in facts(text, "skill")} == {"Python", "Go", "SQL"}
    assert_spans(text)


def test_credential_metadata_lines_do_not_become_credentials():
    text = "\n".join(("Ethan Vale", "CERTIFICATIONS", "CompTIA Security+", "CompTIA | Nov 2022",
                      "AWS Certified Security - Specialty", "AWS | Apr 2025"))
    got = facts(text, "certification")
    assert [(f.value, f.attributes.issuer, f.attributes.certificationDate) for f in got] == [
        ("CompTIA Security+", "CompTIA", "2022-11"),
        ("AWS Certified Security - Specialty", "AWS", "2025-04")]
    assert_spans(text)


def _pdf_with_columns() -> bytes:
    def esc(s: str) -> bytes:
        return s.encode("cp1252").replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
               b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
               b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
               b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>"]
    commands = []
    for x, y, value in ((45, 755, "Casey Rowan"), (45, 735, "casey@example.com"),
                        (45, 650, "CORE SKILLS"), (45, 625, "Python / SQL / Docker"),
                        (300, 650, "EXPERIENCE"), (300, 625, "Platform Engineer"),
                        (300, 605, "Pinecrest Systems | Apr 2021 - Present")):
        commands.append(b"BT /F1 10 Tf " + str(x).encode() + b" " + str(y).encode() + b" Td (" + esc(value) + b") Tj ET\n")
    stream = b"".join(commands)
    objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"endstream")
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(out.tell())
        out.write(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects)+1}\n".encode() + b"0000000000 65535 f \n")
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def test_pdf_columns_are_read_down_each_column_before_crossing():
    doc = extract_pdf(_pdf_with_columns())
    assert doc.page_count == 1
    assert doc.text.index("CORE SKILLS") < doc.text.index("Python / SQL / Docker") < doc.text.index("EXPERIENCE")
    assert doc.text.index("Platform Engineer") < doc.text.index("Pinecrest Systems")
    assert {f.value for f in facts(doc.text, "skill")} == {"Python", "SQL", "Docker"}
    assert hashlib.sha256(doc.text.encode()).hexdigest()


def test_sensitive_terms_still_generate_warnings_without_facts():
    text = "Jordan Ellis\nSUMMARY\nU.S. citizen with a security clearance."
    result = parse_resume(text)
    assert {w.code for w in result.warnings} == {"SENSITIVE_TERM_NOT_IMPORTED"}
    assert not any(f.kind in {"citizenship", "clearance", "work_authorization", "sponsorship_need"} for f in result.facts)
