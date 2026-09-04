import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import { buildXm, cell, emptyCell } from './helpers/xm-builder';
import { songFromImport } from './helpers/imported-song';

/**
 * A set-volume row survives even when no row in the pattern names an
 * instrument.
 *
 * The builder's `ctx.instrumentId` remembers only what *this pattern* has
 * played, and a row that merely sets a volume carries no instrument number of
 * its own. A pattern whose every instrument-bearing row is a tone portamento
 * therefore never sets it -- tone porta must not stamp the channel's
 * instrument (D55, D77) -- so every volume row in that pattern was dropped
 * outright while the note rows survived on their own note data.
 *
 * radix_-_yuki_satellites.xm is the case that exposed it: its opening bassline
 * is a gated `v00`/note pair every few rows, and the second pattern is the
 * first whose rows are all tone portamento. The gating vanished and the line
 * played on at full level -- reported as the second pattern "almost playing
 * the plain samples" where the first sounded right. 22 of the 61 demo modules
 * were losing rows this way.
 *
 * The engine keeps its own per-track instrument across patterns and resolves
 * these rows there, which is the same reason note-offs are kept (D64).
 */

describe('a volume row in a pattern that never names an instrument', () => {
  /**
   * Two patterns, identical but for the first row: pattern 0 opens with a
   * plain note (which names the instrument), pattern 1 opens with a tone
   * portamento (which must not). Both then set volume 0 on row 2.
   */
  const song = () => {
    const rows = (openWithPorta: boolean) => [
      // F-5, instrument 1. `3xx` on the second pattern's opening row.
      [
        cell(66, {
          instrument: 1,
          ...(openWithPorta ? { effectType: 0x3, effectParam: 0 } : {}),
        }),
      ],
      [emptyCell()],
      // Volume column 0x10 == "set volume 0". No note, no instrument.
      [cell(0, { volumeColumn: 0x10 })],
      [emptyCell()],
    ];
    const xm = buildXm({
      numChannels: 1,
      linearFrequency: true,
      speed: 6,
      orders: [0, 1],
      songLength: 2,
      instruments: [{ samples: [{ frames: [0, 1, 0, -1] }] }],
      patterns: [
        { numRows: 4, cells: rows(false) },
        { numRows: 4, cells: rows(true) },
      ],
    });
    return songFromImport(
      importXmToTrackerSong(xm.buffer.slice(0) as ArrayBuffer),
    );
  };

  it('is kept when an earlier row in the pattern named the instrument', () => {
    const built = song();
    const steps = built.patterns[0]!.tracks[0]!.steps;
    expect(steps.find((s) => s.row === 2)?.velocity).toBe(0);
  });

  it('is kept when the pattern names no instrument at all', () => {
    const built = song();
    const steps = built.patterns[1]!.tracks[0]!.steps;
    // Nothing in this pattern can name the instrument, because its only
    // instrument-bearing row is a tone portamento.
    expect(steps.every((s) => s.instrumentId === '')).toBe(true);
    expect(steps.find((s) => s.row === 2)?.velocity).toBe(0);
  });
});

describe('radix_-_yuki_satellites.xm plays its second pattern like its first', () => {
  /** Every volume scheduled on track 0 while playing one order. */
  const volumesForOrder = (order: number) => {
    const buf = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../public/demos/ft2/radix_-_yuki_satellites.xm',
      ),
    );
    const built = songFromImport(
      importXmToTrackerSong(
        buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer,
      ),
    );
    const volumes: number[] = [];
    const engine = new PlaybackEngine({
      scheduler: { start: vi.fn(), stop: vi.fn() },
      audioContext: { currentTime: 0 } as unknown as AudioContext,
      scheduledNoteHandler: () => {},
      scheduledVolumeHandler: (_i, _v, volume, _t, trackIndex) => {
        if (trackIndex === 0) volumes.push(volume);
      },
    });
    engine.loadSong(built);
    // Walk the orders in sequence: the engine carries the channel's instrument
    // across patterns, which is what resolves the second pattern's rows.
    const internals = engine as unknown as {
      scheduleRow: (row: number, time: number) => void;
    };
    for (let o = 0; o <= order; o++) {
      const pattern = built.patterns.find((p) => p.id === built.sequence![o]!)!;
      engine.loadPattern(pattern.id);
      volumes.length = 0;
      for (let row = 0; row < (pattern.length ?? 64); row++) {
        internals.scheduleRow(row, 0);
      }
    }
    return volumes;
  };

  it('gates the bassline to silence between notes in both patterns', () => {
    const first = volumesForOrder(0);
    const second = volumesForOrder(1);
    // The `v00` rows are the gating. Losing them left the line sustaining.
    expect(first.filter((v) => v === 0).length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });
});
