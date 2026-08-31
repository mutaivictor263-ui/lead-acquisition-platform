/**
 * Presentation helper for the leads page: turns the data-layer SearchProgress
 * into a compact human label. Kept here (UI layer) so src/lib/leads/list.ts
 * stays focused on data access and isn't coupled to display wording.
 *
 * FAILED never reads "Ready": a failed discovery shows a failed label even when
 * every lead that was created has since been scored.
 */

import type { SearchProgress } from "@/lib/leads/list";

const TERMINAL = new Set(["COMPLETED", "PARTIAL", "FAILED"]);

export function progressLabel(progress: SearchProgress): string {
  const { total, scored, done, searchStatus } = progress;
  const terminal = TERMINAL.has(searchStatus);

  if (searchStatus === "FAILED") {
    // Never "Ready". Fully scored (or zero leads) → discovery-failed summary;
    // otherwise show how far scoring got.
    return done
      ? `Discovery failed — ${total} leads processed`
      : `Failed — ${scored}/${total} scored`;
  }

  if (done) return "Ready"; // terminal COMPLETED/PARTIAL, fully scored (incl. total 0)

  // Not done: either pre-terminal (discovery still running) or scoring lagging.
  return terminal ? `Processing ${scored}/${total} scored` : "Processing…";
}