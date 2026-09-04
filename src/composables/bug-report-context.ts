/**
 * Selection-to-report mapping: pure glue between the pattern editor's
 * selection rectangle and the bug-report builder's order+row positions.
 *
 * The selection lives inside ONE pattern (the edited one). The report's
 * position lines are order+row of the sequence, so the mapping has to name
 * which order plays that pattern. A pattern can sit at several orders, so
 * the caller supplies the order currently playing (only while playback is
 * actually on that pattern); when there is no such order the first sequence
 * occurrence is used — a deterministic, documented choice, not a guess at
 * what the user meant.
 */

import type { BugReportPosition, BugReportSongIdentity } from './bug-report';

/** The subset of TrackerSelectionRect the mapping needs. */
export interface BugReportSelectionRect {
  rowStart: number;
  rowEnd: number;
  trackStart: number;
  trackEnd: number;
}

/**
 * Everything an entry point can pre-fill before the bug-report dialog
 * opens. The same input shape buildBugReport takes, minus the free text
 * (which always starts empty) and the build string (which is always this
 * app's identity).
 */
export interface BugReportPreset {
  songIdentity?: BugReportSongIdentity;
  startPosition?: BugReportPosition;
  endPosition?: BugReportPosition;
  /** 1-based channel numbers, e.g. the selected columns. */
  channels?: number[];
}

/** All order indices (0-based) whose sequence entry plays `patternId`. */
export function ordersForPattern(
  sequence: readonly string[],
  patternId: string | null,
): number[] {
  if (patternId === null) return [];
  const orders: number[] = [];
  sequence.forEach((id, order) => {
    if (id === patternId) orders.push(order);
  });
  return orders;
}

/**
 * The order a selection in `patternId` should be reported against.
 *
 * Prefers `playingOrder` when it actually plays this pattern (that is the
 * instance the user is hearing); otherwise the pattern's first sequence
 * occurrence. Returns null when the pattern is not placed in the sequence
 * at all — an unplaced pattern has no honest order+row position.
 */
export function resolveSelectionOrder(
  sequence: readonly string[],
  patternId: string | null,
  playingOrder: number | null,
): number | null {
  const orders = ordersForPattern(sequence, patternId);
  if (orders.length === 0) return null;
  if (playingOrder !== null && orders.includes(playingOrder)) return playingOrder;
  // orders.length > 0 was checked above; noUncheckedIndexedAccess just
  // cannot see it through the array index.
  return orders[0] ?? null;
}

/**
 * Map a pattern-editor selection to the report's start/end positions, both
 * on the same order (a selection never leaves its pattern). Returns null
 * when there is no selection or the edited pattern is not in the sequence —
 * the caller must not guess a range.
 */
export function selectionToReportRange(input: {
  selectionRect: BugReportSelectionRect | null;
  /** The edited pattern (trackerStore.currentPatternId), or null. */
  patternId: string | null;
  /** The song's order list (trackerStore.sequence). */
  sequence: readonly string[];
  /**
   * The playing order to prefer, only when playback is live on this song;
   * pass null when nothing is playing.
   */
  playingOrder: number | null;
}): { startPosition: BugReportPosition; endPosition: BugReportPosition } | null {
  const { selectionRect, patternId, sequence, playingOrder } = input;
  if (!selectionRect) return null;
  const order = resolveSelectionOrder(sequence, patternId, playingOrder);
  if (order === null) return null;
  const patternIdField = patternId !== null ? { patternId } : {};
  return {
    startPosition: { order, row: selectionRect.rowStart, ...patternIdField },
    endPosition: { order, row: selectionRect.rowEnd, ...patternIdField },
  };
}

/**
 * The report's 1-based channel list for a selection: the selected columns,
 * ascending. The report format's channels are 1-based like the UI's own
 * numbering; the selection's track indices are 0-based.
 */
export function channelsFromSelection(rect: BugReportSelectionRect): number[] {
  const channels: number[] = [];
  for (let track = rect.trackStart; track <= rect.trackEnd; track += 1) {
    channels.push(track + 1);
  }
  return channels;
}
