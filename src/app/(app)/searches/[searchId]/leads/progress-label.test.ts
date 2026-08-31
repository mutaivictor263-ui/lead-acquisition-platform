import { describe, it, expect } from "vitest";

import { progressLabel } from "./progress-label";
import type { SearchProgress } from "@/lib/leads/list";

function progress(p: Partial<SearchProgress> & { searchStatus: string }): SearchProgress {
  const total = p.total ?? 0;
  const scored = p.scored ?? 0;
  const terminal = ["COMPLETED", "PARTIAL", "FAILED"].includes(p.searchStatus);
  const done = p.done ?? (terminal && (total === 0 || scored >= total));
  return { total, scored, done, searchStatus: p.searchStatus };
}

describe("progressLabel", () => {
  it("PENDING → Processing…", () => {
    expect(progressLabel(progress({ searchStatus: "PENDING", total: 0, scored: 0 }))).toBe("Processing…");
  });

  it("RUNNING → Processing…", () => {
    expect(progressLabel(progress({ searchStatus: "RUNNING", total: 0, scored: 0 }))).toBe("Processing…");
  });

  it("COMPLETED with scored < total → Processing X/Y scored", () => {
    expect(progressLabel(progress({ searchStatus: "COMPLETED", total: 25, scored: 20 }))).toBe(
      "Processing 20/25 scored",
    );
  });

  it("PARTIAL with scored < total → Processing X/Y scored", () => {
    expect(progressLabel(progress({ searchStatus: "PARTIAL", total: 10, scored: 4 }))).toBe(
      "Processing 4/10 scored",
    );
  });

  it("COMPLETED fully scored → Ready", () => {
    expect(progressLabel(progress({ searchStatus: "COMPLETED", total: 25, scored: 25 }))).toBe("Ready");
  });

  it("PARTIAL fully scored → Ready", () => {
    expect(progressLabel(progress({ searchStatus: "PARTIAL", total: 8, scored: 8 }))).toBe("Ready");
  });

  it("FAILED with scored < total → Failed — X/Y scored", () => {
    expect(progressLabel(progress({ searchStatus: "FAILED", total: 5, scored: 3 }))).toBe("Failed — 3/5 scored");
  });

  it("FAILED fully scored → Discovery failed — X leads processed (never Ready)", () => {
    const label = progressLabel(progress({ searchStatus: "FAILED", total: 5, scored: 5 }));
    expect(label).toBe("Discovery failed — 5 leads processed");
    expect(label).not.toContain("Ready");
  });

  // ── terminal zero-lead cases ──────────────────────────────────────────────
  it("COMPLETED with total 0 → Ready", () => {
    expect(progressLabel(progress({ searchStatus: "COMPLETED", total: 0, scored: 0 }))).toBe("Ready");
  });

  it("PARTIAL with total 0 → Ready", () => {
    expect(progressLabel(progress({ searchStatus: "PARTIAL", total: 0, scored: 0 }))).toBe("Ready");
  });

  it("FAILED with total 0 → Discovery failed — 0 leads processed", () => {
    expect(progressLabel(progress({ searchStatus: "FAILED", total: 0, scored: 0 }))).toBe(
      "Discovery failed — 0 leads processed",
    );
  });
});