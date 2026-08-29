import { describe, it, expect, vi } from "vitest";

import { nextPeriodEnd, ensureCreditsForPeriod } from "./consume";
import { getPlan } from "../plans/plans";

// ── nextPeriodEnd (pure) ─────────────────────────────────────────────────────

describe("nextPeriodEnd", () => {
  it("advances a normal date by one month, same day", () => {
    expect(nextPeriodEnd(new Date("2026-03-15T10:00:00.000Z")).toISOString()).toBe(
      "2026-04-15T10:00:00.000Z",
    );
  });

  it("clamps Jan 31 -> Feb 28 in a non-leap year", () => {
    expect(nextPeriodEnd(new Date("2026-01-31T00:00:00.000Z")).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("clamps Jan 31 -> Feb 29 in a leap year", () => {
    expect(nextPeriodEnd(new Date("2024-01-31T00:00:00.000Z")).toISOString()).toBe(
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("rolls December -> January of the next year", () => {
    expect(nextPeriodEnd(new Date("2026-12-10T08:30:00.000Z")).toISOString()).toBe(
      "2027-01-10T08:30:00.000Z",
    );
  });

  it("preserves the time of day", () => {
    expect(nextPeriodEnd(new Date("2026-06-01T23:59:59.500Z")).toISOString()).toBe(
      "2026-07-01T23:59:59.500Z",
    );
  });
});

// ── ensureCreditsForPeriod (mocked prisma; no DB) ────────────────────────────

type UpdateArg = {
  where: { id: string; creditsPeriodEnd: Date | null };
  data: { creditsRemaining: { increment: number }; creditsPeriodEnd: Date };
};

/** Build a minimal prisma mock exposing only organization.findUnique/updateMany. */
function mockPrisma(
  org: { planKey: string; creditsRemaining: number; creditsPeriodEnd: Date | null } | null,
  updateResult: { count: number } = { count: 1 },
) {
  const updateMany = vi.fn(async (_arg: UpdateArg) => updateResult);
  const findUnique = vi.fn(async () => org);
  const prisma = { organization: { findUnique, updateMany } } as unknown as import("@prisma/client").PrismaClient;
  return { prisma, findUnique, updateMany };
}

const FUTURE = new Date(Date.now() + 5 * 24 * 3600 * 1000);
const PAST = new Date(Date.now() - 5 * 24 * 3600 * 1000);

describe("ensureCreditsForPeriod", () => {
  it("does nothing while the period is still in the future", async () => {
    const { prisma, updateMany } = mockPrisma({ planKey: "free", creditsRemaining: 40, creditsPeriodEnd: FUTURE });
    await ensureCreditsForPeriod(prisma, "org_1");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("resets an expired period using the plan allowance", async () => {
    const { prisma, updateMany } = mockPrisma({ planKey: "pro", creditsRemaining: 12, creditsPeriodEnd: PAST });
    await ensureCreditsForPeriod(prisma, "org_1");
    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0][0];
    // delta = allowance(pro=5000) - 12 = 4988
    expect(getPlan("pro").monthlyLeadCredits).toBe(5000);
    expect(arg.data.creditsRemaining).toEqual({ increment: 4988 });
  });

  it("uses a RELATIVE increment, never an absolute set", async () => {
    const { prisma, updateMany } = mockPrisma({ planKey: "free", creditsRemaining: 3, creditsPeriodEnd: PAST });
    await ensureCreditsForPeriod(prisma, "org_1");
    const data = updateMany.mock.calls[0][0].data;
    expect(data.creditsRemaining).toEqual({ increment: 97 }); // 100 - 3
    // must NOT be an absolute assignment
    expect(typeof data.creditsRemaining).toBe("object");
    expect(data.creditsRemaining).not.toBe(100);
  });

  it("computes the next boundary from the STORED period end (drift-free)", async () => {
    const stored = new Date("2026-01-31T00:00:00.000Z"); // in the past relative to 'now'
    const { prisma, updateMany } = mockPrisma({ planKey: "free", creditsRemaining: 0, creditsPeriodEnd: stored });
    await ensureCreditsForPeriod(prisma, "org_1");
    const arg = updateMany.mock.calls[0][0];
    // next = stored + 1 month (clamped), NOT now + 1 month
    expect((arg.data.creditsPeriodEnd as Date).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    // and the WHERE guards on the exact stored boundary
    expect(arg.where.creditsPeriodEnd).toBe(stored);
  });

  it("initializes a NULL period, anchoring the next boundary to now", async () => {
    const before = Date.now();
    const { prisma, updateMany } = mockPrisma({ planKey: "free", creditsRemaining: 100, creditsPeriodEnd: null });
    await ensureCreditsForPeriod(prisma, "org_1");
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where.creditsPeriodEnd).toBeNull(); // WHERE ... IS NULL
    expect(arg.data.creditsRemaining).toEqual({ increment: 0 }); // 100 - 100
    // next boundary ~ now + 1 month (anchored to now, not a stored date)
    const next = (arg.data.creditsPeriodEnd as Date).getTime();
    expect(next).toBeGreaterThan(before);
  });

  it("treats a concurrent-loser (count: 0) as a benign no-op", async () => {
    const { prisma } = mockPrisma({ planKey: "free", creditsRemaining: 0, creditsPeriodEnd: PAST }, { count: 0 });
    await expect(ensureCreditsForPeriod(prisma, "org_1")).resolves.toBeUndefined();
  });

  it("no-op when the organization does not exist", async () => {
    const { prisma, updateMany } = mockPrisma(null);
    await ensureCreditsForPeriod(prisma, "missing");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("preserves a concurrent decrement (composition property)", async () => {
    // Reset reads balance=3 (delta=97). A concurrent consume takes it to 2 before
    // the relative update lands. Applying the relative increment yields 99 = 100-1,
    // preserving the -1. We model the DB row and apply the captured relative op.
    const row = { creditsRemaining: 3 };
    const { prisma } = mockPrisma(
      { planKey: "free", creditsRemaining: 3, creditsPeriodEnd: PAST },
      { count: 1 },
    );
    // hijack updateMany to simulate: concurrent consume, then apply the increment
    (prisma.organization.updateMany as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (arg: { data: { creditsRemaining: { increment: number } } }) => {
        row.creditsRemaining -= 1; // concurrent consume commits first
        row.creditsRemaining += arg.data.creditsRemaining.increment; // then our relative reset
        return { count: 1 };
      },
    );
    await ensureCreditsForPeriod(prisma, "org_1");
    expect(row.creditsRemaining).toBe(99); // 3 - 1 + 97
  });
});