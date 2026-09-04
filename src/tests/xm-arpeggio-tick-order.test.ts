/**
 * The FT2 arpeggio order, driven end to end through PlaybackEngine.
 *
 * The unit test in reference-effect-audit.test.ts proves the effect processor
 * computes FT2's order. This proves it survives the trip through the importer,
 * the song builder and the engine's tick scheduling and reaches the pitch
 * handler -- the D11 failure mode, where a correct number was routed into a
 * stub and nothing reported it.
 *
 * See PLAN-module-format-support.md D83.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ref } from 'vue';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import { buildXm, cell, emptyCell } from './helpers/xm-builder';

const DEMOS = path.resolve(__dirname, '../../public/demos');

function buildFrom(
  file:
    | ReturnType<typeof importXmToTrackerSong>
    | ReturnType<typeof importModToTrackerSong>,
) {
  const patterns = file.data.patterns;
  const ctx: TrackerSongBuilderContext = {
    currentSong: ref(file.data.currentSong),
    moduleFormat: ref(file.data.moduleFormat!),
    initialSpeed: ref(file.data.initialSpeed ?? 6),
    linearFrequency: ref(file.data.linearFrequency ?? true),
    patterns: ref(patterns),
    sequence: ref(file.data.sequence ?? patterns.map((p) => p.id)),
    currentPatternId: ref(patterns[0]!.id),
    currentPattern: ref(patterns[0]!),
    defaultPatternRows: ref(64),
    instrumentSlots: ref(file.data.instrumentSlots),
    songPatches: ref(file.data.songPatches ?? {}),
    songBank: {} as TrackerSongBuilderContext['songBank'],
    normalizeInstrumentId: (id) => (id ? id : undefined),
    formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
  };
  return useTrackerSongBuilder(ctx).buildPlaybackSong('song');
}

interface Scheduled {
  time: number;
  trackIndex: number;
  frequency: number;
}

/**
 * Schedule `rowCount` rows of the module's first pattern and return, per
 * track, the note-on frequency and every pitch the row scheduled after it.
 */
function pitchesFor(
  file:
    | ReturnType<typeof importXmToTrackerSong>
    | ReturnType<typeof importModToTrackerSong>,
  patternIndex: number,
  rows: number[],
) {
  const song = buildFrom(file);
  const pitches: Scheduled[] = [];
  const notes: Scheduled[] = [];

  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: (event: {
      type: string;
      time: number;
      trackIndex: number;
      frequency?: number;
    }) => {
      if (event.type !== 'noteOn' && event.type !== 'note-on') return;
      if (event.frequency === undefined) return;
      notes.push({
        time: event.time,
        trackIndex: event.trackIndex,
        frequency: event.frequency,
      });
    },
    scheduledPitchHandler: (
      _instrumentId: string,
      _voiceIndex: number,
      frequency: number,
      time: number,
      trackIndex: number,
    ) => {
      pitches.push({ time, trackIndex, frequency });
    },
  } as unknown as ConstructorParameters<typeof PlaybackEngine>[0]);

  engine.loadSong(song);
  engine.loadPattern(song.patterns[patternIndex]!.id);
  for (const row of rows) {
    (
      engine as unknown as { scheduleRow: (r: number, t: number) => void }
    ).scheduleRow(row, row);
  }
  return { notes, pitches };
}

/** Semitones above the row's note-on frequency, rounded. */
function semitoneSteps(notes: Scheduled[], pitches: Scheduled[]): number[] {
  expect(notes.length).toBeGreaterThan(0);
  const base = notes[0]!.frequency;
  expect(base).toBeGreaterThan(0);
  return pitches
    .filter((p) => p.time >= notes[0]!.time)
    .map((p) => Math.round(12 * Math.log2(p.frequency / base)));
}

/**
 * The semitone steps of the one track on the row that is arpeggiating.
 *
 * Real modules sound several channels on the same row, and the engine
 * schedules their commands interleaved, so the arpeggiating channel has to be
 * picked out rather than assumed to be first. It is the only track whose
 * pitches take three distinct values within one row.
 */
