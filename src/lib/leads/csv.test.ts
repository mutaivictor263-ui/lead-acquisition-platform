import { describe, it, expect } from "vitest";

import { leadsToCsv, escapeCsvField, csvFilename, CSV_COLUMNS } from "./csv";
import type { LeadDTO } from "./list";

function lead(overrides: Partial<LeadDTO> = {}): LeadDTO {
  return {
    id: "lead_1",
    businessName: "Acme Dentistry",
    category: "dentists",
    website: "https://acme.example.com",
    websiteDomain: "acme.example.com",
    email: "hi@acme.example.com",
    emailStatus: "UNKNOWN",
    phone: "+15550100",
    industry: "Healthcare",
    companySize: "11-50",
    address: "123 Example St",
    city: "Nairobi",
    region: "Nairobi County",
    country: "KE",
    googleProfileUrl: "https://maps.google.com/?cid=1",
    status: "NEW",
    leadScore: 40,
    score: { score: 40, quality: "Fair", model: "rules-v1", scoredAt: "2026-08-01T00:00:00.000Z" },
    socials: [],
    contacts: [],
    ...overrides,
  };
}

const HEADER =
  "Business Name,Category,Website,Email,Phone,Industry,Company Size,Address,City,Region,Country,Google Maps URL,Socials,Status,Score,Quality";

describe("CSV column contract", () => {
  it("has the exact documented column order", () => {
    expect(CSV_COLUMNS).toEqual([
      "Business Name",
      "Category",
      "Website",
      "Email",
      "Phone",
      "Industry",
      "Company Size",
      "Address",
      "City",
      "Region",
      "Country",
      "Google Maps URL",
      "Socials",
      "Status",
      "Score",
      "Quality",
    ]);
  });

  it("emits the header as the first line", () => {
    const csv = leadsToCsv([]);
    expect(csv).toBe(HEADER);
  });
});

describe("leadsToCsv — normal values", () => {
  it("writes one row per lead with score and quality", () => {
    const csv = leadsToCsv([lead({ socials: [{ platform: "LINKEDIN", url: "https://linkedin.com/company/acme" }] })]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(HEADER);
    expect(lines[1]).toBe(
      "Acme Dentistry,dentists,https://acme.example.com,hi@acme.example.com,+15550100,Healthcare,11-50,123 Example St,Nairobi,Nairobi County,KE,https://maps.google.com/?cid=1,https://linkedin.com/company/acme,NEW,40,Fair",
    );
    expect(lines).toHaveLength(2);
  });

  it("falls back to websiteDomain when website is null", () => {
    const csv = leadsToCsv([lead({ website: null })]);
    expect(csv.split("\r\n")[1]).toContain("acme.example.com");
  });
});

describe("leadsToCsv — null / missing values", () => {
  it("renders null fields as empty cells (no 'null' text)", () => {
    const csv = leadsToCsv([
      lead({
        category: null,
        website: null,
        websiteDomain: null,
        email: null,
        phone: null,
        industry: null,
        companySize: null,
        address: null,
        city: null,
        region: null,
        country: null,
        googleProfileUrl: null,
        socials: [],
        leadScore: null,
        score: null,
      }),
    ]);
    // Business Name + Status only; all 14 other columns empty.
    expect(csv.split("\r\n")[1]).toBe("Acme Dentistry,,,,,,,,,,,,,NEW,,");
  });

  it("uses an empty Quality cell when the lead is unscored", () => {
    const csv = leadsToCsv([lead({ leadScore: null, score: null })]);
    const cells = csv.split("\r\n")[1]?.split(",");
    expect(cells?.[cells.length - 2]).toBe(""); // Score
    expect(cells?.[cells.length - 1]).toBe(""); // Quality
  });
});

describe("escapeCsvField — RFC 4180 escaping", () => {
  it("quotes fields containing a comma", () => {
    expect(escapeCsvField("Smith, Jones & Co")).toBe('"Smith, Jones & Co"');
  });

  it("quotes and doubles embedded double quotes", () => {
    expect(escapeCsvField('The "Best" Diner')).toBe('"The ""Best"" Diner"');
  });

  it("quotes fields containing newlines", () => {
    expect(escapeCsvField("Line1\nLine2")).toBe('"Line1\nLine2"');
    expect(escapeCsvField("Line1\r\nLine2")).toBe('"Line1\r\nLine2"');
  });

  it("leaves plain values unquoted", () => {
    expect(escapeCsvField("Acme")).toBe("Acme");
    expect(escapeCsvField(40)).toBe("40");
  });

  it("renders null/undefined as empty", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });
});

describe("leadsToCsv — escaping within rows", () => {
  it("escapes special characters in business name without breaking columns", () => {
    const csv = leadsToCsv([lead({ businessName: 'Bob\'s "Grill", Nairobi' })]);
    const line = csv.split("\r\n")[1];
    expect(line?.startsWith('"Bob\'s ""Grill"", Nairobi",')).toBe(true);
  });
});

describe("leadsToCsv — deterministic output", () => {
  it("produces identical output for identical input", () => {
    const input = [lead({ id: "a" }), lead({ id: "b", businessName: "Beta" })];
    expect(leadsToCsv(input)).toBe(leadsToCsv(input));
  });
});

describe("leadsToCsv — new columns (category, address, maps, socials)", () => {
  it("includes category, address, and Google Maps URL values", () => {
    const row = leadsToCsv([lead()]).split("\r\n")[1] ?? "";
    expect(row).toContain("dentists"); // Category
    expect(row).toContain("123 Example St"); // Address
    expect(row).toContain("https://maps.google.com/?cid=1"); // Google Maps URL
  });

  it("flattens multiple social URLs into one cell, preserving all of them", () => {
    const csv = leadsToCsv([
      lead({
        socials: [
          { platform: "LINKEDIN", url: "https://linkedin.com/company/acme" },
          { platform: "INSTAGRAM", url: "https://instagram.com/acme" },
        ],
      }),
    ]);
    const cells = (csv.split("\r\n")[1] ?? "").split(",");
    // Socials column is index 12 (0-based) in the fixed order.
    expect(cells[12]).toBe("https://linkedin.com/company/acme https://instagram.com/acme");
  });

  it("renders an empty Socials cell when there are none", () => {
    const cells = (leadsToCsv([lead({ socials: [] })]).split("\r\n")[1] ?? "").split(",");
    expect(cells[12]).toBe("");
  });

  it("escapes an address containing a comma without breaking columns", () => {
    const csv = leadsToCsv([lead({ address: "5th Ave, Suite 200", socials: [] })]);
    expect(csv.split("\r\n")[1]).toContain('"5th Ave, Suite 200"');
  });
});

describe("csvFilename", () => {
  it("slugifies the search name and appends the date", () => {
    expect(csvFilename("Restaurants in Nairobi, Kenya", new Date("2026-08-28T10:00:00Z"))).toBe(
      "leadforge-restaurants-in-nairobi-kenya-2026-08-28.csv",
    );
  });

  it("falls back to 'search' for an empty-ish name", () => {
    expect(csvFilename("!!!", new Date("2026-08-28T00:00:00Z"))).toBe("leadforge-search-2026-08-28.csv");
  });
});