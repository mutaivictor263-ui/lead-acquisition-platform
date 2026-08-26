/**
 * Minimal authenticated page. Proves the full chain works end to end:
 * signed-in user -> resolved personal org -> scoped tenant context. Reads the
 * org through the tenant context and shows a sign-out action.
 */
import Link from "next/link";

import { signOut } from "@/auth";
import { prisma } from "@/lib/db/client";
import { currentUser, requireCurrentTenant } from "@/lib/auth/current-user";

export default async function DashboardPage() {
  const user = await currentUser();
  const ctx = await requireCurrentTenant();

  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId },
    select: { name: true, slug: true, planKey: true, creditsRemaining: true },
  });

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32, maxWidth: 640 }}>
      <h1>Dashboard</h1>
      <p>
        Signed in as <strong>{user?.email ?? user?.name ?? user?.id}</strong>
      </p>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18 }}>Your workspace</h2>
        <ul style={{ lineHeight: 1.8 }}>
          <li>Name: {org.name}</li>
          <li>Slug: {org.slug}</li>
          <li>Plan: {org.planKey}</li>
          <li>Credits remaining: {org.creditsRemaining}</li>
          <li>Your role: {ctx.role}</li>
        </ul>
      </section>

      <p style={{ marginTop: 24 }}>
        <Link href="/searches">Go to searches →</Link>
      </p>

      <form action={signOutAction} style={{ marginTop: 24 }}>
        <button
          type="submit"
          style={{
            padding: "8px 14px",
            cursor: "pointer",
            border: "1px solid #ccc",
            borderRadius: 6,
            background: "#fff",
          }}
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
