/**
 * E0x "Set filter" dispatch pins (D115).
 *
 * Every song here is constructed through the *real* decode path -- a real
 * module file through its parser + importer (D94 raw bytes), or native rows
 * through `decodeRawEffect` -- never hand-built
 * `{type:'extEffect', extSubtype:'filterToggle'}` steps (the jt_letgo
 * load-path rule in workspace AGENTS.md).
 *
 * Semantics pinned against libopenmpt `Snd_fx.cpp` `ExtendedMODCommands`
 * case 0x00 (fetched 2026-09-04): `dwFlags.set(CHN_AMIGAFILTER, !(param & 1))`
 * inside a loop over every channel -- E00 (even) = filter ON, E01 (odd) =
 * OFF. Dispatch is profile-gated (`FormatProfile.filterToggleCommand`): MOD
 * and native dispatch; XM (FT2 dummies E0x) and S3M (ST3.21 dummies S0x)
 * do not.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PlaybackEngine,
  buildPlaybackSong,
  type Song as PlaybackSong,
  type PlaybackSongSource,
  type TrackerEntryData,
  type TrackerPattern,
} from '@another-synth/tracker-playback';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { importS3mToTrackerSong } from 'src/audio/tracker/s3m-import';
import { buildSoundtrackerMod, type BuilderCell } from './helpers/mod-builder';
import { buildXm, cell } from './helpers/xm-builder';
import { buildS3m } from './helpers/s3m-builder';

type FilterEvent = { active: boolean; time: number };

function buildEngine(events: FilterEvent[]): PlaybackEngine {
  return new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: vi.fn(),
    scheduledPitchHandler: vi.fn(),
    scheduledVolumeHandler: vi.fn(),
    scheduledFilterHandler: (active: boolean, time: number) => {
      events.push({ active, time });
    },
  } as unknown as ConstructorParameters<typeof PlaybackEngine>[0]);
}

function scheduleAllRows(engine: PlaybackEngine, song: PlaybackSong): void {
  for (const pattern of song.patterns) {
    engine.loadPattern(pattern.id);
    for (let row = 0; row < pattern.length; row += 1) {
      (
        engine as unknown as { scheduleRow: (r: number, t: number) => void }
      ).scheduleRow(row, row);
    }
  }
}

function songFromFile(
  file: TrackerSongFile,
): PlaybackSong {
  const patterns = file.data.patterns as unknown as TrackerPattern[];
  const source: PlaybackSongSource = {
    currentSong: file.data.currentSong,
    ...(file.data.moduleFormat !== undefined
      ? { moduleFormat: file.data.moduleFormat }
      : {}),
    initialSpeed: file.data.initialSpeed ?? 6,
    linearFrequency: file.data.linearFrequency ?? true,
    patterns,
    sequence: file.data.sequence ?? patterns.map((p) => p.id),
    currentPatternId: patterns[0]!.id,
    currentPattern: patterns[0]!,
    defaultPatternRows: patterns[0]!.rows,
    normalizeInstrumentId: (id) => (id ? id : undefined),
  };
  return buildPlaybackSong(source, 'song');
}

/** A 15-sample MOD with E0x rows on channel 0: E00 (on), E01, E00 again. */
function buildFilterMod(): ArrayBuffer {
  const rows: BuilderCell[][] = Array.from(
    { length: 64 },
    () => [undefined, undefined, undefined, undefined] as unknown as BuilderCell[],
  );
  rows[0]![0] = { period: 428, sample: 1, effectCmd: 0x0e, effectParam: 0x00 };
  rows[1]![0] = { effectCmd: 0x0e, effectParam: 0x01 };
  rows[2]![0] = { effectCmd: 0x0e, effectParam: 0x00 };
  return buildSoundtrackerMod({
    samples: [{ lengthBytes: 4, loopStartRaw: 0, loopLengthBytes: 2 }],
    patterns: [rows],
  }).buffer as ArrayBuffer;
}

