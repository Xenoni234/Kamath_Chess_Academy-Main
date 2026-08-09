# KCA — Manual Test Log

Check each item in the browser and record the result. Tick the box when it
passes; add a note if it fails.

**Setup**

```bash
npm run dev   # must print "Socket.io server attached", serves http://localhost:3000
```

- The `User` table was wiped during testing, so the database starts empty —
  register a fresh account where a test needs a logged-in user.
- Default theme is **dark**. The active theme persists in `localStorage`
  under `kca-theme`.

---

## 1. Games page — separated from Overview

Log in as a STUDENT and open the dashboard.

- [ ] The sidebar shows **Overview** and **Games** as two distinct items.
- [ ] Clicking **Overview** highlights only Overview (not Games) and shows the
      dashboard cards.
- [ ] Clicking **Games** navigates to `/dashboard/games` and highlights only
      Games.
- [ ] The Games page shows a table titled **"Games"** with the subtitle
      "Your complete game history across all time formats."
- [ ] With no games played, it shows the empty state (trophy icon, "No games
      played yet.", and a "Play your first game" link to `/dashboard/play`).
- [ ] Play/finish at least one game, return to **Games**, and confirm the row
      shows Date, Format, Time Control, Opponent, Result (win/loss/draw
      colour), and Rating change (+/- coloured, or "—").
- [ ] The **Review** chevron on a row opens that game at `/game/<id>`.

## 2. Light / dark theme — public site

Open `http://localhost:3000` (logged out).

- [ ] A theme icon button sits **immediately left of the Login** button
      (desktop). It shows a **Sun** in dark mode.
- [ ] Clicking it switches the whole page to **light** (light background, dark
      text, teal accent) and the icon becomes a **Moon**.
- [ ] Clicking again returns to **dark**.
- [ ] On a narrow/mobile width, the toggle appears next to the hamburger menu
      and works the same.
- [ ] Login/Register pages also render correctly in the currently-selected
      theme.

## 3. Light / dark theme — dashboard

Logged in, on any dashboard page.

- [ ] A theme toggle button appears in the sidebar **directly above Logout**,
      labelled "Light Mode" / "Dark Mode" with a Sun/Moon icon.
- [ ] Toggling flips the entire dashboard (sidebar, cards, tables, inputs)
      between dark and light. Text stays readable in both.
- [ ] The chess board squares stay their classic colours (`#F0D9B5` /
      `#B58863`) in both themes — they are not affected by the UI theme.

## 4. Persistence & no-flash

- [ ] Choose **light**, then hard-refresh the page → it loads directly in
      light with **no dark flash** before paint.
- [ ] Choose **dark**, refresh → loads in dark.
- [ ] Set a theme on the public site, then log in → the dashboard opens in the
      same theme (shared `localStorage`).
- [ ] Open DevTools console → no hydration warnings on load.

## 5. Registration error handling (from the earlier auth fixes)

Register a first account, then re-register to trigger the duplicate cases.

- [ ] Password field shows the hint **"At least 8 characters"** before submit.
- [ ] Submitting a too-short password jumps back to **step 1** with a red
      inline error under the password field (not just a top banner).
- [ ] A too-short username shows its error under the **username** field.
- [ ] Valid registration (8+ char password, matching confirm, all 3 mandatory
      consents, OTP `000000` in dev) redirects to `/login`.
- [ ] Re-registering with a duplicate **mobile** shows "This mobile number is
      already registered." under the **mobile** field (step 1). Same for
      duplicate **email** / **username**.
- [ ] During registration the dev-server console does **not** print the
      request body or password, and the 409 response body contains only
      `message` + `errors` (no stack trace).

## 6. Engine foundation (cross-origin isolation)

Prerequisite for everything in sections 7–10.

- [ ] `npm run dev` prints `[copyEngine] … -> public/engine/` **and**
      `> Socket.io server attached`.
- [ ] DevTools console on any page: `crossOriginIsolated` is `true` and
      `typeof SharedArrayBuffer` is `"function"`.
- [ ] Network tab on `/dashboard/analysis` loads
      `/engine/stockfish-18-lite.wasm` (~7 MB), **not** the old 1.5 MB
      `/stockfish.js`.
- [ ] **COEP regression check:** open a live game in two browsers, confirm
      Socket.io still connects and moves sync both ways. This is the main risk
      of the new headers.

## 7. Analysis board (`/dashboard/analysis`)

- [ ] From `/dashboard/games`, click **Analyse** on a finished game → the board
      loads that game and the header names both players.
- [ ] Arrow keys `←`/`→` step through moves; `Home`/`End` jump to the ends.
- [ ] The eval bar moves and three engine lines update as you navigate; a cyan
      arrow points at the engine's best move.
- [ ] Paste a Lichess PGN in the Import panel → it loads. Paste garbage → a
      friendly "not a valid PGN" error, no crash.
- [ ] Paste a FEN → the position loads. Paste garbage → friendly error.
- [ ] Play a move from the middle of a loaded game → the line branches from
      there and stale classifications are cleared.
- [ ] **Analyse game** on a ~40-move game: progress bar advances, completes,
      and shows per-side accuracy plus blunder/mistake counts. **Cancel**
      mid-scan stops it and the board stays usable.
- [ ] Click a graded move → the verdict card names the classification and the
      move the engine preferred.
- [ ] **Explain move** streams text in token by token (not one blob).
      Requires `ANTHROPIC_API_KEY`.
- [ ] Click Explain 11 times inside a minute → the 11th shows the rate-limit
      message rather than an error.

## 8. Play vs engine (`/dashboard/play-engine`)

- [ ] Level 1 is beatable; level 8 is not. (Confirms `Skill Level` / `UCI_Elo`
      actually bind — if both feel identical, the options are not applying.)
- [ ] Playing as Black: the engine opens immediately.
- [ ] **Flip board** changes only the view — you still play your own colour.
- [ ] Hint draws an amber arrow; Takeback undoes both your move and the
      engine's reply; Resign ends the game.
- [ ] Promote a pawn → the promotion dialog appears and the choice is applied.
- [ ] On game over, **Analyse this game** opens the analysis board with the
      finished game loaded.

## 9. Opening explorer (`/dashboard/openings`)

Requires `LICHESS_API_TOKEN` — the explorer API now requires OAuth.

- [ ] Play `1.e4` → real Lichess move statistics and win-rate bars appear.
- [ ] Clicking a row in the moves table plays that move and refetches.
- [ ] The breadcrumb line lets you jump back to an earlier move.
- [ ] Toggling a speed or rating filter refetches; deselecting the last one is
      refused (at least one must stay on).
- [ ] Revisit a position already seen → served instantly from cache. Check the
      `opening_cache` row in `npx prisma studio`.
- [ ] `curl` the route with `?fen=garbage` → **400**, not 502.
- [ ] With `LICHESS_API_TOKEN` unset → "Opening explorer is not configured",
      not a crash.

## 10. Game reports (`/dashboard/reports`)

- [ ] **New report** with a real Lichess username → the row appears and moves
      `Queued → Analysing → Ready` on its own (the page polls every 3 s).
- [ ] Accuracy is **not** in the old 75–90 random band. Cross-check one game
      against Lichess's own accuracy figure — same formula, so it should land
      within a few points.
- [ ] **Download** returns a PDF containing accuracy by phase, most-played
      openings and lowest-accuracy openings.
- [ ] The report email arrives with the PDF attached.
- [ ] A nonexistent username → status `Failed` with an explanatory message,
      not a hang.
- [ ] Downloading another user's report id → 404.

---

### Results / notes

_Record failures, screenshots, or environment notes here._
