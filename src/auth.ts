/**
 * Auth.js (NextAuth v5) configuration.
 *
 * Batch 1 scope: Google OAuth only, database sessions via the Prisma adapter,
 * reusing the existing Prisma client (src/lib/db/client.ts). A new user is
 * provisioned a personal Organization + owner Membership on first sign-in
 * (see src/lib/auth/provisioning.ts).
 *
 * No middleware: protected routes are guarded server-side (see the (app)
 * route-group layout), which keeps the Prisma adapter off the edge runtime.
 */

import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";

import { prisma } from "@/lib/db/client";
import { ensurePersonalOrganization } from "@/lib/auth/provisioning";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),

  // OAuth + adapter → database-backed sessions (Session table already exists).
  session: { strategy: "database" },

  providers: [
    Google({
      // Env names match this repo's .env.example (not the AUTH_GOOGLE_* defaults).
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],

  pages: {
    signIn: "/signin",
  },

  callbacks: {
    /**
     * Database-session callback: `user` is the AdapterUser (has a stable id).
     * Expose it on the session so `requireTenant(prisma, userId, orgId)` and the
     * rest of the app can rely on `session.user.id`.
     */
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },

  events: {
    /**
     * Fires once, when the adapter first creates the user row. Provision the
     * user's personal workspace here. The provisioning routine is idempotent and
     * transactional, so a retry or a race can't create a second org or a
     * half-built one.
     */
    async createUser({ user }) {
      if (user.id) {
        await ensurePersonalOrganization(user.id);
      }
    },
  },
});