function arpeggioTrackSteps({
  notes,
  pitches,
}: {
  notes: Scheduled[];
  pitches: Scheduled[];
}): number[] {
  const byTrack = new Map<number, Scheduled[]>();
  for (const p of pitches) {
    const list = byTrack.get(p.trackIndex) ?? [];
    list.push(p);
    byTrack.set(p.trackIndex, list);
  }

  const candidates = [...byTrack.entries()].filter(
    ([, list]) =>
      new Set(list.map((p) => Math.round(p.frequency * 100))).size >= 3,
  );
  expect(candidates).toHaveLength(1);

  const [trackIndex, list] = candidates[0]!;
  const note = notes.find((n) => n.trackIndex === trackIndex);
  expect(note).toBeDefined();

  return [...list]
    .sort((a, b) => a.time - b.time)
    .map((p) => Math.round(12 * Math.log2(p.frequency / note!.frequency)));
}

describe('an XM arpeggio reaches the scheduler in FT2 order', () => {
  it('schedules base, y, x for a 047 at speed 6', () => {
    // ft2-clone runs `arpeggioTab[song.tick & 31]` with song.tick counting
    // *down* from song.speed, so row tick 1 of a speed-6 row reads tab[5] = 2
    // -> the y nibble. 7608 of the corpus's 12987 XM arpeggios are at speed 6.
    const xm = buildXm({
      numChannels: 1,
      linearFrequency: true,
      speed: 6,
      instruments: [{ samples: [{ frames: [0, 1, 0, -1] }] }],
      patterns: [
        {
          numRows: 2,
          cells: [
            [cell(49, { instrument: 1, effectType: 0x00, effectParam: 0x47 })],
            [emptyCell()],
          ],
        },
      ],
    });
    const { notes, pitches } = pitchesFor(
      importXmToTrackerSong(xm.buffer.slice(0) as ArrayBuffer),
      0,
      [0],
    );

    // Tick 0 restates the base note (FT2 has `dummy` at slot 0 of
    // JumpTab_TickZero), then ticks 1..5 give y, x, base, y, x.
    expect(semitoneSteps(notes, pitches)).toEqual([0, 7, 4, 0, 7, 4]);
  });

  it('drives radix-unreal_superhero.xm, whose opening row is a real 047', () => {
    // Pattern 0, row 0 carries note 73 with `047` -- a major triad -- and the
    // module's header speed is 5, which is one of the speeds where FT2's
    // order is neither ProTracker's nor a simple swap of it:
    //   t=1 -> arpeggioTab[4] = 1 -> x  (the third)
    //   t=2 -> arpeggioTab[3] = 0 -> base
    //   t=3 -> arpeggioTab[2] = 2 -> y  (the fifth)
    //   t=4 -> arpeggioTab[1] = 1 -> x
    // ProTracker at speed 5 would give x, y, base, x. The two agree on the
    // first tick and diverge on the second, so this row pins the table read
    // rather than just the x/y swap.
    const buf = fs.readFileSync(
      path.join(DEMOS, 'ft2', 'radix-unreal_superhero.xm'),
    );
    const file = importXmToTrackerSong(
      buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer,
    );
    expect(arpeggioTrackSteps(pitchesFor(file, 0, [0]))).toEqual([
      0, 4, 0, 7, 4,
    ]);
  });

  it('leaves a real MOD arpeggio in ProTracker order', () => {
    // action1.mod, pattern 0 row 0 channel 0: `037`, a minor triad. Channel 1
    // of the same row carries `F07`, so the row runs seven ticks -- which
    // also exercises the speed the arpeggio is now indexed against.
    //
    // ProTracker's `song->tick % 3` gives base, x, y, base, x, y, base. FT2's
    // table read at speed 7 would give base, base, y, x, base, y, x, so the
    // two disagree from the second tick on; this is the guard that D83
    // changed nothing for the corpus's 5846 MOD arpeggios.
    const buf = fs.readFileSync(path.join(DEMOS, 'amiga', 'action1.mod'));
    const file = importModToTrackerSong(
      buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer,
    );
    expect(arpeggioTrackSteps(pitchesFor(file, 0, [0]))).toEqual([
      0, 3, 7, 0, 3, 7, 0,
    ]);
  });
});
