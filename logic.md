# How the Digital Second works — the full logic, in plain language

*A guide to the opponent-preparation engine for a chess player, not a programmer.
It explains **what** it does, **how** it does it (the actual algorithms, data
structures, and models), **how the data is fetched and processed**, and **why you
can trust it**. Every number here is the one the code actually uses.*

---

## 0. The honest headline (read this first)

**No dossier is 100% accurate, and any tool that claims to be is lying to you.**
This whole system is built to be *trustworthy*, which is a different and better
goal than *certain*. Three hard limits sit under everything:

1. **The engine sees deep, not infinitely.** We confirm mistakes with Stockfish
   at depth 18. A deeper search would overturn some verdicts. Depth 18 is far past
   club strength — but it is a very strong *opinion*, not the truth.
2. **Every rate has a margin of error.** "Misses forks 30% of the time" from 20
   chances really means "somewhere between about 13% and 54%." More games shrink
   the range; nothing removes it.
3. **The detectors are good, not perfect — and we measured exactly how good.**
   Our tactic-spotters run at 89.7%–96.8% accuracy; one (the pin) was *thrown out*
   at 76.9% rather than shipped with a caveat.

What rattles a stronger opponent is never a confident number. It is **specific,
checkable, correctly-hedged** preparation: *"in 34 games with this structure he
scored 41%, and in 7 of them he spent under 20 seconds on the losing move."* A
titled player can verify that and respects it. A number they can disprove in one
game destroys trust in the entire document. Everything below is engineered to
stay on the right side of that line.

---

## 1. The whole machine in one diagram

```
                    ┌───────────────────────────────────────────────┐
   YOU ENTER:       │  up to 5 online handles  +  FIDE ID  +  pasted │
                    │  PGN  +  which colour you play                 │
                    └───────────────────────┬───────────────────────┘
                                            │
        ┌───────────────────────────────────┼───────────────────────────────────┐
        │                    STAGE 1 — FETCH & MERGE (the "ingest")             │
        │   Lichess API ─┐                                                       │
        │   Chess.com API├─► normalise → de-duplicate → recency-weight → pool    │
        │   FIDE→broadcast┤     (one clean list of their games, newest first)   │
        │   pasted PGN ───┘                                                      │
        └───────────────────────────────────┬───────────────────────────────────┘
                                            │  (the pooled, weighted games)
        ┌───────────────────────────────────┼───────────────────────────────────┐
        │                    STAGE 2 — ANALYSE (Stockfish + maths)               │
        │                                                                        │
        │   opening TREE ──► weak spots ──┐                                       │
        │   (their repertoire)            │                                       │
        │                                 ├─► tactical profile (what they miss)   │
        │   whole-game SCAN ──────────────┤─► behavioural profile (how they act) │
        │   (Stockfish grades             │─► evolution (how they've changed)     │
        │    every move)                  │                                       │
        │                                 └─► transpositions (move-order tricks)  │
        │                                     novelties (surprise weapons)        │
        └───────────────────────────────────┬───────────────────────────────────┘
                                            │  (numbers + evidence)
        ┌───────────────────────────────────┼───────────────────────────────────┐
        │                    STAGE 3 — WRITE & DELIVER                            │
        │   Stockfish-built recommended lines ─► AI writes the briefing ─► PDF    │
        └────────────────────────────────────────────────────────────────────────┘
```

Read it top to bottom: **you give inputs → we fetch and clean the games → Stockfish
and statistics turn them into findings → an AI writes it up as a plan.**

---

## 2. The models and tools — what is actually doing the thinking

There are **two "brains"**, and it is important to know which does what:

| Tool | What it is | What it decides |
|---|---|---|
| **Stockfish 18 Lite** (NNUE neural-net eval, runs as WebAssembly) | The chess engine. Rated far above any human. | **Every chess judgment** — is this a mistake, what's the best move, is a tactic present. This is the part you trust for *correctness*. |
| **`openai/gpt-oss-120b`** via **Groq** (a large reasoning language model) | The writer. | **Only the prose.** It turns Stockfish's numbers into readable English. It is told to *annotate, never invent* — see §9. Swappable for Anthropic's Claude or a local model; a plain-text template is the fallback if no AI is configured. |

