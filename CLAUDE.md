# Kamath Chess Academy (KCA) — Project Context

Read this file fully before making any changes. It defines the project,
current state, conventions, and hard rules.

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
| Engine | `stockfish.js` at `public/stockfish.js` | Runs as a browser Web Worker |
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
Analysis board (Stockfish in browser + streaming Claude explanations), play
vs engine at adjustable difficulty, puzzle system with SM-2 spaced repetition,
opening preparation via the Lichess Explorer API, game reports (fetch games
from Lichess/Chess.com → analyse → Claude narrative → PDF → email), and an
app-wide light/dark theme with a persisted toggle.

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

Phase 2 is **partially built and not verified**:

- Backend routes exist for analysis explain, opening explorer, puzzles,
  puzzle attempts, and report generation
- `src/lib/claude.ts` exists with move-explanation and report-narrative helpers
- Some Phase 2 UI exists; several dashboard routes may still 404
- Stockfish is downloaded to `public/stockfish.js` but browser integration is
  not confirmed working

### Known open issues (fix these before adding new features)

**Security — critical**
1. `lobby:cancel-challenge` in `src/lib/socket/handlers/lobbyHandlers.ts` does
   not verify the sender is the challenge creator. Any authenticated user can
   cancel anyone's challenge.
2. `game:draw-accept` in `src/lib/socket/handlers/gameHandlers.ts` does not
   check that a draw was actually offered. A player can force a draw
   unilaterally. The server does not track `drawOfferedBy` at all.

**Auth gaps**
3. `src/app/api/analysis/opening/route.ts` has no auth check.
4. `src/app/api/puzzles/random/route.ts` has no auth check.

**Validation**
5. Several routes cast request bodies with `as Type` instead of validating
   with Zod: analysis explain, otp send, otp verify, puzzle attempt, report
   generate.
6. No Socket.io payload is validated with Zod — every handler in
   `gameHandlers.ts` and `lobbyHandlers.ts` trusts the client shape.

**Developer experience**
7. Registration returns a bare `"Validation failed."` with no field details,
   making failures undebuggable. Zod field errors must be surfaced.
8. The password field shows no requirement hint, so users hit the 8-character
   minimum blind.

**Code quality**
9. `any` types in `GameRoomClient.tsx` (~8 occurrences), `PlayLobbyClient.tsx`
   (line ~339), `ChessBoard.tsx` (line ~85).
10. Fire-and-forget promises without `.catch()` in `lobbyHandlers.ts`,
    `gameHandlers.ts`, and `gameEngine.ts` — these will throw unhandled
    rejections.

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
npx tsc --noEmit     # type check, must pass with zero errors
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