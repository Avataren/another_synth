/**
 * The run of page numbers a pager shows at once.
 *
 * Instrument slots cover XM's full 128 instruments, which is 26 pages -- far
 * too many to lay out beside the panel title. The pager shows a window that
 * slides with the current page instead.
 *
 * The behaviour worth pinning is at the ends: the window stays the same size
 * everywhere, sitting flush against the first or last page rather than
 * running past it, so the strip never changes width as you page through.
 */
export function visiblePageWindow(
  currentPage: number,
  totalPages: number,
  windowSize: number,
): number[] {
  if (totalPages <= 0 || windowSize <= 0) return [];

  const count = Math.min(windowSize, totalPages);
  const centred = currentPage - Math.floor(count / 2);
  const start = Math.max(0, Math.min(centred, totalPages - count));
  return Array.from({ length: count }, (_, i) => start + i);
}
