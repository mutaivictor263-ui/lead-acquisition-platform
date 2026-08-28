/**
 * Pagination math for the leads results page. Pure and dependency-free so it's
 * trivially unit-testable and safe to use in a Server Component.
 */

export interface PaginationInfo {
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** 1-based index of the first row on this page (0 when there are no rows). */
  from: number;
  /** 1-based index of the last row on this page. */
  to: number;
}

export function paginationInfo(total: number, page: number, pageSize: number): PaginationInfo {
  const size = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const from = total === 0 ? 0 : (clampedPage - 1) * size + 1;
  const to = Math.min(clampedPage * size, total);
  return {
    totalPages,
    hasPrev: clampedPage > 1,
    hasNext: clampedPage < totalPages,
    from,
    to,
  };
}