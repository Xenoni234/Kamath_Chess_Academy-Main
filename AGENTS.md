npm# Kamath Chess Academy (KCA) — Project Context

Read this file fully before making any changes. It defines the project,
current state, conventions, and hard rules.

> **Next.js note:** this repo runs a Next.js version with breaking changes from
> what you may know — read [`NEXTJS.md`](NEXTJS.md) and the guides in
> `node_modules/next/dist/docs/` before writing any Next.js code.

---

## What this project is

A production-grade chess academy platform for Kamath Chess Academy.
Think **Lichess + an academy management system + AI coaching tools**, built
from scratch as a single Next.js application.

Solo-built by a student developer, using AI coding agents. This is both a
real product for a chess academy and a portfolio centerpiece.

**Repo:** `github.com/Xenoni234/Kamath_Chess_Academy-Main`
**Local path:** `~/dev/Phase0` (folder name is historic — it holds the
whole project, not just Phase 0). Moved off `~/Desktop` deliberately: iCloud
syncs the Desktop and wrecked this repo (see below) — do not move it back.

---

## User roles (5)

| Role | What they do |
|---|---|
| STUDENT | Play, solve puzzles, analyse games, attend classes, view own reports |
| PARENT | View their child's progress, reports, schedule, and payments |
| COACH | Run classes, annotate student games, view assigned batches |
| HR | Schedule classes, manage students/coaches, create puzzles and tournaments |
| HEAD | Everything HR can do, plus platform-wide stats, users, and revenue |

Role is stored on the `User` model as a Prisma enum. Route protection lives
in `src/proxy.ts` (this Next.js version names middleware `proxy`, not
`middleware`).

---

## Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js (App Router, `src/` dir) | Runs via custom server, not `next dev` |
| Server | `server.mjs` at project root | HTTP server + Next handler + Socket.io |
| Language | TypeScript, strict mode | `allowImportingTsExtensions: true` is set |
| Styling | Tailwind CSS | Custom `kca` colour palette |
| Database | PostgreSQL via Supabase | |
| ORM | Prisma 7 | Config in `prisma.config.ts`, NOT in `schema.prisma` |
| Cache / realtime state | Redis via Upstash (REST SDK) | |
| Realtime | Socket.io | In-memory adapter for now |
| Auth | Custom JWT in httpOnly cookies | NOT Supabase Auth, NOT NextAuth |
| Validation | Zod | Every API route and socket payload |
| Chess logic | `chess.js` | Server-side move validation is authoritative |
| Board UI | `react-chessboard` | |
| Engine | Stockfish 18 Lite WASM in `public/engine/` | Browser Web Worker + Node; needs COOP/COEP |
| AI | Pluggable: OpenAI-compatible host (Groq default), Anthropic, Ollama, or an offline template | Move explanations, report narratives, dossier annotation |
| Email | Resend | OTP, invoices, reports |
| PDF | Puppeteer | Report and invoice generation |

---

## Phase roadmap (7 phases)

### Phase 0 — Foundation ✅ COMPLETE
Public website (Hero, Achievements, About, Contact, Footer), custom JWT auth
with 5 roles, 3-step registration with DPDPA consent checkboxes, OTP scaffold,
role-based dashboards, route protection, Prisma schema (~18 models), Supabase
and Redis connected, health check endpoint.

### Phase 1 — Live chess engine ✅ COMPLETE
Socket.io server, live multiplayer games with server-side move validation,
Redis-backed game state, server-authoritative clocks, game lobby (open
challenges + quick pair matchmaking), spectator mode, Glicko-2 ratings per
time format, presence tracking, real OTP via Resend.

### Phase 2 — Analysis & learning ✅ COMPLETE
Sub-features and status (see "Current state" for detail):
- ✅ App-wide light/dark theme with a persisted toggle
- ✅ Games history (all time formats) page
- ✅ Live-play hardening (server-side flag/timeout, illegal-move handling, exit)
- ✅ Puzzle system — solving UI, SM-2 spaced repetition, difficulty + theme
  filters, streak/solved stats, 500k-puzzle Lichess bank (GIN-indexed themes)