Plus the supporting cast: **chess.js** (legal-move rules and board handling),
**Neo4j** (a graph database, for the move-order/transposition search),
**PostgreSQL** (stores the finished dossier), **Redis** (caches fetched games and
runs the background job queue), and the public **Lichess** and **Chess.com** APIs
as the game sources.

**The key point for trust:** the language model never judges a chess move. If it
has no Stockfish number for something, it is instructed to say so, not guess.

---

## 3. How the data is fetched and processed (Stage 1 in detail)

```
  LICHESS handle ─► GET lichess.org/api/games/user/{h}?clocks=true&opening=true
  CHESS.COM handle ► GET api.chess.com/pub/player/{h}/games/{year}/{month}  (walk months)
  FIDE ID ────────► GET /api/fide/player/{id}         (name, ratings)
                    GET /fide/{id}/redirect  (HTML)    (find their broadcasts)
                    GET /api/broadcast/search?q=...    (resolve to tournament id)
                    GET /api/broadcast/{tourId}.pgn    (all the games)
                    keep only games whose [WhiteFideId]/[BlackFideId] == the id
  PASTED PGN ─────► split into single games, parse each independently
                        │
                        ▼
              ┌───────────────────────┐
              │  normalise each game  │  one common record: moves, result,
              │  into a "RawGame"     │  ratings, clocks, date, termination
              └───────────┬───────────┘
                          ▼
              ┌───────────────────────┐   Same game on two accounts? Keep one.
              │  de-duplicate (a Set  │   Two profiled accounts played each other?
              │  keyed by game id)    │   Drop it (it's not "their" opponent).
              └───────────┬───────────┘
                          ▼
              ┌───────────────────────┐   Newer games count more (§4). Then keep
              │  recency-weight, sort │   the freshest up to the budget; OTB games
              │  newest-first, trim   │   are never trimmed (they're scarce+precious).
              └───────────┬───────────┘
                          ▼
                   the pooled game list  ──►  Stage 2
```

Some honest handling built into this stage:

- **Chess.com's `time_control` traps.** `"600+5"` is 10 min + 5 s; `"1/259200"` is
  *3 days per move* correspondence. A naïve reading of the second gives a 1-second
  clock and poisons every downstream time figure — so it's parsed explicitly.
- **Clocks are checked for alignment.** A clock list that doesn't line up with the
  move list one-to-one would silently shift every "time spent" by a constant. Such
  games have their clock data dropped rather than trusted.
- **A game with no date is rejected**, never dated "today" — because that would
  hand an undated game full recency weight (see §4).
- Fetched games are **cached in Redis for 24 hours**, so re-running is fast and
  kind to the public APIs.

---

## 4. The algorithms and data structures, named

This is the "which DSA / which algo" answer. Each is chosen to be simple and
*explainable*, because a plan you can't explain is a plan a titled player won't
trust.

| Where | Data structure / algorithm | In one sentence |
|---|---|---|
| Recency | **Exponential decay** `weight = 0.5 ^ (age_days / 180)` | Every game's influence halves every 180 days. |
| Repertoire | **Trie (prefix tree)** of positions, depth 24 plies | Shared move-tree so common opening paths merge into one branch. |
| Transpositions | **Directed graph (DAG) + variable-length path search** | Different move orders reaching the same position collapse to one node; we search paths through it. |
| Weakness / scan | **Two-pass engine sweep** (shallow filter → deep confirm) | Cheap depth-12 pass finds suspects; expensive depth-18 pass confirms them. |
| Engine throughput | **Worker pool** (many Stockfish instances, work-stealing) | Positions are farmed out to a pool so the scan is parallel, not one-at-a-time. |
| Tactics | **Geometric board scan** (ray-casting, attack maps via chess.js) | Forks/pins/skewers are found by looking at what attacks what, not by pattern-guessing. |
| Every rate | **Wilson score interval** | Turns "6 of 18" into an honest range, correct even for small samples. |
| Every accuracy | **Mean ± 1.96 × standard error** | The bracket on an average that tells you whether two numbers really differ. |
| "Enough evidence?" | **Sample-size gating** (min 25 moves / 6 opportunities) | Below a threshold, the finding is hidden, not shown as a shaky percentage. |
| Novelties | **Set intersection**: engine-near-best ∩ human-rare | A move Stockfish likes that humans almost never play. |
| Identity (OTB) | **Exact-match filter on FIDE id** | No name guessing — the id must be in the game's tags. |

