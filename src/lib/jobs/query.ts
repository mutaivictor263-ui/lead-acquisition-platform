/**
 * Lead-table query builder (§28).
 *
 * Turns validated filter/sort/page input into a Prisma query fragment. Pure and
 * synchronous so it's trivially testable: give it a tenant context + filters,
 * assert the where/orderBy/skip/take it produces. The tenant filter is applied
 * via ctx.where() so organizationId + deletedAt can't be omitted.
 */

import type { LeadListInput } from "../validation/search";
import type { TenantContext } from "../tenant/scope";

export interface LeadQuery {
  where: Record<string, unknown>;
  orderBy: Record<string, "asc" | "desc">;
  skip: number;
  take: number;
}

export function buildLeadQuery(ctx: TenantContext, input: LeadListInput): LeadQuery {
  const filters: Record<string, unknown> = {};

  if (input.status) filters.status = input.status;
  if (input.category) filters.category = { equals: input.category, mode: "insensitive" };
  if (input.country) filters.country = { equals: input.country, mode: "insensitive" };

  // "has X" filters map to not-null (and non-empty) checks.
  if (input.hasEmail) filters.email = { not: null };
  if (input.hasWebsite) filters.website = { not: null };
  if (input.hasPhone) filters.phone = { not: null };

  if (typeof input.minScore === "number") filters.leadScore = { gte: input.minScore };

  // Free-text search across business name + email (case-insensitive).
  if (input.q) {
    filters.OR = [
      { businessName: { contains: input.q, mode: "insensitive" } },
      { email: { contains: input.q, mode: "insensitive" } },
    ];
  }

  return {
    where: ctx.where(filters),
    orderBy: { [input.sort]: input.order },
    skip: (input.page - 1) * input.pageSize,
    take: input.pageSize,
  };
}