import { describe, it, expect } from "vitest";

import { paginationInfo } from "./pagination";

describe("paginationInfo", () => {
  it("handles an empty result set", () => {
    expect(paginationInfo(0, 1, 25)).toEqual({
      totalPages: 1,
      hasPrev: false,
      hasNext: false,
      from: 0,
      to: 0,
    });
  });

  it("computes pages and range on the first page", () => {
    expect(paginationInfo(50, 1, 25)).toEqual({
      totalPages: 2,
      hasPrev: false,
      hasNext: true,
      from: 1,
      to: 25,
    });
  });

  it("computes range on the last page", () => {
    expect(paginationInfo(51, 3, 25)).toEqual({
      totalPages: 3,
      hasPrev: true,
      hasNext: false,
      from: 51,
      to: 51,
    });
  });

  it("clamps an out-of-range page", () => {
    const info = paginationInfo(10, 99, 25);
    expect(info.totalPages).toBe(1);
    expect(info.hasNext).toBe(false);
    expect(info.to).toBe(10);
  });

  it("treats a single full page as having no next", () => {
    expect(paginationInfo(25, 1, 25)).toMatchObject({ totalPages: 1, hasNext: false, from: 1, to: 25 });
  });
});