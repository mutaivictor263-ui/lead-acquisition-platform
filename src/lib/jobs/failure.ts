/**
 * Shared failure handling for the enrichment/scoring workers.
 *
 * BullMQ emits `failed` on EVERY failed attempt (1, 2, 3), not only the last, and
 * increments `attemptsMade` before emitting. So a durable FAILED must be written
 * only once retries are exhausted — determined by `shouldMarkFailed`, which the
 * workers gate on. The FAILED mutation is tenant-scoped and never overwrites a
 * lead that already reached COMPLETED.
 */

/** True only when the job's retries are exhausted (final attempt has failed). */
export function shouldMarkFailed(attemptsMade: number, attempts: number): boolean {
  return attemptsMade >= attempts;
}

/** Narrow DB surface (PrismaClient satisfies it). */
export interface FailureDb {
  lead: {
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
}

/**
 * Durably mark a lead FAILED after its processing retries are exhausted.
 * Tenant-scoped (id + organizationId) and guarded so it never regresses a lead
 * that already COMPLETED (a stray retry on a completed lead is a no-op).
 */
export async function markLeadFailed(
  db: FailureDb,
  args: { organizationId: string; leadId: string },
): Promise<void> {
  await db.lead.updateMany({
    where: {
      id: args.leadId,
      organizationId: args.organizationId,
      processingStatus: { not: "COMPLETED" },
    },
    data: { processingStatus: "FAILED" },
  });
}