# Local setup (Windows, PowerShell)

Status: written from the repository's own scripts and READMEs. **Not yet reproduced on a second machine** (ledger task P0-09). If a step fails, record the exact error in the notebook and open a defect issue; do not work around it silently.

## Prerequisites
| Tool | Version | Check |
|---|---|---|
| Git | any recent | `git --version` |
| Node.js | 24.13.1 (`.nvmrc`) | `node -v` |
| Python | 3.12 (verified on the author's machine; 3.10 also installed) | `python --version` |
| Docker Desktop | with Compose | `docker compose version` |
| Google Chrome | stable (tests drive headed Chrome) | open it once |
| Ollama (optional) | only for Qwen shadow tests | `ollama list` |

## 1. Clone and branch
```powershell
git clone https://github.com/ckvishwa/Job-Hunter.git
cd Job-Hunter
git fetch origin
git switch careerops-integration        # active development branch; main is far behind
git switch -c qa/<your-topic>           # work on short-lived branches
```

## 2. Dependencies
```powershell
npm ci
cd web; npm ci; npm run build; cd ..     # the UI e2e tests need web/dist
npx playwright install chromium          # Playwright browsers
cd services/ai
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
cd ..\..
```
ML tests (optional): `services/ml/requirements.lock` (pinned) in its own venv.

## 3. Local PostgreSQL (throwaway/dev data only, never real candidate data)
```powershell
Copy-Item infra/.env.example infra/.env
# Replace every CHANGE_ME in infra/.env with its own random value:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
docker compose -f infra/docker-compose.yml --env-file infra/.env up -d
docker inspect jobhunter-s1-pg --format '{{.State.Health.Status}}'   # wait for: healthy
npm run db:migrate
```
Port is `127.0.0.1:55440` (change `JH_PG_PORT` if taken). Never run `docker compose down -v` (deletes data). `infra/.env` is git-ignored: never commit it, never share your values.

## 4. Smoke checks
```powershell
npm run typecheck
npx vitest run tests/discovery tests/adapters tests/resolver     # fast, no browser/DB
python scripts/sync_progress.py --check
npx vitest run tests/api/s1-api.test.ts                          # needs PostgreSQL + Python
npx vitest run tests/e2e/offline/dashboard.e2e.test.ts           # headed Chrome, needs web build
```
Run the whole stack: `npm run dev:stack`, `npm run dev:stack:status`, `npm run dev:stack:stop` (UI http://127.0.0.1:4321/).

## Environment variables (names only; values live in git-ignored files)
`JH_PG_USER`, `JH_PG_PASSWORD`, `JH_PG_DB`, `JH_PG_PORT`, `JH_AI_SERVICE_TOKEN`, `JH_AI_QWEN_FALLBACK` (default off), `JH_UI_DIAG` (set to `1` for browser diagnostics). See `infra/.env.example`.

## Troubleshooting
- Tests skipped silently: a suite needs `dbAvailable()`, Python and `web/node_modules/astro`; check Docker health and `npm ci` in `web/`.
- Headed Chrome tests fail only in long runs: close other heavy programs; see `docs/KNOWN_FLAKES.md`; rerun the file alone first.
- Port 55440 busy: set `JH_PG_PORT`.
- Windows line endings: `docs/PRD.md` is marked `-text` so its checksum survives `core.autocrlf=true`.
- Never put real résumés, cookies or screenshots with personal data into the repo; `private-runtime/` is git-ignored and stays on your machine.
