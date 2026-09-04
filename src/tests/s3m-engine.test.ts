/**
 * P5 -- S3M engine-level pins. The D59 lesson: per-file flag data must be
 * pinned at the ENGINE, through the real builder -- note frequencies resolve
 * correctly at import either way; only the effect arithmetic is wrong when
 * the flag is lost at any layer. Also pins the S3M fine-portamento high
 * parameters (EFx/FFx) and the header global volume at the engine boundary.
 */

import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { importS3mToTrackerSong } from '../audio/tracker/s3m-import';
import { buildS3m } from './helpers/s3m-builder';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import {
  PlaybackEngine,
} from '@another-synth/tracker-playback';
import {
  createS3mPitchModel,
  s3mPeriodForNote,
} from '@another-synth/tracker-playback';

/** The same rig raw-effect-bytes.test.ts uses, trimmed to what S3M needs. */
function makeBuilderContext(file: ReturnType<typeof importS3mToTrackerSong>) {
  const patterns = file.data.patterns;
  const context: TrackerSongBuilderContext = {
    currentSong: ref(file.data.currentSong),
    moduleFormat: ref(file.data.moduleFormat!),
    initialSpeed: ref(file.data.initialSpeed ?? 6),
    linearFrequency: ref(file.data.linearFrequency ?? true),
    amigaLimits: ref(file.data.amigaLimits ?? false),
    initialGlobalVolume: ref(file.data.initialGlobalVolume ?? 1),
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
  return useTrackerSongBuilder(context);
}

function makeEngine(log: string[]) {
  return new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: (e: unknown) => log.push(`note:${JSON.stringify(e)}`),
    scheduledPitchHandler: (...args: unknown[]) =>
      log.push(`pitch:${JSON.stringify(args)}`),
    scheduledVolumeHandler: () => log.push('volume'),
    scheduledPanHandler: () => log.push('pan'),
    scheduledSampleOffsetHandler: () => log.push('offset'),
    scheduledEnvelopePositionHandler: () => log.push('envpos'),
    scheduledAllNotesOffHandler: () => log.push('alloff'),
    scheduledGlobalVolumeHandler: (gain: number) =>
      log.push(`globalvol:${gain}`),
    scheduledRetriggerHandler: () => log.push('retrig'),
    scheduledMacroHandler: () => log.push('macro'),
    scheduledAutomationHandler: (e: unknown) => log.push(`auto:${JSON.stringify(e)}`),
    positionCommandHandler: (e: unknown) => log.push(`pos:${JSON.stringify(e)}`),
  } as unknown as ConstructorParameters<typeof PlaybackEngine>[0]);
}

function pitchValues(log: string[]): number[] {
  return log
    .filter((l) => l.startsWith('pitch:'))
    .map((l) => {
      // scheduledPitchHandler(instrumentId, voiceIndex, frequency, ...)
      const args = JSON.parse(l.slice(6)) as unknown[];
      return args[2] as number;
    });
}

function importS3m(spec: Parameters<typeof buildS3m>[0]) {
  const built = buildS3m(spec);
  return importS3mToTrackerSong(built.buffer.slice(0) as ArrayBuffer);
}

const ONE_PCM_CHANNEL = [0x00];

describe('S3M amiga-limits flag reaches the engine (D59 pin)', () => {
  const spec: Parameters<typeof buildS3m>[0] = {
    flags: 0x10,
    channelSettings: ONE_PCM_CHANNEL,
    orders: [0],
    speed: 6,
    tempo: 125,
    patterns: [
      [
        [{ note: 0x30, instrument: 1, volume: 64 }],
        [{ effect: 0x05, param: 0x60 }],
        [{}],
        [{}],
      ],
    ],
    instruments: [{ frames: [0, 0.25, -0.25, 0] }],
  };

  function scheduleWith(song: ReturnType<typeof importS3m>): string[] {
    const log: string[] = [];
    const engine = makeEngine(log);
    const builder = makeBuilderContext(song);
    engine.loadSong(builder.buildPlaybackSong('song'));
    const pattern = song.data.patterns[0]!;
    engine.loadPattern(pattern.id);
    for (let row = 0; row < pattern.rows; row += 1) {
      (
        engine as unknown as { scheduleRow: (r: number, t: number) => void }
      ).scheduleRow(row, row);
    }
    return log;
  }

  it('a slide away from C-4 clamps at the 3424 period with the flag', () => {
    const song = importS3m(spec);
    expect(song.data.amigaLimits).toBe(true);
    const pitches = pitchValues(scheduleWith(song));
    // C-4 = 261.34 Hz; the slide cannot get past the amiga clamp, so every
    // scheduled pitch stays at the note's frequency.
    expect(pitches.length).toBeGreaterThan(0);
    for (const p of pitches) {
      expect(p).toBeCloseTo(261.336, 1);
    }
  });

  it('the same module without the flag slides below the clamp', () => {
    const song = importS3m({ ...spec, flags: 0 });
    expect(song.data.amigaLimits).toBeUndefined();
    const pitches = pitchValues(scheduleWith(song));
    expect(pitches.length).toBeGreaterThan(0);
    // 6 ticks x 96x4 = 2304 period units past 3424 -> ~156 Hz.
    expect(pitches[pitches.length - 1]!).toBeLessThan(200);
  });
});

