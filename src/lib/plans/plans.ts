/**
 * Plan definitions — the single source of truth (§18).
 *
 * Nothing in the app should hardcode "5000 leads" or "pro can use AI scoring".
 * Read capabilities from here. `prisma/seed.ts` mirrors these rows into the
 * `plans` table so subscriptions can foreign-key to a stable key and Stripe
 * price ids stay in one place.
 *
 * `stripePriceId` comes from env so test/live keys differ per environment and
 * never get committed.
 */

export type PlanKey = "free" | "starter" | "pro" | "agency";

export interface PlanCapabilities {
  emailEnrichment: boolean;
  advancedEnrichment: boolean;
  aiScoring: boolean;
  googleSheets: boolean;
  apiAccess: boolean;
  priorityProcessing: boolean;
}

export interface Plan {
  key: PlanKey;
  name: string;
  priceMonthlyCents: number;
  monthlyLeadCredits: number;
  /** -1 means unlimited. */
  maxActiveSearches: number;
  maxSeats: number;
  stripePriceId: string | null;
  capabilities: PlanCapabilities;
}

const caps = (o: Partial<PlanCapabilities>): PlanCapabilities => ({
  emailEnrichment: false,
  advancedEnrichment: false,
  aiScoring: false,
  googleSheets: false,
  apiAccess: false,
  priorityProcessing: false,
  ...o,
});

export const PLANS: Record<PlanKey, Plan> = {
  free: {
    key: "free",
    name: "Free",
    priceMonthlyCents: 0,
    monthlyLeadCredits: 100,
    maxActiveSearches: 1,
    maxSeats: 1,
    stripePriceId: null,
    capabilities: caps({}),
  },
  starter: {
    key: "starter",
    name: "Starter",
    priceMonthlyCents: 2900,
    monthlyLeadCredits: 1000,
    maxActiveSearches: 5,
    maxSeats: 1,
    stripePriceId: process.env.STRIPE_PRICE_STARTER ?? null,
    capabilities: caps({ emailEnrichment: true, googleSheets: true }),
  },
  pro: {
    key: "pro",
    name: "Pro",
    priceMonthlyCents: 5900,
    monthlyLeadCredits: 5000,
    maxActiveSearches: -1,
    maxSeats: 3,
    stripePriceId: process.env.STRIPE_PRICE_PRO ?? null,
    capabilities: caps({
      emailEnrichment: true,
      advancedEnrichment: true,
      aiScoring: true,
      googleSheets: true,
      priorityProcessing: true,
    }),
  },
  agency: {
    key: "agency",
    name: "Agency",
    priceMonthlyCents: 9900,
    monthlyLeadCredits: 15000,
    maxActiveSearches: -1,
    maxSeats: 10,
    stripePriceId: process.env.STRIPE_PRICE_AGENCY ?? null,
    capabilities: caps({
      emailEnrichment: true,
      advancedEnrichment: true,
      aiScoring: true,
      googleSheets: true,
      apiAccess: true,
      priorityProcessing: true,
    }),
  },
};

export function getPlan(key: string): Plan {
  return PLANS[(key as PlanKey)] ?? PLANS.free;
}

export function planAllows(key: string, capability: keyof PlanCapabilities): boolean {
  return getPlan(key).capabilities[capability];
}

export function unlimitedSearches(key: string): boolean {
  return getPlan(key).maxActiveSearches === -1;
}