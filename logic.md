# How the Digital Second works

*A plain-language guide to the opponent-preparation engine — written for a chess
player, not a programmer. Every number here is the one the code actually uses.*

The "Digital Second" builds a dossier on an opponent: what they play, where they
are weak, which tactics they miss, how they behave under pressure, and how their
game has changed over the years. This document explains what it does, how, and —
just as importantly — **what it cannot know**. If you are going to trust it
against a stronger player, you need to know exactly how far each claim reaches.

---

## 0. The honest headline

**No dossier is 100% accurate, and any tool that claims to be is lying to you.**
Three hard limits sit under everything below:

1. **The engine only sees so deep.** We confirm mistakes at depth 18. A deeper
   search would change some verdicts. Depth 18 is strong — far past club level —
   but it is not the truth, it is a very good opinion.
2. **Every rate has a margin of error.** "Misses forks 30% of the time" from 20
   chances really means "somewhere around 13–54%." More games narrow that; nothing
   removes it.
3. **The pattern detectors are good, not perfect** — and we measured exactly how
   good (see §6).

So the goal is never a confident-sounding number. It is **specific, checkable,
correctly-hedged** preparation: *"in 34 games with this pawn structure he scored
41%, and in 7 of them he spent under 20 seconds on the critical move."* A titled
player can verify that and will respect it. A number they can disprove in one
game destroys trust in the whole document. Everything below is built to earn the
first kind of trust and avoid the second.

---

## 1. The pipeline in one picture

The dossier is built in stages, each feeding the next:

```
   games in  →  opening tree  →  weak spots  →  tactics they miss
                                              →  how they behave
                                              →  how they've changed
                     ↓
             transpositions (move-order tricks)
                     ↓
             novelties (surprise weapons)
                     ↓
             recommended lines  →  written briefing  →  PDF
```

Roughly: we gather their games, learn their openings, find where they go wrong,
grade their tactics and habits with the engine, look at how they've evolved over
time, then hand all of it to a writing layer that turns numbers into a plan.

---

## 2. Where the games come from

A player's evidence is scattered, so we pull from four kinds of source and label
every one. **What each can and cannot tell us matters:**

| Source | What it gives | What it can't |
|---|---|---|
| **Lichess** handle | Fast games, clocks, its own quick evals | Only their online play |
| **Chess.com** handle | Same, from the other big site | Only their online play |
| **Pasted PGN** (up to 15 games) | Games you already have — a coach's file, a downloaded round | Only as good as what you paste; needs a date on each game |
| **OTB via FIDE ID** | The real over-the-board tournament games, through Lichess's broadcast relays — with an **exact FIDE-ID match** and a **per-game rating** | No move clocks stated, and no record of *how* a game ended |

Up to **five accounts** can be merged into one opponent, because the same person
often has a Lichess handle, a Chess.com handle, and OTB games under their FIDE ID.
The dossier treats them as one player and says which games came from where.

Two honest details on the OTB games:

- **Identity is exact.** A broadcast game is only kept if the opponent's FIDE ID
  is literally in the game's tags — never by guessing from a name that might be
  spelled three ways.
- **OTB games have no "increment" written down.** We work it out from the clocks
  (see §5), and we flag every such figure as *inferred* so you know it rests on a
  deduction, not a stated time control.

---

## 3. Recency weighting — recent games count more

A player from three years ago is not the player you'll face next week. So every
game gets a **weight** that fades with age. The rule is a **half-life of 180 days
(about six months)**: a game six months old counts half as much as a fresh one,
a year old a quarter, and so on. Nothing is thrown away — old games still whisper,
they just don't shout.

One subtle but important choice: the "clock starts" at the **newest game we have
across all their accounts**, not at today's date. So a player who stopped posting
games six months ago is still profiled at full strength — we don't punish them for
a quiet spell — while *within* their history, the recent games still dominate. When
several accounts are merged, they all share the same reference point, so a
long-dead account can't accidentally weigh as much as a live one.

*(OTB games are the exception to one rule: they are never dropped to save space,
even though they're often the oldest, because for tournament prep they're the most
valuable games we have. See §11.)*

---

## 4. The opening tree — learning their repertoire

