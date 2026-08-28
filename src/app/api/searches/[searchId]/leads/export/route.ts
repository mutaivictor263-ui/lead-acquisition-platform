/**
 * GET /api/searches/[searchId]/leads/export — CSV download of a search's leads.
 *
 * Uses the SAME data path as the Leads UI (listLeads → buildLeadQuery), so the
 * export can never include another org's leads, another search's leads,
 * soft-deleted leads, or leads excluded by the active q/minScore/sort/order
 * filters. The search is also verified to belong to the caller's org before any
 * data is read.
 *
 * MVP safety cap: EXPORT_MAX_ROWS. The export is NEVER silently truncated — if a
 * search has more matching leads than the cap, the request fails with 413 and a
 * clear message rather than returning a partial file.
 */

import { NextResponse, type NextRequest } from "next/server";

import { currentUser } from "@/lib/auth/current-user";
import { requireTenant } from "@/lib/tenant/scope";
import { prisma } from "@/lib/db/client";
import { leadListSchema } from "@/lib/validation/search";
import { listLeads } from "@/lib/leads/list";
import { leadsToCsv, csvFilename, EXPORT_MAX_ROWS } from "@/lib/leads/csv";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ searchId: string }> },
) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const membership = await prisma.membership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  });
  if (!membership) {
    return NextResponse.json({ error: "No organization" }, { status: 403 });
  }

  const ctx = await requireTenant(prisma, user.id, membership.organizationId);
  const { searchId } = await context.params;

  // Confirm the search belongs to this tenant (also gives us its name).
  const search = await prisma.search.findFirst({
    where: ctx.where({ id: searchId }),
    select: { id: true, name: true },
  });
  if (!search) {
    return NextResponse.json({ error: "Search not found" }, { status: 404 });
  }

  // Parse the same filters the UI uses; fall back to defaults on bad input.
  const parsed = leadListSchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  const input = parsed.success ? parsed.data : leadListSchema.parse({});

  // Guardrail: count matching leads through the same scoped query and refuse
  // (don't truncate) if it exceeds the cap. Then fetch exactly that many.
  const probe = await listLeads(prisma, ctx, { ...input, page: 1, pageSize: 1 }, searchId);
  if (probe.total > EXPORT_MAX_ROWS) {
    return NextResponse.json(
      {
        error: "Export too large",
        message: `This export has ${probe.total} leads, above the ${EXPORT_MAX_ROWS} limit. Narrow the filters and try again.`,
        total: probe.total,
        limit: EXPORT_MAX_ROWS,
      },
      { status: 413 },
    );
  }

  const { leads } = await listLeads(
    prisma,
    ctx,
    { ...input, page: 1, pageSize: EXPORT_MAX_ROWS },
    searchId,
  );

  const csv = leadsToCsv(leads);
  const filename = csvFilename(search.name);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}