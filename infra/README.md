# S1 infrastructure: dedicated PostgreSQL

PostgreSQL is the **authoritative store for the S1 candidate workflow only** (resumes, extracted facts, fact revisions, profile
revisions). The legacy JSONL stores (`data/*.jsonl`, `private-runtime/candidate/*.json`) are untouched and remain what the
existing pipeline reads, until a separately tested cutover.

| Item | Value |
|---|---|
| Compose project / container | `jobhunter-s1` / `jobhunter-s1-pg` |
| Image | `postgres:17.6-bookworm`, pinned by digest in `docker-compose.yml` (PostgreSQL 17 is a supported major) |
| Volume | named volume `jobhunter_s1_pgdata` |
| Port | `127.0.0.1:55440` only (never `0.0.0.0`); change with `JH_PG_PORT` |
| Health check | `pg_isready` every 5 s |
| Secrets | `infra/.env` (gitignored). Template: `infra/.env.example` |

It does **not** touch, reuse or depend on any other project's containers or volumes (for example `lakewood-*`, `livekit-dev`). If
port 55440 is taken, set a different `JH_PG_PORT` in `infra/.env`; nothing else needs to change.

## First-time setup (PowerShell, from the repository root)

```powershell
Copy-Item infra/.env.example infra/.env
# Replace every CHANGE_ME in infra/.env with its own random value:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

docker compose -f infra/docker-compose.yml --env-file infra/.env up -d
docker inspect jobhunter-s1-pg --format '{{.State.Health.Status}}'   # wait for: healthy
npm run db:migrate                                                    # applies db/migrations/*.sql, once each
```

Stop / start (data is kept in the named volume):

```powershell
docker compose -f infra/docker-compose.yml --env-file infra/.env stop
docker compose -f infra/docker-compose.yml --env-file infra/.env start
```

`docker compose ... down` keeps the volume. `down -v` **deletes all S1 data**; do not run it without a backup.

## Run the S1/S2 stack (one command)

```powershell
npm run dev:stack          # PostgreSQL -> migrations -> Python AI -> Fastify API -> Astro dev server, each health-checked
npm run dev:stack:status   # service, port, pid, health
npm run dev:stack:stop     # stops UI, API and AI service (add -StopDb via: pwsh scripts/dev-stack.ps1 stop -StopDb)
```

| Service | URL (loopback only) | Health check used by the script |
|---|---|---|
| Astro UI | http://127.0.0.1:4321/ | `/api/v1/healthz` **through the UI proxy**, so a wrong API port is caught |
| TypeScript API (Fastify) | http://127.0.0.1:8787/ | `/api/v1/healthz` |
| Python AI service | http://127.0.0.1:8765/ | `/internal/v1/ai/info` with the service token |
| PostgreSQL | 127.0.0.1:55440 | `docker inspect` health = `healthy` |

The script reads `infra/.env` (never printing it), derives `JH_API_URL` (the UI proxy target) and `JH_ALLOWED_ORIGINS` from the ports it
actually uses, refuses to start a service whose port is held by something else, creates `services/ai/.venv` once if it is missing, and
writes logs to `private-runtime/dev-logs/<service>.log` and `.err.log` (gitignored). Open the UI and sign in with `JH_API_ACCESS_TOKEN`.

What the UI shows when something is wrong (all pages, not only the dashboard):

| Situation | What you see |
|---|---|
| API not running / proxy cannot reach it | "Can't reach the Job Hunter API" with **Try again**; no sign-in form |
| Browser offline | "You appear to be offline" with **Try again**; coming back online re-checks once |
| Never signed in | Sign-in form; no private data was requested |
| Session expired or cleared | Sign-in form with "Your session expired" |
| API answered with an unexpected server error | "The server reported an unexpected error" with **Try again** |
| One dashboard section failing | The rest still renders; a banner names what is missing and offers **Try again** |

Manual start (what the script automates), from the repository root, each in its own terminal:

```powershell
# 1. Python AI service (loopback only). Variables come from infra/.env in the environment.
python -m venv services/ai/.venv
services/ai/.venv/Scripts/python -m pip install -r services/ai/requirements.txt
cd services/ai; .venv/Scripts/python run.py
# 2. TypeScript API (loopback only; refuses to start if migrations are pending)
npm run api
# 3. Astro UI at http://127.0.0.1:4321 (proxies /api to the API)
cd web; npm install; npm run dev        # or: npm run build; npm run preview -- --host 127.0.0.1 --port 4321
```

## Backup

Backups contain candidate data. They go under `private-runtime/backups/` (gitignored). Never commit or share them.

