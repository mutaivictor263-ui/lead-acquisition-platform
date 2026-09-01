/**
 * Enrichment pipeline (§19, §21) — one job per lead, run independently.
 *
 * Mirrors processDiscovery's shape on purpose: dependencies (db, provider,
 * scoring fan-out) are injected so this is unit-testable without Postgres/Redis,
 * and the real Prisma client + BullMQ queue slot in unchanged at the worker.
 *
 * Guarantees that matter here:
 *  - Fabricates NOTHING. A provider returns only what it truly found; anything
 *    absent stays absent.
 *  - Gap-fill only: a field is written solely when the provider found a value
 *    AND the lead's current value is empty. Existing non-null data is never
 *    overwritten and is never nulled out.
 *  - Tenant-safe: the lead is read by (id + organizationId + not deleted), and
 *    the update's WHERE also carries organizationId.
 *  - Records a LeadActivity, then fans out to the existing scoring queue.
 *
 * No real enrichment provider is configured yet, so `mockEnrichmentProvider`
 * returns no data — it exists to run the pipeline end to end and hand off to
 * scoring. The fact that mock enrichment ran is logged and recorded.
 */

import type { SocialPlatform } from "@prisma/client";

// ── Provider abstraction (mirrors lead_providers.ts) ─────────────────────────

export interface EnrichmentLeadInput {
  id: string;
  organizationId: string;
  businessName: string;
  website: string | null;
  websiteDomain: string | null;
  email: string | null;
  phone: string | null;
  industry: string | null;
  companySize: string | null;
}

