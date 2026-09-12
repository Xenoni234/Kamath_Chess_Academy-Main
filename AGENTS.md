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
whole project, not just Phase 0). It lived at `~/dev/Phase0` for a while because
iCloud Desktop sync wrecked it; **iCloud Drive is now off on this machine**, which
is the only reason the Desktop is safe. If iCloud Drive is ever turned back on,
move the repo out again — see the iCloud entry under Known gaps for the symptoms.

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

**Role access is enforced in four places, deliberately — do not rely on any one
of them alone.** `proxy.ts` (edge, by path prefix), a `hasRole` guard inside each
role page (so a proxy misconfiguration is not the only thing between a student and
academy revenue), `requireRole` on mutating API routes, and — for anything about a
*specific* student — the relationship helpers in `src/lib/authz.ts`
(`isParentOf` / `isCoachOf` / `canViewStudent`). Role alone never answers "may this
person see THIS student"; always go through `canViewStudent`, and return **404, not
403**, so ids cannot be probed.

**Accounts:** public registration always creates a STUDENT (`register/route.ts`
hardcodes it). Every other role is created by staff via `/api/admin/users`, which
sets an unusable random password and emails a one-time code — **a password is never
generated, shown, or emailed.** The first HEAD is a chicken-and-egg and comes from
`scripts/createHeadUser.ts`. HR may create STUDENT/PARENT/COACH; only HEAD may
create staff or change roles, and the last active HEAD cannot be demoted.

**Login portals** (`/login/student|parent|coach|staff`) are **presentation only**.
The account's role decides access; using the "wrong" door grants nothing.

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

## Phase roadmap (8 phases)

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
- ✅ **Ingestion** (`ingest.ts`) — Lichess ndjson + Chess.com archives. Retains
  per game: game id, normalised `termination` (+ `terminationRaw`), the real
  `TimeControl` (initial/increment/per-move — every field nullable, and **null
  means unknown; never default an increment to 0**), both players' ratings,
  `rated`, ECO, and both timestamps. 24 h Redis cache of the compact form, key
  versioned (`second:ingest:v2:…`) — **bump it whenever `RawGame` changes**, or
  cached values hydrate with the new fields `undefined` and the dossier is blind
  while looking plausible.
- ✅ **Up to 5 accounts per dossier** (`OpponentAccount`), any mix of both sites,
  merged by `fetchOpponentGamesMulti`. Deduped by `source:gameId`; games between
  two profiled accounts are dropped as self-play. **Time-decay weighting uses one
  shared reference — the newest game across every account** (`weight = 0.5 **
  (ageDays / 180)`), so an account abandoned 18 months ago is correctly
  discounted rather than weighing 1.0 on its own newest game. An inactive player
  with only one account still profiles at full strength. `ArtifactAccount.meanWeight`
  surfaces the discount in the Sources panel; hiding it inside the maths would
  make a dossier built almost entirely from one account indistinguishable from
  one built from five.
- ✅ **Opening Trie** (`trie.ts`) — SAN-keyed repertoire tree per colour,
  weighted counts + score, capped at 24 plies.
- ✅ **Weakness detection** (`weakness.ts`) — engine-grades their recurring
  decision positions (ply 5–20) and blends accuracy with **clock pressure**:
  positions they think long about *and* misplay.
  **Think time is increment-corrected.** Clocks are *remaining* time, so
  `prev − curr` under-reports by exactly the increment on every increment game
  and goes negative when the increment exceeds the time spent. `clockSpentCs`
  adds it back and returns **null rather than a guess** when the increment is
  unknown, the result is negative, or it exceeds the base clock. Two more
  silent-wrongness guards live here: a clock array that does not match the move
  list is dropped whole (it would otherwise shift every think time in that game
  by a constant ply offset), and samples are bucketed to the modal `initialSec`
  within 4×, because averaging a 1+0 account with a 15+10 one describes neither.
  `artifact.clockBasis` records which games the figures came from.
  **Dossiers generated before this are not comparable** — their `avgClockSpent`
  is understated by the increment, and `clockBasis` is absent.
