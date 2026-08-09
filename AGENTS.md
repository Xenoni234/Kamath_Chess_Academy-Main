# Kamath Chess Academy (KCA) — Project Context

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
**Local path:** `~/Desktop/Phase0` (folder name is historic — it holds the
whole project, not just Phase 0)

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
| AI | Anthropic Claude API (`@anthropic-ai/sdk`) | Move explanations, report narratives |
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

### Phase 2 — Analysis & learning 🔨 IN PROGRESS (current phase)
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

### Phase 3 — Academy operations 📋 PLANNED
Arena / Swiss / Round Robin tournaments with live leaderboards, class
scheduling (HR assigns coaches to batches), coach and parent dashboards with
real data, Razorpay payments, auto-generated PDF invoices, notification system.

### Phase 4 — Digital Second AI 📋 PLANNED
The flagship feature. Profile any opponent from their Lichess/Chess.com/FIDE
history using time-decay weighting, build an opening Trie of their repertoire,
detect weaknesses (low accuracy + high clock time on the same positions), use a
Neo4j graph to find transposition move-orders that bypass their known
preparation, mine playable novelties with Stockfish, and have Claude generate a
15–20 move annotated repertoire targeting that specific opponent.

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

- `ANTHROPIC_API_KEY` and `LICHESS_API_TOKEN` must be set in `.env.local`;
  both are in `.env.example`. Claude's client is lazily constructed, so a
  missing key fails the request rather than the import.
- Report PDFs are written to `/tmp` and served by
  `/api/reports/[reportId]/download`; that path is ephemeral and per-instance,
  so the emailed attachment is the durable copy.
- Report generation is still `setImmediate` fire-and-forget. `bullmq` is a
  dependency but a real queue is Phase 3 work — a restart mid-job leaves the
  row stuck in `processing`.

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
npm run setup:engine # copy Stockfish builds into public/engine (auto on pre{dev,build})
npx tsc --noEmit     # type check, must pass with zero errors
npm run build        # production build — the strictest gate
npm run lint
npx prisma generate
npx prisma studio    # browse the database
```

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