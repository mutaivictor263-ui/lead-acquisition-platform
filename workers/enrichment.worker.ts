/**
 * Enrichment worker process (§19). Runs OUTSIDE the Next.js app on a long-running
 * host. Consumes the `enrichment` queue and drives the tested processEnrichment
 * pipeline, injecting the real Prisma client, the (mock) enrichment provider, and
 * the scoring fan-out.
 *
 * Start with:  npm run worker:enrichment
 *
 * Needs a generated Prisma client (`prisma generate`) and a reachable Redis, so
 * it runs in your repo, not the build sandbox.
 */

import "dotenv/config";

import { Worker } from "bullmq";

import { connection, QUEUE, enqueueScoring, type EnrichmentJobData } from "../src/lib/jobs/queue";
import { processEnrichment, mockEnrichmentProvider } from "../src/lib/jobs/enrichment";
import { shouldMarkFailed, markLeadFailed } from "../src/lib/jobs/failure";
import { websiteEnrichmentProvider } from "../src/lib/providers/website_enrichment";
import { prisma } from "../src/lib/db/client";

// Real homepage enrichment runs only when ENABLE_WEBSITE_ENRICHMENT=true;
// otherwise the mock provider (which fills nothing) stays in place.
const enrichmentProvider = websiteEnrichmentProvider.isConfigured()
  ? websiteEnrichmentProvider
  : mockEnrichmentProvider;

const worker = new Worker<EnrichmentJobData>(
  QUEUE.enrichment,
  async (job) => {
    const { organizationId, searchId, leadId } = job.data;

    return processEnrichment(
      {
        db: prisma,
        provider: enrichmentProvider,
        enqueueScoring: (data) => enqueueScoring(data),
        log: (event, data) => console.log(JSON.stringify({ event, ...data })),
      },
      { organizationId, searchId, leadId },
    );
  },
  // Same shape as the discovery worker; retry/backoff come from the queue's
  // defaultJobOptions set when each job was enqueued.
  { connection, concurrency: 4 },
);

// One lead failing must NOT fail the search (§7, §30). BullMQ retries the job per
// the queue's defaultJobOptions (3 attempts, exponential backoff); we only log.
// Deliberately NO Search.status write here — unlike the discovery worker, an
// enrichment failure is isolated to its single lead.
worker.on("failed", async (job, err) => {
  console.error(
    JSON.stringify({
      event: "enrichment.failed",
      leadId: job?.data.leadId,
      searchId: job?.data.searchId,
      attemptsMade: job?.attemptsMade,
      error: err.message,
    }),
  );
  // Durable FAILED only once retries are exhausted (not on a transient attempt).
  if (job && shouldMarkFailed(job.attemptsMade, job.opts.attempts ?? 1)) {
    await markLeadFailed(prisma, {
      organizationId: job.data.organizationId,
      leadId: job.data.leadId,
    }).catch((e) => console.error(JSON.stringify({ event: "enrichment.mark_failed_error", leadId: job.data.leadId, error: String(e) })));
  }
});

worker.on("completed", (job) => {
  console.log(JSON.stringify({ event: "enrichment.completed", leadId: job.data.leadId }));
});

console.log(JSON.stringify({ event: "enrichment.worker_started", provider: enrichmentProvider.key }));