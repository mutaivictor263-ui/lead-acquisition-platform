"use client";

/**
 * Invisible companion for the searches list. While `active` is true (the list
 * has at least one PENDING/RUNNING search), it calls router.refresh() every 5s
 * so the dynamic Server Component re-queries Prisma and statuses update in place.
 * When the last active search reaches a terminal state, the parent re-renders
 * with active=false and the interval is torn down — polling stops on its own.
 *
 * router.refresh() re-fetches the current route's Server Component from the
 * server (bypassing the client Router Cache); it does not reload the page.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const POLL_INTERVAL_MS = 5000;

export function StatusPoller({ active }: { active: boolean }): null {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active, router]);

  return null;
}
