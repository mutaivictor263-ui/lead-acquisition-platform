import Link from "next/link";

import { prisma } from "@/lib/db/client";
import { requireCurrentTenant } from "@/lib/auth/current-user";

// searchParams is async in Next 15.
type SearchParams = Promise<{ created?: string; queued?: string }>;

const statusColor: Record<string, string> = {
  PENDING: "#8a6d1f",
  RUNNING: "#1f5f8a",
  COMPLETED: "#1f7a3d",
  PARTIAL: "#8a6d1f",
  FAILED: "#8a1f2b",
};

function fmt(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export default async function SearchesPage({ searchParams }: { searchParams: SearchParams }) {
  const ctx = await requireCurrentTenant();
  const sp = await searchParams;

  const searches = await prisma.search.findMany({
    where: ctx.where(),
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      name: true,
      category: true,
      city: true,
      region: true,
      country: true,
      leadsRequested: true,
      leadsFound: true,
      status: true,
      createdAt: true,
    },
  });

  const cell: React.CSSProperties = { padding: "8px 10px", borderBottom: "1px solid #eee", textAlign: "left" };

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32, maxWidth: 900 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1>Searches</h1>
        <Link
          href="/searches/new"
          style={{ padding: "8px 14px", border: "1px solid #ccc", borderRadius: 6, textDecoration: "none" }}
        >
          + New search
        </Link>
      </div>

      {sp.created ? (
        <p
          style={{
            background: sp.queued === "0" ? "#fff8e1" : "#e9f7ef",
            border: `1px solid ${sp.queued === "0" ? "#f0d98c" : "#b7e0c4"}`,
            padding: "8px 12px",
            borderRadius: 6,
            marginBottom: 16,
          }}
        >
          {sp.queued === "0"
            ? "Search created, but it couldn't be queued for processing. Is Redis running and the worker started (npm run worker)? It will stay PENDING until queued."
            : "Search created and queued. Leads appear as the discovery worker processes it."}
        </p>
      ) : null}

      {searches.length === 0 ? (
        <p style={{ color: "#666" }}>No searches yet. Create your first one to start finding leads.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={cell}>Name</th>
              <th style={cell}>Location</th>
              <th style={cell}>Status</th>
              <th style={cell}>Leads</th>
              <th style={cell}>Created</th>
            </tr>
          </thead>
          <tbody>
            {searches.map((s) => (
              <tr key={s.id}>
                <td style={cell}>
                  <Link href={`/searches/${s.id}/leads`}>{s.name}</Link>
                </td>
                <td style={cell}>{[s.city, s.region, s.country].filter(Boolean).join(", ") || "—"}</td>
                <td style={{ ...cell, color: statusColor[s.status] ?? "#333", fontWeight: 600 }}>{s.status}</td>
                <td style={cell}>
                  {s.leadsFound} / {s.leadsRequested}
                </td>
                <td style={cell}>{fmt(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
