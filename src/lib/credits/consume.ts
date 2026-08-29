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

import { getPlan } from "../plans/plans";

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

/**
 * Advance a date by exactly one calendar month (UTC), clamping the day to the
 * last valid day of the target month so it never overflows into the following
 * one. Pure and deterministic.
 *
 *   Jan 31 -> Feb 28 (or Feb 29 in a leap year)
 *   Dec 15 -> Jan 15 of the next year
 */
export function nextPeriodEnd(from: Date): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();

  const targetYear = month === 11 ? year + 1 : year;
  const targetMonth = (month + 1) % 12;

  // Day 0 of (targetMonth + 1) is the last day of targetMonth.
  const lastDayOfTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfTarget);

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      clampedDay,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * Lazily roll the organization's credit period if it has expired (or was never
 * initialized), refilling to the plan allowance. Safe to call on any hot path
 * before credits are spent.
 *
 * Concurrency invariant: the refill is a SINGLE atomic conditional updateMany
 * that (a) guards on the exact period boundary that was read — so only one
 * concurrent caller wins per expired period (losers match 0 rows and no-op),
 * and (b) adjusts the balance RELATIVELY (`increment: delta`, delta = allowance
 * - balanceRead) rather than assigning an absolute value. Because the write is
 * relative, a consume or refund that commits between the read and the reset is
 * preserved, never overwritten:
 *
 *   allowance 100, read balance 3 -> delta 97
 *   concurrent consume: 3 -> 2
 *   reset: 2 + 97 -> 99   (the -1 is kept)
 */
export async function ensureCreditsForPeriod(
  prisma: PrismaClient,
  organizationId: string,
): Promise<void> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { planKey: true, creditsRemaining: true, creditsPeriodEnd: true },
  });
  if (!org) return;

  const now = new Date();
  // Live period -> nothing to do.
  if (org.creditsPeriodEnd !== null && org.creditsPeriodEnd > now) return;

  const allowance = getPlan(org.planKey).monthlyLeadCredits;
  const delta = allowance - org.creditsRemaining;
  // Drift-free: anchor the next boundary to the stored one; null anchors to now.
  const next = nextPeriodEnd(org.creditsPeriodEnd ?? now);

  // Optimistic-concurrency reset. The WHERE matches the EXACT boundary we read
  // (a Date, or null via `creditsPeriodEnd: null` => IS NULL), so only the first
  // concurrent caller updates the row; others get count === 0.
  await prisma.organization.updateMany({
    where: { id: organizationId, creditsPeriodEnd: org.creditsPeriodEnd },
    data: { creditsRemaining: { increment: delta }, creditsPeriodEnd: next },
  });
  // count === 0 => a concurrent caller already rolled this period; no-op.
}