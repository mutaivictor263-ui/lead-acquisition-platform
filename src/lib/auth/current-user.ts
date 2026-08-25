/**
 * Server-side auth helpers. Thin wrappers over `auth()` plus a bridge into the
 * existing tenant-scoping layer (src/lib/tenant/scope.ts) — this does NOT
 * reimplement scoping, it resolves the caller's active org and hands off to
 * `requireTenant`.
 *
 * Use from Server Components, Route Handlers, and Server Actions.
 */

import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { prisma } from "@/lib/db/client";
import { requireTenant, type TenantContext } from "@/lib/tenant/scope";
import { ensurePersonalOrganization } from "@/lib/auth/provisioning";

export interface SessionUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

/** The signed-in user, or null. Never redirects. */
export async function currentUser(): Promise<SessionUser | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session.user as SessionUser;
}

/** The signed-in user, or redirect to /signin. Guarantees a user with an id. */
export async function requireAuth(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/signin");
  return user;
}

/**
 * Resolve the caller's active organization and return a scoped TenantContext.
 * Batch 1 is single-org-per-user, so we take the user's (only) membership. If a
 * membership is somehow missing (e.g. the createUser event didn't run), we
 * self-heal by provisioning the personal org, then scope to it.
 */
export async function requireCurrentTenant(): Promise<TenantContext> {
  const user = await requireAuth();

  let membership = await prisma.membership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  });

  if (!membership) {
    const organizationId = await ensurePersonalOrganization(user.id);
    membership = { organizationId };
  }

  return requireTenant(prisma, user.id, membership.organizationId);
}