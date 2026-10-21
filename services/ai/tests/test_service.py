"""Service-level behavior: authentication, typed errors, size limits, safe DOCX handling, and the optional Qwen fallback
(exercised with a mocked Ollama transport; no model runs in tests)."""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import Settings, create_app
from app.qwen_fallback import QwenFallback
from tests.builders import build_docx, build_pdf

TOKEN = "s" * 40


def make_client(qwen: QwenFallback | None = None) -> TestClient:
    qwen = qwen or QwenFallback(False, "http://127.0.0.1:11434", "qwen2.5:3b-instruct-q4_K_M")
    return TestClient(create_app(Settings(service_token=TOKEN, qwen=qwen)))


def post(client: TestClient, data: bytes, file_type: str = "pdf", token: str | None = TOKEN):
    headers = {"content-type": "application/octet-stream"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    return client.post(f"/internal/v1/ai/extract-resume?fileType={file_type}", content=data, headers=headers)


def test_requires_the_service_token():
    c = make_client()
    assert post(c, b"x", token=None).status_code == 401
    assert post(c, b"x", token="wrong" * 8).status_code == 401
    assert c.get("/internal/v1/ai/info").status_code == 401
    assert c.get("/internal/v1/ai/info", headers={"authorization": f"Bearer {TOKEN}"}).json()["schemaRevision"] == 1


def test_no_interactive_docs_exposed():
    c = make_client()
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert c.get(path).status_code == 404


def test_rejects_unknown_file_type():
    assert post(make_client(), b"x", file_type="exe").json()["error"]["code"] == "UNSUPPORTED_FILE_TYPE"


def test_encrypted_pdf_is_password_protected_not_unreadable():
    data = (Path(__file__).parent / "fixtures" / "encrypted-minimal.pdf").read_bytes()
    assert post(make_client(), data).json()["error"]["code"] == "ENCRYPTED_PDF"


def test_corrupt_files_are_typed_errors_not_500s():
    c = make_client()
    assert post(c, b"%PDF-1.4 not really a pdf").json()["error"]["code"] == "UNREADABLE_FILE"
    assert post(c, b"PK\x03\x04garbage", "docx").json()["error"]["code"] == "UNREADABLE_FILE"


def test_docx_with_entity_declaration_is_refused():
    bomb = '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaa">]>'
    data = build_docx(["Jordan Rivers", "x" * 200], extra_body_prefix=bomb)
    assert post(make_client(), data, "docx").json()["error"]["code"] == "UNSAFE_DOCX"


def test_docx_without_body_is_typed():
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("other.xml", "<a/>")
    assert post(make_client(), out.getvalue(), "docx").json()["error"]["code"] == "NO_DOCX_BODY"


def test_pdf_page_limit():
    data = build_pdf([f"line {i} " + "word " * 10 for i in range(21 * 46)], per_page=46)
    r = post(make_client(), data)
    assert r.status_code == 422 and r.json()["error"]["code"] == "TOO_MANY_PAGES"


def test_oversize_body_is_413():
    r = post(make_client(), b"0" * (6 * 1024 * 1024 + 1))
    assert r.status_code == 413 and r.json()["error"]["code"] == "FILE_TOO_LARGE"


def test_chunked_body_is_capped_while_streaming():
    def chunks():
        for _ in range(8):  # 8 MB with no Content-Length
            yield b"0" * (1024 * 1024)
    r = make_client().post("/internal/v1/ai/extract-resume?fileType=pdf", content=chunks(),
                           headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/octet-stream"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "FILE_TOO_LARGE"


# --- Qwen fallback ---------------------------------------------------------------------------------------------------

NARRATIVE = [
    "Morgan Lee",
    "morgan.lee@example.com",
    "I am a quality engineer writing automated tests in Python and Java for payment systems. I led the migration from "
    "Selenium to Playwright and mentored two junior engineers on distributed teams.",
]


def qwen_with(reply: dict | str, status: int = 200) -> QwenFallback:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["model"] == "qwen2.5:3b-instruct-q4_K_M" and body["options"]["temperature"] == 0 and body["keep_alive"] == 0
        content = reply if isinstance(reply, str) else json.dumps(reply)
        return httpx.Response(status, json={"message": {"content": content}})
    return QwenFallback(True, "http://127.0.0.1:11434", "qwen2.5:3b-instruct-q4_K_M", transport=httpx.MockTransport(handler))


def test_qwen_is_not_called_when_the_rules_found_enough():
    def boom(request: httpx.Request) -> httpx.Response:
        raise AssertionError("Qwen must not be called for a structured resume")
    q = QwenFallback(True, "http://127.0.0.1:11434", "m", transport=httpx.MockTransport(boom))
    lines = ["Jordan Rivers", "SKILLS", "Python, SQL, Splunk, Wireshark, Nmap, Bash", "EXPERIENCE", "Initech | Security Analyst | Feb 2023 – Present"]
    body = post(make_client(q), build_docx(lines), "docx").json()
    assert body["stats"]["qwenStatus"] == "NOT_REQUIRED" and body["stats"]["qwenFacts"] == 0


def test_qwen_disabled_by_default_leaves_unstructured_resume_with_contact_facts_only():
    body = post(make_client(), build_pdf(NARRATIVE)).json()
    assert body["stats"]["qwenStatus"] == "DISABLED"
    assert {f["kind"] for f in body["facts"]} <= {"legal_name", "email"}


def test_qwen_proposals_are_verified_against_the_text_and_marked_as_qwen():
    reply = {"facts": [
        {"kind": "skill", "quote": "Playwright"},
        {"kind": "skill", "quote": "Selenium"},
        {"kind": "skill", "quote": "Rust"},  # not in the resume: dropped
        {"kind": "employment", "quote": "quality engineer"},  # kind not allowed: dropped
        {"kind": "citizenship", "quote": "citizen"},  # forbidden kind: dropped
    ]}
    body = post(make_client(qwen_with(reply)), build_pdf(NARRATIVE)).json()
    qwen_facts = [f for f in body["facts"] if f["proposedBy"] == "qwen"]
    assert sorted(f["value"] for f in qwen_facts) == ["Playwright", "Selenium"]
    assert body["stats"]["qwenStatus"] == "USED" and body["stats"]["qwenDropped"] == 3
    for f in qwen_facts:
        assert body["text"][f["span"]["start"]:f["span"]["end"]] == f["span"]["quote"]
    assert body["parserRevision"].startswith("resume-rules@3+qwen:")


@pytest.mark.parametrize("reply", ["not json", {"facts": "nope"}])
def test_qwen_garbage_is_a_warning_not_a_failure(reply):
    body = post(make_client(qwen_with(reply)), build_pdf(NARRATIVE)).json()
    assert body["stats"]["qwenStatus"] == "UNAVAILABLE"
    assert [w["code"] for w in body["warnings"]] == ["QWEN_FALLBACK_UNAVAILABLE"]
    assert not [f for f in body["facts"] if f["proposedBy"] == "qwen"]


def test_qwen_endpoint_must_be_loopback():
    with pytest.raises(ValueError):
        QwenFallback(True, "http://example.com:11434", "m")
    with pytest.raises(ValueError):
        QwenFallback(True, "http://user:pw@127.0.0.1:11434", "m")
