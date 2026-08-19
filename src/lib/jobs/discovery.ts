/**
 * Discovery pipeline (§17, §21, §26) — the core of Phase 2.
 *
 * One discovery job per search: call the provider, normalize, dedup (within the
 * batch AND against existing org leads), reserve credits only for genuinely new
 * leads, create Lead rows, and fan out one enrichment job per new lead. The
 * search ends COMPLETED, or PARTIAL if credits ran out mid-batch — never
 * hard-failed because of duplicates or a capped balance.
 *
 * Dependencies are injected (db, provider, credit reservation, enqueue) so this
 * logic is unit-testable without Postgres/Redis, and so the real Prisma client
 * and BullMQ queue slot in unchanged at the call site.
 */

import type { LeadProvider, SearchParams } from "../providers/lead_providers";
import { normalizeBusiness } from "../providers/normalize";

// ── Narrow DB surface this pipeline needs (PrismaClient satisfies it) ─────────

export interface DiscoveryDb {
  lead: {
    findMany(args: {
      where: { organizationId: string; dedupeHash: { in: string[] } };
      select: { dedupeHash: true };
    }): Promise<{ dedupeHash: string }[]>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
  leadActivity: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  search: {
    findFirst(args: {
      where: { id: string; organizationId: string; deletedAt: null };
    }): Promise<SearchRow | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
}

interface SearchRow {
  id: string;
  organizationId: string;
  category: string;
  city: string | null;
  region: string | null;
  country: string | null;
  postalCode: string | null;
  leadsRequested: number;
}

export interface DiscoveryDeps {
  db: DiscoveryDb;
  provider: LeadProvider;
  /** Reserve one lead-credit atomically. Returns false if the balance is spent. */
  reserveLeadCredit(): Promise<boolean>;
  /** Fan-out: enqueue enrichment for a freshly created lead. */
  enqueueEnrichment(leadId: string): Promise<void>;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface DiscoveryResult {
  status: "COMPLETED" | "PARTIAL";
  requested: number;
  discovered: number; // returned by provider
  duplicates: number; // collapsed within batch or already in org
  created: number; // new leads persisted
  stoppedForCredits: boolean;
}

export async function processDiscovery(
  deps: DiscoveryDeps,
  args: { organizationId: string; searchId: string },
): Promise<DiscoveryResult> {
  const { db, provider, reserveLeadCredit, enqueueEnrichment, log } = deps;
  const { organizationId, searchId } = args;

  const search = await db.search.findFirst({
    where: { id: searchId, organizationId, deletedAt: null },
  });
  if (!search) throw new Error(`Search not found or not in tenant: ${searchId}`);

  const params: SearchParams = {
    category: search.category,
    city: search.city ?? undefined,
    region: search.region ?? undefined,
    country: search.country ?? undefined,
    postalCode: search.postalCode ?? undefined,
    limit: search.leadsRequested,
  };

  const raw = await provider.searchBusinesses(params);
  log?.("discovery.provider_returned", { searchId, count: raw.length, provider: provider.key });

  // Normalize + collapse duplicates WITHIN this batch (provider may repeat).
  const byHash = new Map<string, ReturnType<typeof normalizeBusiness> & { raw: (typeof raw)[number] }>();
  for (const business of raw) {
    const norm = normalizeBusiness(business);
    if (!byHash.has(norm.dedupeHash)) byHash.set(norm.dedupeHash, { ...norm, raw: business });
  }
  const batch = [...byHash.values()];
  const withinBatchDupes = raw.length - batch.length;

  // Cross-search dedup: which of these already exist for this org? (§26)
  const hashes = batch.map((b) => b.dedupeHash);
  const existing =
    hashes.length > 0
      ? await db.lead.findMany({
          where: { organizationId, dedupeHash: { in: hashes } },
          select: { dedupeHash: true },
        })
      : [];
  const existingSet = new Set(existing.map((e) => e.dedupeHash));
  const fresh = batch.filter((b) => !existingSet.has(b.dedupeHash));

  let created = 0;
  let stoppedForCredits = false;

  for (const b of fresh) {
    // Reserve credit BEFORE creating the lead so limits can't be raced (§20).
    const reserved = await reserveLeadCredit();
    if (!reserved) {
      stoppedForCredits = true;
      log?.("discovery.credits_exhausted", { searchId, createdSoFar: created });
      break;
    }

    const lead = await db.lead.create({
      data: {
        organizationId,
        searchId,
        businessName: b.businessName,
        category: b.category,
        website: b.website,
        websiteDomain: b.websiteDomain,
        phone: b.phone,
        phoneNormalized: b.phoneNormalized,
        address: b.address,
        city: b.city,
        region: b.region,
        country: b.country,
        postalCode: b.postalCode,
        googleProfileUrl: b.googleProfileUrl,
        source: provider.key,
        sourceId: b.sourceId,
        dedupeHash: b.dedupeHash,
        status: "NEW",
        socials: b.socials.length
          ? { create: b.socials.map((s) => ({ platform: s.platform, url: s.url })) }
          : undefined,
      },
    });

    await db.leadActivity.create({
      data: { leadId: lead.id, type: "discovered", metaJson: { searchId, source: provider.key } },
    });

    // Fan out: each lead enriches independently (§19, §30).
    await enqueueEnrichment(lead.id);
    created++;
  }

  const status: DiscoveryResult["status"] = stoppedForCredits ? "PARTIAL" : "COMPLETED";
  await db.search.update({
    where: { id: searchId },
    data: { status, leadsFound: created },
  });

  const duplicates = withinBatchDupes + existingSet.size;
  log?.("discovery.done", { searchId, created, duplicates, status });

  return {
    status,
    requested: search.leadsRequested,
    discovered: raw.length,
    duplicates,
    created,
    stoppedForCredits,
  };
}