- ✅ Analysis board (multi-threaded Stockfish 18 + streaming Claude explanations)
- ✅ Play vs engine at adjustable difficulty
- ✅ Opening preparation via the Lichess Explorer API
- ✅ Game reports (fetch games → engine analysis → Claude narrative → PDF → email)

### Phase 3 — Academy operations ✅ COMPLETE
Arena / Swiss / Round Robin tournaments with live standings, class scheduling
(HR assigns coaches to batches), role dashboards wired to real data,
notification system with a live bell, durable BullMQ job queue on a dedicated
TCP Redis, and `requireRole` / `writeAuditLog` helpers. **Razorpay is
deliberately deferred** — the scaffold in `src/lib/razorpay.ts` is inactive
(`isPaymentsEnabled()` returns false) and the site stays free during the first
3 months of testing.

### Phase 4 — Digital Second AI ✅ COMPLETE (current phase)
The flagship feature: profile any opponent from their Lichess/Chess.com history
and generate an annotated repertoire aimed at that specific player. All code
lives under `src/lib/second/`:
- ✅ **Ingestion** (`ingest.ts`) — Lichess ndjson + Chess.com archives, with
  clocks and timestamps. **Time-decay weighting is relative to the player's own
  most recent game** (`weight = 0.5 ** (ageDays / 180)`), so an inactive player
  still profiles correctly. 24 h Redis cache of the compact form.
- ✅ **Opening Trie** (`trie.ts`) — SAN-keyed repertoire tree per colour,
  weighted counts + score, capped at 24 plies.
- ✅ **Weakness detection** (`weakness.ts`) — engine-grades their recurring
  decision positions (ply 5–20) and blends accuracy with **clock pressure**:
  positions they think long about *and* misplay.
- ✅ **Transpositions** (`graph.ts`) — loads the Trie into **Neo4j**, MERGE-ing
  on a 4-field FEN key (no move counters) so move-orders collapse into a DAG;
  Cypher then finds bypass move-orders to weak targets. Opt-in: without
  `NEO4J_*` the stage is skipped and the rest of the dossier still generates.
  The load runs in **one transaction** — the `DETACH DELETE` used to commit on
  its own, so a failure mid-load left the profile with zero positions, which
  looks identical to "never ran".
- ✅ **Dossiers are regenerable** — `POST /api/second/profiles/[id]/regenerate`
  plus a button on the dossier page. The artifact (including `graphUsed`) is a
  snapshot frozen at job time and nothing else recomputes it, so a dossier built
  while an optional stage was down would otherwise report that state forever.
  When the graph stage is skipped, `graphSkipReason` records **why**
  (`not-configured` vs `failed`) so the UI stops blaming configuration for
  every failure.
- ✅ **Novelty mining** (`novelty.ts`) — engine MultiPV ∩ rare in the Lichess
  Explorer = sound moves humans rarely play.
- ✅ **Repertoire + PDF** (`repertoire.ts`, `pdf.ts`, `claude.ts`) — lines are
  chosen by engine analysis; the AI layer only *annotates* them, so the template
  provider is chess-safe and free.
- ✅ **Job / routes / UI** (`runProfileJob.ts`, `api/second/*`,
  `dashboard/second`) — durable via `profileQueue`, owner-only dossier +
  download (404, never 403), audit-logged, notification on completion.

**Verified end-to-end** against real accounts: 15 games profiled → 12 Trie
lines, 8 weaknesses, 3 novelties, PDF + notification, in ~8 s. A 94-game run
produced 7 novelties and a 200 KB dossier PDF.

**Neo4j verified live** (Docker, see Commands): 331 positions / 331 moves
loaded, and `findTranspositions` returned a correct bypass — their usual
`e4 e5 Nf3 Nf6 Nc3` versus the `e4 e5 Nc3 Nf6 Nf3` Vienna move-order, both
reaching the same Four Knights position. Note `transpositions: 0` is a normal
result on a small sample: the query only reports a bypass when a *weak* position
is reachable by two or more distinct move-orders in their own games.

### Phase 5 — Video classes 📋 PLANNED
Inbuilt group video via mediasoup WebRTC SFU (no third-party API), Socket.io
signalling, screen sharing for board demonstration, in-class chat.

### Phase 6 — Mobile 📋 PLANNED
React Native app for iOS and Android, offline puzzle solving with local cache,
push notifications.

