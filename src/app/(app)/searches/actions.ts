"use server";

/**
 * Search creation entry point (§16, §21).
 *
 * The keystone that makes the (already built) discovery pipeline reachable:
 * validate input -> enforce the plan's active-search limit -> create the Search
 * row (tenant-scoped) -> enqueue the discovery job. Credits are NOT reserved
 * here — the discovery worker reserves one atomically per genuinely-new lead
 * (see src/lib/jobs/discovery.ts), so nothing is spent until real work runs.
 *
 * Redis coupling is deferred with a dynamic import of the queue, so merely
 * rendering the form doesn't open a Redis connection — only an actual submit
 * does. The Search row is committed before enqueue; if enqueue fails (e.g. Redis
 * down), the row survives as PENDING and can be retried, and the user is told.
 */

import { redirect } from "next/navigation";
import { Prisma, SearchStatus } from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { requireCurrentTenant } from "@/lib/auth/current-user";
import { createSearchSchema } from "@/lib/validation/search";
import { getPlan, unlimitedSearches } from "@/lib/plans/plans";

export interface CreateSearchState {
  error?: string;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function defaultName(category: string, parts: (string | undefined)[]): string {
  const loc = parts.filter(Boolean).join(", ");
  return loc ? `${titleCase(category)} in ${loc}` : titleCase(category);
}

/** Read a trimmed string field, returning undefined for blanks. */
function str(form: FormData, key: string): string | undefined {
  const v = form.get(key);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

export async function createSearchAction(
  _prev: CreateSearchState,
  formData: FormData,
): Promise<CreateSearchState> {
  const ctx = await requireCurrentTenant();

  // ── Build + validate input ──────────────────────────────────────────────
  const filterEntries: Record<string, boolean | number> = {};
  for (const key of ["hasWebsite", "hasEmail", "hasPhone", "hasLinkedin", "hasInstagram", "hasFacebook"]) {
    if (formData.get(key) === "on") filterEntries[key] = true;
  }
  const minScoreRaw = str(formData, "minScore");
  if (minScoreRaw !== undefined) filterEntries.minScore = Number(minScoreRaw);
  const filters = Object.keys(filterEntries).length > 0 ? filterEntries : undefined;

  const parsed = createSearchSchema.safeParse({
    name: str(formData, "name"),
    category: str(formData, "category"),
    city: str(formData, "city"),
    region: str(formData, "region"),
    country: str(formData, "country"),
    postalCode: str(formData, "postalCode"),
    leadsRequested: Number(formData.get("leadsRequested")),
    filters,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const input = parsed.data;

  // ── Enforce the plan's active-search limit (§18) ────────────────────────
  const org = await prisma.organization.findUniqueOrThrow({
    where: { id: ctx.organizationId },
    select: { planKey: true },
  });

  if (!unlimitedSearches(org.planKey)) {
    const activeCount = await prisma.search.count({
      where: ctx.where({ status: { in: [SearchStatus.PENDING, SearchStatus.RUNNING] } }),
    });
    const limit = getPlan(org.planKey).maxActiveSearches;
    if (activeCount >= limit) {
      return {
        error:
          `Your ${getPlan(org.planKey).name} plan allows ${limit} active ` +
          `search${limit === 1 ? "" : "es"}. Wait for one to finish or upgrade.`,
      };
    }
  }

  // ── Create the tenant-scoped Search row ─────────────────────────────────
  const search = await prisma.search.create({
    data: {
      organizationId: ctx.organizationId,
      createdByUserId: ctx.userId,
      name: input.name ?? defaultName(input.category, [input.city, input.region, input.country]),
      category: input.category,
      city: input.city,
      region: input.region,
      country: input.country,
      postalCode: input.postalCode,
      leadsRequested: input.leadsRequested,
      filtersJson: input.filters ? (input.filters as Prisma.InputJsonValue) : undefined,
      status: SearchStatus.PENDING,
    },
    select: { id: true },
  });

  // ── Enqueue discovery (deferred Redis import; idempotent by searchId) ────
  let queued = true;
  try {
    const { enqueueDiscovery } = await import("@/lib/jobs/queue");
    await enqueueDiscovery(
      { organizationId: ctx.organizationId, searchId: search.id },
      { priority: getPlan(org.planKey).capabilities.priorityProcessing ? 1 : undefined },
    );
  } catch {
    queued = false;
  }

  // redirect() throws NEXT_REDIRECT — must stay outside the try/catch above.
  redirect(queued ? "/searches?created=1" : "/searches?created=1&queued=0");
}