```powershell
New-Item -ItemType Directory -Force private-runtime/backups | Out-Null
$stamp = Get-Date -Format yyyyMMdd-HHmmss
docker exec jobhunter-s1-pg sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/s1.dump'
docker cp jobhunter-s1-pg:/tmp/s1.dump "private-runtime/backups/s1-$stamp.dump"
```

(`/tmp/s1.dump` inside the container is overwritten by the next backup and disappears when the container is recreated.)

Uploaded resume files are stored by content hash in `private-runtime/s1-uploads/`; back that folder up together with the dump.

## Verify a backup without touching live data

```powershell
docker cp private-runtime/backups/s1-<stamp>.dump jobhunter-s1-pg:/tmp/check.dump
docker exec jobhunter-s1-pg sh -c 'createdb -U "$POSTGRES_USER" jobhunter_restore_check && pg_restore -U "$POSTGRES_USER" -d jobhunter_restore_check --no-owner /tmp/check.dump'
docker exec jobhunter-s1-pg sh -c 'psql -U "$POSTGRES_USER" -d jobhunter_restore_check -Atc "select (select count(*) from resumes), (select count(*) from candidate_facts), (select count(*) from fact_revisions)"'
docker exec jobhunter-s1-pg sh -c 'dropdb -U "$POSTGRES_USER" jobhunter_restore_check'
```

Compare the counts with the live database.

## Recovery (replace the live database from a backup)

1. Stop the API (`Ctrl+C` in its window). Keep a fresh backup of the current state first if it is still readable.
2. Restore:
   ```powershell
   docker cp private-runtime/backups/s1-<stamp>.dump jobhunter-s1-pg:/tmp/restore.dump
   docker exec jobhunter-s1-pg sh -c 'dropdb -U "$POSTGRES_USER" --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB" && pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner /tmp/restore.dump'
   ```
3. `npm run db:migrate` (no-op if the dump already contains every migration), then `npm run api`.

## Roll back S1 (destructive)

The S1 tables can be removed without affecting any legacy store: take a backup, then run
`db/migrations/down/0001_s1_candidate.down.sql` with `psql`. To abandon S1 entirely, stop the compose project and, only if you are
sure, delete the volume with `docker volume rm jobhunter_s1_pgdata`.

## S2 (role catalog, recommendations, selections)

Migration `db/migrations/0002_s2_roles.sql` is additive (no S1 table is altered). `npm run db:migrate` applies it. The API seeds the role
catalog on start; `npm run roles:seed` does the same on demand. Both are idempotent: a rerun inserts nothing, a role a person edited is
never overwritten, and a run that changes nothing does not create a catalog version.

Take a backup before migrating a database that holds real candidate data (see Backup above; a backup taken before S2 restores to a
database that `npm run db:migrate` then upgrades).

Roll back S2 (destructive; removes the catalog, recommendations, decisions and saved selections, never S1 data): back up, then run
`db/migrations/down/0002_s2_roles.down.sql` with `psql`.

Windows note: loopback TCP connects on the machine this was built on intermittently stall or fail (`ETIMEDOUT`) with no project code
involved; see `docs/KNOWN_FLAKES.md`, seventh entry.

## Tests

The DB-backed suites create and drop their own throwaway databases (`jh_test_<random>`) inside this container; they never write to
the working database. They are skipped automatically when `infra/.env` does not exist (for example in CI). If `infra/.env` exists but
the database is unreachable, they **fail loudly** rather than skip; set `JH_SKIP_DB_TESTS=1` to skip deliberately.

## S3 (official job discovery)

Migration `db/migrations/0003_s3_discovery.sql` is additive (no S1/S2 table is altered); `npm run db:migrate` (or `npm run dev:stack`) applies it. **Back up first** (Backup above). Roll back (destructive, development only): back up, then run `db/migrations/down/0003_s3_discovery.down.sql` with `psql`; S1/S2 data is unaffected.

Discovery reads only the employer boards you list. Copy `config/company-boards.example.json` to `config/company-boards.json` (gitignored) or point `JH_BOARDS_FILE` at your list. Each entry is `{ "company", "ats": "greenhouse" | "lever", "board": "<token from the employer's board URL>" }`; add `"corporateDomain"` when the employer's Greenhouse listings are served from its own domain, otherwise those postings are rejected as `UNOFFICIAL_HOST`. Limits (env): `JH_DISCOVERY_MAX_BOARDS` (25), `JH_DISCOVERY_MAX_CANDIDATES` (50), `JH_DISCOVERY_MAX_PER_BOARD` (50), `JH_DISCOVERY_DELAY_MS` (400).

Bounded real-source pilot (throwaway database, synthetic selection, GET only): `npm run s3:pilot -- --boards <file> --max-boards 12 --max-candidates 50 [--open-filters]`.
