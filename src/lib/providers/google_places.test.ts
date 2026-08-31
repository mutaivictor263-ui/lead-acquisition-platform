import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  GooglePlacesProvider,
  buildTextQuery,
  parseAddressComponents,
  mapPlaceToRawBusiness,
  mapPlaces,
  resolvePlacesApiKey,
  PLACES_ENDPOINT,
  FIELD_MASK,
  MAX_PAGES,
} from "./google_places";
import type { SearchParams } from "./lead_providers";

const params: SearchParams = {
  category: "restaurants",
  city: "Nairobi",
  country: "Kenya",
  limit: 25,
};

function place(overrides: Record<string, unknown> = {}) {
  return {
    id: "ChIJ_test_1",
    displayName: { text: "Mama Oliech Restaurant", languageCode: "en" },
    formattedAddress: "Marcus Garvey Rd, Nairobi, Kenya",
    websiteUri: "https://mamaoliech.example",
    internationalPhoneNumber: "+254 20 1234567",
    googleMapsUri: "https://maps.google.com/?cid=123",
    primaryTypeDisplayName: { text: "Restaurant", languageCode: "en" },
    addressComponents: [
      { longText: "Nairobi", types: ["locality"] },
      { longText: "Nairobi County", types: ["administrative_area_level_1"] },
      { longText: "Kenya", shortText: "KE", types: ["country"] },
      { longText: "00100", types: ["postal_code"] },
    ],
    ...overrides,
  };
}

/** Build a fake fetch Response. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("buildTextQuery", () => {
  it("combines category and location", () => {
    expect(buildTextQuery(params)).toBe("restaurants in Nairobi, Kenya");
  });
  it("uses just the category when no location is given", () => {
    expect(buildTextQuery({ category: "plumbers", limit: 10 })).toBe("plumbers");
  });
});

describe("parseAddressComponents", () => {
  it("extracts city, region, country, postal code", () => {
    expect(parseAddressComponents(place().addressComponents)).toEqual({
      city: "Nairobi",
      region: "Nairobi County",
      country: "Kenya",
      postalCode: "00100",
    });
  });
  it("returns an empty object for missing components", () => {
    expect(parseAddressComponents(undefined)).toEqual({});
  });
});

describe("mapPlaceToRawBusiness", () => {
  it("maps a full place into RawBusiness", () => {
    const rb = mapPlaceToRawBusiness(place(), "restaurants");
    expect(rb).toEqual({
      sourceId: "ChIJ_test_1",
      businessName: "Mama Oliech Restaurant",
      category: "Restaurant",
      website: "https://mamaoliech.example",
      phone: "+254 20 1234567",
      address: "Marcus Garvey Rd, Nairobi, Kenya",
      city: "Nairobi",
      region: "Nairobi County",
      country: "Kenya",
      postalCode: "00100",
      googleProfileUrl: "https://maps.google.com/?cid=123",
      raw: { placeId: "ChIJ_test_1" },
    });
  });

  it("never fabricates email, socials, or company size", () => {
    const rb = mapPlaceToRawBusiness(place(), "restaurants");
    expect(rb?.email).toBeUndefined();
    expect(rb?.socialUrls).toBeUndefined();
    expect(rb).not.toHaveProperty("companySize");
  });

  it("leaves optional fields undefined when Google omits them", () => {
    const rb = mapPlaceToRawBusiness(
      { id: "x", displayName: { text: "No Website Co" } },
      "cafes",
    );
    expect(rb).toMatchObject({
      sourceId: "x",
      businessName: "No Website Co",
      category: "cafes", // fallback to the search category
    });
    expect(rb?.website).toBeUndefined();
    expect(rb?.phone).toBeUndefined();
    expect(rb?.city).toBeUndefined();
  });

  it("drops a place with no usable name", () => {
    expect(mapPlaceToRawBusiness({ id: "x", displayName: { text: "  " } }, "cafes")).toBeNull();
    expect(mapPlaceToRawBusiness({ id: "x" }, "cafes")).toBeNull();
  });
});

describe("mapPlaces", () => {
  it("maps multiple businesses and skips unnamed ones", () => {
    const out = mapPlaces(
      [place({ id: "a" }), { id: "b" /* no name */ }, place({ id: "c", displayName: { text: "Second" } })],
      "restaurants",
    );
    expect(out).toHaveLength(2);
    expect(out.map((b) => b.sourceId)).toEqual(["a", "c"]);
  });
  it("returns [] for undefined places", () => {
    expect(mapPlaces(undefined, "x")).toEqual([]);
  });
});

describe("resolvePlacesApiKey", () => {
  it("prefers GOOGLE_PLACES_API_KEY", () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "primary");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "fallback");
    expect(resolvePlacesApiKey()).toBe("primary");
  });
  it("falls back to GOOGLE_MAPS_API_KEY", () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "fallback");
    expect(resolvePlacesApiKey()).toBe("fallback");
  });
  it("is undefined when neither is set (or blank)", () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "  ");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
    expect(resolvePlacesApiKey()).toBeUndefined();
  });
});

