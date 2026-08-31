import { describe, it, expect, vi, afterEach } from "vitest";

import {
  WebsiteEnrichmentProvider,
  extractEmails,
  extractSocialUrls,
  MAX_BYTES,
} from "./website_enrichment";
import type { EnrichmentLeadInput } from "../jobs/enrichment";

function lead(overrides: Partial<EnrichmentLeadInput> = {}): EnrichmentLeadInput {
  return {
    id: "lead_1",
    organizationId: "org_1",
    businessName: "Acme Ltd",
    website: "https://acme.example",
    websiteDomain: "acme.example",
    email: null,
    phone: null,
    industry: null,
    companySize: null,
    ...overrides,
  };
}

/** Build a fetch Response stub. */
function htmlResponse(
  html: string,
  opts: { ok?: boolean; status?: number; contentType?: string; contentLength?: number } = {},
): Response {
  const { ok = true, status = 200, contentType = "text/html; charset=utf-8", contentLength } = opts;
  const headers = new Map<string, string>();
  headers.set("content-type", contentType);
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return {
    ok,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    text: async () => html,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── Pure extractors ──────────────────────────────────────────────────────────

describe("extractEmails", () => {
  it("pulls mailto and plaintext emails, lowercased and de-duped", () => {
    const html = `
      <a href="mailto:Hello@Acme.example">Email</a>
      contact us at Sales@Acme.example or Hello@acme.example
    `;
    expect(extractEmails(html)).toEqual(["hello@acme.example", "sales@acme.example"]);
  });

  it("filters image false-positives and denylisted junk", () => {
    const html = `logo@2x.png sprite@3x.jpg noreply@example.com abc@sentry.io real@acme.example`;
    expect(extractEmails(html)).toEqual(["real@acme.example"]);
  });

  it("returns [] when there is no email", () => {
    expect(extractEmails("<p>no contact here</p>")).toEqual([]);
  });
});

describe("extractSocialUrls", () => {
  it("collects only known social hosts, de-duped", () => {
    const html = `
      <a href="https://www.linkedin.com/company/acme">in</a>
      <a href="https://facebook.com/acme">fb</a>
      <a href="https://acme.example/about">site</a>
      <a href="https://www.linkedin.com/company/acme">dup</a>
    `;
    expect(extractSocialUrls(html)).toEqual([
      "https://www.linkedin.com/company/acme",
      "https://facebook.com/acme",
    ]);
  });

  it("returns [] when there are no social links", () => {
    expect(extractSocialUrls('<a href="https://acme.example">home</a>')).toEqual([]);
  });
});

// ── Provider.enrich (fetch mocked) ───────────────────────────────────────────

describe("WebsiteEnrichmentProvider.isConfigured", () => {
  it("reflects ENABLE_WEBSITE_ENRICHMENT", () => {
    const p = new WebsiteEnrichmentProvider();
    vi.stubEnv("ENABLE_WEBSITE_ENRICHMENT", "");
    expect(p.isConfigured()).toBe(false);
    vi.stubEnv("ENABLE_WEBSITE_ENRICHMENT", "true");
    expect(p.isConfigured()).toBe(true);
  });
});

describe("WebsiteEnrichmentProvider.enrich", () => {
  it("extracts email + socials and sets emailSource=website", async () => {
    const html = `
      <a href="mailto:hello@acme.example">mail</a>
      <a href="https://www.linkedin.com/company/acme">in</a>
      <a href="https://instagram.com/acme">ig</a>
    `;
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(html)));

    const data = await new WebsiteEnrichmentProvider().enrich(lead());

    expect(data.email).toBe("hello@acme.example");
    expect(data.emailSource).toBe("website");
    expect(data.socials).toEqual([
      { platform: "LINKEDIN", url: "https://linkedin.com/company/acme" },
      { platform: "INSTAGRAM", url: "https://instagram.com/acme" },
    ]);
  });

  it("never fabricates phone / industry / companySize / contacts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse('<a href="mailto:x@acme.example">x</a>')));
    const data = await new WebsiteEnrichmentProvider().enrich(lead());
    expect(data.phone).toBeUndefined();
    expect(data.phoneNormalized).toBeUndefined();
    expect(data.industry).toBeUndefined();
    expect(data.companySize).toBeUndefined();
    expect(data.contacts).toBeUndefined();
  });

  it("returns {} when the page has neither email nor socials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("<p>hello world</p>")));
    expect(await new WebsiteEnrichmentProvider().enrich(lead())).toEqual({});
  });

  it("returns {} and does NOT fetch when the lead has no website", async () => {
    const fetchMock = vi.fn(async () => htmlResponse("<p>x</p>"));
    vi.stubGlobal("fetch", fetchMock);
    const data = await new WebsiteEnrichmentProvider().enrich(lead({ website: null }));
    expect(data).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prepends https:// when the website has no scheme", async () => {
    let calledUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calledUrl = url;
      return htmlResponse('<a href="mailto:x@acme.example">x</a>');
    }));
    await new WebsiteEnrichmentProvider().enrich(lead({ website: "acme.example" }));
    expect(calledUrl).toBe("https://acme.example");
  });

  it("returns {} on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse("<p>x</p>", { ok: false, status: 500 })));
    expect(await new WebsiteEnrichmentProvider().enrich(lead())).toEqual({});
  });

  it("returns {} on a non-HTML content-type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse('{"a":1}', { contentType: "application/json" })));
    expect(await new WebsiteEnrichmentProvider().enrich(lead())).toEqual({});
  });

  it("returns {} when content-length exceeds the cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => htmlResponse('<a href="mailto:x@acme.example">x</a>', { contentLength: MAX_BYTES + 1 })),
    );
    expect(await new WebsiteEnrichmentProvider().enrich(lead())).toEqual({});
  });

  it("returns {} on a network/timeout failure (never throws)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("aborted");
    }));
    await expect(new WebsiteEnrichmentProvider().enrich(lead())).resolves.toEqual({});
  });

  it("is deterministic for identical input", async () => {
    const html = '<a href="mailto:hi@acme.example">m</a><a href="https://x.com/acme">x</a>';
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(html)));
    const a = await new WebsiteEnrichmentProvider().enrich(lead());
    vi.stubGlobal("fetch", vi.fn(async () => htmlResponse(html)));
    const b = await new WebsiteEnrichmentProvider().enrich(lead());
    expect(a).toEqual(b);
  });
});