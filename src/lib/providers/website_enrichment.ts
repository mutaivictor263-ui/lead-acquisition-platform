/**
 * Website enrichment provider (Tier 1 — no external API).
 *
 * Given a lead's existing website, fetch the HOMEPAGE ONLY and extract a contact
 * email + social profile URLs from the HTML. It fabricates nothing: if the page
 * yields neither, it returns {}. Social URL classification reuses the existing
 * normalizeSocials() so platform handling is shared, not reinvented.
 *
 * Bounds (best-effort, never throws to the pipeline): ~5s timeout, ~1.5 MB read
 * cap, homepage only (no crawling), a basic User-Agent, follows redirects, no
 * robots.txt. Any fetch problem (non-2xx, non-HTML, oversized, timeout, network)
 * yields {} so a bad site never fails the lead.
 *
 * Enabled only when ENABLE_WEBSITE_ENRICHMENT === "true"; otherwise the worker
 * keeps using mockEnrichmentProvider.
 */

import type { EnrichmentData, EnrichmentLeadInput, EnrichmentProvider } from "../jobs/enrichment";
import { normalizeSocials } from "./normalize";

export const FETCH_TIMEOUT_MS = 5000;
export const MAX_BYTES = 1_500_000; // ~1.5 MB
const USER_AGENT = "LeadForgeBot/1.0 (+https://leadforge.local/bot)";

const KNOWN_SOCIAL_HOSTS = [
  "linkedin.com",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
];

// Junk we never treat as a contact email.
const EMAIL_DENY_SUBSTRINGS = ["example.com", "example.org", "example.net", "sentry.", "wixpress.com", "yourdomain", "@2x", "@3x"];
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|ico|bmp)$/i;
const EMAIL_SHAPE_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const EMAIL_FIND_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MAILTO_RE = /mailto:([^"'?>\s]+)/gi;
const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;

/** Extract candidate contact emails from HTML, in priority order (mailto first).
 *  Lowercased, de-duplicated, with image/junk false-positives filtered. Pure. */
export function extractEmails(html: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const consider = (raw: string) => {
    let email = raw.trim().toLowerCase();
    // strip a trailing query/params occasionally captured after mailto
    email = email.split("?")[0] ?? email;
    if (!email || seen.has(email)) return;
    if (IMAGE_EXT_RE.test(email)) return;
    if (EMAIL_DENY_SUBSTRINGS.some((d) => email.includes(d))) return;
    if (!EMAIL_SHAPE_RE.test(email)) return;
    seen.add(email);
    found.push(email);
  };

  for (const m of html.matchAll(MAILTO_RE)) {
    try {
      consider(decodeURIComponent(m[1] ?? ""));
    } catch {
      consider(m[1] ?? "");
    }
  }
  for (const m of html.matchAll(EMAIL_FIND_RE)) consider(m[0]);

  return found;
}

/** Extract raw social-profile hrefs from HTML (de-duped). Classification and
 *  canonicalization happen via normalizeSocials(). Pure. */
export function extractSocialUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(HREF_RE)) {
    const href = (m[1] ?? "").trim();
    if (!href) continue;
    const lower = href.toLowerCase();
    if (!KNOWN_SOCIAL_HOSTS.some((h) => lower.includes(h))) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    urls.push(href);
  }
  return urls;
}

/** Ensure an absolute http(s) URL to fetch. */
function toAbsoluteUrl(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

/** Fetch a homepage within the guardrails. Returns HTML text, or null on any
 *  problem (never throws). */
async function fetchHomepage(website: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(toAbsoluteUrl(website), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    });

    if (!res.ok) return null;

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.includes("html")) return null;

    const declaredLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BYTES) return null;

    const text = await res.text();
    return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
  } catch {
    // timeout / abort / network / decode — best-effort, yield nothing.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export class WebsiteEnrichmentProvider implements EnrichmentProvider {
  readonly key = "website";

  isConfigured(): boolean {
    return process.env.ENABLE_WEBSITE_ENRICHMENT === "true";
  }

  async enrich(lead: EnrichmentLeadInput): Promise<EnrichmentData> {
    const website = lead.website?.trim();
    if (!website) return {}; // nothing to fetch — never fabricate

    const html = await fetchHomepage(website);
    if (!html) return {};

    const emails = extractEmails(html);
    const socials = normalizeSocials(extractSocialUrls(html)).map((s) => ({
      platform: s.platform,
      url: s.url,
    }));

    const data: EnrichmentData = {};
    if (emails.length > 0) {
      data.email = emails[0];
      data.emailSource = "website";
    }
    if (socials.length > 0) {
      data.socials = socials;
    }
    // phone / industry / companySize / contacts: intentionally never set here.
    return data;
  }
}

export const websiteEnrichmentProvider = new WebsiteEnrichmentProvider();