import { describe, it, expect } from 'vitest';
import {
  channelsFromSelection,
  ordersForPattern,
  resolveSelectionOrder,
  selectionToReportRange,
} from '../composables/bug-report-context';

/**
 * A sequence where pattern "P" sits at orders 2 and 5 — the multi-instance
 * case the order resolution rules exist for.
 */
const SEQUENCE = ['A', 'B', 'P', 'C', 'D', 'P'];

const RECT = { rowStart: 10, rowEnd: 20, trackStart: 1, trackEnd: 3 };

describe('ordersForPattern', () => {
  it('finds every sequence occurrence of a pattern, ascending', () => {
    expect(ordersForPattern(SEQUENCE, 'P')).toEqual([2, 5]);
  });

  it('returns a single occurrence for a pattern placed once', () => {
    expect(ordersForPattern(SEQUENCE, 'B')).toEqual([1]);
  });

  it('returns nothing for a pattern that is not in the sequence', () => {
    expect(ordersForPattern(SEQUENCE, 'Z')).toEqual([]);
  });

  it('returns nothing without a pattern id', () => {
    expect(ordersForPattern(SEQUENCE, null)).toEqual([]);
  });
});

describe('resolveSelectionOrder', () => {
  it('prefers the playing order when it plays the edited pattern', () => {
    expect(resolveSelectionOrder(SEQUENCE, 'P', 5)).toBe(5);
  });

  it('ignores a playing order that plays a different pattern', () => {
    expect(resolveSelectionOrder(SEQUENCE, 'P', 3)).toBe(2);
  });

  it('falls back to the first occurrence when nothing is playing', () => {
    expect(resolveSelectionOrder(SEQUENCE, 'P', null)).toBe(2);
  });

  it('returns null for a pattern missing from the sequence', () => {
    expect(resolveSelectionOrder(SEQUENCE, 'Z', 0)).toBeNull();
    expect(resolveSelectionOrder(SEQUENCE, null, 0)).toBeNull();
  });
});

describe('selectionToReportRange', () => {
  it('maps the selection rows onto the playing order, 0-based', () => {
    const range = selectionToReportRange({
      selectionRect: RECT,
      patternId: 'P',
      sequence: SEQUENCE,
      playingOrder: 5,
    });
    expect(range).not.toBeNull();
    expect(range?.startPosition).toEqual({ order: 5, row: 10, patternId: 'P' });
    expect(range?.endPosition).toEqual({ order: 5, row: 20, patternId: 'P' });
    expect(range?.endPosition.row).toBe(RECT.rowEnd);
  });

  it('uses the first sequence occurrence when the song is not playing', () => {
    const range = selectionToReportRange({
      selectionRect: RECT,
      patternId: 'P',
      sequence: SEQUENCE,
      playingOrder: null,
    });
    expect(range?.startPosition.order).toBe(2);
    expect(range?.endPosition.order).toBe(2);
  });

  it('returns null with no selection — no range may be guessed', () => {
    expect(
      selectionToReportRange({
        selectionRect: null,
        patternId: 'P',
        sequence: SEQUENCE,
        playingOrder: 2,
      }),
    ).toBeNull();
  });

  it('returns null when the edited pattern is not placed in the sequence', () => {
    expect(
      selectionToReportRange({
        selectionRect: RECT,
        patternId: 'Z',
        sequence: SEQUENCE,
        playingOrder: 2,
      }),
    ).toBeNull();
  });
});

describe('channelsFromSelection', () => {
  it('reports the selected columns 1-based and ascending', () => {
    expect(channelsFromSelection({ rowStart: 0, rowEnd: 4, trackStart: 2, trackEnd: 4 })).toEqual([
      3, 4, 5,
    ]);
  });

  it('maps a single-column selection to a single channel', () => {
    expect(channelsFromSelection({ rowStart: 0, rowEnd: 0, trackStart: 0, trackEnd: 0 })).toEqual([
      1,
    ]);
  });
});
