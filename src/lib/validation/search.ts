/**
 * Input validation (§16, §28, §35). One Zod schema per input shape; every API
 * route and server action parses through these before touching the DB. Inferred
 * types are the single source of truth for handlers and the query builder.
 */

import { z } from "zod";

// Allowed lead-count tiers (§16). Kept as a set so the UI and API agree.
export const LEAD_COUNT_OPTIONS = [25, 50, 100, 500, 1000] as const;

export const LEAD_STATUSES = [
  "NEW",
  "CONTACTED",
  "INTERESTED",
  "QUALIFIED",
  "MEETING_BOOKED",
  "CUSTOMER",
  "NOT_INTERESTED",
  "LOST",
] as const;

export const createSearchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1, "Category is required").max(120),
  city: z.string().trim().max(120).optional(),
  region: z.string().trim().max(120).optional(),
  country: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().max(20).optional(),
  leadsRequested: z
    .number()
    .int()
    .refine((n) => (LEAD_COUNT_OPTIONS as readonly number[]).includes(n), {
      message: `Leads must be one of: ${LEAD_COUNT_OPTIONS.join(", ")}`,
    }),
  filters: z
    .object({
      hasWebsite: z.boolean().optional(),
      hasEmail: z.boolean().optional(),
      hasPhone: z.boolean().optional(),
      hasLinkedin: z.boolean().optional(),
      hasInstagram: z.boolean().optional(),
      hasFacebook: z.boolean().optional(),
      minScore: z.number().int().min(0).max(100).optional(),
    })
    .strict()
    .optional(),
});
export type CreateSearchInput = z.infer<typeof createSearchSchema>;

// Lead table querying (§28). Coerce so it parses raw querystring values.
export const leadListSchema = z.object({
  q: z.string().trim().max(200).optional(), // free-text over business name/email
  status: z.enum(LEAD_STATUSES).optional(),
  category: z.string().trim().max(120).optional(),
  country: z.string().trim().max(120).optional(),
  hasEmail: z.coerce.boolean().optional(),
  hasWebsite: z.coerce.boolean().optional(),
  hasPhone: z.coerce.boolean().optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  sort: z.enum(["createdAt", "leadScore", "businessName"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type LeadListInput = z.infer<typeof leadListSchema>;