/**
 * Google Places API (New) — Text Search discovery provider (§6).
 *
 * Implements the existing LeadProvider contract: given a SearchParams, return
 * RAW businesses. Normalization, dedup, credits, and enrichment all happen above
 * this layer, unchanged — this adapter only queries Google and maps the response
 * into RawBusiness. It never normalizes or persists.
 *
 * API: Places API (New), POST https://places.googleapis.com/v1/places:searchText
 *   - Auth:  X-Goog-Api-Key header (key never goes in the URL or logs)
 *   - Fields: X-Goog-FieldMask header (required; no default field set)
 *   - Paging: pageSize <= 20 + nextPageToken; all body params other than
 *             pageToken must stay identical between pages.
 *
 * Fields Google does NOT provide (email, socials, company size) are left
 * undefined — never fabricated. Enrichment fills those later.
 */

import type { LeadProvider, RawBusiness, SearchParams } from "./lead_providers";

export const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

/** Only the fields we map into RawBusiness — keeps the request in the Pro SKU
 *  and avoids pulling (and paying for) Enterprise-tier fields. No spaces. */
export const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.websiteUri",
  "places.internationalPhoneNumber",
  "places.googleMapsUri",
  "places.addressComponents",
  "places.primaryTypeDisplayName",
  "nextPageToken",
].join(",");

/** Places Text Search caps pageSize at 20; we cap total pages for safety. */
export const PAGE_SIZE = 20;
export const MAX_PAGES = 3;

/** Resolve the API key: canonical var first, then the backward-compatible one.
 *  A blank/whitespace canonical value falls through to the fallback. */
export function resolvePlacesApiKey(): string | undefined {
  const primary = process.env.GOOGLE_PLACES_API_KEY?.trim();
  if (primary) return primary;
  const fallback = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (fallback) return fallback;
  return undefined;
}

// ── Google response shapes (only what we read) ───────────────────────────────

interface PlacesAddressComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}
interface Place {
  id?: string;
  displayName?: { text?: string; languageCode?: string };
  formattedAddress?: string;
  websiteUri?: string;
  internationalPhoneNumber?: string;
  googleMapsUri?: string;
  addressComponents?: PlacesAddressComponent[];
  primaryTypeDisplayName?: { text?: string; languageCode?: string };
}
interface SearchTextResponse {
  places?: Place[];
  nextPageToken?: string;
}

// ── Pure helpers (unit-tested without network) ───────────────────────────────

/** Compose the Google text query from the search parameters. */
export function buildTextQuery(params: SearchParams): string {
  const location = [params.city, params.region, params.country].filter(Boolean).join(", ");
  return location ? `${params.category} in ${location}` : params.category;
}

/** Pull city / region / country / postal code out of Google addressComponents. */
export function parseAddressComponents(
  components: PlacesAddressComponent[] | undefined,
): { city?: string; region?: string; country?: string; postalCode?: string } {
  const out: { city?: string; region?: string; country?: string; postalCode?: string } = {};
  for (const c of components ?? []) {
    const types = c.types ?? [];
    const value = c.longText ?? c.shortText;
    if (!value) continue;
    if (out.city === undefined && (types.includes("locality") || types.includes("postal_town"))) {
      out.city = value;
    } else if (out.region === undefined && types.includes("administrative_area_level_1")) {
      out.region = value;
    } else if (out.country === undefined && types.includes("country")) {
      out.country = value;
    } else if (out.postalCode === undefined && types.includes("postal_code")) {
      out.postalCode = value;
    }
  }
  return out;
}

/**
 * Map a single Google Place to RawBusiness. Only fields Google actually returns
 * are populated; email, socialUrls, and company size are intentionally omitted
 * (Places does not provide them — enrichment's job, not ours to invent).
 */
export function mapPlaceToRawBusiness(place: Place, fallbackCategory: string): RawBusiness | null {
  const businessName = place.displayName?.text?.trim();
  if (!businessName) return null; // a business with no name isn't a usable lead

  const addr = parseAddressComponents(place.addressComponents);

  return {
    sourceId: place.id,
    businessName,
    category: place.primaryTypeDisplayName?.text ?? fallbackCategory,
    website: place.websiteUri,
    phone: place.internationalPhoneNumber,
    address: place.formattedAddress,
    city: addr.city,
    region: addr.region,
    country: addr.country,
    postalCode: addr.postalCode,
    googleProfileUrl: place.googleMapsUri,
    // email, socialUrls: not provided by Places — left undefined on purpose.
    raw: { placeId: place.id },
  };
}

/** Map a whole page of places, dropping any without a usable name. */
export function mapPlaces(places: Place[] | undefined, fallbackCategory: string): RawBusiness[] {
  const out: RawBusiness[] = [];
  for (const p of places ?? []) {
    const mapped = mapPlaceToRawBusiness(p, fallbackCategory);
    if (mapped) out.push(mapped);
  }
  return out;
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class GooglePlacesProvider implements LeadProvider {
  readonly key = "google_places";

  isConfigured(): boolean {
    return resolvePlacesApiKey() !== undefined;
  }

  async searchBusinesses(params: SearchParams): Promise<RawBusiness[]> {
    const apiKey = resolvePlacesApiKey();
    if (!apiKey) {
      // Should never run (registry only selects configured providers), but fail
      // loudly and WITHOUT leaking anything if it does.
      throw new Error("Google Places provider is not configured (missing API key).");
    }

    const textQuery = buildTextQuery(params);
    const collected: RawBusiness[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const body: Record<string, unknown> = { textQuery, pageSize: PAGE_SIZE };
      if (pageToken) body.pageToken = pageToken;

      const response = await fetch(PLACES_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        // Surface status + Google's own error status/message, never the key.
        const detail = await safeErrorMessage(response);
        throw new Error(
          `Google Places request failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
        );
      }

      let data: SearchTextResponse;
      try {
        data = (await response.json()) as SearchTextResponse;
      } catch {
        throw new Error("Google Places returned an unparseable (non-JSON) response.");
      }
      if (typeof data !== "object" || data === null || ("places" in data && !Array.isArray(data.places))) {
        throw new Error("Google Places returned an unexpected response shape.");
      }

      collected.push(...mapPlaces(data.places, params.category));

      if (collected.length >= params.limit) break; // enough — stop early
      if (!data.nextPageToken) break; // no more results
      pageToken = data.nextPageToken;
    }

    return collected.slice(0, params.limit);
  }
}

/**
 * Best-effort extraction of Google's error status/message for logging, with the
 * API key stripped in case it were ever echoed back. Never throws.
 */
async function safeErrorMessage(response: Response): Promise<string | null> {
  try {
    const json = (await response.json()) as { error?: { status?: string; message?: string } };
    const status = json.error?.status;
    const message = json.error?.message;
    const combined = [status, message].filter(Boolean).join(" - ");
    return combined ? redactKey(combined) : null;
  } catch {
    return null;
  }
}

/** Defensive: strip anything that looks like a key= param from a string. */
function redactKey(s: string): string {
  return s.replace(/([?&]key=)[^&\s]+/gi, "$1[REDACTED]");
}