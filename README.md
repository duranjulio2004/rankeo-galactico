# Rankeo Galáctico 🪐

Rank anything with your friends. Pick the better of two items in quick 1v1
duels; a Bradley–Terry model turns your picks into a personal ranking with
confidence bars, auto tier lists, and, for group lists, a shared group
ranking plus who-agrees-with-whom insights.

**Status:** v1 feature-complete (duels, personal and group rankings, tiers,
invites, insights). 47 automated tests passing. Deployable to Railway; not
deployed yet.

See **[DESIGN.md](DESIGN.md)** for what it is, the key decisions and why, and
the milestone plan.

## Run locally

Requires **Node 24+** (uses built-in `node:sqlite` and native TypeScript type
stripping, so there's no server build step).

```bash
npm install
npm run dev        # API on :3000 (auto-restart) + Vite on :5173 → open http://localhost:5173
```

Production mode locally:

```bash
npm run build      # builds the SPA into dist/client
npm start          # serves API + SPA on http://localhost:3000
```

Environment variables (all optional):

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/rankeo.db` | SQLite file (created on first run, schema auto-migrates) |
| `SIGNUP_CODE` | unset | If set, signing up requires this code **or** a valid group invite link |
| `NODE_ENV` | — | `production` marks session cookies `Secure` |

## Test

```bash
npm test           # node:test: ranking engine + API integration (in-memory DB)
npm run typecheck  # tsc over server, client and tests
```

- `test/ranking.test.ts`: model fitting, confidence, pair selection (including
  simulations: a noisy voter with a hidden true order, active vs. random pairing),
  group weighting, agreement/divisive/hot takes, tiers.
- `test/api.test.ts`: auth, sessions, CSRF guard, rate limit, signup code,
  group/list access control, voting, undo, exclusions, archiving, group
  rankings and insights.
- The UI has no automated tests; it was checked by driving the production
  build in headless Chrome (see DESIGN.md §6).

## Deploy (Railway)

The repo has a `Dockerfile` and `railway.json` (Dockerfile build, health check
on `/api/health`, single replica: SQLite needs exactly one writer).

1. `railway login` (opens the browser).
2. In the repo folder: `railway init` → create a new project, e.g. *rankeo-galactico*.
3. `railway up` to build and deploy. It runs without a volume, but then the
   database is wiped on every redeploy, so do step 4 before inviting anyone.
4. In the Railway dashboard, open the service:
   - **Add a Volume** mounted at **`/data`** (the database lives at `/data/rankeo.db`).
   - **Settings → Networking → Generate Domain** to get a public URL.
   - **Variables:** add `SIGNUP_CODE` with a code of your choice (recommended,
     so strangers who find the URL can't sign up; friends join via invite links).
     Set it in the dashboard; don't commit it.
5. `railway up` again (or connect the GitHub repo for auto-deploys on push).

Backups: the whole state is one SQLite file on the volume; enable Railway's
volume backups for the service in the dashboard.

## Project layout

```
src/server/ranking/   pure ranking engine (Bradley–Terry, pairing, group, tiers)
src/server/           Hono app, routes, auth, SQLite schema, rankings glue
src/client/           React SPA (pages/, components/, styles.css)
test/                 node:test suites
```
