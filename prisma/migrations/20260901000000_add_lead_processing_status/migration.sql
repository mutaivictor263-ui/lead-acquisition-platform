-- Batch 3a: durable lead processing status.
-- NOTE: hand-authored to match what `prisma migrate dev` generates for the
-- schema change, plus a backfill step. Generate/verify with
-- `npx prisma migrate dev --create-only` in the repo before applying.
-- Tables use @@map (leads, lead_scores); columns keep their camelCase names.

-- CreateEnum
CREATE TYPE "LeadProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable: additive, non-nullable with a default so existing rows backfill to PENDING.
ALTER TABLE "leads"
  ADD COLUMN "processingStatus" "LeadProcessingStatus" NOT NULL DEFAULT 'PENDING';

-- Backfill: a lead that already has a LeadScore is COMPLETED; everything else
-- stays PENDING. We do NOT invent historical FAILED states.
UPDATE "leads"
  SET "processingStatus" = 'COMPLETED'
  FROM "lead_scores" ls
  WHERE ls."leadId" = "leads"."id";

-- CreateIndex
CREATE INDEX "leads_organizationId_searchId_processingStatus_idx"
  ON "leads" ("organizationId", "searchId", "processingStatus");