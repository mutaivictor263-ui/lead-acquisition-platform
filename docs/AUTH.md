# Authentication (Phase 2 — Batch 1)

Auth.js (NextAuth v5) with the Prisma adapter, Google OAuth, and database
sessions. On first sign-in a user gets a personal Organization and an owner
Membership, establishing `User -> Organization -> Membership -> authenticated
access`.

## Required environment variables

These already exist in `.env.example`; fill them in your local `.env`.

| Variable               | Required for Batch 1 | Notes                                                        |
| ---------------------- | -------------------- | ----------------------------------------------------------- |
| `AUTH_SECRET`          | Yes                  | `openssl rand -base64 32`. Auth.js reads this automatically. |
| `AUTH_URL`             | Yes (prod), dev ok   | `http://localhost:3000` in dev.                             |
| `GOOGLE_CLIENT_ID`     | Yes                  | From Google Cloud OAuth 2.0 credentials.                    |
| `GOOGLE_CLIENT_SECRET` | Yes                  | From Google Cloud OAuth 2.0 credentials.                    |
| `DATABASE_URL`         | Yes                  | Existing Postgres connection (already configured).          |

Not used in Batch 1 (leave as-is): SMTP/email, Stripe, provider API keys.

## Google OAuth setup

In Google Cloud Console -> APIs & Services -> Credentials, create an OAuth 2.0
Client ID (type: Web application) and add the redirect URI:

```
http://localhost:3000/api/auth/callback/google
```

For production, add the same path under your deployed origin. Put the client id
and secret into `.env`.

## How it fits together

- `src/auth.ts` — NextAuth config: `PrismaAdapter(prisma)`, Google provider,
  `session.strategy = "database"`, a `session` callback that exposes
  `session.user.id`, and a `createUser` event that provisions the personal org.
- `src/app/api/auth/[...nextauth]/route.ts` — exposes the auth endpoints.
- `src/lib/auth/provisioning.ts` — idempotent, transactional org + owner
  membership creation.
- `src/lib/auth/current-user.ts` — `currentUser()`, `requireAuth()`, and
  `requireCurrentTenant()` (bridges into `requireTenant` from
  `src/lib/tenant/scope.ts`).
- `src/app/(app)/layout.tsx` — server-side guard for all protected pages.
- `src/app/(auth)/signin/page.tsx` — basic Google sign-in.

No `middleware.ts`: protection is enforced server-side in the `(app)` layout,
which keeps the Prisma adapter on the Node runtime.

No schema change: the existing `User` / `Account` / `Session` /
`VerificationToken` models already satisfy `@auth/prisma-adapter`, so no
migration is needed for this batch.