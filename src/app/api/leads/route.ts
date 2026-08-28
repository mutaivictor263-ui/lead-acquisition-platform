/**
 * GET /api/leads — the authenticated, tenant-scoped Results API (§28).
 *
 *   ?searchId=…   restrict to one search (optional)
 *   ?q= &status= &category= &country= &hasEmail= &hasWebsite= &hasPhone=
 *   &minScore= &sort=(createdAt|leadScore|businessName) &order=(asc|desc)
 *   &page= &pageSize=
 *
 * Auth uses the project's existing approach (currentUser + requireTenant). A lead
 * from another organization can never be returned: the WHERE is built through the
 * tenant context, which injects organizationId + deletedAt: null.
 */

import { NextResponse, type NextRequest } from "next/server";

import { currentUser } from "@/lib/auth/current-user";
import { requireTenant } from "@/lib/tenant/scope";
import { prisma } from "@/lib/db/client";
import { leadsQuerySchema, listLeads } from "@/lib/leads/list";

export async function GET(request: NextRequest) {
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Resolve the caller's (personal) organization — same resolution the page
  // helpers use, but returning JSON instead of redirecting.
  const membership = await prisma.membership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  });
  if (!membership) {
    return NextResponse.json({ error: "No organization" }, { status: 403 });
  }

  const ctx = await requireTenant(prisma, user.id, membership.organizationId);

  const parsed = leadsQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { searchId, ...list } = parsed.data;
  const result = await listLeads(prisma, ctx, list, searchId);

  return NextResponse.json(result);
}