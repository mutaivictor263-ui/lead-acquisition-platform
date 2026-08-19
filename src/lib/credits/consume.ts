/**
 * Credit accounting (§20) — concurrency-safe.
 *
 * The naive "read balance, check, then write" loses under concurrency: two
 * requests both read 5, both think they can spend 5, both write. The fix is a
 * single conditional UPDATE — decrement only if the guard still holds — which
 * Postgres executes atomically per row. No app-level lock needed.
 *
 *   UPDATE organizations
 *      SET creditsRemaining = creditsRemaining - $n
 *    WHERE id = $org AND creditsRemaining >= $n
 *
 * If it matches 0 rows, the balance was insufficient — reject. We record the
 * spend in usage_records within the same transaction so the audit trail can
 * never drift from the balance.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

export type UsageKind =
  | "lead_generated"
  | "enrichment"
  | "email_verification"
  | "export"
  | "api_request";

export class InsufficientCreditsError extends Error {
  constructor(public readonly needed: number) {
    super("Insufficient credits");
    this.name = "InsufficientCreditsError";
  }
}

interface ConsumeArgs {
  organizationId: string;
  amount: number;
  kind: UsageKind;
  searchId?: string;
  meta?: Prisma.InputJsonValue;
}

/**
 * Atomically reserve `amount` credits and log usage. Throws
 * InsufficientCreditsError if the balance can't cover it. Returns the new
 * balance. Call this BEFORE spending money on a provider — reserve first,
 * then do the work; refund on hard failure via `refundCredits`.
 */
export async function consumeCredits(
  prisma: PrismaClient,
  { organizationId, amount, kind, searchId, meta }: ConsumeArgs,
): Promise<{ creditsRemaining: number }> {
  if (amount <= 0) throw new Error("consumeCredits: amount must be positive");

  return prisma.$transaction(async (tx) => {
    // Atomic guard: decrement only if enough remain.
    const updated = await tx.organization.updateMany({
      where: { id: organizationId, creditsRemaining: { gte: amount } },
      data: { creditsRemaining: { decrement: amount } },
    });

    if (updated.count === 0) {
      throw new InsufficientCreditsError(amount);
    }

    await tx.usageRecord.create({
      data: { organizationId, kind, quantity: amount, searchId, metaJson: meta ?? undefined },
    });

    const org = await tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { creditsRemaining: true },
    });
    return { creditsRemaining: org.creditsRemaining };
  });
}

/**
 * Return reserved credits when work fails before delivering value (§30). Logs a
 * negative-quantity usage row so net usage over the period stays accurate.
 */
export async function refundCredits(
  prisma: PrismaClient,
  { organizationId, amount, kind, searchId, meta }: ConsumeArgs,
): Promise<void> {
  if (amount <= 0) return;
  await prisma.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: organizationId },
      data: { creditsRemaining: { increment: amount } },
    });
    await tx.usageRecord.create({
      data: {
        organizationId,
        kind,
        quantity: -amount,
        searchId,
        metaJson: {
  ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}),
  refund: true,
},
      },
    });
  });
}

/** Reset a period: refill to the plan allowance and stamp the next period end. */
export async function resetCreditsForPeriod(
  prisma: PrismaClient,
  organizationId: string,
  monthlyLeadCredits: number,
  periodEnd: Date,
): Promise<void> {
  await prisma.organization.update({
    where: { id: organizationId },
    data: { creditsRemaining: monthlyLeadCredits, creditsPeriodEnd: periodEnd },
  });
}