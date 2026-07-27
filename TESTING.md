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

---

### Results / notes

_Record failures, screenshots, or environment notes here._
