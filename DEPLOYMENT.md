# Deploying Kamath Chess Academy → `kamathchessacademy.com`

**Goal:** take this platform live on your Hostinger domain, targeted for **14 Sept**.
Mobile app is deliberately deferred — ship the web app, gather real feedback, then decide.

This is a practical runbook. It is written around the **recommended path**: one **VPS running
Docker Compose**. A provider comparison is in [§2](#2-where-to-host--comparison) if you want to
choose differently — every provider below uses the same Compose setup.

---

## 0. TL;DR

1. Rent a small **VPS** (2 vCPU / 4 GB is plenty to start).
2. Point `kamathchessacademy.com` **DNS at the VPS IP** (the domain stays at Hostinger — only DNS changes).
3. On the VPS: install Docker, clone the repo, drop in a production env file, `docker compose up -d`.
4. **Caddy** gets a free HTTPS certificate automatically and reverse-proxies to the app.
5. Keep using your existing **Supabase** (Postgres) and **Upstash** (Redis) — they're already provisioned.

Everything the app needs to run is already in the repo; this guide only adds four small files
(`Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.env.production`).

---

## 1. Why not "just upload it to Hostinger"?

Hostinger's **shared/web hosting** (and serverless hosts like Vercel) **cannot run this app.** It is
not a static site or a plain Next.js app — it is a **custom Node server** (`server.mjs`) that:

- runs a **Socket.io** WebSocket server for live games, presence, and notifications;
- sets **COOP/COEP** cross-origin-isolation headers so the **Stockfish WASM** engine can use threads
  (`server.mjs` lines 22-24) — analysis, reports, dossiers, and opening repertoires all depend on this;
- runs **Puppeteer** (headless Chromium) to render report/dossier/opening **PDFs**;
- runs a **persistent background worker** (`npm run worker`, BullMQ) for profiling & report jobs;
- optionally runs **Neo4j** for the Digital Second transposition graph.

That combination needs a real Linux host you control — a **VPS or container platform**. Your
**domain can stay registered at Hostinger**; we only change its DNS records to point at the server.

---

## 2. Where to host — comparison

| Option | Monthly | Ops effort | Notes |
|---|---|---|---|
| **Hostinger VPS (KVM 2)** | ~₹700–1,000 | Low–Med | One vendor with your domain. 2 vCPU / 8 GB. Full root, Docker-ready. **Recommended if you want a single bill.** |
| **Hetzner CX22 / DigitalOcean** | ~€4–8 / $6–12 | Low–Med | Best price/performance (Hetzner). Separate account from Hostinger. Same Compose setup. **Recommended for value.** |
| **Railway / Render** | ~$15–40+ | Lowest | Push repo, it builds. Easiest, but you pay per service (app + worker + Redis + Neo4j add up), and the custom server + COOP/COEP needs a little config. Good if you value time over cost. |

**Recommendation:** a single **2 vCPU / 4–8 GB VPS** (Hostinger KVM 2 or Hetzner CX22). The engine
runs up to 8 parallel Stockfish workers and Puppeteer spins up Chromium, so **4 GB RAM is the
sensible floor**; 8 GB gives headroom.

---

## 3. Architecture

```
                         ┌────────────────────────── VPS (Docker Compose) ──────────────────────────┐
   kamathchessacademy.com│                                                                            │
        (DNS A record) ─▶│  ┌────────┐   :443   ┌─────────────┐   :3000   ┌──────────────────────┐   │
                         │  │ Caddy  │──HTTPS──▶ │  app        │◀────────▶ │  Socket.io (same     │   │
                         │  │ (TLS)  │           │ server.mjs  │           │  origin, /socket.io) │   │
                         │  └────────┘           └─────────────┘           └──────────────────────┘   │
                         │                         │        │                                          │
                         │                  ┌──────┘        └────────┐                                 │
                         │            ┌───────────┐            ┌───────────┐     ┌───────────┐         │
                         │            │  worker   │            │  redis    │     │  neo4j    │         │
                         │            │ (BullMQ)  │──jobs────▶ │ (BullMQ   │     │ (optional)│         │
                         │            └───────────┘            │  queue)   │     └───────────┘         │
                         │                                     └───────────┘                           │
                         └────────────────────────────────────────────────────────────────────────────┘
                                     │                         │
                          ┌──────────▼─────────┐    ┌──────────▼──────────┐
                          │ Supabase Postgres  │    │ Upstash Redis (REST)│   ← managed, already provisioned
                          │ (DATABASE_URL)     │    │ cache / presence    │
                          └────────────────────┘    └─────────────────────┘
```

- **Self-hosted on the VPS:** `app`, `worker`, a dedicated **`redis`** (BullMQ needs a raw TCP Redis
  — Upstash REST is for the app cache only), optional **`neo4j`**, and **`caddy`** for TLS.
- **Managed (keep as-is):** **Supabase** Postgres and **Upstash** Redis. Email via **Resend**, AI via
  **Groq** (or Anthropic) — all external, configured by env vars.

---

## 4. One-time prep (before touching the server)

1. **Push all code to GitHub** (`github.com/Xenoni234/Kamath_Chess_Academy-Main`) so the VPS can clone it.
2. **(Recommended) migrate the database to Mumbai first.** The DB is currently in Tokyo
   (`ap-northeast-1`); users are in India. `scripts/migrate-region.sh` does a verified dump/restore
   to a new **`ap-south-1`** Supabase project. This cuts ~130 ms off *every* request. Do it now so the
   `DATABASE_URL`/`DIRECT_URL` you deploy with are already the fast ones. (The 495k-row puzzle bank
   comes across in the dump — no re-import.)
3. Make sure you have all **secrets** ready (see [§6](#6-environment-variables)).

---

## 5. Server setup

### 5.1 Rent the VPS & log in
Pick Ubuntu 24.04 LTS. SSH in as root:
```bash
ssh root@YOUR_SERVER_IP
```

### 5.2 Install Docker
```bash
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version
```

### 5.3 Clone the repo
```bash
mkdir -p /opt && cd /opt
git clone https://github.com/Xenoni234/Kamath_Chess_Academy-Main.git kca
cd kca
```

### 5.4 Add the four deployment files
Create these in the repo root on the server (they are **not** committed — they hold secrets and
infra config). Copy each block verbatim.

**`Dockerfile`**
```dockerfile
FROM node:22-bookworm-slim

# Chromium runtime libraries for Puppeteer (PDF generation)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates fonts-liberation wget \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci                      # installs deps + downloads Puppeteer's Chromium
COPY . .
RUN npm run build               # `prebuild` copies the Stockfish engine into public/engine
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start"]     # NODE_ENV=production node server.mjs
```

**`docker-compose.yml`**
```yaml
services:
  app:
    build: .
    restart: unless-stopped
    env_file: .env.production
    expose: ["3000"]
    depends_on: [redis]

  worker:
    build: .
    restart: unless-stopped
    env_file: .env.production
    command: ["npm", "run", "worker"]
    depends_on: [redis]

  redis:                         # dedicated TCP Redis for BullMQ (QUEUE_REDIS_URL)
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes: ["redis-data:/data"]

  # OPTIONAL — omit this whole service for a lean launch (see §8).
  neo4j:
    image: neo4j:5
    restart: unless-stopped
    environment:
      NEO4J_AUTH: "neo4j/${NEO4J_LOCAL_PASSWORD}"
    volumes: ["neo4j-data:/data"]

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
      - caddy-config:/config
    depends_on: [app]

volumes:
  redis-data:
  neo4j-data:
  caddy-data:
  caddy-config:
```

**`Caddyfile`** (automatic HTTPS + WebSocket-aware reverse proxy; it passes the app's COOP/COEP
headers straight through):
```
kamathchessacademy.com, www.kamathchessacademy.com {
    encode gzip
    reverse_proxy app:3000
}
```

**`.env.production`** — see [§6](#6-environment-variables).

### 5.5 Point the app's URLs at the domain
Inside `.env.production`, set:
```
NEXT_PUBLIC_APP_URL=https://kamathchessacademy.com
NEXT_PUBLIC_SOCKET_URL=https://kamathchessacademy.com
QUEUE_REDIS_URL=redis://redis:6379
# only if you kept the neo4j service:
NEO4J_URI=bolt://neo4j:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=<same as NEO4J_LOCAL_PASSWORD in compose>
```

### 5.6 Apply the database schema
The app's tables live in Supabase. Push the current Prisma schema **once** (uses the direct
5432 connection, never the pooler):
```bash
docker compose run --rm app npx prisma db push --url="$DIRECT_URL"
```
(Or run it locally before deploy — same DB either way. This also creates the Phase-5 tables:
`opening_repertoires`, `saved_openings`.)

### 5.7 Launch
```bash
docker compose up -d --build
docker compose logs -f app        # look for "KCA Platform ready" + "Socket.io server attached"
```

### 5.8 DNS cutover (at Hostinger)
In **hPanel → Domains → DNS / Nameservers → Manage DNS records**:
- `A` record — Host `@` → **YOUR_SERVER_IP**
- `A` record — Host `www` → **YOUR_SERVER_IP**  (or `CNAME www → kamathchessacademy.com`)
- Lower the TTL to 300 a day before, so the switch propagates fast.

Within minutes Caddy will obtain a Let's Encrypt certificate and `https://kamathchessacademy.com`
goes live. Verify TLS + isolation headers:
```bash
curl -sI https://kamathchessacademy.com | grep -i "cross-origin\|strict-transport"
# expect: Cross-Origin-Opener-Policy: same-origin  /  Cross-Origin-Embedder-Policy: require-corp
```

---

## 6. Environment variables

Copy `.env.example` → `.env.production` and fill it in. **Required** to boot and serve:

| Key | What |
|---|---|
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | Auth signing — use long random strings (`openssl rand -hex 48`). |
| `JWT_ACCESS_EXPIRY`, `JWT_REFRESH_EXPIRY` | e.g. `15m` / `30d`. |
| `DATABASE_URL` | Supabase **pooled** (6543, `?pgbouncer=true`) — runtime queries. |
| `DIRECT_URL` | Supabase **direct** (5432) — migrations only. |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase project. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | App cache / presence. |
| `QUEUE_REDIS_URL` | `redis://redis:6379` (the Compose service) — **required for durable jobs**; without it jobs run inline and don't survive a restart. |
| `LICHESS_API_TOKEN` | Opening Explorer + novelty mining + Opening Trainer. Any Lichess personal token. |
| `RESEND_API_KEY`, `EMAIL_FROM` | OTP, invoices, report/dossier emails. |
| `AI_PROVIDER` | `openai-compatible` (Groq, free tier) recommended. |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | For `openai-compatible` (Groq). *(or set `ANTHROPIC_API_KEY` with `AI_PROVIDER=anthropic`.)* |
| `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SOCKET_URL` | Both `https://kamathchessacademy.com`. |
| `NEXT_PUBLIC_APP_NAME` | "Kamath Chess Academy". |

**Optional / off for launch:**
- `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` — only if you run the Neo4j service (see §8).
- `MSG91_AUTH_KEY` / `MSG91_TEMPLATE_ID` — SMS OTP (email OTP works without it).
- `CLOUDINARY_*` — image uploads, if used.
- `RAZORPAY_*` / `NEXT_PUBLIC_RAZORPAY_KEY_ID` — **leave unset**; payments are intentionally disabled
  (`isPaymentsEnabled()` returns false — the site is free during testing).
- `OLLAMA_*` — not used in production (don't run the coach off a local model).

> **Never commit `.env.production`.** Keep it only on the server.

---

## 8. Lean-launch decisions (ship faster, safely)

- **Skip Neo4j for v1.** The Digital Second transposition stage **degrades gracefully** without it —
  dossiers still generate, they just omit the "bypass move-order" section (`graphSkipReason:
  not-configured`). Omit the `neo4j` service and the `NEO4J_*` vars; add it later with zero code
  changes. One less service to run and monitor.
- **Payments stay off.** Per project policy the platform is free for the first months of testing;
  the Razorpay scaffold is inactive. Nothing to configure.
- **PDFs live in `/tmp`.** Report/dossier/opening PDFs are written to `/tmp` inside the `app`
  container (ephemeral, per-instance). Fine on a single instance — the emailed copy is the durable
  one, and any expired download regenerates. Don't scale `app` beyond 1 replica without moving PDFs
  to object storage first.
- **Do the Mumbai DB migration before launch** (§4.2) — biggest single latency win.
- **Puzzles are already imported** into the shared Supabase DB (495k rows) — no import step at deploy.

---

## 8.5 Video classes (Phase 6)

Classes have a live room with **in-class chat + roster over Socket.io** and video. Video has
two modes; pick per your appetite for infra:

**Simplest (recommended for launch): embedded video, no extra infra.**
Leave `MEDIASOUP_ENABLED` unset in production. The room embeds a free **Jitsi Meet** call (or the
coach's `meetingUrl` if set). Nothing to run. The room route is already served **without COEP**
(handled in `server.mjs`) so the video iframe loads.

**Full self-hosted SFU (mediasoup, Phase 6 v2): more control, real infra.**
The SFU is built and ships in the app (`src/lib/media/`, `handlers/mediaHandlers.ts`). To turn it on:

1. **Env** (`.env.production`):
   ```
   MEDIASOUP_ENABLED=true
   MEDIASOUP_ANNOUNCED_IP=<the VPS PUBLIC IP>     # required — clients connect here
   MEDIASOUP_LISTEN_IP=0.0.0.0
   MEDIASOUP_MIN_PORT=40000
   MEDIASOUP_MAX_PORT=40100
   ```
2. **Open the UDP media port range** on the host and any cloud firewall, and publish it from the
   `app` container in `docker-compose.yml`:
   ```yaml
   app:
     # ...
     ports:
       - "40000-40100:40000-40100/udp"
   ```
   (mediasoup binds RTP inside this range; `MEDIASOUP_ANNOUNCED_IP` is what it advertises to clients.)
3. **Run a TURN server** so users behind strict/symmetric NATs can still connect — without it some
   students silently fail to join. Add **coturn** as a Compose service (or a managed TURN), open its
   ports (3478/tcp+udp, and a UDP relay range), and — once you wire client ICE servers — point the
   room client at it. For a small launch you can start SFU-off and add this when you need it.
4. **Native worker binary:** mediasoup ships a prebuilt worker in the npm package, so the Docker
   build needs nothing extra. (This project blocks install scripts; the worker still works because
   it's bundled, not built on install.)

Notes: the SFU runs **inside the `server.mjs` process** (the same one Socket.io uses), so no separate
media service for v1 of the SFU. It scales with participants (forwarding, not mixing); size the VPS
accordingly and cap participants per room as usage grows.

## 9. Post-deploy smoke tests

Run through these on the live domain before announcing:

- [ ] `https://kamathchessacademy.com` loads with a valid padlock (TLS).
- [ ] COOP/COEP headers present (curl check in §5.8).
- [ ] **Register + log in** (email OTP arrives via Resend).
- [ ] **Play a live game** vs another browser/incognito — moves, clock, and result sync (Socket.io).
- [ ] **Solve a puzzle** (`/dashboard/puzzles`).
- [ ] **Analysis board** streams an engine eval + a Claude explanation (proves COOP/COEP + AI + engine).
- [ ] **Build a dossier** (Digital Second) from a Lichess handle — completes, PDF downloads, notification fires (proves the worker + engine + Puppeteer + queue).
- [ ] **Build an opening repertoire** (Opening Trainer) — e.g. "Caro-Kann Defence" → variations, guide, PDF.
- [ ] `docker compose logs worker` shows jobs completing, no crash loops.

---

## 10. Operations

**Update / redeploy** (after pushing new code):
```bash
cd /opt/kca && git pull && docker compose up -d --build
```

**Rollback** (previous version):
```bash
cd /opt/kca && git checkout <last-good-commit> && docker compose up -d --build
```

**Logs:** `docker compose logs -f app` / `worker`.
**Restart one service:** `docker compose restart app`.

**Backups:**
- Postgres — **Supabase does automated backups**; enable/verify Point-in-Time Recovery in the
  Supabase dashboard. This is your real data; nothing on the VPS is authoritative for it.
- Redis (BullMQ) — transient job state; the `redis-data` volume with AOF is enough.
- Neo4j (if used) — the `neo4j-data` volume; it's a rebuildable cache, low priority.

---

## 11. Launch checklist → 14 Sept

**Now → ~3 weeks out (this week):**
- [ ] Push all code to GitHub.
- [ ] Run the **Supabase Mumbai migration** and update `DATABASE_URL`/`DIRECT_URL`.
- [ ] Rent the VPS; install Docker.

**~2 weeks out:**
- [ ] Add the four deploy files; fill `.env.production`.
- [ ] `docker compose up -d --build` on a **test subdomain** (e.g. `staging.kamathchessacademy.com` → same IP) and run all §9 smoke tests.
- [ ] Fix anything the smoke tests surface.

**~1 week out:**
- [ ] Lower DNS TTL to 300.
- [ ] Seed real content: coaches/HR accounts, batches, a first tournament, any puzzles/classes for opening week.
- [ ] Confirm Resend sender domain is verified (so OTP/emails don't spam-folder).

**Launch day (14 Sept):**
- [ ] Point `@` and `www` A-records at the VPS IP.
- [ ] Watch `docker compose logs -f` for the first live users.
- [ ] Re-run the §9 smoke tests on the production domain.
- [ ] Announce. 🎉

---

## 12. Rough cost (monthly)

| Item | Cost |
|---|---|
| VPS (2 vCPU / 4–8 GB) | ~₹700–1,000 / ~€5–8 |
| Supabase | Free tier → Pro ($25) if you outgrow it |
| Upstash Redis | Free tier is generous |
| Resend | Free tier (3k emails/mo) |
| Groq (AI) | Free tier |
| Domain | already owned (Hostinger) |

Realistically **~₹700–1,000/month** to start, everything else on free tiers until traffic grows.

---

## 13. Mobile (deferred — the right call)

The web app is responsive and works on phones today. Ship it, watch how real students and coaches
use it, and let that feedback shape a future **React Native** app (Phase 7) rather than guessing now.
When you do, the API and auth here are reused as-is; only the client is new.

---

## 14. Troubleshooting

- **`fetch is not a function` / analysis fails after a dossier:** the Stockfish WASM boot clobbers
  global `fetch`; the code already guards this with `pristineFetch`. If you see it, you're on stale
  code — redeploy `main`.
- **Board pieces invisible / engine single-threaded:** COOP/COEP headers aren't reaching the browser.
  Check the curl in §5.8; make sure nothing (a CDN/proxy in front of Caddy) strips them.
- **Jobs stuck on "processing":** `QUEUE_REDIS_URL` unset or the `worker` service is down —
  `docker compose ps` and `docker compose logs worker`.
- **PDF generation fails:** the Chromium libs in the Dockerfile are missing — rebuild the image.
- **`db push` hangs:** you used the pooled URL. Migrations must use `DIRECT_URL` (port 5432).
- **Out of memory under load:** engine concurrency + Puppeteer is memory-hungry — size the VPS at 4 GB+.
```
