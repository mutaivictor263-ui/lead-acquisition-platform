import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks must be created via vi.hoisted so they exist when the hoisted vi.mock runs.
const { orgCreate, membershipCreate, membershipFindFirst, userFindUniqueOrThrow } = vi.hoisted(() => ({
  orgCreate: vi.fn(async (_args: { data: Record<string, unknown> }) => ({ id: "org_new" })),
  membershipCreate: vi.fn(async () => ({})),
  membershipFindFirst: vi.fn(async () => null as null | { organizationId: string }),
  userFindUniqueOrThrow: vi.fn(async () => ({ name: "Ada", email: "ada@example.com" })),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    membership: { findFirst: membershipFindFirst },
    user: { findUniqueOrThrow: userFindUniqueOrThrow },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) =>
      fn({ organization: { create: orgCreate }, membership: { create: membershipCreate } }),
  },
}));

import { ensurePersonalOrganization } from "./provisioning";

beforeEach(() => {
  orgCreate.mockClear();
  membershipCreate.mockClear();
  membershipFindFirst.mockClear();
});

describe("ensurePersonalOrganization", () => {
  it("initializes creditsPeriodEnd (~one month out) when creating the org", async () => {
    const before = Date.now();
    await ensurePersonalOrganization("user_1");

    expect(orgCreate).toHaveBeenCalledTimes(1);
    const data = orgCreate.mock.calls[0][0].data as { creditsPeriodEnd?: Date; name?: string; slug?: string };
    expect(data.creditsPeriodEnd).toBeInstanceOf(Date);

    // roughly one month ahead of "now" (27-32 days), and definitely in the future
    const deltaDays = ((data.creditsPeriodEnd as Date).getTime() - before) / (24 * 3600 * 1000);
    expect(deltaDays).toBeGreaterThan(26);
    expect(deltaDays).toBeLessThan(33);

    // name + slug still set; credits/planKey left to schema defaults (not present here)
    expect(typeof data.name).toBe("string");
    expect(typeof data.slug).toBe("string");
  });

  it("is idempotent: skips creation when a membership already exists", async () => {
    membershipFindFirst.mockResolvedValueOnce({ organizationId: "org_existing" });
    const orgId = await ensurePersonalOrganization("user_1");
    expect(orgId).toBe("org_existing");
    expect(orgCreate).not.toHaveBeenCalled();
  });
});