export interface EnrichmentContact {
  name?: string | null;
  jobTitle?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface EnrichmentSocial {
  platform: SocialPlatform;
  url: string;
}

/** What a provider actually FOUND. Everything optional; omitted = "not found". */
export interface EnrichmentData {
  website?: string | null;
  websiteDomain?: string | null;
  email?: string | null;
  emailSource?: string | null;
  phone?: string | null;
  phoneNormalized?: string | null;
  industry?: string | null;
  companySize?: string | null;
  contacts?: EnrichmentContact[];
  socials?: EnrichmentSocial[];
}

export interface EnrichmentProvider {
  readonly key: string;
  enrich(lead: EnrichmentLeadInput): Promise<EnrichmentData>;
}

/**
 * Mock enrichment provider. Returns NOTHING — no emails, phones, websites,
 * socials, or contacts are invented. It lets the pipeline run end to end and
 * hand off to scoring while a real provider is not yet configured. That mock
 * enrichment ran is recorded as a LeadActivity by processEnrichment.
 */
export const mockEnrichmentProvider: EnrichmentProvider = {
  key: "mock",
  async enrich() {
    return {};
  },
};

// ── Narrow DB surface this pipeline needs (PrismaClient satisfies it) ─────────

export interface EnrichmentLeadRow {
  id: string;
  organizationId: string;
  businessName: string;
  website: string | null;
  websiteDomain: string | null;
  email: string | null;
  emailSource: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  industry: string | null;
  companySize: string | null;
}

export interface EnrichmentDb {
  lead: {
    findFirst(args: {
      where: { id: string; organizationId: string; deletedAt: null };
    }): Promise<EnrichmentLeadRow | null>;
    updateMany(args: {
      where: { id: string; organizationId: string; processingStatus?: { in: string[] } };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  leadContact: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  leadSocial: {
    findMany(args: {
      where: { leadId: string };
      select: { platform: true };
    }): Promise<{ platform: SocialPlatform }[]>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  leadActivity: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface EnrichmentDeps {
  db: EnrichmentDb;
  provider: EnrichmentProvider;
  /** Fan-out: enqueue scoring for a successfully enriched lead. */
  enqueueScoring(args: { organizationId: string; searchId: string; leadId: string }): Promise<void>;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface EnrichmentOutcome {
  leadId: string;
  applied: boolean; // enrichment ran against a real, in-tenant lead
  reason?: string; // e.g. "lead_not_found"
  fieldsFilled: string[]; // scalar gaps we filled
  contactsAdded: number;
  socialsAdded: number;
  scoringEnqueued: boolean;
}

/** Return `incoming` only if the current value is empty AND incoming has data. */
function gapFill(current: string | null, incoming?: string | null): string | undefined {
  if (current != null && current !== "") return undefined; // never overwrite existing
  if (incoming == null || incoming === "") return undefined; // nothing real to write
  return incoming;
}

export async function processEnrichment(
  deps: EnrichmentDeps,
  args: { organizationId: string; searchId: string; leadId: string },
): Promise<EnrichmentOutcome> {
  const { db, provider, enqueueScoring, log } = deps;
  const { organizationId, searchId, leadId } = args;

  // Tenant-safe read: id AND organizationId, and must be live.
  const lead = await db.lead.findFirst({
    where: { id: leadId, organizationId, deletedAt: null },
  });
  if (!lead) {
    // A missing/soft-deleted lead isn't a retryable failure — log and stop
    // cleanly without enqueuing scoring.
    log?.("enrichment.lead_not_found", { leadId, organizationId });
    return {
      leadId,
      applied: false,
      reason: "lead_not_found",
      fieldsFilled: [],
      contactsAdded: 0,
      socialsAdded: 0,
      scoringEnqueued: false,
    };
  }

  // Mark the lead as processing the moment enrichment picks it up. Only PENDING
  // or FAILED advance to PROCESSING — a COMPLETED lead is never downgraded (the
  // filtered WHERE matches zero rows for it).
  await db.lead.updateMany({
    where: { id: leadId, organizationId, processingStatus: { in: ["PENDING", "FAILED"] } },
    data: { processingStatus: "PROCESSING" },
  });

  const data = await provider.enrich({
    id: lead.id,
    organizationId: lead.organizationId,
    businessName: lead.businessName,
    website: lead.website,
    websiteDomain: lead.websiteDomain,
    email: lead.email,
    phone: lead.phone,
    industry: lead.industry,
    companySize: lead.companySize,
  });

  if (provider.key === "mock") {
    log?.("enrichment.mock_performed", { leadId, provider: provider.key });
  }

  // ── Scalar gap-fills (never overwrite, never null out §8/§9) ───────────────
  const update: Record<string, unknown> = {};
  const fieldsFilled: string[] = [];
  const scalarPlan: [keyof EnrichmentLeadRow, string | null | undefined][] = [
    ["website", data.website],
    ["websiteDomain", data.websiteDomain],
    ["email", data.email],
    ["emailSource", data.emailSource],
    ["phone", data.phone],
    ["phoneNormalized", data.phoneNormalized],
    ["industry", data.industry],
    ["companySize", data.companySize],
  ];
  for (const [field, incoming] of scalarPlan) {
    const value = gapFill(lead[field] as string | null, incoming);
    if (value !== undefined) {
      update[field] = value;
      fieldsFilled.push(field);
    }
  }
  if (fieldsFilled.length > 0) {
    // Tenant-safe write: WHERE carries organizationId.
    await db.lead.updateMany({ where: { id: leadId, organizationId }, data: update });
  }

  // ── Socials: respect @@unique([leadId, platform]); add only new platforms ──
  let socialsAdded = 0;
  const incomingSocials = (data.socials ?? []).filter((s) => s?.url);
  if (incomingSocials.length > 0) {
    const existingSocials = await db.leadSocial.findMany({
      where: { leadId },
      select: { platform: true },
    });
    const havePlatforms = new Set<SocialPlatform>(existingSocials.map((e) => e.platform));
    for (const s of incomingSocials) {
      if (havePlatforms.has(s.platform)) continue; // don't clobber an existing platform
      await db.leadSocial.create({ data: { leadId, platform: s.platform, url: s.url } });
      havePlatforms.add(s.platform);
      socialsAdded++;
    }
  }

  // ── Contacts: only rows that actually carry data ──────────────────────────
  let contactsAdded = 0;
  for (const c of data.contacts ?? []) {
    if (!c || (!c.name && !c.jobTitle && !c.email && !c.phone)) continue;
    await db.leadContact.create({
      data: {
        leadId,
        name: c.name ?? null,
        jobTitle: c.jobTitle ?? null,
        email: c.email ?? null,
        phone: c.phone ?? null,
      },
    });
    contactsAdded++;
  }

  // ── Audit trail ───────────────────────────────────────────────────────────
  await db.leadActivity.create({
    data: {
      leadId,
      type: "enriched",
      metaJson: {
        provider: provider.key,
        mock: provider.key === "mock",
        fieldsFilled,
        contactsAdded,
        socialsAdded,
        searchId,
      },
    },
  });

  // ── Fan out to the existing scoring queue (algorithm not implemented §14) ──
  await enqueueScoring({ organizationId, searchId, leadId });

  log?.("enrichment.done", { leadId, fieldsFilled: fieldsFilled.length, contactsAdded, socialsAdded });

  return { leadId, applied: true, fieldsFilled, contactsAdded, socialsAdded, scoringEnqueued: true };
}