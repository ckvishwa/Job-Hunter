"""Internal FastAPI service. Bound to loopback by the launcher; every call needs the shared bearer token."""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
from dataclasses import dataclass

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .contracts import SCHEMA_REVISION, ExtractResponse, ExtractStats, Warning_
from .extract_text import ExtractError, extract
from .parse_resume import PARSER_REVISION, parse_resume
from .qwen_fallback import QwenFallback

log = logging.getLogger("jobhunter.ai")
MAX_BODY_BYTES = 6 * 1024 * 1024


@dataclass
class Settings:
    service_token: str
    qwen: QwenFallback

    @staticmethod
    def from_env() -> "Settings":
        token = os.environ.get("JH_AI_SERVICE_TOKEN", "")
        if len(token) < 32:
            raise RuntimeError("JH_AI_SERVICE_TOKEN must be set (32+ characters).")
        return Settings(
            service_token=token,
            qwen=QwenFallback(
                enabled=os.environ.get("JH_AI_QWEN_FALLBACK", "0") == "1",
                base_url=os.environ.get("JH_AI_OLLAMA_URL", "http://127.0.0.1:11434"),
                model=os.environ.get("JH_AI_QWEN_MODEL", "qwen2.5:3b-instruct-q4_K_M"),
            ),
        )


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def create_app(settings: Settings) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def authorized(request: Request) -> bool:
        header = request.headers.get("authorization", "")
        supplied = header[7:] if header.lower().startswith("bearer ") else ""
        return hmac.compare_digest(supplied.encode(), settings.service_token.encode())

    @app.get("/internal/v1/ai/info")
    async def info(request: Request):
        if not authorized(request):
            return error(401, "UNAUTHORIZED", "Missing or invalid service token.")
        return {"schemaRevision": SCHEMA_REVISION, "parserRevision": PARSER_REVISION + settings.qwen.revision_suffix,
                "qwenFallback": settings.qwen.enabled}

    @app.post("/internal/v1/ai/extract-resume")
    async def extract_resume(request: Request, fileType: str = ""):
        if not authorized(request):
            return error(401, "UNAUTHORIZED", "Missing or invalid service token.")
        if fileType not in ("pdf", "docx"):
            return error(400, "UNSUPPORTED_FILE_TYPE", "fileType must be pdf or docx.")
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            return error(413, "FILE_TOO_LARGE", "Body exceeds the service limit.")
        # Read incrementally so a chunked upload cannot be buffered past the limit.
        buffer = bytearray()
        async for chunk in request.stream():
            buffer.extend(chunk)
            if len(buffer) > MAX_BODY_BYTES:
                return error(413, "FILE_TOO_LARGE", "Body exceeds the service limit.")
        data = bytes(buffer)
        try:
            doc = extract(data, fileType)
            parsed = parse_resume(doc.text)
            qwen = settings.qwen.run(doc.text, parsed.facts)
        except ExtractError as e:
            return error(422, e.code, e.message)
        except Exception as e:  # never echo file content
            log.error("extract failed: %s", type(e).__name__)
            return error(500, "INTERNAL_ERROR", "Extraction failed unexpectedly.")
        warnings = [Warning_(code="LAYOUT_AMBIGUOUS", message=f"PDF page {w.split('=')[-1]} has uncertain column order; review extracted text.") for w in doc.warnings] + list(parsed.warnings)
        if qwen.status == "UNAVAILABLE":
            warnings.append(Warning_(code="QWEN_FALLBACK_UNAVAILABLE", message=f"Optional model fallback was not usable ({qwen.detail})."))
        facts = sorted([*parsed.facts, *qwen.facts], key=lambda f: (f.span.start, f.span.end))
        body = ExtractResponse(
            parserRevision=PARSER_REVISION + settings.qwen.revision_suffix,
            fileType=fileType,  # type: ignore[arg-type]
            text=doc.text,
            textSha256=hashlib.sha256(doc.text.encode("utf-8")).hexdigest(),
            warnings=warnings,
            facts=facts,
            stats=ExtractStats(pageCount=doc.page_count, characterCount=len(doc.text), deterministicFacts=len(parsed.facts),
                               qwenFacts=len(qwen.facts), qwenDropped=qwen.dropped, qwenStatus=qwen.status),  # type: ignore[arg-type]
        )
        return JSONResponse(content=body.model_dump(mode="json"))

    return app
