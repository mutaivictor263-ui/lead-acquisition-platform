/**
 * Tenant scoping (§24).
 *
 * The rule: every tenant-owned query is filtered by organizationId, and a user
 * may only touch orgs they're a member of. Forgetting the filter once is a
 * cross-tenant data leak, so we make the scoped context the ONLY convenient way
 * to query — reach for `ctx.where({...})` instead of hand-writing the org id,
 * and it can't be omitted.
 */

import type { PrismaClient, MemberRole } from "@prisma/client";

export class TenantAccessError extends Error {
  constructor(message = "Not a member of this organization") {
    super(message);
    this.name = "TenantAccessError";
  }
}

export interface TenantContext {
  userId: string;
  organizationId: string;
  role: MemberRole;
  /** Merge the org filter into any Prisma `where`. Use on every tenant query. */
  where<T extends Record<string, unknown>>(w?: T): T & { organizationId: string; deletedAt: null };
  /** Same, but for models without soft-delete. */
  whereHard<T extends Record<string, unknown>>(w?: T): T & { organizationId: string };
}

/**
 * Build a scoped context after verifying membership. Call at the start of every
 * request handler that touches tenant data; pass the resulting ctx down.
 * Throws TenantAccessError if the user isn't a member — never returns an
 * unscoped client.
 */
export async function requireTenant(
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
): Promise<TenantContext> {
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { role: true },
  });
  if (!membership) throw new TenantAccessError();

  return {
    userId,
    organizationId,
    role: membership.role,
    where: (w) => ({ ...(w ?? {}), organizationId, deletedAt: null }) as never,
    whereHard: (w) => ({ ...(w ?? {}), organizationId }) as never,
  };
}

/** Coarse role gate for admin-only actions (billing, member management, deletion). */
export function requireRole(ctx: TenantContext, ...allowed: MemberRole[]): void {
  if (!allowed.includes(ctx.role)) {
    throw new TenantAccessError(`Requires role: ${allowed.join(" or ")}`);
  }
}