---

## Current state — read carefully

Phase 2 is feature-complete. **Done and verified this phase:**

- **Puzzles** — full solving UI at `/dashboard/puzzles`
  (`src/app/(dashboard)/puzzles/page.tsx`): loads a puzzle, auto-plays the
  Lichess setup move, validates the solution line, submits SM-2 attempts.
  SM-2 review scheduling in `POST /api/puzzles/[puzzleId]/attempt`; puzzle
  selection (due reviews → random un-attempted) in `GET /api/puzzles`;
  difficulty bands + 26 theme filters; streak/best/solved stats via
  `GET /api/puzzles/stats`. **500,000 Lichess puzzles imported** (via
  `npm run import:puzzles <csv> <n>`, ~145 MB, ~31% of the free tier);
  `Puzzle.themes` has a **GIN index** for fast theme queries.
- **Light/dark theme** — CSS-variable `kca-*` palette, persisted toggle in the
  dashboard sidebar and public navbar (see Design system).
- **Games history** — all-format history page at `/dashboard/games`, backed by
  `GET /api/games`.
- **Live play** — server-authoritative flag/timeout (`game:timeout` recomputes
  real remaining time), illegal-move snap-back, per-player board orientation,
  a "Playing as <user>" indicator, and exit-to-dashboard on the result modal.

- **Chess engine** — Stockfish 18 Lite (WASM, NNUE). `scripts/copyEngine.mjs`
  copies the multi-threaded and single-threaded builds from the `stockfish`
  devDependency into `public/engine/` (gitignored) on `predev`/`prebuild`.
  `server.mjs` sets COOP/COEP so the page is cross-origin isolated and
  `SharedArrayBuffer` is available; `src/lib/engine/select.ts` falls back to
  the single-threaded build, then the old `public/stockfish.js` asm.js build,
  when it is not. Measured ~3.1M nps in-browser, depth 16 MultiPV 3 in ~1 s.
  - `src/lib/engine/uci.ts` — UCI parsing (browser + server share it)
  - `src/lib/engine/classify.ts` — Lichess-compatible win% / accuracy /
    move classification, so board and reports never disagree
  - `src/lib/engine/analysis.ts` — game-tree building and per-move grading
  - `src/hooks/useStockfish.ts` — worker driver with a cancellable queue,
    MultiPV, `Skill Level` / `UCI_Elo`
  - `src/lib/engine/serverEngine.ts` — the same build under Node, for reports
- **Analysis board** — `/dashboard/analysis`. Live MultiPV-3 eval, eval bar,
  best-move arrow, keyboard navigation, full-game review with per-move
  classification and per-side accuracy, and streaming Claude explanations.
  Loads from games history (`?gameId=`), a PGN (`?pgn=` or paste), a FEN, or
  free play. **Analysis is not persisted** — a reload re-runs the scan.
- **Play vs engine** — `/dashboard/play-engine`. 8 difficulty levels mapped to
  `Skill Level` + `UCI_Elo`, colour choice, hint, takeback, resign. Entirely
  local: no Socket.io, no `Game` row, unrated.
- **Opening explorer** — `/dashboard/openings`, backed by
  `/api/analysis/opening` (24 h `OpeningCache`). Note the upstream moved to
  `explorer.lichess.org` and **now requires OAuth** — set `LICHESS_API_TOKEN`
  or the route returns 502.
- **Game reports** — `/dashboard/reports` is wired to the real API and polls
  for status. `src/lib/reports/gameStats.ts` replaced the old
  `Math.random()` accuracy with genuine Stockfish analysis of the player's own
  moves (depth 12, first 8 plies skipped as book, capped at 20 games / 1500
  positions). Verified against real Lichess data: Magnus scores 92.9%, his
  opponents 90.7% with a 3.1% blunder rate.

**Known gaps / follow-ups:**

