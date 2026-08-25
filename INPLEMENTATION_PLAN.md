# LeadForge AI — Implementation Plan

## Stack (decided)

- **App:** Next.js (App Router) + TypeScript (strict) + Tailwind + shadcn/ui
- **Data:** PostgreSQL + Prisma
- **Jobs:** Redis + BullMQ, workers in a separate process
- **Auth:** Auth.js (NextAuth v5) with the Prisma adapter — no hand-rolled crypto
- **Payments:** Stripe (Checkout + Billing Portal + webhooks)
- **Deploy:** Vercel (app) + managed Postgres + managed Redis; workers on a
  long-running host (Railway/Render/Fly), since Vercel functions can't hold a
  BullMQ worker open.

## Architectural decisions worth stating up front

1. **Per-lead fan-out.** A search creates one discovery job that fans out into
   N independent enrichment jobs, each enqueuing its own scoring job. One slow
   or failing business never stalls or fails the batch. A search ends COMPLETED
   or PARTIAL, never hard-failed because one lead errored.
2. **Reserve credits before spending money.** `consumeCredits` runs an atomic
   conditional UPDATE before any provider call; `refundCredits` returns them on
   hard failure. This is race-safe against concurrent requests.
3. **Tenancy is not optional.** `requireTenant` verifies membership and returns
   a context whose `.where()` always injects `organizationId` + `deletedAt`.
   Queries go through it so the filter can't be forgotten.
4. **Providers are replaceable.** Everything above `LeadProvider` is
   provider-agnostic. The mock provider is dev-only and gated off in production.
5. **Plans are data.** Capabilities/limits read from `src/lib/plans`; the app
   never hardcodes "5000 leads" inline.

## Build order (per spec §36)

- **Phase 1 — Foundation** ← *this delivery*
  Schema, tenancy model, plans config, provider abstraction, normalization +
  dedup, atomic credits, tenant scoping, job pipeline skeleton, env + DX files.
- **Phase 2 — Lead generation:** Next.js app + Auth.js; search form; discovery
  worker writing deduped Lead rows; lead table with filter/sort/paginate.
- **Phase 3 — Enrichment:** website/email/phone/social extraction workers;
  email verification; AI scoring worker.
- **Phase 4 — Export:** CSV + Google Sheets OAuth.
- **Phase 5 — Monetization:** Stripe checkout/portal/webhooks; usage tracking UI;
  limit enforcement wired to credits.
- **Phase 6 — Production:** rate limiting, structured logging, audit log,
  security review, tests, CI, deploy config.

## What can't be verified in the build sandbox

The sandbox has no Postgres/Redis and can't reach Stripe/Google/OpenAI, and the
Prisma engine binary is network-blocked there. So `prisma validate`, migrations,
and live provider calls happen in your repo. The schema passed a structural
check (types + relation back-refs) and the normalize/dedup/plans/provider code
passed strict typecheck and 12 unit tests.

---

# CHANGELOG

## Phase 1 — Foundation (in progress)
- Multi-tenant Prisma schema: 20 models, 7 enums, all tenant tables scoped by
  organizationId, dedup unique constraint per org, soft-delete, Auth.js models.
- Configurable plans (free/starter/pro/agency) with capability flags.
- `LeadProvider` abstraction + registry + dev-only mock provider.
- Normalization (domain/phone/social) + deterministic dedup hash — 12 passing
  unit tests.
- Atomic, concurrency-safe credit consume/refund/reset.
- Tenant scoping context + role guard.
- BullMQ queue definitions with fan-out, retry, exponential backoff.
- `.env.example`, README, this plan.

## Phase 2 — Lead generation (in progress)
- Schema refinement: denormalized `leadScore` onto Lead (+ index) so the lead
  table filters/sorts on score without a relation join.
- Zod validation: `createSearchSchema` (enforces the 25/50/100/500/1000 tiers)
  and `leadListSchema` (filters/sort/pagination, coerces querystring values).
- Discovery pipeline (`processDiscovery`): provider call → normalize → within-
  batch dedup → cross-search dedup vs existing org leads → per-lead atomic credit
  reservation → Lead + social + activity creation → enrichment fan-out → search
  marked COMPLETED or PARTIAL. Dependency-injected; 100% unit-tested.
- Tenant-scoped lead-table query builder (`buildLeadQuery`).
- Prisma client singleton; BullMQ discovery worker wiring the pipeline to real
  deps (Prisma, atomic credits, enrichment queue).
- Tests: 22 passing (discovery happy-path, within-batch dedup, cross-search
  dedup, credit-exhaustion → PARTIAL, query builder scoping/mapping, validation).
  Strict `tsc` passes on all new pure modules.

### Still open in Phase 2
- Next.js app scaffold + Auth.js (sign up / login / protected routes).
- Search form UI and lead table UI (needs the running app; not verifiable in
  the build sandbox).
- API routes: POST/GET/DELETE /api/searches, GET/PATCH/DELETE /api/leads.