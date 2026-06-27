# Kamath Chess Academy Platform

Phase 0 of the Kamath Chess Academy platform is a Next.js App Router application with the public website, authentication foundations, Prisma data model, role-gated dashboards, and health checks.

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Configure environment values:

```bash
cp .env.example .env.local
```

Set real Supabase PostgreSQL values for `DATABASE_URL` and `DIRECT_URL`, real Upstash values for `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, and strong JWT secrets.

3. Push the Prisma schema:

```bash
npx prisma db push
```

4. Start the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Project Structure

- `src/app/(public)` contains the finalized public website and placeholder legal pages.
- `src/app/(auth)` contains login and registration pages.
- `src/app/(dashboard)/dashboard` contains role-based dashboards at `/dashboard/student`, `/dashboard/parent`, `/dashboard/coach`, `/dashboard/hr`, and `/dashboard/head`.
- `src/app/api` contains contact, health, and auth route handlers.
- `src/lib` contains Prisma, Redis, auth, validation, and utility helpers.
- `prisma/schema.prisma` defines the Phase 0 database model.
- `src/proxy.ts` contains the Next 16 request gate for dashboard routes.

## Phase 0 Scope

Phase 0 includes database schema, auth routes, httpOnly token cookies, role-based dashboard shells, route protection, and health checks.

Future phases will add real OTP delivery, chess board workflows, Stockfish analysis, tournament/game logic, payments, realtime features, and external AI integrations.
