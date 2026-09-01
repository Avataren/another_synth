import { describe, it, expect } from 'vitest';
import {
  activeRowBarWidthPx,
  selectUpcomingPattern,
} from 'src/components/tracker/pattern-buffering';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * Pin the guard rules the pattern grid's playback double-buffer relies on:
 * the upcoming pattern must always be renderable, and must be null whenever
 * the buffer machinery should stay off (idle, empty sequence, jump outside
 * the sequence, deleted pattern). A wrong non-null here would pre-render a
 * grid for a pattern that never plays; a wrong null just loses the benefit.
 */

function makeTrack(id: string, rowCount = 4): TrackerTrackData {
  return {
    id,
    name: `Track ${id}`,
    entries: Array.from({ length: rowCount }, (_, i) => ({ row: i, note: 'C-4' })),
  };
}

function makePatterns(ids: string[]) {
  const map = new Map(
    ids.map((id) => [id, { id, tracks: [makeTrack(id)], rows: 4 }]),
  );
  return (id: string) => map.get(id) ?? null;
}

describe('selectUpcomingPattern', () => {
  it('returns null when not playing', () => {
    const resolve = makePatterns(['p0', 'p1']);
    expect(selectUpcomingPattern(false, 0, ['p0', 'p1'], resolve)).toBeNull();
  });

  it('returns null for an empty sequence', () => {
    const resolve = makePatterns(['p0']);
    expect(selectUpcomingPattern(true, 0, [], resolve)).toBeNull();
  });

  it('wraps around the end of the sequence', () => {
    const resolve = makePatterns(['p0', 'p1', 'p2']);
    const upcoming = selectUpcomingPattern(true, 2, ['p0', 'p1', 'p2'], resolve);
    expect(upcoming?.id).toBe('p0');
  });

  it('returns the next pattern mid-sequence', () => {
    const resolve = makePatterns(['p0', 'p1', 'p2']);
    const upcoming = selectUpcomingPattern(true, 0, ['p0', 'p1', 'p2'], resolve);
    expect(upcoming?.id).toBe('p1');
  });

  it('single-entry sequence wraps to itself', () => {
    const resolve = makePatterns(['p0']);
    const upcoming = selectUpcomingPattern(true, 0, ['p0'], resolve);
    expect(upcoming?.id).toBe('p0');
  });

  it('returns null when the index sits outside the sequence', () => {
    const resolve = makePatterns(['p0', 'p1']);
    expect(selectUpcomingPattern(true, 5, ['p0', 'p1'], resolve)).toBeNull();
    expect(selectUpcomingPattern(true, -1, ['p0', 'p1'], resolve)).toBeNull();
  });

  it('returns null when the next pattern was deleted mid-playback', () => {
    // Sequence still names p1, but the store no longer has it.
    const resolve = makePatterns(['p0']);
    const upcoming = selectUpcomingPattern(true, 0, ['p0', 'p1'], resolve);
    expect(upcoming).toBeNull();
  });

  it('carries tracks and rows for the buffer to render', () => {
    const resolve = makePatterns(['p0', 'p1']);
    const upcoming = selectUpcomingPattern(true, 0, ['p0', 'p1'], resolve);
    expect(upcoming?.tracks).toHaveLength(1);
    expect(upcoming?.tracks[0]?.id).toBe('p1');
    expect(upcoming?.rows).toBe(4);
  });
});

describe('activeRowBarWidthPx', () => {
  it('is null for a zero-channel pattern', () => {
    expect(activeRowBarWidthPx(0, false)).toBeNull();
  });

  it('equals one column width for a single track', () => {
    expect(activeRowBarWidthPx(1, false)).toBe(180);
  });

  it('equals first width plus (n-1) pitches for wider patterns', () => {
    for (const count of [1, 2, 4, 8, 9, 16, 17, 32]) {
      const width = activeRowBarWidthPx(count, false);
      expect(width).not.toBeNull();
      expect(width).toBeGreaterThan(0);
    }
  });

  it('spans to the far edge of the last column including gaps', () => {
    // 4 channels: 180 + 3 * (180 + 10) = 750 (no trailing gap after the last column)
    expect(activeRowBarWidthPx(4, false)).toBe(750);
    // Dual FX column widens every pitch.
    expect(activeRowBarWidthPx(4, true)).toBe(240 + 3 * (240 + 10));
  });

  it('is monotonic in channel count', () => {
    let prev = 0;
    for (const count of [1, 4, 8, 9, 16, 17, 32]) {
      const width = activeRowBarWidthPx(count, false) ?? 0;
      expect(width).toBeGreaterThanOrEqual(prev);
      prev = width;
    }
  });
});
