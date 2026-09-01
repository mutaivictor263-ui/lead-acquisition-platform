import { describe, it, expect, vi } from "vitest";

import { processEnrichment, type EnrichmentDb, type EnrichmentProvider } from "./enrichment";

const leadRow = {
  id: "lead_1",
  organizationId: "org_A",
  businessName: "Acme",
  website: "https://acme.example",
  websiteDomain: "acme.example",
  email: null,
  phone: null,
  industry: null,
  companySize: null,
};

/** Mock EnrichmentDb capturing updateMany calls. */
function mockDb() {
  const updateMany = vi.fn(async (_a: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({ count: 1 }));
  const db = {
    lead: {
      findFirst: vi.fn(async () => leadRow),
      updateMany,
    },
    leadContact: { create: vi.fn(async () => ({})) },
    leadSocial: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    leadActivity: { create: vi.fn(async () => ({})) },
  } as unknown as EnrichmentDb;
  return { db, updateMany };
}

/** Provider that returns whatever data it's constructed with. */
function provider(data: Record<string, unknown> = {}): EnrichmentProvider {
  return { key: "test", enrich: vi.fn(async () => data) };
}

const args = { organizationId: "org_A", searchId: "s1", leadId: "lead_1" };

describe("processEnrichment — processing status", () => {
  it("sets PROCESSING at the start, tenant-scoped, only from PENDING/FAILED", async () => {
    const { db, updateMany } = mockDb();
    const enqueueScoring = vi.fn(async () => {});
    await processEnrichment({ db, provider: provider({}), enqueueScoring }, args);

    // first updateMany is the PROCESSING transition
    const first = updateMany.mock.calls[0][0];
    expect(first.data).toEqual({ processingStatus: "PROCESSING" });
    expect(first.where.id).toBe("lead_1");
    expect(first.where.organizationId).toBe("org_A"); // tenant-scoped
    expect(first.where.processingStatus).toEqual({ in: ["PENDING", "FAILED"] }); // never downgrade COMPLETED
  });

  it("empty enrichment ({}) is NOT a failure and still enqueues scoring", async () => {
    const { db, updateMany } = mockDb();
    const enqueueScoring = vi.fn(async () => {});
    const out = await processEnrichment({ db, provider: provider({}), enqueueScoring }, args);

    expect(enqueueScoring).toHaveBeenCalledWith({ organizationId: "org_A", searchId: "s1", leadId: "lead_1" });
    expect(out).toMatchObject({ applied: true, scoringEnqueued: true });
    // no FAILED write anywhere in processEnrichment
    const wroteFailed = updateMany.mock.calls.some((c) => c[0].data.processingStatus === "FAILED");
    expect(wroteFailed).toBe(false);
  });

  it("does not mark FAILED even when the provider finds real data", async () => {
    const { db, updateMany } = mockDb();
    const enqueueScoring = vi.fn(async () => {});
    await processEnrichment(
      { db, provider: provider({ email: "hi@acme.example", emailSource: "website" }), enqueueScoring },
      args,
    );
    const wroteFailed = updateMany.mock.calls.some((c) => c[0].data.processingStatus === "FAILED");
    expect(wroteFailed).toBe(false);
    expect(enqueueScoring).toHaveBeenCalledOnce();
  });
});