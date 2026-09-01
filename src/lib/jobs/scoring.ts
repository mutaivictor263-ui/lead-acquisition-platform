/**
 * Scoring pipeline (§21) — one job per lead, run independently. The terminal
 * stage: discovery → enrichment → scoring.
 *
 * Mirrors processDiscovery / processEnrichment: dependencies (db) are injected so
 * the core is unit-testable without Postgres/Redis, and the pure scoring function
 * (computeLeadScore) can be tested with no I/O at all.
 *
 * Scoring is deterministic and transparent — simple, explainable rules over data
 * that is ACTUALLY present on the lead. Nothing is fabricated: a factor only
 * contributes (and only appears in reasonsJson) when the underlying data exists.
 * No LLM/AI call in this version.
 */

import type { EmailStatus } from "@prisma/client";

// ── Scoring model ─────────────────────────────────────────────────────────────

export const SCORING_MODEL = "rules-v1";

/** Point weights per factor. Total = 100. */
export const SCORING_WEIGHTS = {
  website: 15,
  email: 20,
  email_valid: 15,
  phone: 15,
  industry: 10,
  company_size: 10,
  location: 5,
  socials: 5,
  contacts: 5,
} as const;

export type ScoreFactor = keyof typeof SCORING_WEIGHTS;

export interface ScoreReason {
  factor: ScoreFactor;
  points: number;
  reason: string;
}

export interface ScoreResult {
  score: number; // 0–100
  quality: string; // Poor | Fair | Good | Excellent
  reasons: ScoreReason[];
}

/** The lead fields the algorithm reads. */
export interface ScoringLeadRow {
  id: string;
  organizationId: string;
  businessName: string;
  website: string | null;
  websiteDomain: string | null;
  email: string | null;
  emailStatus: EmailStatus;
  phone: string | null;
  companySize: string | null;
  industry: string | null;
  address: string | null;
  city: string | null;
}

export interface ScoringRelated {
  hasContacts: boolean;
  hasSocials: boolean;
}

function present(value: string | null | undefined): boolean {
  return value != null && value.trim() !== "";
}

function qualityFor(score: number): string {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Fair";
  return "Poor";
}

/**
 * Pure, deterministic scoring. Only present data contributes; each contributing
 * factor is recorded with its points and a human reason. No side effects.
 */
export function computeLeadScore(lead: ScoringLeadRow, related: ScoringRelated): ScoreResult {
  const hasEmail = present(lead.email);

  const checks: { factor: ScoreFactor; present: boolean; reason: string }[] = [
    { factor: "website", present: present(lead.website) || present(lead.websiteDomain), reason: "Website present" },
    { factor: "email", present: hasEmail, reason: "Email present" },
    { factor: "email_valid", present: hasEmail && lead.emailStatus === "VALID", reason: "Email verified as valid" },
    { factor: "phone", present: present(lead.phone), reason: "Phone present" },
    { factor: "industry", present: present(lead.industry), reason: "Industry known" },
    { factor: "company_size", present: present(lead.companySize), reason: "Company size known" },
    { factor: "location", present: present(lead.address) || present(lead.city), reason: "Location details present" },
    { factor: "socials", present: related.hasSocials, reason: "Social profile(s) present" },
    { factor: "contacts", present: related.hasContacts, reason: "Contact(s) present" },
  ];

  const reasons: ScoreReason[] = checks
    .filter((c) => c.present)
    .map((c) => ({ factor: c.factor, points: SCORING_WEIGHTS[c.factor], reason: c.reason }));

  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  const score = Math.max(0, Math.min(100, raw));

  return { score, quality: qualityFor(score), reasons };
}

// ── Narrow DB surface this pipeline needs (PrismaClient satisfies it) ─────────

export interface ScoringDb {
  lead: {
    findFirst(args: {
      where: { id: string; organizationId: string; deletedAt: null };
    }): Promise<ScoringLeadRow | null>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
    updateMany(args: {
      where: { id: string; organizationId: string };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  leadContact: {
    findMany(args: { where: { leadId: string }; select: { id: true } }): Promise<{ id: string }[]>;
  };
  leadSocial: {
    findMany(args: { where: { leadId: string }; select: { id: true } }): Promise<{ id: string }[]>;
  };
  leadScore: {
    findFirst(args: { where: { leadId: string } }): Promise<{ id: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    update(args: { where: { leadId: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  leadActivity: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

export interface ScoringDeps {
  db: ScoringDb;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface ScoringOutcome {
  leadId: string;
  scored: boolean;
  reason?: string; // e.g. "lead_not_found"
  score?: number;
  quality?: string;
  reasons?: ScoreReason[];
}

export async function processScoring(
  deps: ScoringDeps,
  args: { organizationId: string; searchId: string; leadId: string },
): Promise<ScoringOutcome> {
  const { db, log } = deps;
  const { organizationId, searchId, leadId } = args;

  // Tenant-safe read: id AND organizationId, and must be live. Never score a
  // lead from another org.
  const lead = await db.lead.findFirst({
    where: { id: leadId, organizationId, deletedAt: null },
  });
  if (!lead) {
    // Missing/soft-deleted lead is not retryable — log and stop cleanly, no score.
    log?.("scoring.lead_not_found", { leadId, organizationId });
    return { leadId, scored: false, reason: "lead_not_found" };
  }

  // Existence of related rows feeds two factors (no fabrication — we only read).
  const [contacts, socials] = await Promise.all([
    db.leadContact.findMany({ where: { leadId }, select: { id: true } }),
    db.leadSocial.findMany({ where: { leadId }, select: { id: true } }),
  ]);

  const { score, quality, reasons } = computeLeadScore(lead, {
    hasContacts: contacts.length > 0,
    hasSocials: socials.length > 0,
  });

  // ── Persist LeadScore idempotently (leadId is @unique) ─────────────────────
  // findFirst → update|create avoids upsert's strict input typing. Scoring jobs
  // are one-per-lead (jobId score-<leadId>), so this can't race itself.
  const scoreData = {
    score,
    quality,
    reasonsJson: reasons,
    model: SCORING_MODEL,
  };
  const existing = await db.leadScore.findFirst({ where: { leadId } });
  if (existing) {
    await db.leadScore.update({ where: { leadId }, data: scoreData });
  } else {
    await db.leadScore.create({ data: { leadId, ...scoreData } });
  }

  // ── Denormalized copy on the lead (schema documents this mirror) ───────────
  // Tenant-safe: reached only after the scoped read above confirmed ownership.
  // Denormalized score mirror + mark the lead COMPLETED in one tenant-scoped
  // write, so a successful scoring atomically completes the lead.
  await db.lead.updateMany({
    where: { id: leadId, organizationId },
    data: { leadScore: score, processingStatus: "COMPLETED" },
  });

  // ── Audit trail ───────────────────────────────────────────────────────────
  await db.leadActivity.create({
    data: {
      leadId,
      type: "scored",
      metaJson: { score, quality, model: SCORING_MODEL, searchId, reasonCount: reasons.length },
    },
  });

  log?.("scoring.done", { leadId, score, quality });

  return { leadId, scored: true, score, quality, reasons };
}