- **Two engine landmines in `src/lib/engine/serverEngine.ts`. Do not undo either.**
  1. **Never resolve a search without waiting for `bestmove`.** On timeout the
     code sends `stop` and then keeps its listener until the `bestmove` that
     `stop` produces actually lands (`STOP_GRACE_MS`). Resolving immediately —
     as it used to — leaves that message for the *next* search's listener, which
     then resolves the wrong position in ~2 ms, permanently desyncing the batch.
     It cost 300 s of budget for 2.6 s of work (`budget exhausted after 34/60`)
     **and** produced wrong weakness accuracies. Measured after the fix: 60/60
     positions at depth 12 in 3.5 s, 59 ms each.
  2. **Never call the global `fetch` on any path that can run beside the engine
     — import `pristineFetch` from `@/lib/pristineFetch`.** The Emscripten
     runtime clobbers `globalThis.fetch` while booting. `serverEngine` restores
     it afterwards (from that same shared reference, never a per-boot save —
     with a pool, a per-boot save captures the already-clobbered value and
     faithfully restores the broken one; boots are serialised through
     `bootQueue` for the same reason). **Restoring is still not sufficient**:
     the profiling job talks to Lichess and the AI provider *while* engines are
     booting, so a request can land inside the clobbered window. This shipped
     broken and was invisible — `generateOpponentRepertoire` caught the
     `TypeError` and fell back to template prose, so every dossier looked fine
     while silently losing its AI narrative. All of `claude.ts`, `explorer.ts`,
     `ingest.ts` and `runReportJob.ts` now use `pristineFetch`.
- **Engine threads are 1 on purpose, everywhere.** Measured on an M4: at fixed
  depth, more threads per engine is *slower* (depth 20: 1311 ms at threads=1 vs
  1762 ms at threads=4) because SMP widens the search. Throughput comes from
  `mapWithEngines` running `ENGINE_CONCURRENCY` single-threaded engines in
  parallel. Do not "optimise" this by raising `threads`.
- **Dossier timings after the above** (Rambo1998, 94 games, deep settings):
  ingest 2.4 s · weakness+novelty 3.6 s · Neo4j 7.8 s · extend 12.5 s ·
  **AI narrative 102 s** · PDF 2.7 s = **~132 s total**, down from ~20 minutes.
  All Stockfish work is now ~26 s; the local Ollama narrative is the bottleneck.
  Per-stage times are logged as `[second] <stage>: Ns` — check those first before
  optimising anything here.
- **The database is in Tokyo (`ap-northeast-1`) and the users are in India** —
  measured ~150 ms per round trip. That is the floor under every page. Moving to
  `ap-south-1` takes it to ~20-30 ms; `scripts/migrate-region.sh` does the
  dump/restore and verifies row counts, but you must create the Supabase project
  and hand it the new **direct** (5432, not pooled 6543) URL. The whole DB is
  157 MB, 145 MB of which is the 495k-row `Puzzle` table, so a plain
  `pg_dump`/`pg_restore` is fine — no need to re-import from CSV. Needs
  `brew install libpq` for pg_dump 17.
- **Connection pooling is load-bearing** — `src/lib/db.ts` sets
  `idleTimeoutMillis` to 5 minutes. `pg-pool` defaults to 10 s, and
  NotificationBell polls every 30 s, so with the default *every* poll and every
  human-paced navigation found a dead pool and paid a fresh TCP+TLS+SCRAM
  handshake. Measured: 682 ms → 142 ms on a query after a 15 s idle gap. Do not
  drop those pool options. The pool is memoised on `globalThis` alongside the
  client so HMR does not orphan pools.
- No AI key is required — `AI_PROVIDER` (`openai-compatible` | `anthropic` |
  `ollama` | `template`) selects the backend, and `template` is a real
  deterministic fallback rather than a stub. `openai-compatible` speaks OpenAI's
  `/chat/completions` against `LLM_BASE_URL` (Groq by default, free tier), so
  moving to Cerebras/DeepSeek/OpenAI is an env change, not a code change.
  **`reasoning_effort` and `include_reasoning` are Groq extensions** and are
  sent only when the host is `*.groq.com` — other hosts reject unknown fields.
  Only `delta.content` is read from the SSE stream, never `delta.reasoning`, or
  a reasoning model's thinking would surface in the coach panel.
  `LICHESS_API_TOKEN` must still be set in `.env.local`; all of these are in
  `.env.example`. Anthropic's client is lazily constructed, so a missing key
  fails the request rather than the import.
