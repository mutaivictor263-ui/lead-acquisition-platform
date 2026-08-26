/**
 * Background job pipeline (§21) — BullMQ + Redis.
 *
 * Shape (this is the important part):
 *
 *   discovery job (1 per search)
 *        │  finds businesses, dedups, creates Lead rows
 *        ▼
 *   enrichment job  ×N   (1 per lead — INDEPENDENT)
 *        │  website → email → phone → social → contact → verify
 *        ▼
 *   scoring job     ×N   (1 per lead, enqueued on enrichment success)
 *
 * Fanning out per-lead is deliberate: one slow website or a single failure must
 * not stall or fail the whole search (§7, §30). Each lead's failure is isolated,
 * retried with backoff, and the search is marked COMPLETED or PARTIAL based on
 * how many leads finished — never hard-failed because one business errored.
 *
 * Workers live in a separate process (see docs/DEPLOYMENT) so provider latency
 * never touches HTTP request handlers.
 */

import { Queue, type JobsOptions } from "bullmq";
import IORedis from "ioredis";

export const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null, // required by BullMQ
});

export const QUEUE = {
  discovery: "discovery",
  enrichment: "enrichment",
  scoring: "scoring",
} as const;

// Retry + exponential backoff + capped attempts (§21). Old jobs auto-clean so
// Redis doesn't grow unbounded.
export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 }, // 2s, 4s, 8s
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
};

// ── Job payloads ──────────────────────────────────────────────────────────────

export interface DiscoveryJobData {
  organizationId: string;
  searchId: string;
  providerKey?: string; // optional explicit provider; else registry default
}

export interface EnrichmentJobData {
  organizationId: string;
  searchId: string;
  leadId: string;
}

export interface ScoringJobData {
  organizationId: string;
  searchId: string;
  leadId: string;
}

// ── Queues ────────────────────────────────────────────────────────────────────

export const discoveryQueue = new Queue<DiscoveryJobData>(QUEUE.discovery, {
  connection,
  defaultJobOptions,
});
export const enrichmentQueue = new Queue<EnrichmentJobData>(QUEUE.enrichment, {
  connection,
  defaultJobOptions,
});
export const scoringQueue = new Queue<ScoringJobData>(QUEUE.scoring, {
  connection,
  defaultJobOptions,
});

/**
 * Entry point called by POST /api/searches after the search row is created and
 * credits are reserved. Priority lets Pro/Agency plans jump the queue (§18).
 * Idempotent by jobId so a double-submit can't launch the same search twice.
 */
export async function enqueueDiscovery(
  data: DiscoveryJobData,
  opts: { priority?: number } = {},
): Promise<void> {
  await discoveryQueue.add("discover", data, {
    jobId: `discovery-${data.searchId}`,
    priority: opts.priority,
  });
}

/** Fan-out helper the discovery worker calls once per created lead. */
export async function enqueueEnrichment(data: EnrichmentJobData): Promise<void> {
  await enrichmentQueue.add("enrich", data, { jobId: `enrich-${data.leadId}`, });
}

/** Enqueued by the enrichment worker on success. */
export async function enqueueScoring(data: ScoringJobData): Promise<void> {
  await scoringQueue.add("score", data, { jobId: `score-${data.leadId}`, });
}