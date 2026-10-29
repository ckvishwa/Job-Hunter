# Project command center (`/project`)

An internal, read-only engineering view inside the existing Job Hunter app. It is a projection of the canonical records; it has no database and no write path.

| Shown | Read from (fixed paths, never user-supplied) |
|---|---|
| Phases, tasks, evidence, gate, next task, team | `docs/PROGRESS_LEDGER.json` |
| PRD explorer and search | `docs/PRD.md` (hash checked against the ledger lock) |
| Engineering notebook preview | `docs/team/ENGINEERING_NOTEBOOK.md` |
| Task-specific KT links | `docs/kt/*.md` (a link appears only where the file mentions the task ID) |

## Run it locally

```
npm run dev:stack          # API, AI service and web UI (see docs/kt/LOCAL_SETUP.md)
# or, UI + API only:
npm run api                # Fastify on 127.0.0.1:8787 (needs infra/.env)
npm run dev --prefix web   # Astro on http://127.0.0.1:4321
```

Open `http://127.0.0.1:4321/project`, sign in with the local access token (the same session as the rest of the app) and use the tabs: Overview, PRD, Roadmap, Board, Team, Notebook. Deep links: `#/roadmap/P0`, `#/task/P0-01`, `#/prd?q=FR-0301`.

## API (all `GET`, session required, `Cache-Control: no-store`)

`/api/v1/project/overview`, `/phases`, `/tasks`, `/prd`, `/notebook`. A missing or unusable source returns `404 PROJECT_SOURCE_MISSING` or `422 PROJECT_SOURCE_INVALID` (the UI shows a dedicated "unavailable" panel); there is no write route.

## Rules the dashboard enforces

- Counts and percentages are computed from task records on every request; nothing is hard-coded or cached.
- Only tasks whose evidence passes the ledger rules count as verified. A `VERIFIED` status with rejected evidence is shown as a warning, never as done.
- Phase state, next task and evidence validation follow `scripts/sync_progress.py`. The TypeScript port in `src/project/ledger.ts` is pinned to it by `tests/project/ledger-parity.test.ts`, which runs the Python script on a synthetic ledger and on the real ledger.
- Gate A shows the state of the first ledger phase (P0). It reads BLOCKED while the ledger records a blocker; the dashboard cannot clear it.
- Repository Markdown is rendered with text nodes only (`web/src/lib/markdown-lite.ts`); raw HTML is displayed literally and only `http(s)` links are created.

## Tests

```
npx vitest run tests/project tests/web/project-model.test.ts        # no browser (also in npm run test:fast)
npx vitest run tests/e2e/offline/project.e2e.test.ts                # headed Chrome, synthetic data, no database
```

QA path for Hani456: run the commands above on her machine, then compare the Overview numbers with `python scripts/sync_progress.py --next` and the ledger by hand. Independent verification is recorded in the ledger task P0-11; this dashboard is not Gate A evidence.
