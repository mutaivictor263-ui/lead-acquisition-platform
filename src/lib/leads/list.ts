/**
 * Leads data-access (§28). The single tenant-safe path for reading a user's
 * leads, shared by the API route and (later) the leads page.
 *
 * Tenant safety is inherited from buildLeadQuery, which applies ctx.where() — so
 * organizationId + deletedAt: null are always in the WHERE and can't be omitted.
 * searchId is an additional, optional filter layered on top.
 *
 * buildLeadListArgs and mapLead are pure (unit-tested without a DB). listLeads is
 * the thin Prisma-bound orchestrator. The two `as Prisma.*` assertions bridge the
 * dynamically-built where/orderBy (buildLeadQuery returns loose Record shapes by
 * design) to Prisma's input types — they assert nothing about the row data, which
 * Prisma infers from the inline select and mapLead consumes fully typed.
 */

import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";

import { buildLeadQuery } from "../jobs/query";
import { leadListSchema, type LeadListInput } from "../validation/search";
import type { TenantContext } from "../tenant/scope";

// Query schema = the existing lead-list schema + an optional searchId filter.
// Defined here (not by editing search.ts) so existing validation stays intact.
export const leadsQuerySchema = leadListSchema.extend({
  searchId: z.string().trim().min(1).max(64).optional(),
});
export type LeadsQueryInput = z.infer<typeof leadsQuerySchema>;

// ── Output DTOs (what the API returns / the UI renders) ──────────────────────

export interface LeadScoreDTO {
  score: number;
  quality: string;
  model: string | null;
  scoredAt: string;
}
export interface LeadSocialDTO {
  platform: string;
  url: string;
}
export interface LeadContactDTO {
  name: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
}
export interface LeadDTO {
  id: string;
  businessName: string;
  category: string | null;
  website: string | null;
  websiteDomain: string | null;
  email: string | null;
  emailStatus: string;
  phone: string | null;
  industry: string | null;
  companySize: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  status: string;
  leadScore: number | null;
  score: LeadScoreDTO | null;
  socials: LeadSocialDTO[];
  contacts: LeadContactDTO[];
}
export interface LeadListResult {
  leads: LeadDTO[];
  total: number;
  page: number;
  pageSize: number;
}

/** The row shape mapLead consumes. Prisma's inferred row (enums widened to
 *  string) is assignable to this, so mapLead needs no cast. */
export interface LeadRowWithRelations {
  id: string;
  businessName: string;
  category: string | null;
  website: string | null;
  websiteDomain: string | null;
  email: string | null;
  emailStatus: string;
  phone: string | null;
  industry: string | null;
  companySize: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  status: string;
  leadScore: number | null;
  score: { score: number; quality: string; model: string | null; scoredAt: Date } | null;
  socials: { platform: string; url: string }[];
  contacts: { name: string | null; jobTitle: string | null; email: string | null; phone: string | null }[];
}

export interface LeadListArgs {
  where: Record<string, unknown>;
  orderBy: Record<string, "asc" | "desc">;
  skip: number;
  take: number;
}

/** Layer an optional searchId onto an already tenant-scoped where. Pure. */
export function applySearchScope(
  where: Record<string, unknown>,
  searchId?: string,
): Record<string, unknown> {
  return searchId ? { ...where, searchId } : where;
}

/** Assemble the tenant-scoped query fragment (where/orderBy/skip/take). Pure. */
export function buildLeadListArgs(
  ctx: TenantContext,
  input: LeadListInput,
  searchId?: string,
): LeadListArgs {
  const q = buildLeadQuery(ctx, input);
  return {
    where: applySearchScope(q.where, searchId),
    orderBy: q.orderBy,
    skip: q.skip,
    take: q.take,
  };
}

/** Map a DB row to the API/UI DTO. Pure. */
export function mapLead(row: LeadRowWithRelations): LeadDTO {
  return {
    id: row.id,
    businessName: row.businessName,
    category: row.category,
    website: row.website,
    websiteDomain: row.websiteDomain,
    email: row.email,
    emailStatus: row.emailStatus,
    phone: row.phone,
    industry: row.industry,
    companySize: row.companySize,
    city: row.city,
    region: row.region,
    country: row.country,
    status: row.status,
    leadScore: row.leadScore,
    score: row.score
      ? {
          score: row.score.score,
          quality: row.score.quality,
          model: row.score.model,
          scoredAt: row.score.scoredAt.toISOString(),
        }
      : null,
    socials: row.socials.map((s) => ({ platform: s.platform, url: s.url })),
    contacts: row.contacts.map((c) => ({
      name: c.name,
      jobTitle: c.jobTitle,
      email: c.email,
      phone: c.phone,
    })),
  };
}

/**
 * List a tenant's leads. Tenant-scoped + soft-delete-excluded via buildLeadQuery;
 * optionally filtered to one search. Returns mapped rows plus the total.
 */
export async function listLeads(
  prisma: PrismaClient,
  ctx: TenantContext,
  input: LeadListInput,
  searchId?: string,
): Promise<LeadListResult> {
  const { where, orderBy, skip, take } = buildLeadListArgs(ctx, input, searchId);
  const prismaWhere = where as Prisma.LeadWhereInput;

  const [rows, total] = await Promise.all([
    prisma.lead.findMany({
      where: prismaWhere,
      orderBy: orderBy as Prisma.LeadOrderByWithRelationInput,
      skip,
      take,
      select: {
        id: true,
        businessName: true,
        category: true,
        website: true,
        websiteDomain: true,
        email: true,
        emailStatus: true,
        phone: true,
        industry: true,
        companySize: true,
        city: true,
        region: true,
        country: true,
        status: true,
        leadScore: true,
        score: { select: { score: true, quality: true, model: true, scoredAt: true } },
        socials: { select: { platform: true, url: true } },
        contacts: { select: { name: true, jobTitle: true, email: true, phone: true } },
      },
    }),
    prisma.lead.count({ where: prismaWhere }),
  ]);

  return { leads: rows.map(mapLead), total, page: input.page, pageSize: input.pageSize };
}