- **Don't run the coach off a local Ollama model.** It loses twice over: a model
  small enough to fit is much weaker prose, and it competes with Stockfish for
  the same cores. Measured: gemma2:2b took ~3.6 s for ~110 words, versus well
  under a second on a hosted 120B model.
- Report PDFs are written to `/tmp` and served by
  `/api/reports/[reportId]/download`; that path is ephemeral and per-instance,
  so the emailed attachment is the durable copy.
- Report and profiling jobs are durable **only when `QUEUE_REDIS_URL` is set**
  (BullMQ + `npm run worker`). Without it they fall back to inline
  `setImmediate`, and a restart mid-job leaves the row stuck in `processing`.
- **The Stockfish WASM module overwrites `globalThis.fetch` when it boots.**
  `createEngine` in `src/lib/engine/serverEngine.ts` now saves and restores it.
  Never remove that — without it, every `fetch` made *after* engine analysis in
  the same process (opening explorer, Upstash Redis, Anthropic, Resend) fails
  with `fetch is not a function`.
- Dossier PDFs are written to `/tmp` (same ephemerality caveat as reports);
  regenerating the dossier is the recovery path.
- Phase 4 novelty mining is only as good as the explorer data: without
  `LICHESS_API_TOKEN` it returns no novelties rather than guessing. A strong
  opponent's mainlines legitimately yield zero novelties — that is a real
  result, not a bug.
- **RESOLVED — never put this repo under `~/Desktop` again.** iCloud syncs the
  Desktop, and with ~48k `node_modules` files plus a constantly-rewritten
  `.next/`, it caused three separate problems that looked unrelated:
  1. Conflict copies (`routes.d 2.ts`, `validator 3.ts`, …) in `.next/types/`,
     making `npx tsc --noEmit` fail with bogus `TS6200 / TS2300 duplicate
     identifier` errors.
  2. `bird` + `fileproviderd` + `cloudd` burning ~100 % CPU permanently.
  3. Endless file-watcher churn → constant Next recompiles → Fast Refresh
     reloading every open tab → a flood of `GET /login` hits that pinned the
     dev server.

  Moving to `~/dev/Phase0` fixed all three (measured: hundreds of `/login`
  hits per second → 3 in 30 s, and recompiles → 0). If conflict copies ever
  reappear, the cleanup is:

  ```bash
  find .next \( -name "* [0-9].ts" -o -name "* [0-9].tsx" \) -delete
  ```

### Resolved issues (kept for history)

The Phase-1/2 security, auth, validation, and code-quality issues previously
tracked here are all **fixed and pushed**: challenge-ownership check on
`lobby:cancel-challenge`; draw consent via `drawOfferedBy`; auth checks on the
opening and puzzle routes; Zod validation on every API route and socket
payload; registration field errors + password hint; and the `any`-type and
unhandled-promise cleanups.

---

## Hard rules

1. **Never commit `.env.local`.** All secrets come from `process.env`. Never
   hardcode a credential, key, or connection string in source.
2. **Never modify Phase 0 public website components** in
   `src/components/public/` or `src/app/(public)/` — they are design-final.
3. **Server is authoritative for chess.** Never trust a client-side move.
   Always re-validate with `chess.js` on the server before applying.
4. **Clocks are server-side.** The client displays a countdown; the server owns
   the real remaining time and syncs on every move.
5. **Every API route checks auth** by reading the `kca_access_token` cookie and
   calling `verifyAccessToken`, unless it is deliberately public.
6. **Every API route and socket handler validates input with Zod.** No
   `as SomeType` casts on request bodies or socket payloads.
7. **Every socket handler that mutates state checks permission** — is this user
   a player in this game? the creator of this challenge? Do not assume.
8. **Never create git commits.** The user performs all commits themselves.
   Make the changes, verify with `npx tsc --noEmit`, and leave committing —
   and `git push` — entirely to the user. Do not stage-and-commit on their
   behalf, and do not offer to.

---

## Prisma — important quirks

This project uses **Prisma 7**, which moved datasource URLs out of
`schema.prisma` and into `prisma.config.ts`.

Migrations must use a **direct connection on port 5432**, not the transaction
pooler on 6543 — pushing through the pooler hangs indefinitely.