describe('S3M fine portamento (EFx/FFx high parameters)', () => {
  function pitchesFor(effectParam: number): number[] {
    const song = importS3m({
      channelSettings: ONE_PCM_CHANNEL,
      orders: [0],
      patterns: [
        [
          [{ note: 0x30, instrument: 1, volume: 64 }],
          [{ effect: 0x05, param: effectParam }],
          [{}],
          [{}],
        ],
      ],
      instruments: [{ frames: [0, 0.25, -0.25, 0] }],
    });
    const log: string[] = [];
    const engine = makeEngine(log);
    const builder = makeBuilderContext(song);
    engine.loadSong(builder.buildPlaybackSong('song'));
    const pattern = song.data.patterns[0]!;
    engine.loadPattern(pattern.id);
    for (let row = 0; row < pattern.rows; row += 1) {
      (
        engine as unknown as { scheduleRow: (r: number, t: number) => void }
      ).scheduleRow(row, row);
    }
    return pitchValues(log);
  }

  it('EF3 is a one-shot 3-unit slide on tick 0, then nothing', () => {
    const pitches = pitchesFor(0xe3);
    // pitches[0] is the C-4 note itself; row 1's EF3 slides once to
    // period 3427 -> 14317056/3427/16 = 260.9 Hz, then holds.
    expect(pitches.length).toBeGreaterThanOrEqual(2);
    for (const p of pitches.slice(1)) {
      expect(p).toBeCloseTo(261.108, 1);
    }
  });

  it('E00 after EF3 re-fires the fine step from memory, it does not fast-slide', () => {
    // The reviewer's case: the fine-slide decision must be made on the
    // RESOLVED parameter (GET_LAST_NFO runs before the fine branches in
    // st3play), so an E00 after EF3 is one more 3-unit step -- not a
    // per-tick slide at the 0xE3 "speed" (227x4 = 908 units/tick).
    const song = importS3m({
      channelSettings: ONE_PCM_CHANNEL,
      orders: [0],
      patterns: [
        [
          [{ note: 0x30, instrument: 1, volume: 64 }],
          [{ effect: 0x05, param: 0xe3 }],
          [{ effect: 0x05, param: 0x00 }], // E00: memory says EF3
          [{}],
        ],
      ],
      instruments: [{ frames: [0, 0.25, -0.25, 0] }],
    });
    const log: string[] = [];
    const engine = makeEngine(log);
    const builder = makeBuilderContext(song);
    engine.loadSong(builder.buildPlaybackSong('song'));
    const pattern = song.data.patterns[0]!;
    engine.loadPattern(pattern.id);
    for (let row = 0; row < pattern.rows; row += 1) {
      (
        engine as unknown as { scheduleRow: (r: number, t: number) => void }
      ).scheduleRow(row, row);
    }
    const pitches = pitchValues(log);
    // Rows 1 and 2 each fire exactly one 3-unit fine step: the scheduled
    // pitches contain the EF3 landing (261.108 Hz at C-4) and the E00
    // memory re-fire (260.879 Hz, one further step) -- and nothing else. A
    // 908-unit/tick slide at the raw 0xE3 "speed" would have collapsed the
    // pitch to ~150 Hz instead.
    expect(pitches.some((p) => Math.abs(p - 261.108) < 0.01)).toBe(true);
    expect(pitches.some((p) => Math.abs(p - 260.879) < 0.01)).toBe(true);
    expect(pitches.every((p) => p > 260)).toBe(true);
  });

  it('FF3 slides four times as far, once', () => {
    const pitches = pitchesFor(0xf3);
    // 3424 + 12 = 3436: 260.5 Hz.
    for (const p of pitches.slice(1)) {
      expect(p).toBeCloseTo(260.424, 1);
    }
  });
});

