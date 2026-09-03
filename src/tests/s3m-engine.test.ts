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
} from '../../packages/tracker-playback/src/engine';

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