- ✅ **Tactical profile** (`tactics.ts` + `lib/tactics/motifs.ts`) — engine-grades
  their own moves across **whole games** (`weakness.ts` only covers plies 5–20,
  the opening, where tactics are rarest) and classifies which motif Stockfish's
  preferred move exploited. Two-pass: depth 12 over the scan window, then
  depth 18 only where their move differed from the engine's, because a depth-12
  "best move" is not solid enough to accuse someone of missing a tactic.
  **`TACTICAL_SCAN_MAX_GAMES` is deliberately separate from the ingest budget** —
  this is the only stage whose cost scales with game count (~65 positions per
  game), so ingest breadth and tactical depth are tuned independently.
  **The detector's accuracy is measured, not asserted.** `scripts/validateMotifs.ts`
  scores it against the ~500k Lichess puzzles already in the `Puzzle` table,
  using their own `themes[]` as ground truth, and judges each motif on the 95%
  lower bound of precision. Only motifs in `SHIPPABLE_MOTIFS` reach a dossier:
  fork, skewer, discoveredAttack, hangingPiece, backRankMate. **`pin` is
  excluded at 76.9% precision** — restoring it means improving the detector and
  re-measuring, never lowering the bar. `MOTIF_PRECISION` is quoted to the user,
  so **re-run the harness and update it whenever the detector changes**.
  Every rate ships with its denominator and a Wilson interval, and anything
  under `MIN_OPPORTUNITIES` renders as "not enough evidence" rather than a
  percentage — a rate computed from two events is how a dossier becomes
  superstition.
- ✅ **Behavioural profile** (`behaviour.ts`) — accuracy bucketed by clock
  remaining (as a **fraction of base time**, never raw seconds — ten seconds is a
  crisis in 3+2 and routine in 15+10), by long-think vs normal, by the result of
  their previous game in that account, and by position character; plus how their
  losses actually end. Derived from the **same** `scan.ts` pass as the tactical
  profile — the grading is the expensive part and both need identical records,
  so running two scans would double the cost of the most expensive stage.
  Everything carries `n` and a 95% interval, and buckets under `MIN_SAMPLES` are
  hidden rather than shown as a percentage. **These are correlations over their
  own games, not psychology** — the UI and the AI prompt both say so explicitly,
  because an accuracy dip under time pressure otherwise reads as a claim about
  what the opponent feels.
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

### Phase 5 — Digital Second: OTB, manual games, evolution ✅ COMPLETE
Extends Phase 4 from online-usernames-only to the games that actually decide
tournaments. Tasks in order:

1. **Supabase region migration — ✅ DONE 11 Sept 2026.** Moved Tokyo →
   Mumbai (`ap-south-1`) with `scripts/migrate-region.sh`. Row counts matched
   table-by-table, all 94 indexes present, and `verifyRoles.ts` (15/15) plus
   `verifyRegistration.ts` (11/11) both pass against the new instance. Measured
   connect+query: **989 ms → 79 ms**.
2. **Manual PGN input** (up to 15 games) — `src/lib/second/pgnImport.ts`. ✅ splitter + ply-aligned clock/eval extraction done; paste UI pending.
3. **OTB games from a FIDE ID**, via Lichess broadcasts — `src/lib/second/otb.ts`. ✅ done. The dead `fideId` field is now load-bearing: a FIDE id pulls the opponent's OTB games in as a `BROADCAST` account. Increment is **inferred from rising clocks** (OTB PGN has no `[TimeControl]`) and flagged `incrementInferred`; OTB games are **exempt from the recency budget trim** (scarce and old, but the most valuable for prep) and **excluded from the "how losses end" breakdown** (broadcast PGN has no `[Termination]`). Discovery scrapes `/fide/{id}/redirect` and **degrades to a name search** if that yields nothing. **Live-verified** through a dev-only diagnostic route (below): control FIDE 46608524 (Kapadi Yash) returns 22 real OTB games with per-game Elo and inferred 30s increments. Two live-only bugs were caught and fixed: the scraped redirect ids are ROUND ids that 404 on the tour-PGN endpoint, so search-resolved TOUR ids now lead the candidate list (they were being crowded out of the MAX_TOURS budget, yielding zero games); and broadcast PGN fetches are rate limited, so `fetchBroadcastPgn` now retries on 429 and the tour loop is paced.
4. **Style evolution over time** — `src/lib/second/evolution.ts`. ✅ done. Buckets the scanned games by calendar-year era and recomputes the SAME metrics per era (accuracy, blunder rate, score, rating, repertoire share). A trend is stated **only when the two eras' confidence intervals do not overlap** — 88%±4 vs 91%±5 is not a trend and is never reported as one. Repertoire shifts (a line abandoned/adopted between the first and last era) are flagged. It never claims *why* the play changed. Fed into the AI narrative, UI, and PDF.
5. **`logic.md`** — the whole Second AI explained for a chess player. ✅ done. Repo-root, plain language, all figures drawn from the code; 11 sections ending in the honest-limits list.