Every game is walked move by move into a shared tree (a "trie"), out to **24 plies
(12 moves each)**. Each position in the tree remembers two things:

- **Weight** — the recency-weighted number of games that reached it. A line four
  of their recent games went down outweighs a line from one game two years ago.
- **Score from here** — how they actually did from that position (wins, draws,
  losses, all recency-weighted).

That's the whole idea of "their repertoire": not just *what* they play, but *how
often* and *how well*. A line they play a lot but score badly in is a target. A
line they play rarely is noise, and is treated as such.

---

## 5. Weak spots — where the engine catches them

Now the engine gets involved. For the positions they reach often enough (weight at
least **0.6**, between plies **5 and 20** (a ply is a single move by one side), up to **30 positions**), Stockfish grades
the move they usually play. If their habitual move is clearly worse than the best
move — and their accuracy in that position sits below the ceiling of **88%** — it
becomes a listed weakness: *"from here they usually play Nc6, which scores only 71%.
Steer the game here."*

**Clocks amplify this, honestly.** Chess clocks record *time remaining*, so the
time spent on a move is `(before − after) + increment`. We only ever use this when
we actually know the increment; if we don't, the think-time is left blank rather
than guessed — a wrong think-time is worse than none. When we do have it, a weak
move played fast, with the clock running low, is a sharper target than the same
move played after a long think, and the dossier says so.

**A design rule you can rely on:** think-time figures are only ever compared within
the same time control. A bullet game and a rapid game are never averaged together —
the dossier tells you which time control its clock figures rest on, and how many
games were excluded as a different one.

---

## 6. Tactical profiling — which tactics they miss

This is the part where being honest about accuracy matters most, so we measured it.

For each of their moves in the deep scan, the engine knows the *best* move. We
check, geometrically (by actually looking at the board — what attacks what, along
which lines), whether that best move was a tactic, and whether **they found it or
missed it.** Over many games this becomes: *"in 18 positions where a fork was
available, they took it 12 times and missed it 6."*

We only detect five motifs, and we **ship only the ones we could prove are
reliable.** Each detector was tested against thousands of tagged puzzles:

| Motif | Detector accuracy | Shipped? |
|---|---|---|
| Hanging piece | 96.8% | ✅ |
| Back-rank mate | 91.6% | ✅ |
| Skewer | 90.8% | ✅ |
| Fork | 90.3% | ✅ |
| Discovered attack | 89.7% | ✅ |
| **Pin** | **76.9%** | ❌ **excluded** |

**Pin is deliberately left out.** At 76.9%, roughly a quarter of the positions it
flagged weren't really pins. A plan built on "they miss pins" that is wrong a
quarter of the time is worse than saying nothing about pins. Reporting five motifs
honestly beats six speculatively — and the only way pin comes back is a better
detector, re-measured, not a lower bar.

We also never report a rate off too few examples: a motif needs at least **6
opportunities** before its miss-rate is shown at all, and it's always shown with
its range, not as a bare percentage.

---

## 7. Behavioural profiling — patterns, not psychology

