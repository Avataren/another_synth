import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import type { Song, Step } from '@another-synth/tracker-playback';

/**
 * How the engine walks the order list.
 *
 * Two things here are easy to get wrong in a way that stays hidden on the
 * usual module, where every pattern is 64 rows:
 *
 *  - The row cursor counts monotonically and is folded into a row with
 *    `% length`. Carrying it across a pattern boundary only lands on row 0
 *    when the two patterns happen to be the same length.
 *  - E6x is a countdown, not a tally. Counting upward toward a target either
 *    never jumps or never stops, and with one loop in the song it is the
 *    former, which is silent -- the section simply plays once.
 *
 * Both were live in xyce-dans_la_rue.xm: a 96-row pattern at order 36 left the
 * cursor at 96, so order 37's 64-row pattern played row 0 and then jumped
 * straight to row 33 (97 % 64), and its E60/E61 section never repeated.
 */

interface Recorded {
  row: number;
  sequenceIndex?: number;
  patternId?: string;
}

function stepWith(row: number, effect: Step['effect']): Step {
  return { row, effect } as Step;
}

function makeSong(
  patterns: Array<{ id: string; length: number; steps?: Step[] }>,
  sequence: string[],
): Song {
  return {
    title: 'T',
    author: 'A',
    bpm: 125,
    moduleFormat: 'xm',
    patterns: patterns.map((p) => ({
      id: p.id,
      length: p.length,
      tracks: [{ id: `${p.id}-t0`, steps: p.steps ?? [] }],
    })),
    sequence,
  };
}

/**
 * Drive the engine's lookahead scheduler against a synthetic clock and collect
 * every row it schedules, in order.
 *
 * The engine prunes its own position log as time passes, so entries are taken
 * by identity as they appear rather than read off at the end.
 */
function walk(song: Song, maxRows = 2000): Recorded[] {
  let now = 0;
  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: {
      get currentTime() {
        return now;
      },
    } as unknown as AudioContext,
    scheduledNoteHandler: vi.fn(),
  });
  engine.loadSong(song);
  engine.setLoopSong(false);

  const internals = engine as unknown as {
    scheduleAhead: () => void;
    state: string;
    scheduledPositions: Recorded[];
  };
  internals.state = 'playing';

  const seen = new Set<object>();
  const rows: Recorded[] = [];
  for (let i = 0; i < 40000 && internals.state === 'playing'; i++) {
    internals.scheduleAhead();
    for (const pos of internals.scheduledPositions) {
      if (seen.has(pos)) continue;
      seen.add(pos);
      rows.push(pos);
      if (rows.length >= maxRows) return rows;
    }
    now += 0.05;
  }
  return rows;
}

const rowsOf = (walked: Recorded[], sequenceIndex: number) =>
  walked.filter((r) => r.sequenceIndex === sequenceIndex).map((r) => r.row);

describe('patterns of differing length', () => {
  it('starts the next pattern at row 0 after a longer one', () => {
    // 96 then 64, the xyce case. Carrying the cursor gives 97 % 64 = 33.
    const walked = walk(
      makeSong(
        [
          { id: 'long', length: 96 },
          { id: 'short', length: 64 },
        ],
        ['long', 'short'],
      ),
    );

    expect(rowsOf(walked, 0)).toEqual([...Array(96).keys()]);
    expect(rowsOf(walked, 1)).toEqual([...Array(64).keys()]);
  });

  it('starts the next pattern at row 0 after a shorter one', () => {
    const walked = walk(
      makeSong(
        [
          { id: 'short', length: 32 },
          { id: 'long', length: 64 },
        ],
        ['short', 'long'],
      ),
    );

    expect(rowsOf(walked, 0)).toEqual([...Array(32).keys()]);
    expect(rowsOf(walked, 1)).toEqual([...Array(64).keys()]);
  });

  it('keeps every pattern whole across a run of mixed lengths', () => {
    const walked = walk(
      makeSong(
        [
          { id: 'a', length: 16 },
          { id: 'b', length: 48 },
          { id: 'c', length: 32 },
        ],
        ['a', 'b', 'c', 'a'],
      ),
    );

    expect(rowsOf(walked, 0)).toEqual([...Array(16).keys()]);
    expect(rowsOf(walked, 1)).toEqual([...Array(48).keys()]);
    expect(rowsOf(walked, 2)).toEqual([...Array(32).keys()]);
    expect(rowsOf(walked, 3)).toEqual([...Array(16).keys()]);
  });
});

