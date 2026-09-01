/**
 * Scoring worker process (§21). Runs OUTSIDE the Next.js app on a long-running
 * host. Consumes the `scoring` queue and drives the tested processScoring
 * pipeline with the real Prisma client. Terminal stage — nothing is enqueued
 * downstream.
 *
 * Start with:  npm run worker:scoring
 *
 * Needs a generated Prisma client (`prisma generate`) and a reachable Redis, so
 * it runs in your repo, not the build sandbox.
 */

import "dotenv/config";

import { Worker } from "bullmq";

import { connection, QUEUE, type ScoringJobData } from "../src/lib/jobs/queue";
import { processScoring } from "../src/lib/jobs/scoring";
import { shouldMarkFailed, markLeadFailed } from "../src/lib/jobs/failure";
import { prisma } from "../src/lib/db/client";

const worker = new Worker<ScoringJobData>(
  QUEUE.scoring,
  async (job) => {
    const { organizationId, searchId, leadId } = job.data;

    return processScoring(
      {
        db: prisma,
        log: (event, data) => console.log(JSON.stringify({ event, ...data })),
      },
      { organizationId, searchId, leadId },
    );
  },
  // Same shape as the enrichment worker; retry/backoff come from the queue's
  // defaultJobOptions set when each job was enqueued.
  { connection, concurrency: 4 },
);

// One lead failing must NOT fail the search. BullMQ retries the job per the
// queue's defaultJobOptions; we only log. No Search.status write here.
worker.on("failed", async (job, err) => {
  console.error(
    JSON.stringify({
      event: "scoring.failed",
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
    }).catch((e) => console.error(JSON.stringify({ event: "scoring.mark_failed_error", leadId: job.data.leadId, error: String(e) })));
  }
});

worker.on("completed", (job) => {
  console.log(JSON.stringify({ event: "scoring.completed", leadId: job.data.leadId }));
});

console.log("scoring worker started");