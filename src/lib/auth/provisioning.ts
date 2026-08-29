/**
 * First-login provisioning: give a brand-new user their own workspace so the
 * User -> Organization -> Membership chain exists before any tenant-scoped
 * query runs.
 *
 * Invariants:
 *  - Idempotent: if the user already belongs to any org, do nothing and return
 *    that org's id. Safe to call from the createUser event AND lazily as a
 *    self-heal from the auth helpers.
 *  - Transactional: the Organization and the owner Membership are created in a
 *    single transaction, so a failure never leaves an org with no owner.
 *  - Race-safe: Organization.slug is unique; on a collision we retry with a new
 *    slug, and if a concurrent call already made the user's membership we adopt
 *    it instead of creating a duplicate.
 */

import { randomBytes } from "node:crypto";

import { Prisma, MemberRole } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { nextPeriodEnd } from "../credits/consume";

const MAX_SLUG_ATTEMPTS = 5;

function baseSlug(seed: string): string {
  const cleaned = seed
    .toLowerCase()
    .split("@")[0] // if it's an email, use the local part
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return cleaned.length > 0 ? cleaned : "workspace";
}

function randomSuffix(): string {
  // 4 bytes -> 8 hex chars; short, URL-safe, collision-unlikely.
  return randomBytes(4).toString("hex");
}

function workspaceName(name: string | null, email: string | null): string {
  if (name && name.trim().length > 0) return `${name.trim()}'s Workspace`;
  if (email) return `${email.split("@")[0]}'s Workspace`;
  return "My Workspace";
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/**
 * Ensure the user has a personal organization + owner membership.
 * Returns the organization id the user belongs to.
 */
export async function ensurePersonalOrganization(userId: string): Promise<string> {
  // Idempotency gate: already a member of something? Use it.
  const existing = await prisma.membership.findFirst({
    where: { userId },
    select: { organizationId: true },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing.organizationId;

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { name: true, email: true },
  });

  const base = baseSlug(user.email ?? user.name ?? "workspace");
  const name = workspaceName(user.name, user.email);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = `${base}-${randomSuffix()}`;
    try {
      const org = await prisma.$transaction(async (tx) => {
        const created = await tx.organization.create({
          data: { name, slug, creditsPeriodEnd: nextPeriodEnd(new Date()) },
          select: { id: true },
        });
        await tx.membership.create({
          data: {
            userId,
            organizationId: created.id,
            role: MemberRole.OWNER,
          },
        });
        return created;
      });
      return org.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent call may have already provisioned this user — adopt it.
        const concurrent = await prisma.membership.findFirst({
          where: { userId },
          select: { organizationId: true },
        });
        if (concurrent) return concurrent.organizationId;
        // Otherwise it was a slug collision; retry with a fresh suffix.
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Failed to provision a personal organization for user ${userId} after ${MAX_SLUG_ATTEMPTS} attempts`,
  );
}