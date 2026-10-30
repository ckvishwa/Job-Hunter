"""Launcher: loopback only. `python run.py` reads JH_AI_HOST / JH_AI_PORT / JH_AI_SERVICE_TOKEN."""
import os

import uvicorn

from app.main import Settings, create_app

if __name__ == "__main__":
    host = os.environ.get("JH_AI_HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("The AI service must bind to loopback.")
    uvicorn.run(create_app(Settings.from_env()), host=host, port=int(os.environ.get("JH_AI_PORT", "8765")), log_level="warning")