### Phase 6 — Video classes ✅ BUILT, NOT YET PROVEN WITH TWO REAL BROWSERS
Inbuilt group video via mediasoup WebRTC SFU (no third-party API), Socket.io
signalling, screen sharing for board demonstration, in-class chat.

### Phase 7 — Mobile 📋 PLANNED
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

- **Registration OTP is real now — and it was completely broken before.** Nothing
  in the app ever called `/api/auth/otp/send`, so no `OtpVerification` row was ever
  created and **every production sign-up returned 400**; it only appeared to work
  because of a `NODE_ENV === "development" && otp === "000000"` bypass. The bypass
  is gone, the register page now requests a code, and one shared `issueOtpCode`
  (`src/lib/otp.ts`) serves registration, password reset and staff invites. Two
  things that must stay: the email is **lowercased on both the write and the
  lookup** (they disagreed, so any capitalised address could receive a code it
  could never redeem), and the code comes from `crypto.randomInt`, not
  `Math.random`. There is no standalone verify endpoint — it consumed the row, so
  verify-then-register always failed.
- **Move explanations are built from facts, never from a FEN. Do not "optimise"
  this back.** `/api/analysis/explain` takes only `{ fen, playedUci }`; the SERVER
  validates the move is legal, runs two short searches (top-3 with PVs at the
  position, plus the position the move reached — that second score is what makes
  "this cost you N centipawns" honest), and calls `buildMoveFacts`
  (`src/lib/analysis/moveFacts.ts`). Only that fact record reaches the model.
  It was previously the client's job to send the evaluation, the "best" move and
  the alternatives, and every one of those could be — and was — wrong: the
  Opening Trainer sent the eval from the *end of a 15-move line* as if it were
  this position's, named the played move as its own best move, and sent an empty
  alternatives list, so every specific claim in the output was invented. The
  facts include the **complete piece list** and the **complete attacker/defender
  census of the destination square**, because with either missing the model
  invents them (it claimed a knight on an empty square, and a defender that did
  not defend). `MOVE_EXPLANATION_SYSTEM` carries the same anti-invention clause
  as the other prompts — it is the one that was missing it. Evaluations are
  rendered in **pawns from the student's colour**, never raw White-POV
  centipawns, and a mate-derived `cpLoss` (~10 000) is withheld rather than shown.
  `scripts/verifyMoveFacts.ts` pins all of this offline.
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
- **The scan is sized to the HOST, not to `SCAN_MAX_GAMES`. Do not raise the cap
  without re-measuring on the target machine.** Measured in production (2 vCPUs,
  so `ENGINE_CONCURRENCY` derives to **1**, against 8 on the laptop): ingest 0.9 s ·
  weakness+novelty 3.0 s · **scan 509 s** · extend 33.6 s · AI narrative 4.0 s ·
  PDF 1.0 s = ~9.2 min. Groq makes the narrative a rounding error; the scan is
  everything. The deep pass confirms ~1.9 moves/s on one core and logged
  `budget exhausted after 682/1677 items`, so **59 % of candidate mistakes never
  got their depth-18 confirmation** — and the code then fell back to the depth-12
  score, which is precisely what the deep pass exists to avoid. Two fixes:
  unconfirmed moves are now **dropped rather than graded at depth 12** (counted in
  `ScanResult.unconfirmed`), and `scanGameBudget()` trims the game list to what
  the pool can finish (~35 games per engine), because `scanned` is newest-first —
  an exhausted deep pass silently left `games` claiming 96 while `moves` covered
  only the newest 40, giving every rate a denominator its numerator never saw.
