import { describe, it, expect, vi } from "vitest";

import { shouldMarkFailed, markLeadFailed, type FailureDb } from "./failure";

describe("shouldMarkFailed — exhaustion semantics", () => {
  it("is false while retries remain (attempt 1 and 2 of 3)", () => {
    expect(shouldMarkFailed(1, 3)).toBe(false);
    expect(shouldMarkFailed(2, 3)).toBe(false);
  });

  it("is true on the final attempt (3 of 3) and beyond", () => {
    expect(shouldMarkFailed(3, 3)).toBe(true);
    expect(shouldMarkFailed(4, 3)).toBe(true);
  });

  it("handles a single-attempt job", () => {
    expect(shouldMarkFailed(0, 1)).toBe(false);
    expect(shouldMarkFailed(1, 1)).toBe(true);
  });
});

describe("markLeadFailed — tenant-scoped, COMPLETED-guarded", () => {
  it("writes FAILED scoped by leadId + organizationId, never overwriting COMPLETED", async () => {
    const updateMany = vi.fn(async (_a: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({ count: 1 }));
    const db = { lead: { updateMany } } as FailureDb;

    await markLeadFailed(db, { organizationId: "org_A", leadId: "lead_1" });

    expect(updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = updateMany.mock.calls[0][0];
    expect(where.id).toBe("lead_1");
    expect(where.organizationId).toBe("org_A");
    expect(where.processingStatus).toEqual({ not: "COMPLETED" });
    expect(data).toEqual({ processingStatus: "FAILED" });
  });
});