The engine grades a large sample of their own moves (up to **200 games**, plies
16–120 of each (a ply is one side's move), at depth 18 with a fast depth-12 pre-filter to find the candidates
worth a deep look). From that we build **accuracy buckets** — the same accuracy
number, sliced by situation:

- **Clock pressure** — accuracy as their clock runs down.
- **Long think vs normal** — do they play worse right after a big think?
- **After the previous game** — accuracy in the game after a win vs after a loss
  (a proxy for tilt).
- **Position type** — open vs closed, queens on vs off, opposite-side castling.
- **How their losses end** — resign, flag, checkmate, and so on.

**The framing is not optional, and the dossier states it every time:** these are
*correlations over their own games*, not mind-reading. "Accuracy drops 6% under 30
seconds" is a fact about their past moves. It is **not** a claim about what they
feel. A bucket with fewer than **25 moves** is hidden rather than shown as a
percentage, because below that the number isn't yet real.

*(OTB games are left out of the "how their losses end" section entirely — broadcast
PGN doesn't record whether a game was resigned or lost on time, and we won't invent
a resignation we can't see. The dossier says how many OTB losses it set aside.)*

---

## 8. Transpositions — the move-order tricks

Two different move orders can reach the same position. If you only look at their
*moves in order*, you miss that their pet Sicilian setup can be reached by a
quieter move order that dodges their preparation.

To catch this, every position is stored by its **"shape"** — the first four fields
of its board description (pieces, side to move, castling rights, en-passant square),
which is what actually defines a position regardless of how you got there. In a
graph database, identical shapes collapse into one node, and we search for **paths
of up to 24 moves** from the start into their known positions. The output is a
**bypass**: *"reach this position via this move order instead of their usual one,
and you're in their weak line before they realise it."*

---

## 9. Novelty mining — surprise weapons

A good surprise is a move that is **strong for the engine but rare for humans**.

For target positions in their repertoire, the engine looks at its top choices
(depth 12, three candidate moves), and we cross-check each against the Lichess
Opening Explorer's human statistics. A move qualifies as a novelty when it is
**within 40 centipawns of best** (engine-sound), not actually bad (no worse than
−40), and **played in fewer than 10% of human games** at that position (with at
least 30 human games on record, so "rare" is real and not just "unseen"). That's a
weapon that takes them out of book immediately without risking your own position.

If the Explorer isn't reachable, this section simply reports no novelties rather
than guessing.

---

## 10. What the numbers actually mean

Three ideas run through the whole dossier, and understanding them is what lets you
use it against a strong player:

- **Sample size.** Every rate keeps its denominator. "6 of 18" is shown, not just
  "33%." A percentage without a count is hidden, because it can't be judged.
- **Confidence intervals (the ranges in brackets).** "72% [61–81]" means the true
  figure is very likely between 61 and 81. **When two ranges overlap, that is not
  a difference** — it's the single most important rule in the document. The style-
  evolution section (below) will *refuse* to call a trend unless the ranges are
  fully apart.
- **"Not enough evidence."** When a bucket, motif, or era is too thin, the dossier
  says so instead of showing a shaky number. An honest blank beats a confident
  guess every time.

**Style evolution over time** puts all three to work: the same measurements are
sliced by calendar year (a year needs at least **8 games and 25 graded moves** to
count). A trend — "accuracy up," "blunders halved," "rating climbing" — is stated
**only when the two years' ranges don't overlap.** 88% ± 4 one year and 91% ± 5 the
next is *not* improvement, and the dossier will not call it one. It also flags
repertoire shifts (a line dropped or taken up between the first and last year), and
it never claims to know *why* the play changed — only that it measurably did.

---

## 11. Known limits — read this before you trust it

Everything above is built to be honest, but honesty means naming the edges:

- **Engine depth is finite.** Depth 18 confirms our verdicts; a deeper engine would
  overturn some. Treat "a mistake" as "a mistake to a strong engine," not gospel.
- **Every rate has a margin.** The brackets are not decoration. A one-game
  disagreement with the dossier is completely expected and does not mean it's wrong.
- **Detectors are imperfect** — 89.7% to 96.8% on the five shipped motifs, and pin
  is missing on purpose. We quote these to you rather than hiding them.
- **Online evals are a shortcut, not an authority.** Lichess's own `[%eval]` marks
  are used only to *find* candidate mistakes fast; our own Stockfish then confirms
  each at depth 18. No dossier figure rests on someone else's engine.
- **OTB data has real gaps.** No stated time control (we infer the increment from
  rising clocks and flag it), and no record of how games ended (that section
  excludes them). The identity match, by contrast, is exact.
- **The FIDE→broadcast link is the one fragile step.** It reads a Lichess web page
  to find an opponent's broadcasts, and that page's format can change. When it finds
  nothing it falls back to a name search and *tells you* it did — an OTB miss never
  sinks a dossier that still has online games.
- **Behaviour is correlation, never psychology.** We can measure that their accuracy
  drops under time pressure. We cannot, and do not, tell you what they feel.

Used within these limits — specific, sourced, correctly hedged — the dossier is
something a stronger player will read and respect. Pushed past them, into confident
claims it can't support, it becomes exactly the thing that gets dismissed. The whole
system is built to stay on the right side of that line.