- **The database is in Mumbai (`ap-south-1`) as of 11 Sept 2026.** It was in
  Tokyo (`ap-northeast-1`), which cost ~150 ms per round trip from India and was
  the floor under every page. Measured after the move: connect+query went from
  **989 ms to 79 ms**. `scripts/migrate-region.sh` did the dump/restore and
  verified row counts table-by-table; all 94 indexes came across, including the
  `Puzzle_themes_idx` GIN index. The old Tokyo URLs are kept **commented out at
  the top of `.env.local`** as the rollback — swapping two lines reverts it.
  Do not delete the Tokyo project until Mumbai has run in production for a while.
  Note `--schema=public` in the dump: a full dump drags in Supabase's own `auth`
  / `storage` / `realtime` / `vault` schemas, which already exist in the target
  and are owned by roles `postgres` cannot touch, producing 300+ alarming but
  meaningless errors. Needs `brew install libpq` for pg_dump >= 17.
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
- **Never run two dev servers against this repo at once.** They share
  `.next/dev/cache/turbopack`, and two processes writing that database corrupt it.
  The symptom is deeply misleading: Turbopack reports a **syntax error in a file
  that is perfectly valid** (seen as `Unterminated regexp literal` in
  `LoginForm.tsx`, which typechecked clean the whole time), plus panics about
  missing `.sst` files. `npm run dev` does warn — *"Another next dev server is
  already running"* — but if the first one was started by something else (an agent
  driving the browser preview, say) it is easy to miss. The fix is not to debug the
  file:

  ```bash
  pkill -f "node server.mjs"; rm -rf .next && npm run dev
  ```

- **iCloud Desktop sync will destroy this repo — it is only safe here because
  iCloud Drive is switched off.** When it was on, the Desktop plus ~48k
  `node_modules` files and a constantly-rewritten `.next/` caused three separate
  problems that looked unrelated:
  1. Conflict copies (`routes.d 2.ts`, `validator 3.ts`, …) in `.next/types/`,
     making `npx tsc --noEmit` fail with bogus `TS6200 / TS2300 duplicate
     identifier` errors.
  2. `bird` + `fileproviderd` + `cloudd` burning ~100 % CPU permanently.
  3. Endless file-watcher churn → constant Next recompiles → Fast Refresh
     reloading every open tab → a flood of `GET /login` hits that pinned the
     dev server.

  Moving off the Desktop fixed all three (measured: hundreds of `/login` hits
  per second → 3 in 30 s, and recompiles → 0); disabling iCloud Drive entirely
  is what makes the current location equivalent. If conflict copies ever
  reappear, iCloud is back on — turn it off (or move the repo), then clean up:

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

## Pre-launch state (11 Sept 2026)

Target go-live is **14 Sept 2026** on `kamathchessacademy.com` (domain at Hostinger).
See `DEPLOYMENT.md` for the runbook.

**Done and verified against the live database:**
- Schema is in sync — `ClassAttendance`, `ContactMessage` and the five `Payment`
  columns are pushed. The push was purely additive; all 500,000 puzzle rows survived.
- `scripts/verifyRoles.ts` passes 15/15 — the parent/coach/HR/HEAD authorisation
  matrix, including the negative cases (a parent cannot read another child, a coach
  cannot read a stranger).
- `scripts/verifyRegistration.ts` passes 11/11 end-to-end against a running server:
  a code is issued and stored lowercased, a wrong code is refused, the right code
  creates a **verified STUDENT**, login works, and the code row is consumed.
- `npx tsc --noEmit`, `npx eslint src` and `npm run build` are all clean.

**The catch-all 401 is gone — do not reintroduce it.** 28 handlers wrapped
`verifyAccessToken` *and* all their database work in one `try` whose `catch`
returned 401 with no logging. A single database blip therefore looked exactly like
an expired session: the client tore the session down and the server left no trace.
`/api/auth/refresh` was the worst case — every signed-in user hits it every 15
minutes, so one hiccup logged out everyone whose token happened to expire in that
window. The shape now is always: authenticate in its own small `try` that returns
401, then a second `try` around the real work that **logs and returns 500**.

**All five of the previously-unbuilt features now exist**, each with a verify
script: the coach attendance panel, invoice generation, coach game annotations, the
audit-log viewer, and the role context provider. Razorpay is built and gated behind
`isPaymentsEnabled()`.

