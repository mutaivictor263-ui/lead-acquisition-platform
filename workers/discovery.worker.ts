/**
 * Discovery worker process (§19). Runs OUTSIDE the Next.js app on a long-running
 * host. Consumes the `discovery` queue and drives the tested `processDiscovery`
 * pipeline, injecting the real Prisma client, atomic credit reservation, and the
 * enrichment fan-out.
 *
 * Start with:  node --loader tsx src/workers/discovery.worker.ts
 * (or compiled)  — see docs for the process manager / Procfile setup.
 *
 * Note: needs a generated Prisma client (`prisma generate`) and a reachable
 * Redis, so it runs in your repo, not the build sandbox.
 */

import "dotenv/config";

import { Worker } from "bullmq";

import { connection, QUEUE, enqueueEnrichment, type DiscoveryJobData } from "../src/lib/jobs/queue";
import { processDiscovery } from "../src/lib/jobs/discovery";
import { consumeCredits, InsufficientCreditsError } from "../src/lib/credits/consume";
import { providerRegistry } from "../src/lib/providers/lead_providers";
import { prisma } from "../src/lib/db/client";


const worker = new Worker<DiscoveryJobData>(
  QUEUE.discovery,
  async (job) => {
    const { organizationId, searchId, providerKey } = job.data;

    await prisma.search.update({ where: { id: searchId }, data: { status: "RUNNING" } });

    const provider = providerRegistry.resolve(providerKey);

    return processDiscovery(
      {
        db: prisma,
        provider,
        // Reserve exactly one lead-credit per new lead, atomically (§20).
        reserveLeadCredit: async () => {
          try {
            await consumeCredits(prisma, {
              organizationId,
              amount: 1,
              kind: "lead_generated",
              searchId,
            });
            return true;
          } catch (e) {
            if (e instanceof InsufficientCreditsError) return false;
            throw e;
          }
        },
        enqueueEnrichment: (leadId) => enqueueEnrichment({ organizationId, searchId, leadId }),
        log: (event, data) => console.log(JSON.stringify({ event, ...data })),
      },
      { organizationId, searchId },
    );
  },
  { connection, concurrency: 4 },
);

worker.on("failed", async (job, err) => {
  // Discovery itself failing (not an individual lead) marks the search failed.
  console.error(JSON.stringify({ event: "discovery.failed", searchId: job?.data.searchId, error: err.message }));
  if (job?.data.searchId) {
    await prisma.search
      .update({ where: { id: job.data.searchId }, data: { status: "FAILED" } })
      .catch(() => {});
  }
});

console.log("discovery worker started");