```bash
npx prisma generate
npx prisma db push --url="$DIRECT_URL"
```

If `db push` hangs with no output, that is the pooler-port problem, not a
network failure.

Runtime queries use `DATABASE_URL` (port 6543, pooled, with
`?pgbouncer=true`). Migrations use `DIRECT_URL` (port 5432).

---

## Design system

Light and dark themes are both supported as of Phase 2. Dark is the default.
The `kca-*` Tailwind colours resolve to CSS variables defined in
`globals.css` (`:root` for dark, `:root[data-theme="light"]` for light); the
active theme is stored on `<html data-theme>` and persisted to
`localStorage` under `kca-theme`. Toggle controls live in the dashboard
sidebar (above Logout) and the public navbar (left of Login).

```
Background       #050505
Surface          #0D0D0D
Surface elevated #141414
Input background #1C1C1C
Border           #1F1F1F
Border (hover)   #2D2D2D
Accent (cyan)    #00C8E8
Accent hover     #29D8ED
Text primary     #FFFFFF
Text secondary   #E0E0E0
Text muted       #888888
Success          #22C55E
Warning          #F59E0B
Danger           #EF4444
```

Chess board squares use classic chess colours (`#F0D9B5` / `#B58863`), **not**
the dark UI palette — pieces are invisible against near-black squares.

Fonts: Space Grotesk (headings), Inter (body), JetBrains Mono (code and chess
notation).

Reusable classes already defined in `globals.css`: `.btn-primary`,
`.btn-secondary`, `.card`, `.input-field`, `.section-heading`,
`.section-subheading`. Use these rather than inventing new styles.

---

## Commands

```bash
npm run dev          # starts server.mjs — must print "Socket.io server attached"
npm run worker       # BullMQ worker (reports + opponent profiling); needs QUEUE_REDIS_URL
npm run setup:engine # copy Stockfish builds into public/engine (auto on pre{dev,build})
npx tsc --noEmit     # type check, must pass with zero errors
npm run build        # production build — the strictest gate
npx prisma generate
npx prisma studio    # browse the database
npx prisma db push   # apply schema changes — see the warning below
```

**Never run `prisma migrate dev` on this project.** There is no
`prisma/migrations` directory and the database is not managed by Prisma Migrate,
so `migrate dev` tries to baseline and may offer to **reset the database**.
Schema changes ship with `npx prisma db push`. Always check what it intends to
do first — an empty diff means the DB already matches:

```bash
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

`npm run lint` is **broken** — this Next version removed `next lint`, so the
script resolves a bogus path. Lint with ESLint directly:

```bash
npx eslint src
```

**Neo4j (Phase 4 transpositions).** This machine runs Docker via **OrbStack**;
there is also a colima `judge0-x64` profile belonging to another project —
leave it alone. Start the graph DB with:

```bash
open -a OrbStack && docker start kca-neo4j
```

First-time creation (already done; recreate only if the container is removed):

```bash
docker run -d --name kca-neo4j -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/kcadevpassword -v kca-neo4j-data:/data neo4j:5
```

Browser UI at `http://localhost:7474`. The password above is **local-dev only**;
the matching `NEO4J_*` vars live in `.env.local` (never committed).

---

## Conventions

- Commit messages: `type(scope): description` — e.g.
  `feat(puzzles): add SM-2 spaced repetition scheduling`
- Types: `feat`, `fix`, `chore`, `refactor`, `docs`
- One commit per logical unit of work. Do not bundle unrelated changes.
- API routes return `{ success: boolean, ... }` consistently. Errors include a
  `message` string and, for validation failures, an `errors` object keyed by
  field name.
- Prefer editing existing files over creating new ones. Prefer small focused
  files over large ones.
- After any schema change, run `npx prisma generate` before type checking.

---

## Legal context

This platform handles data belonging to minors (chess students, often under
 18) and processes payments, so India's DPDPA 2023 applies.

- Registration requires three separate mandatory consent checkboxes: terms
  and privacy policy, age/guardian confirmation, and data-processing consent
- Marketing and SMS consent are optional and must default to unchecked —
  pre-ticking them is a dark pattern and is not permitted
- Users must be able to export their data and delete their account
- All access to personal data is written to the `AuditLog` table