### Things that must not be undone

- **`src/lib/pdf/launch.ts` is the only place Chromium may be launched.** All three
  renderers used bare `puppeteer.launch({headless:true})`, and the deployment image
  runs as root, where Chromium's setuid sandbox refuses to start. Every PDF in the
  app would have failed on its first production render. `--no-sandbox` is safe here
  and only here: the browser never loads anything but HTML this codebase generated.
- **The class video room name is a secret, not the class id.** It used to be
  `meet.jit.si/KCA-<class cuid>`, so anyone who guessed or was forwarded a URL could
  join a live class of minors with no account, and the student's display name was in
  the URL fragment. The key is generated behind the authorisation gate and **rotated
  on every class start**. The name now goes through the Jitsi IFrame API's options
  object, never the URL. Be honest about the limit: this closes enumeration and stale
  links, but a secret room on public Jitsi is obscurity, not authentication — real
  authentication is 8x8 JaaS with a signed JWT, or the self-hosted SFU.
- **Erasure is an UPDATE, so no cascade fires.** `src/lib/compliance/anonymise.ts`
  deletes every dependent row explicitly. Two are unreachable from the User relation
  and are swept by email: `OtpVerification` rows with a null `userId` (they carry a
  raw address), and `ContactMessage`, which has no FK at all. `GameReport` stays
  `Restrict` deliberately — it never fires on an update, and changing it to Cascade
  would be a data-loss footgun for anyone who later attempts a real delete.
- **`Invoice.number` comes from the `invoice_counters` table**, not from counting
  existing invoices — that loses a race under READ COMMITTED and dies on the unique
  index. Gaps are correct; a reserved number must never be reused.
- **The Razorpay webhook releases its idempotency marker on failure.** Insert-first
  stops duplicate settlement, but if processing then throws, the retry would hit
  P2002 and return 200 with the payment still PENDING forever. The catch deletes the
  marker so the retry can work.
- **`isPaymentsEnabled()` is server-only.** A `"use client"` file importing it gets
  `false` baked into the bundle and checkout silently vanishes. It is passed down as
  a prop; `scripts/verifyRazorpay.ts` greps for violations.

### Verification

Twelve self-cleaning scripts, all passing, all runnable with
`npx tsx --env-file=.env.local scripts/<name>.ts` (those marked † need `npm run dev`):

`verifyPdfLaunch` · `verifyRoomSecurity`† · `verifyAttendance`† · `verifyContact`† ·
`verifyConsent`† · `verifyAnonymise` · `verifyInvoice` · `verifyRazorpay`† ·
`verifyAudit`† · `verifyAnnotation`† · `verifyRoles` · `verifyRegistration`†

**Never verified:** two-browser SFU video (Phase 6); the Razorpay **outbound** order
call, which needs real test-mode keys (signature verification and idempotency ARE
covered); and the authenticated UIs as a human sees them.

**Still deferred by decision:** Phase 7 (mobile), SMS (the consent checkbox was
removed rather than left collecting consent for a channel that cannot deliver), and
Neo4j in production.

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

# Phase 4 verification. These catch what tsc cannot — every one of them has
# already found a real bug that typechecked cleanly.
npx tsx --env-file=.env.local scripts/validateMotifs.ts 1500   # score the motif detector vs Lichess puzzle labels
npx tsx --env-file=.env.local scripts/verifyScan.ts <handle> LICHESS 30   # ingest + scan + profiles, with timings
npx tsx --env-file=.env.local scripts/dryRunDossier.ts         # full artifact + PDF assembly, no DB writes
npx tsx --env-file=.env.local scripts/e2eProfileJob.ts         # the real job incl. persistence; creates and deletes its own dossier
npx tsx scripts/verifyOtb.ts <fideId> <broadcast.pgn>          # OTB identity + increment inference, offline against a PGN
npx tsx --env-file=.env.local scripts/verifyOtb.ts <fideId>    # OTB full live chain against Lichess broadcasts
npx tsx scripts/verifyEvolution.ts                             # style-evolution trend gating (synthetic, no engine/network)
# (The dev-only /api/dev/otb diagnostic route was removed before launch — use
#  scripts/verifyOtb.ts, which covers the same chain offline and live.)
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