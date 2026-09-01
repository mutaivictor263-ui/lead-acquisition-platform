import { describe, it, expect, vi } from "vitest";

import { processScoring, type ScoringDb } from "./scoring";

const leadRow = {
  id: "lead_1",
  organizationId: "org_A",
  businessName: "Acme",
  website: "https://acme.example",
  websiteDomain: "acme.example",
  email: null,
  emailStatus: "UNKNOWN",
  phone: "+15550100",
  companySize: null,
  industry: null,
  address: "123 Example St",
  city: "Nairobi",
};

function mockDb() {
  const updateMany = vi.fn(async (_a: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({ count: 1 }));
  const db = {
    lead: {
      findFirst: vi.fn(async () => leadRow),
      update: vi.fn(async () => ({})),
      updateMany,
    },
    leadContact: { findMany: vi.fn(async () => []) },
    leadSocial: { findMany: vi.fn(async () => []) },
    leadScore: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
    leadActivity: { create: vi.fn(async () => ({})) },
  } as unknown as ScoringDb;
  return { db, updateMany };
}

const args = { organizationId: "org_A", searchId: "s1", leadId: "lead_1" };

describe("processScoring — completion status", () => {
  it("writes leadScore and processingStatus COMPLETED in one tenant-scoped update", async () => {
    const { db, updateMany } = mockDb();
    const out = await processScoring({ db }, args);

    expect(updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: "lead_1", organizationId: "org_A" }); // tenant-scoped
    expect(data.processingStatus).toBe("COMPLETED");
    expect(typeof data.leadScore).toBe("number"); // score written together
    expect(data.leadScore).toBe(out.score);
  });
});