/**
 * Deterministic CSV serialization for lead exports (§Export). No third-party CSV
 * library — hand-rolled RFC-4180-style quoting so the output is stable and
 * testable.
 *
 * A field is quoted when it contains a comma, double quote, CR, or LF; embedded
 * double quotes are escaped by doubling them. null/undefined become empty cells.
 * Rows are joined with CRLF (the RFC-4180 line terminator), which Excel/Sheets
 * both accept.
 *
 * The column order below is the fixed, documented contract for the export and
 * mirrors what the Leads table shows, plus a few already-present identifiers.
 */

import type { LeadDTO } from "./list";

/** Fixed export column order. Header label + how to pull it from a LeadDTO. */
const COLUMNS: { header: string; value: (lead: LeadDTO) => string | number | null }[] = [
  { header: "Business Name", value: (l) => l.businessName },
  { header: "Website", value: (l) => l.website ?? l.websiteDomain },
  { header: "Email", value: (l) => l.email },
  { header: "Phone", value: (l) => l.phone },
  { header: "Industry", value: (l) => l.industry },
  { header: "Company Size", value: (l) => l.companySize },
  { header: "City", value: (l) => l.city },
  { header: "Region", value: (l) => l.region },
  { header: "Country", value: (l) => l.country },
  { header: "Status", value: (l) => l.status },
  { header: "Score", value: (l) => l.leadScore },
  { header: "Quality", value: (l) => (l.score ? l.score.quality : null) },
];

/** The ordered header labels — exported so tests/callers can assert the contract. */
export const CSV_COLUMNS: readonly string[] = COLUMNS.map((c) => c.header);

/**
 * Maximum rows a single MVP export will produce. Enforced by the export route,
 * which returns 413 (never a silent truncation) when a matching set exceeds it.
 * Lives here rather than in route.ts because Next.js route modules may only
 * export HTTP handlers.
 */
export const EXPORT_MAX_ROWS = 5000;

/** Escape a single CSV field per RFC 4180. null/undefined → empty string. */
export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize leads to a CSV string (header row + one row per lead). Pure. */
export function leadsToCsv(leads: LeadDTO[]): string {
  const rows: string[] = [];
  rows.push(COLUMNS.map((c) => escapeCsvField(c.header)).join(","));
  for (const lead of leads) {
    rows.push(COLUMNS.map((c) => escapeCsvField(c.value(lead))).join(","));
  }
  return rows.join("\r\n");
}

/** Build a safe download filename: leadforge-<slug>-<YYYY-MM-DD>.csv */
export function csvFilename(searchName: string, date: Date = new Date()): string {
  const slug =
    searchName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "search";
  const day = date.toISOString().slice(0, 10);
  return `leadforge-${slug}-${day}.csv`;
}