describe("GooglePlacesProvider.isConfigured", () => {
  it("is false with no key, true with a key", () => {
    const provider = new GooglePlacesProvider();
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
    expect(provider.isConfigured()).toBe(false);
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "abc");
    expect(provider.isConfigured()).toBe(true);
  });
});

// ── searchBusinesses (fetch mocked) ──────────────────────────────────────────

describe("GooglePlacesProvider.searchBusinesses", () => {
  beforeEach(() => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "test-key");
  });

  it("sends the correct endpoint, method, headers and body", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse({ places: [place()] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await new GooglePlacesProvider().searchBusinesses(params);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toBe(PLACES_ENDPOINT);
    expect(capturedInit.method).toBe("POST");
    const headers = capturedInit.headers as Record<string, string>;
    expect(headers["X-Goog-Api-Key"]).toBe("test-key");
    expect(headers["X-Goog-FieldMask"]).toBe(FIELD_MASK);
    expect(headers["Content-Type"]).toBe("application/json");
    const sent = JSON.parse(capturedInit.body as string);
    expect(sent).toEqual({ textQuery: "restaurants in Nairobi, Kenya", pageSize: 20 });
    expect(sent).not.toHaveProperty("pageToken");
  });

  it("maps a normal response into RawBusiness[]", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ places: [place(), place({ id: "b", displayName: { text: "Second" } })] })));
    const out = await new GooglePlacesProvider().searchBusinesses(params);
    expect(out).toHaveLength(2);
    expect(out[0].businessName).toBe("Mama Oliech Restaurant");
    expect(out[0].sourceId).toBe("ChIJ_test_1");
  });

  it("returns [] for an empty result set", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ places: [] })));
    expect(await new GooglePlacesProvider().searchBusinesses(params)).toEqual([]);
  });

  it("paginates with pageToken and concatenates pages", async () => {
    const p1 = Array.from({ length: 20 }, (_, i) => place({ id: `p1_${i}`, displayName: { text: `P1 ${i}` } }));
    const p2 = Array.from({ length: 20 }, (_, i) => place({ id: `p2_${i}`, displayName: { text: `P2 ${i}` } }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ places: p1, nextPageToken: "TOKEN2" }))
      .mockResolvedValueOnce(jsonResponse({ places: p2 }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new GooglePlacesProvider().searchBusinesses({ ...params, limit: 40 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).pageToken).toBe("TOKEN2");
    expect(out).toHaveLength(40);
  });

  it("stops early once the requested limit is reached (no extra page fetch)", async () => {
    const p1 = Array.from({ length: 20 }, (_, i) => place({ id: `p1_${i}`, displayName: { text: `P1 ${i}` } }));
    const fetchMock = vi.fn(async () => jsonResponse({ places: p1, nextPageToken: "TOKEN2" }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new GooglePlacesProvider().searchBusinesses({ ...params, limit: 10 });

    expect(fetchMock).toHaveBeenCalledTimes(1); // didn't fetch page 2
    expect(out).toHaveLength(10); // truncated to limit
  });

  it("never exceeds MAX_PAGES requests", async () => {
    const full = Array.from({ length: 20 }, (_, i) => place({ id: `x_${i}`, displayName: { text: `X ${i}` } }));
    const fetchMock = vi.fn(async () => jsonResponse({ places: full, nextPageToken: "ALWAYS_MORE" }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await new GooglePlacesProvider().searchBusinesses({ ...params, limit: 1000 });

    expect(fetchMock).toHaveBeenCalledTimes(MAX_PAGES);
    expect(out).toHaveLength(MAX_PAGES * 20);
  });

  it("throws on a non-2xx response with status + Google message, without the key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { status: "PERMISSION_DENIED", message: "API key invalid" } }, false, 403)),
    );
    await expect(new GooglePlacesProvider().searchBusinesses(params)).rejects.toThrow(/HTTP 403/);
    await expect(new GooglePlacesProvider().searchBusinesses(params)).rejects.toThrow(/PERMISSION_DENIED/);
    await expect(new GooglePlacesProvider().searchBusinesses(params)).rejects.not.toThrow(/test-key/);
  });

  it("throws on a quota / rate-limit (429) response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }, false, 429)),
    );
    await expect(new GooglePlacesProvider().searchBusinesses(params)).rejects.toThrow(/HTTP 429/);
  });

  it("throws on an unparseable (non-JSON) body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token");
      },
    } as unknown as Response)));
    await expect(new GooglePlacesProvider().searchBusinesses(params)).rejects.toThrow(/non-JSON/);
  });

  it("throws on an unexpected response shape (places not an array)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ places: "nope" })));
    await expect(new GooglePlacesProvider().searchBusinesses(params)).rejects.toThrow(/unexpected response shape/);
  });

  it("propagates a network/fetch failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    await expect(new GooglePlacesProvider().searchBusinesses(params)).rejects.toThrow(/network down/);
  });

  it("throws (without leaking) when called with no key configured", async () => {
    vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
    await expect(new GooglePlacesProvider().searchBusinesses(params)).rejects.toThrow(/not configured/);
  });
});