The rest of this section walks each pipeline stage and says what it computes.

### 4a. Recency weighting — an exponential decay curve
Every game gets `weight = 0.5 ^ (age / 180 days)`. Six months → half; a year →
a quarter. **Nothing is deleted** — old games still whisper. Clever detail: "age"
is measured from the **newest game across all their accounts**, not today, so a
player who went quiet is still profiled at full strength while *recent-vs-old*
within their history is preserved.

### 4b. The opening tree — a trie
Every game is walked move-by-move into one shared **trie** (a prefix tree), 24
plies deep. Identical opening sequences share the same branch. Each node stores
the recency-weighted **count** of games that reached it and their **score** from
there. That is "their repertoire": not just *what* they play, but *how often* and
*how well*. A line they play a lot but score badly in is a target.

### 4c. Weak spots — Stockfish grading their habits
For positions they reach often enough, our own Stockfish grades the move they
usually play. If it's clearly worse than the best move and their accuracy there is
below 88%, it's a listed weakness. **Clocks amplify it honestly:** time-spent =
`(clock before − clock after) + increment`, and it's only ever used when the
increment is actually known — otherwise the think-time is left blank, never
guessed. Bullet and rapid are never averaged together.

### 4d. Tactical profiling — geometry, with *measured* accuracy
For each of their moves, Stockfish knows the best move; we then check
**geometrically** — ray-casting along ranks/files/diagonals and reading attack
maps via chess.js — whether that best move was a tactic and whether **they found
or missed it.** We ship only detectors we proved reliable against thousands of
tagged puzzles:

| Motif | Detector accuracy | Shipped? |
|---|---|---|
| Hanging piece | 96.8% | ✅ |
| Back-rank mate | 91.6% | ✅ |
| Skewer | 90.8% | ✅ |
| Fork | 90.3% | ✅ |
| Discovered attack | 89.7% | ✅ |
| **Pin** | **76.9%** | ❌ **excluded on purpose** |

A rate is only shown after **≥ 6 opportunities**, always with its Wilson range.

### 4e. Behavioural profiling — bucketing + Wilson, *not psychology*
Stockfish grades a large sample of their moves; we then **bucket** the same
accuracy by situation: under time pressure, after a long think, in the game after
a loss (tilt), by pawn structure, and how their losses end. Each bucket carries a
Wilson interval and is **hidden below 25 moves.** The framing is stated every
time: these are **correlations in their past games, not claims about feelings.**

### 4f. Transpositions — a graph (DAG) and a path search
Two move orders can reach the same position. We store each position by its
**"shape"** (the first four fields of its board description — pieces, side to move,
castling, en-passant) in a **graph database**, so identical shapes become one
node. We then search for **move paths of up to 24 plies** from the start into
their known positions. Output: *"reach this position by this quieter move order
and you're in their weak line before they realise it."*

### 4g. Novelty mining — a set intersection
For target positions we ask Stockfish for its top moves, and cross-check each
against the **Lichess Opening Explorer's** human statistics. A **novelty** is the
intersection: engine-sound (within 40 centipawns of best) **and** human-rare
(played in under 10% of games, with ≥ 30 human games on record). A weapon that
takes them out of book immediately.

### 4h. Evolution — era buckets + a strict interval gate
The same games are sliced by **calendar year** and every metric recomputed per
year. A trend ("accuracy up", "blunders halved") is stated **only when the two
years' confidence intervals do not overlap.** 88% ± 4 vs 91% ± 5 is *not*
improvement and is never reported as one. It says *that* they changed, never *why*.

---

