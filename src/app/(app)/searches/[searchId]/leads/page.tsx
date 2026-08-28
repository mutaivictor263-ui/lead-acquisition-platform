import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/db/client";
import { requireCurrentTenant } from "@/lib/auth/current-user";
import { leadListSchema, type LeadListInput } from "@/lib/validation/search";
import { listLeads } from "@/lib/leads/list";
import { paginationInfo } from "@/lib/leads/pagination";

// params + searchParams are async in Next 15.
type Params = Promise<{ searchId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const statusColor: Record<string, string> = {
  PENDING: "#8a6d1f",
  RUNNING: "#1f5f8a",
  COMPLETED: "#1f7a3d",
  PARTIAL: "#8a6d1f",
  FAILED: "#8a1f2b",
};

const qualityColor: Record<string, string> = {
  Excellent: "#1f7a3d",
  Good: "#1f5f8a",
  Fair: "#8a6d1f",
  Poor: "#8a1f2b",
};

/** Flatten Next's searchParams (string | string[] | undefined) to plain strings. */
function flatten(sp: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
  }
  return out;
}

/** Build a querystring for a leads link, preserving current filters. */
function buildQuery(input: LeadListInput, page: number): string {
  const p = new URLSearchParams();
  if (input.q) p.set("q", input.q);
  if (typeof input.minScore === "number") p.set("minScore", String(input.minScore));
  p.set("sort", input.sort);
  p.set("order", input.order);
  if (page > 1) p.set("page", String(page));
  if (input.pageSize !== 25) p.set("pageSize", String(input.pageSize));
  const s = p.toString();
  return s ? `?${s}` : "";
}

const cell: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid #eee", textAlign: "left", whiteSpace: "nowrap" };
const field: React.CSSProperties = { padding: "6px 8px", border: "1px solid #ccc", borderRadius: 6, fontSize: 14 };

export default async function LeadsPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const ctx = await requireCurrentTenant();
  const { searchId } = await params;
  const raw = flatten(await searchParams);

  // Confirm the search exists in THIS tenant (also drives the header). If it
  // belongs to another org (or is soft-deleted), this returns null → 404.
  const search = await prisma.search.findFirst({
    where: ctx.where({ id: searchId }),
    select: { id: true, name: true, status: true, leadsFound: true, leadsRequested: true },
  });
  if (!search) notFound();

  // Parse filters; fall back to defaults on invalid querystring.
  const parsed = leadListSchema.safeParse(raw);
  const input = parsed.success ? parsed.data : leadListSchema.parse({});

  const { leads, total, page, pageSize } = await listLeads(prisma, ctx, input, searchId);
  const { totalPages, hasPrev, hasNext, from, to } = paginationInfo(total, page, pageSize);

  const hasFilters = Boolean(input.q) || typeof input.minScore === "number";
  const base = `/searches/${searchId}/leads`;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32, maxWidth: 1100 }}>
      <p style={{ marginBottom: 8 }}>
        <Link href="/searches">← Searches</Link>
      </p>

      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>{search.name}</h1>
        <span style={{ color: statusColor[search.status] ?? "#333", fontWeight: 600 }}>{search.status}</span>
        <span style={{ color: "#666" }}>
          {search.leadsFound} / {search.leadsRequested} leads
        </span>
      </div>

      {/* Filters (plain GET form — resets to page 1 on submit) */}
      <form method="get" action={base} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
        <input name="q" defaultValue={input.q ?? ""} placeholder="Search name or email" style={{ ...field, minWidth: 220 }} />
        <input
          name="minScore"
          type="number"
          min={0}
          max={100}
          defaultValue={typeof input.minScore === "number" ? input.minScore : ""}
          placeholder="Min score"
          style={{ ...field, width: 110 }}
        />
        <select name="sort" defaultValue={input.sort} style={field}>
          <option value="createdAt">Newest</option>
          <option value="leadScore">Score</option>
          <option value="businessName">Business name</option>
        </select>
        <select name="order" defaultValue={input.order} style={field}>
          <option value="desc">Desc</option>
          <option value="asc">Asc</option>
        </select>
        <button type="submit" style={{ ...field, cursor: "pointer", background: "#fff" }}>
          Apply
        </button>
        {hasFilters ? (
          <Link href={base} style={{ ...field, textDecoration: "none", color: "#333" }}>
            Clear
          </Link>
        ) : null}
      </form>

      {leads.length === 0 ? (
        <p style={{ color: "#666" }}>
          {hasFilters ? "No leads match your filters." : "No leads for this search yet."}
        </p>
      ) : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={cell}>Business</th>
                <th style={cell}>Website</th>
                <th style={cell}>Email</th>
                <th style={cell}>Phone</th>
                <th style={cell}>Industry</th>
                <th style={cell}>Size</th>
                <th style={cell}>Score</th>
                <th style={cell}>Quality</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td style={{ ...cell, whiteSpace: "normal" }}>{l.businessName}</td>
                  <td style={cell}>
                    {l.website ? (
                      <a href={l.website} target="_blank" rel="noreferrer">
                        {l.websiteDomain ?? l.website}
                      </a>
                    ) : (
                      l.websiteDomain ?? "—"
                    )}
                  </td>
                  <td style={cell}>{l.email ?? "—"}</td>
                  <td style={cell}>{l.phone ?? "—"}</td>
                  <td style={cell}>{l.industry ?? "—"}</td>
                  <td style={cell}>{l.companySize ?? "—"}</td>
                  <td style={cell}>{l.leadScore ?? "—"}</td>
                  <td style={{ ...cell, color: l.score ? qualityColor[l.score.quality] ?? "#333" : "#999", fontWeight: 600 }}>
                    {l.score?.quality ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, color: "#666" }}>
            <span>
              {from}–{to} of {total}
            </span>
            <span style={{ display: "flex", gap: 12 }}>
              {hasPrev ? (
                <Link href={`${base}${buildQuery(input, page - 1)}`}>← Prev</Link>
              ) : (
                <span style={{ color: "#bbb" }}>← Prev</span>
              )}
              <span>
                Page {page} of {totalPages}
              </span>
              {hasNext ? (
                <Link href={`${base}${buildQuery(input, page + 1)}`}>Next →</Link>
              ) : (
                <span style={{ color: "#bbb" }}>Next →</span>
              )}
            </span>
          </div>
        </>
      )}
    </main>
  );
}