const patLoop = (paramY: number): Step['effect'] =>
  ({
    type: 'extEffect',
    paramX: 6,
    paramY,
    extSubtype: 'patLoop',
  }) as Step['effect'];

describe('E6x pattern loop', () => {
  it('replays the marked section once for E61', () => {
    // E60 at row 0 marks the start, E61 at row 3 asks for one repeat, so rows
    // 0-3 play twice before the pattern continues.
    const walked = walk(
      makeSong(
        [
          {
            id: 'p',
            length: 8,
            steps: [stepWith(0, patLoop(0)), stepWith(3, patLoop(1))],
          },
        ],
        ['p'],
      ),
    );

    expect(rowsOf(walked, 0)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('repeats as many times as the parameter asks', () => {
    const walked = walk(
      makeSong(
        [
          {
            id: 'p',
            length: 6,
            steps: [stepWith(1, patLoop(0)), stepWith(2, patLoop(3))],
          },
        ],
        ['p'],
      ),
    );

    // Rows 1-2 play once plus three repeats.
    expect(rowsOf(walked, 0)).toEqual([
      0, 1, 2, 1, 2, 1, 2, 1, 2, 3, 4, 5,
    ]);
  });

  it('loops from the top when no E60 marked a start', () => {
    const walked = walk(
      makeSong([{ id: 'p', length: 4, steps: [stepWith(2, patLoop(1))] }], [
        'p',
      ]),
    );

    expect(rowsOf(walked, 0)).toEqual([0, 1, 2, 0, 1, 2, 3]);
  });

  it('terminates rather than looping the section forever', () => {
    // The failure mode of decrementing in the wrong place: the jump lands back
    // on the E6x row with the counter re-armed.
    const walked = walk(
      makeSong(
        [
          {
            id: 'p',
            length: 8,
            steps: [stepWith(0, patLoop(0)), stepWith(7, patLoop(2))],
          },
          { id: 'q', length: 4 },
        ],
        ['p', 'q'],
      ),
      500,
    );

    expect(rowsOf(walked, 1)).toEqual([0, 1, 2, 3]);
  });
});

describe('global volume across a stop', () => {
  it('is back at full when playback is reset', () => {
    // Gxx is effect state. A song stopped partway through a fade used to start
    // again at whatever volume the fade had reached, with nothing to restore it
    // until the next Gxx -- audibly, pressing play gave near-silence.
    const engine = new PlaybackEngine({
      scheduler: { start: vi.fn(), stop: vi.fn() },
      audioContext: { currentTime: 0 } as unknown as AudioContext,
      scheduledNoteHandler: vi.fn(),
    });
    const internals = engine as unknown as {
      globalVolume: number;
      resetEffectStates: () => void;
    };

    internals.globalVolume = 0;
    internals.resetEffectStates();

    expect(internals.globalVolume).toBe(1);
  });

  it('is restored by stop()', () => {
    const engine = new PlaybackEngine({
      scheduler: { start: vi.fn(), stop: vi.fn() },
      audioContext: { currentTime: 0 } as unknown as AudioContext,
      scheduledNoteHandler: vi.fn(),
    });
    engine.loadSong(makeSong([{ id: 'p', length: 4 }], ['p']));
    const internals = engine as unknown as { globalVolume: number };

    internals.globalVolume = 0.05;
    engine.stop();

    expect(internals.globalVolume).toBe(1);
  });
});
