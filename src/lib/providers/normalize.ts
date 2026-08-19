/**
 * Normalization + dedup (§9, §13).
 *
 * Dedup is only as good as normalization: "https://Foo.com/", "foo.com", and
 * "http://www.foo.com" must collapse to one domain before we compare. Same for
 * phones and social URLs. Then the dedupeHash gives one deterministic key per
 * business, enforced UNIQUE per org at the DB level.
 */

import { createHash } from "node:crypto";
import type { RawBusiness } from "./lead_providers";

export type SocialPlatform =
  | "LINKEDIN"
  | "FACEBOOK"
  | "INSTAGRAM"
  | "TWITTER"
  | "YOUTUBE"
  | "TIKTOK";

/** Lowercase host, strip leading www, drop path/query. Returns null if unparseable. */
export function normalizeDomain(website?: string | null): string | null {
  if (!website) return null;
  try {
    const withScheme = /^https?:\/\//i.test(website) ? website : `https://${website}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Best-effort E.164-ish: keep digits and a single leading +. Not a validator. */
export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return (plus ? "+" : "") + digits;
}

const SOCIAL_HOSTS: Record<string, SocialPlatform> = {
  "linkedin.com": "LINKEDIN",
  "facebook.com": "FACEBOOK",
  "fb.com": "FACEBOOK",
  "instagram.com": "INSTAGRAM",
  "twitter.com": "TWITTER",
  "x.com": "TWITTER",
  "youtube.com": "YOUTUBE",
  "youtu.be": "YOUTUBE",
  "tiktok.com": "TIKTOK",
};

export interface NormalizedSocial {
  platform: SocialPlatform;
  url: string;
}

/** Classify + canonicalize a social URL. Returns null for unknown platforms. */
export function normalizeSocial(url: string): NormalizedSocial | null {
  const host = normalizeDomain(url);
  if (!host) return null;
  for (const [domain, platform] of Object.entries(SOCIAL_HOSTS)) {
    if (host === domain || host.endsWith(`.${domain}`)) {
      try {
        const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        const u = new URL(withScheme);
        // canonical form: https://host + lowercased path, no trailing slash/query
        const path = u.pathname.replace(/\/+$/, "").toLowerCase();
        return { platform, url: `https://${host}${path}` };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** De-duplicate + normalize a list of social URLs (§9). */
export function normalizeSocials(urls: string[] = []): NormalizedSocial[] {
  const seen = new Map<SocialPlatform, string>();
  for (const raw of urls) {
    const s = normalizeSocial(raw);
    if (s && !seen.has(s.platform)) seen.set(s.platform, s.url);
  }
  return [...seen.entries()].map(([platform, url]) => ({ platform, url }));
}

/**
 * Deterministic dedup key (§13). Precedence:
 *   1. provider sourceId  2. website domain  3. normalized phone
 *   4. fallback: businessName + city + country
 * The first available signal wins so the same business collapses even when one
 * search has a website and another only has a phone.
 */
export function computeDedupeHash(b: {
  sourceId?: string | null;
  website?: string | null;
  phone?: string | null;
  businessName: string;
  city?: string | null;
  country?: string | null;
}): string {
  const key =
    (b.sourceId && `src:${b.sourceId}`) ||
    (normalizeDomain(b.website) && `dom:${normalizeDomain(b.website)}`) ||
    (normalizePhone(b.phone) && `tel:${normalizePhone(b.phone)}`) ||
    `name:${b.businessName.trim().toLowerCase()}|${(b.city ?? "").toLowerCase()}|${(b.country ?? "").toLowerCase()}`;
  return createHash("sha256").update(key).digest("hex");
}

/** Turn a RawBusiness into the normalized fields we actually persist. */
export function normalizeBusiness(b: RawBusiness) {
  return {
    businessName: b.businessName.trim(),
    category: b.category ?? null,
    website: b.website ?? null,
    websiteDomain: normalizeDomain(b.website),
    phone: b.phone ?? null,
    phoneNormalized: normalizePhone(b.phone),
    address: b.address ?? null,
    city: b.city ?? null,
    region: b.region ?? null,
    country: b.country ?? null,
    postalCode: b.postalCode ?? null,
    googleProfileUrl: b.googleProfileUrl ?? null,
    sourceId: b.sourceId ?? null,
    socials: normalizeSocials(b.socialUrls),
    dedupeHash: computeDedupeHash(b),
  };
}