describe('E0x dispatch through the real MOD decode path', () => {
  it('E00 schedules filter ON, E01 filter OFF, at their row times', () => {
    const file = importModToTrackerSong(buildFilterMod());
    expect(file.data.moduleFormat).toBe('protracker');
    const events: FilterEvent[] = [];
    const engine = buildEngine(events);
    const song = songFromFile(file);
    engine.loadSong(song);
    scheduleAllRows(engine, song);

    expect(events).toEqual([
      { active: true, time: 0 },
      { active: false, time: 1 },
      { active: true, time: 2 },
    ]);
  });

  it('the handler is global: both channels carrying E00 dispatch the same state', () => {
    const rows: BuilderCell[][] = Array.from(
      { length: 64 },
      () => [undefined, undefined, undefined, undefined] as unknown as BuilderCell[],
    );
    rows[0]![0] = { period: 428, sample: 1, effectCmd: 0x0e, effectParam: 0x00 };
    rows[0]![1] = { period: 428, sample: 1, effectCmd: 0x0e, effectParam: 0x00 };
    const buffer = buildSoundtrackerMod({
      samples: [{ lengthBytes: 4, loopStartRaw: 0, loopLengthBytes: 2 }],
      patterns: [rows],
    });
    const file = importModToTrackerSong(buffer.buffer as ArrayBuffer);
    const events: FilterEvent[] = [];
    const engine = buildEngine(events);
    const song = songFromFile(file);
    engine.loadSong(song);
    scheduleAllRows(engine, song);

    expect(events).toEqual([
      { active: true, time: 0 },
      // The E0x cell on channel 1 also dispatches: the handler is global (no
      // track argument), so both cells carry the same state and the second
      // is a no-op re-assert of the same value.
      { active: true, time: 0 },
    ]);
  });
});

describe('native songs dispatch E0x (resolved decision)', () => {
  it('a hand-authored E00 row toggles the filter', () => {
    const entry = (row: number, cmd?: number, param?: number): TrackerEntryData => ({
      row,
      ...(cmd === undefined ? {} : { note: 'C-2' }),
      ...(cmd === undefined ? {} : { instrument: '01' }),
      ...(cmd === undefined ? {} : { effectCommand: cmd }),
      ...(cmd === undefined ? {} : { effectParam: param ?? 0 }),
    });
    const pattern: TrackerPattern = {
      id: 'p0',
      name: 'P0',
      rows: 64,
      tracks: [
        {
          id: 't0',
          name: 'T0',
          entries: [
            entry(0, 0x0e, 0x00),
            entry(1, 0x0e, 0x01),
            entry(2, 0x0e, 0x02),
          ],
        },
      ],
    };
    const source: PlaybackSongSource = {
      currentSong: { title: 'T', author: 'A', bpm: 120 },
      moduleFormat: 'native',
      patterns: [pattern],
      sequence: ['p0'],
      currentPatternId: 'p0',
      currentPattern: pattern,
      defaultPatternRows: 64,
      normalizeInstrumentId: (id) => (id ? id : undefined),
    };
    const events: FilterEvent[] = [];
    const engine = buildEngine(events);
    const song = buildPlaybackSong(source, 'song');
    engine.loadSong(song);
    scheduleAllRows(engine, song);

    // E02 is even like E00: libopenmpt tests only the low bit.
    expect(events).toEqual([
      { active: true, time: 0 },
      { active: false, time: 1 },
      { active: true, time: 2 },
    ]);
  });
});

describe('XM does not dispatch E0x (FT2 dummies it)', () => {
  it('an XM song with E00 cells schedules no filter events', () => {
    const rows = Array.from({ length: 64 }, () =>
      Array.from({ length: 4 }, () => cell(0)),
    );
    rows[0]![0] = cell(49, { instrument: 1, effectType: 0x0e, effectParam: 0x00 });
    rows[1]![0] = cell(0, { effectType: 0x0e, effectParam: 0x01 });
    const buffer = buildXm({
      numChannels: 4,
      patterns: [{ numRows: 64, cells: rows }],
      instruments: [{ samples: [{ frames: [0, 100, -100, 100] }] }],
    });
    const file = importXmToTrackerSong(buffer.buffer as ArrayBuffer);
    const events: FilterEvent[] = [];
    const engine = buildEngine(events);
    const song = songFromFile(file);
    engine.loadSong(song);
    scheduleAllRows(engine, song);

    expect(events).toEqual([]);
  });
});

describe('S3M does not dispatch S00 (ST3.21 dummies it)', () => {
  it('an S3M song with S00 cells schedules no filter events', () => {
    const buffer = buildS3m({
      orders: [0],
      patterns: [
        [
          [
            { note: 4, instrument: 1, effect: 0x13, param: 0x00 }, // S00
            { effect: 0x13, param: 0x01 }, // S01
          ],
        ],
      ],
      instruments: [{ frames: [0, 100, -100, 100], volume: 64, c2spd: 8363 }],
    });
    const file = importS3mToTrackerSong(buffer.buffer);
    const events: FilterEvent[] = [];
    const engine = buildEngine(events);
    const song = songFromFile(file);
    engine.loadSong(song);
    scheduleAllRows(engine, song);

    expect(events).toEqual([]);
  });
});