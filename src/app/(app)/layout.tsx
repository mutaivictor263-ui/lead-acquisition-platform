/**
 * Protected application layout. Any page under the (app) route group requires a
 * signed-in user; unauthenticated requests are redirected to /signin. This is
 * the server-side guard that replaces middleware for Batch 1.
 */
import { requireAuth } from "@/lib/auth/current-user";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAuth(); // redirects to /signin when there is no session
  return children;
}