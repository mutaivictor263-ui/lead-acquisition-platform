# LeadForge AI

Lead generation SaaS: discover, enrich, qualify, organize, and export business
leads. Multi-tenant, credit-metered, background-processed.

> **Status: Phase 1 (Foundation).** This drop contains the schema and core
> architecture. See `docs/IMPLEMENTATION_PLAN.md` for the build order.

## What's here

```
prisma/schema.prisma           Multi-tenant data model (20 models)
src/lib/plans/plans.ts         Plan definitions + capability checks
src/lib/providers/
  lead-provider.ts             LeadProvider interface, registry, mock provider
  normalize.ts                 URL/phone normalization + dedup hashing
src/lib/credits/consume.ts     Atomic, concurrency-safe credit accounting
src/lib/tenant/scope.ts        Tenant scoping context + role guard
src/lib/jobs/queue.ts          BullMQ queues + fan-out pipeline
.env.example                   All required environment variables
```

## Local setup

Requires Node 20+, PostgreSQL, and Redis running locally (or via Docker).

```bash
cp .env.example .env          # fill in values
npm install
npx prisma migrate dev        # create the schema
npx prisma db seed            # seed plans (Phase 2 adds seed.ts)
npm run dev                   # Next.js app (added in Phase 2)
npm run worker                # BullMQ workers (added in Phase 2)
```

## Verified so far

- Schema: structural check passed (types + relation back-references; 20 models,
  7 enums, 40 relations).
- `plans`, `lead-provider`, `normalize`: strict `tsc` typecheck passes.
- `normalize` / dedup: 12 unit tests pass (`npx tsx` against the real modules).

The credits, tenant, and queue modules depend on a generated Prisma client and
Redis, so they typecheck and run once you've run `prisma generate` in your repo.

## Security posture (baseline)

- All provider/Stripe/OAuth secrets are server-side env vars — never shipped to
  the browser.
- Integration tokens are encrypted at rest (`ENCRYPTION_KEY`); only key hashes
  are stored for API keys.
- Every tenant query goes through `requireTenant().where()`.
- Credit limits are enforced atomically and can't be raced.