## 5. How the repertoire is built — fetched, or Stockfish-made?

This is the question people most often get wrong, so plainly: **it's both, and the
dossier always keeps them separate.**

```
   THEIR repertoire            OUR counter-prep              THE write-up
   (observed / fetched)        (computed by Stockfish)       (AI annotation)
   ─────────────────────       ───────────────────────       ─────────────────
   the moves they actually  →  Stockfish finds the best   →  gpt-oss-120b turns
   played, from their real     reply / refutation to          the lines + numbers
   games (the trie in §4b)     their weak lines; novelty      into readable prose
                               mining finds surprises         (annotate, not invent)
```

1. **What they play is *fetched / observed*** — it is literally the moves from
   their own games, counted and weighted. Nothing invented.
2. **What we recommend *against* them is *made here by Stockfish*** — the
   recommended lines are the engine's best continuations from their weak positions,
   and the novelties are engine-strong ∩ human-rare moves. These are **computed on
   our machines**, not copied from any database of "prep."
3. **The prose is written by the language model**, and it is handed the lines and
   the numbers and told to explain them — not to produce chess judgments of its
   own. Each recommended line even marks the ply where *their* book ends and the
   *engine's* continuation begins, so the write-up never passes an engine guess off
   as their habit.

So: **their half is real and observed; our half is freshly engine-generated; the
AI only narrates.**

---

## 6. Why you can trust it — the authenticity argument

Trust here is not a promise, it's a set of design choices you can check:

- **Exact identity, no guessing.** Online games come from the account you named.
  OTB games are kept *only* if the opponent's FIDE id is literally in the game's
  tags — never matched by a name that might be spelled three ways. (Verified live:
  profiling FIDE 46608524 returns 22 real tournament games, each carrying that id.)
- **Our own engine is the judge — twice.** Lichess's own quick evals are used only
  as a free pre-filter to *find* suspect moves; our Stockfish then re-checks each at
  depth 18. **No figure in the dossier rests on someone else's engine.**
- **Every number carries its denominator and its range.** "6 of 18 [13–54%]", not
  "33%." A percentage you can't judge is hidden.
- **The detectors are measured, and one was rejected.** 89.7%–96.8% precision is
  quoted to you; the pin was cut at 76.9% rather than shipped and hoped for.
- **Trends must clear the statistics.** Overlapping ranges are never called a
  change. This single rule kills the most tempting false claim.
- **Sources are labelled and provenance is shown** — which account each game came
  from, how stale it is, and (for OTB) that the time control is *inferred*.
- **"Not enough evidence" is a real, frequent output.** When a bucket, motif, or
  era is too thin, it says so instead of manufacturing confidence.
- **The AI cannot fabricate chess.** It only narrates Stockfish's findings; with no
  number, it is told to say nothing.

The result is a document whose every claim is either checkable on the board or
openly hedged. That is what makes it usable against a stronger player — and what
separates it from a confident-sounding guess.

---

## 7. Known limits — the honest list

- **Engine depth is finite.** Depth 18 confirms; a deeper engine would overturn
  some verdicts. A one-game disagreement with the dossier is completely expected.
- **Sample size bounds every rate.** The brackets are not decoration.
- **Detectors are imperfect** (and the pin is deliberately absent).
- **Online evals are a shortcut, not an authority** — used only to pre-filter.
- **OTB data has real gaps.** No stated time control (increment is inferred from
  rising clocks and flagged), and no record of how a game ended (that section
  excludes OTB games and says so). The identity match, by contrast, is exact.
- **The FIDE→broadcast discovery reads a Lichess web page**, so it can break when
  their markup changes; it then falls back to a name search and *tells you* it did.
  An OTB miss never sinks a dossier that still has online games.
- **Behaviour is correlation, never psychology.** We can measure that their
  accuracy drops under time pressure. We cannot, and do not, tell you what they feel.

Used within these limits — specific, sourced, correctly hedged — the dossier earns
a stronger player's respect. Pushed past them, into claims it can't support, it
becomes the very thing that gets dismissed. The whole system is built to stay on
the right side of that line.
