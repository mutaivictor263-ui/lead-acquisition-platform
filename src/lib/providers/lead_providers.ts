/**
 * Lead provider abstraction (§6).
 *
 * Every source of businesses — Google Places, Apify actors, a CSV import —
 * implements this one interface. Nothing above this layer knows which provider
 * ran. Adding a provider = writing one adapter + registering it. API keys stay
 * server-side (these modules never ship to the browser).
 *
 * Providers return RAW business data. Normalization, dedup, persistence, credit
 * accounting, and enrichment all happen in layers above — a provider's only job
 * is "given a query, return businesses I found".
 */

export interface SearchParams {
  category: string;
  city?: string;
  region?: string;
  country?: string;
  postalCode?: string;
  limit: number;
}

/** Raw business as returned by a provider — pre-normalization, may be sparse. */
export interface RawBusiness {
  /** Provider's stable id for this business, if any (used for dedup §13). */
  sourceId?: string;
  businessName: string;
  category?: string;
  website?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  region?: string;
  country?: string;
  postalCode?: string;
  googleProfileUrl?: string;
  /** Any social links the provider already knows about. */
  socialUrls?: string[];
  /** Free-form extras a specific provider might return; not persisted directly. */
  raw?: Record<string, unknown>;
}

export interface LeadProvider {
  /** Stable key stored on the lead's `source` field. */
  readonly key: string;
  /** True if the provider is configured (has creds) and safe to call. */
  isConfigured(): boolean;
  searchBusinesses(params: SearchParams): Promise<RawBusiness[]>;
}

/**
 * Registry + selection. In production you might order providers by cost or
 * quality and fall through on failure (§30). Here we keep it explicit and
 * predictable: pick the first configured provider unless one is named.
 */
class ProviderRegistry {
  private providers = new Map<string, LeadProvider>();

  register(p: LeadProvider) {
    this.providers.set(p.key, p);
  }

  get(key: string): LeadProvider | undefined {
    return this.providers.get(key);
  }

  /** All configured providers, in registration order. */
  configured(): LeadProvider[] {
    return [...this.providers.values()].filter((p) => p.isConfigured());
  }

  /**
   * Resolve which provider to use. Explicit key wins; otherwise first configured.
   * Throws if nothing is usable so callers fail loudly rather than silently
   * returning zero leads.
   */
  resolve(preferredKey?: string): LeadProvider {
    if (preferredKey) {
      const p = this.get(preferredKey);
      if (!p) throw new Error(`Unknown lead provider: ${preferredKey}`);
      if (!p.isConfigured()) throw new Error(`Lead provider not configured: ${preferredKey}`);
      return p;
    }
    const first = this.configured()[0];
    if (!first) throw new Error("No lead provider is configured. Set provider API keys in the environment.");
    return first;
  }
}

export const providerRegistry = new ProviderRegistry();

// ── Mock provider (§6) ────────────────────────────────────────────────────────
// Clearly isolated, deterministic, and DISABLED in production. Lets the whole
// pipeline run end-to-end in dev without external calls. It returns plausible
// SHAPES, not fake "verified" data — enrichment/scoring still run on top.

export class MockLeadProvider implements LeadProvider {
  readonly key = "mock";

  isConfigured(): boolean {
    // Never active in production. Gate on an explicit dev flag.
    return process.env.NODE_ENV !== "production" && process.env.ENABLE_MOCK_PROVIDER === "true";
  }

  async searchBusinesses(params: SearchParams): Promise<RawBusiness[]> {
    const n = Math.min(params.limit, 25);
    const loc = [params.city, params.region, params.country].filter(Boolean).join(", ");
    return Array.from({ length: n }, (_, i) => {
      const slug = `${params.category}-${i + 1}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      return {
        sourceId: `mock_${slug}`,
        businessName: `${titleCase(params.category)} ${i + 1}`,
        category: params.category,
        website: `https://${slug}.example.com`,
        phone: `+1-555-01${String(i).padStart(2, "0")}`,
        address: `${100 + i} Example St`,
        city: params.city,
        region: params.region,
        country: params.country,
        postalCode: params.postalCode,
        socialUrls: [`https://www.linkedin.com/company/${slug}`],
        raw: { generatedFor: loc },
      };
    });
  }
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// Register built-ins. Real adapters (GooglePlacesProvider, ApifyProvider) get
// registered here too once their API keys are wired — see docs/PROVIDERS.md.
providerRegistry.register(new MockLeadProvider());