describe('S3M header global volume reaches the engine', () => {
  it('loads at gv/64 and pushes it through the D72 machinery', () => {
    const song = importS3m({
      globalVolume: 32,
      channelSettings: ONE_PCM_CHANNEL,
      orders: [0],
      patterns: [[[]]],
      instruments: [],
    });
    const log: string[] = [];
    const engine = makeEngine(log);
    const builder = makeBuilderContext(song);
    engine.loadSong(builder.buildPlaybackSong('song'));
    expect(log.filter((l) => l.startsWith('globalvol:'))).toContain('globalvol:0.5');
  });
});

describe('notes above B-6 stay in the period domain', () => {
  /**
   * The reported symptom (Morten, 2026-09-04): the satellite_one.s3m lead on
   * channels 4/5 sounded muffled, with the notes failing to separate and the
   * level sagging. Those channels play in octaves 6 and 7, and the S3M period
   * table stopped at B-6 -- so `frequencyForNote` returned undefined, the
   * note-on cleared `currentPeriod`, and every later tone portamento on the
   * channel fell into the frequency-ratio fallback, which slides several
   * times slower and glided across the following rows instead of landing.
   *
   * Pinned at the engine, because the importer resolves the note either way:
   * only the effect arithmetic downstream was wrong (the D59 lesson).
   */
  function slideFor(note: number): number[] {
    const song = importS3m({
      channelSettings: ONE_PCM_CHANNEL,
      orders: [0],
      patterns: [
        [
          // A plain note-on, then a G02 tone portamento a semitone above it.
          [{ note, instrument: 1, volume: 64 }],
          [{ note: note + 1, effect: 0x07, param: 0x02 }],
          [{}],
          [{}],
        ],
      ],
      instruments: [{ frames: [0, 0.25, -0.25, 0] }],
    });
    const log: string[] = [];
    const engine = makeEngine(log);
    const builder = makeBuilderContext(song);
    engine.loadSong(builder.buildPlaybackSong('song'));
    const pattern = song.data.patterns[0]!;
    engine.loadPattern(pattern.id);
    for (let row = 0; row < pattern.rows; row += 1) {
      (
        engine as unknown as { scheduleRow: (r: number, t: number) => void }
      ).scheduleRow(row, row);
    }
    return pitchValues(log);
  }

  /** Ticks the slide needs before it settles on its target. */
  function ticksToSettle(pitches: number[]): number {
    const target = pitches[pitches.length - 1]!;
    let settled = pitches.length;
    while (settled > 0 && Math.abs(pitches[settled - 1]! - target) < 1e-6) {
      settled -= 1;
    }
    return settled;
  }

  it('the top octaves resolve to a table period, not undefined', () => {
    // 0x60 = C-7 and 0x70 = C-8: both are spellings the octave nibble
    // reaches, and both were undefined while the table held six octaves.
    expect(s3mPeriodForNote(0x60)).toBeDefined();
    expect(s3mPeriodForNote(0x70)).toBeDefined();
  });

  it('a G02 above B-6 lands inside its row, on the table pitch', () => {
    // C-7 (0x60) is one semitone below C#-7 (0x61) and past the old table
    // edge. A period-domain G02 moves 8 period units a tick, so the 24 units
    // between those two entries are covered in 3 ticks -- inside the row's
    // six. The ratio fallback needed nine, gliding a row and a half into the
    // notes that followed, which is what "the notes don't separate" was.
    const pitches = slideFor(0x60);
    expect(ticksToSettle(pitches)).toBeLessThan(6);

    // ...and it settles on the table entry for C#-7, not the equal-tempered
    // frequency the fallback targeted.
    const model = createS3mPitchModel();
    const target = model.frequencyFromPeriod(s3mPeriodForNote(0x61)!);
    expect(pitches[pitches.length - 1]!).toBeCloseTo(target, 4);
  });

  it('G02 moves 8 period units a tick in either octave', () => {
    // The invariant behind both of the above: a period-domain slide steps
    // `param * portamentoUnitScale` = 8 units a tick whatever the octave. It
    // is the *musical* size of that step that differs -- a semitone is 192
    // units at C-4 and only 24 at C-7, which is why the low note is still
    // moving when the row ends and the high one has arrived. The ratio
    // fallback had no such unit at all.
    const model = createS3mPitchModel();
    for (const note of [0x30, 0x60]) {
      const periods = slideFor(note).map((f) =>
        model.rawPeriodFromFrequency(f),
      );
      const steps = periods
        .slice(1)
        .map((p, i) => periods[i]! - p)
        .filter((d) => d > 1e-6); // drop the held ticks after it settles
      expect(steps.length).toBeGreaterThan(0);
      for (const d of steps) expect(d).toBeCloseTo(8, 6);
    }
  });
});
