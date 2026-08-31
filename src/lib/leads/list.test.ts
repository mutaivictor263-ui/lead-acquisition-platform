/**
 * Data-access tests for the Results API (§28). No Postgres/Redis: the tenant
 * scoping, soft-delete exclusion, search filtering, sorting, and score mapping
 * are all exercised through buildLeadQuery + listLeads with an injected fake DB.
 * Integration tests that hit a real Postgres can layer on later.
 */

import { describe, it, expect } from "vitest";
import type { MemberRole } from "@prisma/client";

import type { TenantContext } from "../tenant/scope";
import { buildLeadQuery } from "../jobs/query";
import { leadListSchema, type LeadListInput } from "../validation/search";
import {
  buildLeadListArgs,
  mapLead,
  applySearchScope,
  leadsQuerySchema,
  type LeadRowWithRelations,
} from "./list";

/** Minimal TenantContext fake — mirrors scope.ts's own factory (as never). */
function fakeCtx(organizationId: string): TenantContext {
  return {
    userId: `user_${organizationId}`,
    organizationId,
    role: "OWNER" as MemberRole,
    where: (w) => ({ ...(w ?? {}), organizationId, deletedAt: null }) as never,
    whereHard: (w) => ({ ...(w ?? {}), organizationId }) as never,
  };
}

function parse(qs: Record<string, string>): LeadListInput {
  return leadListSchema.parse(qs);
}

function sampleRow(overrides: Partial<LeadRowWithRelations> = {}): LeadRowWithRelations {
  return {
    id: "lead_1",
    businessName: "Acme Dentistry",
    category: "dentists",
    website: "https://acme.example.com",
    websiteDomain: "acme.example.com",
    email: null,
    emailStatus: "UNKNOWN",
    phone: "+15550100",
    industry: null,
    companySize: null,
    address: "123 Example St",
    city: "Nairobi",
    region: null,
    country: "KE",
    googleProfileUrl: "https://maps.google.com/?cid=1",
    status: "NEW",
    leadScore: 40,
    score: { score: 40, quality: "Fair", model: "rules-v1", scoredAt: new Date("2026-08-01T00:00:00.000Z") },
    socials: [{ platform: "LINKEDIN", url: "https://linkedin.com/company/acme" }],
    contacts: [],
    ...overrides,
  };
}

describe("buildLeadQuery — tenant scoping & soft delete", () => {
  it("always injects organizationId and deletedAt: null", () => {
    const q = buildLeadQuery(fakeCtx("org_A"), parse({}));
    expect(q.where.organizationId).toBe("org_A");
    expect(q.where.deletedAt).toBeNull();
  });

  it("scopes to the caller's org — never another org", () => {
    const a = buildLeadQuery(fakeCtx("org_A"), parse({}));
    const b = buildLeadQuery(fakeCtx("org_B"), parse({}));
    expect(a.where.organizationId).toBe("org_A");
    expect(b.where.organizationId).toBe("org_B");
    expect(a.where.organizationId).not.toBe(b.where.organizationId);
  });
});

describe("buildLeadQuery — filters, sort, pagination", () => {
  it("maps minScore to a leadScore gte filter", () => {
    const q = buildLeadQuery(fakeCtx("o"), parse({ minScore: "40" }));
    expect(q.where.leadScore).toEqual({ gte: 40 });
  });

  it("maps q to a case-insensitive OR over businessName + email", () => {
    const q = buildLeadQuery(fakeCtx("o"), parse({ q: "acme" }));
    expect(q.where.OR).toEqual([
      { businessName: { contains: "acme", mode: "insensitive" } },
      { email: { contains: "acme", mode: "insensitive" } },
    ]);
  });

  it("sorts by score (leadScore) descending", () => {
    const q = buildLeadQuery(fakeCtx("o"), parse({ sort: "leadScore", order: "desc" }));
    expect(q.orderBy).toEqual({ leadScore: "desc" });
  });

  it("sorts by business name ascending", () => {
    const q = buildLeadQuery(fakeCtx("o"), parse({ sort: "businessName", order: "asc" }));
    expect(q.orderBy).toEqual({ businessName: "asc" });
  });

  it("paginates with skip/take", () => {
    const q = buildLeadQuery(fakeCtx("o"), parse({ page: "3", pageSize: "10" }));
    expect(q.skip).toBe(20);
    expect(q.take).toBe(10);
  });
});

describe("applySearchScope", () => {
  it("adds searchId while preserving the tenant filter", () => {
    const scoped = applySearchScope({ organizationId: "o", deletedAt: null }, "search_1");
    expect(scoped).toEqual({ organizationId: "o", deletedAt: null, searchId: "search_1" });
  });

  it("is a no-op without a searchId", () => {
    const w = { organizationId: "o", deletedAt: null };
    expect(applySearchScope(w)).toBe(w);
  });
});

describe("mapLead — scoring data", () => {
  it("surfaces score + quality from the score relation", () => {
    const dto = mapLead(sampleRow());
    expect(dto.score).toEqual({
      score: 40,
      quality: "Fair",
      model: "rules-v1",
      scoredAt: "2026-08-01T00:00:00.000Z",
    });
    expect(dto.leadScore).toBe(40);
  });

  it("maps address and googleProfileUrl", () => {
    const dto = mapLead(sampleRow());
    expect(dto.address).toBe("123 Example St");
    expect(dto.googleProfileUrl).toBe("https://maps.google.com/?cid=1");
  });

  it("returns null score for an unscored lead", () => {
    const dto = mapLead(sampleRow({ score: null, leadScore: null }));
    expect(dto.score).toBeNull();
  });
});

describe("buildLeadListArgs — tenant scope + search filter", () => {
  it("scopes to org, excludes soft-deleted, applies searchId + sort", () => {
    const a = buildLeadListArgs(fakeCtx("org_A"), parse({ sort: "leadScore" }), "search_1");
    expect(a.where.organizationId).toBe("org_A"); // tenant scoped
    expect(a.where.deletedAt).toBeNull(); // soft-deleted excluded
    expect(a.where.searchId).toBe("search_1"); // search filtering
    expect(a.orderBy).toEqual({ leadScore: "desc" }); // sort by score
  });

  it("omits searchId when absent and never leaks another org's id", () => {
    const b = buildLeadListArgs(fakeCtx("org_B"), parse({}));
    expect(b.where.organizationId).toBe("org_B");
    expect(b.where.searchId).toBeUndefined();
  });
});

describe("leadsQuerySchema", () => {
  it("coerces querystring values, applies defaults, accepts searchId", () => {
    const p = leadsQuerySchema.parse({ page: "2", searchId: "s1" });
    expect(p.page).toBe(2);
    expect(p.sort).toBe("createdAt");
    expect(p.order).toBe("desc");
    expect(p.searchId).toBe("s1");
  });

  it("rejects an invalid sort field", () => {
    expect(leadsQuerySchema.safeParse({ sort: "nope" }).success).toBe(false);
  });
});