/**
 * S3M `Dxy` volume-slide semantics at the engine boundary.
 *
 * Scream Tracker 3 reads the two nibbles of a volume slide differently from
 * ProTracker/FT2, and the engine had been reading them the MOD/XM way:
 *
 * - a 0xF nibble makes the slide *fine* -- `DxF` one step up on tick 0,
 *   `DFy` one step down -- where the MOD/XM reading simply lets the up
 *   nibble win, so `DFy` walked the channel *up* by 15/64 every tick;
 * - with both nibbles set the *down* nibble wins, not the up one;
 * - `D0F`/`DF0` slide 15 units on every tick including the first;
 * - ST3.00-era files (`fastVolumeSlides`) slide on tick 0 too.
 *
 * Pinned through the real importer and the real builder, per D59: the flag
 * data is per-file, and only the effect arithmetic is wrong when a layer
 * drops it.
 */

import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import { importS3mToTrackerSong } from '../audio/tracker/s3m-import';
import { buildS3m, type S3mSpec } from './helpers/s3m-builder';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import { PlaybackEngine, profileForFormat } from '@another-synth/tracker-playback';

const ONE_PCM_CHANNEL = [0x00];

/**
 * The level a note written at volume byte 32 actually starts at.
 *
 * The importer stamps the volume as the tracker's own two-hex-digit column
 * (`round(32/64 * 255) = 0x80`), so the engine's starting point is 128/255,
 * not 32/64. Slides move from there in 1/64 steps, which is why every
 * expectation below is written as `BASE + n / 64`.
 */
const BASE = 128 / 255;

function makeBuilderContext(file: ReturnType<typeof importS3mToTrackerSong>) {
  const patterns = file.data.patterns;
  const context: TrackerSongBuilderContext = {
    currentSong: ref(file.data.currentSong),
    moduleFormat: ref(file.data.moduleFormat!),
    initialSpeed: ref(file.data.initialSpeed ?? 6),
    linearFrequency: ref(file.data.linearFrequency ?? true),
    amigaLimits: ref(file.data.amigaLimits ?? false),
    fastVolumeSlides: ref(file.data.fastVolumeSlides ?? false),
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

/** Every volume value the engine schedules, in order. */
function volumesFor(spec: S3mSpec): number[] {
  const file = importS3mToTrackerSong(
    buildS3m(spec).buffer.slice(0) as ArrayBuffer,
  );
  const volumes: number[] = [];
  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: () => {},
    scheduledPitchHandler: () => {},
    scheduledVolumeHandler: (
      _instrumentId: string,
      _voiceIndex: number,
      volume: number,
    ) => volumes.push(volume),
    scheduledPanHandler: () => {},
    scheduledSampleOffsetHandler: () => {},
    scheduledEnvelopePositionHandler: () => {},
    scheduledAllNotesOffHandler: () => {},
    scheduledGlobalVolumeHandler: () => {},
    scheduledRetriggerHandler: () => {},
    scheduledMacroHandler: () => {},
    scheduledAutomationHandler: () => {},
    positionCommandHandler: () => {},
  } as unknown as ConstructorParameters<typeof PlaybackEngine>[0]);
  const builder = makeBuilderContext(file);
  engine.loadSong(builder.buildPlaybackSong('song'));
  const pattern = file.data.patterns[0]!;
  engine.loadPattern(pattern.id);
  for (let row = 0; row < 4; row += 1) {
    (
      engine as unknown as { scheduleRow: (r: number, t: number) => void }
    ).scheduleRow(row, row);
  }
  return volumes;
}

/**
 * A note at volume 32 (half scale), then one row carrying the volume slide
 * under test, then two empty rows. Volume 32 rather than 64 so a slide in the
 * wrong direction is visible rather than clamped away at full scale.
 */
function songWith(param: number, extra: Partial<S3mSpec> = {}): S3mSpec {
  return {
    channelSettings: ONE_PCM_CHANNEL,
    orders: [0],
    speed: 6,
    tempo: 125,
    patterns: [
      [
        [{ note: 0x30, instrument: 1, volume: 32 }],
        [{ effect: 0x04, param }],
        [{}],
        [{}],
      ],
    ],
    instruments: [{ frames: [0, 0.25, -0.25, 0] }],
    ...extra,
  };
}

describe('S3M Dxy: a 0xF nibble makes the slide fine', () => {
  it('DF4 steps down by 4/64 once and holds', () => {
    const volumes = volumesFor(songWith(0xf4));
    expect(volumes[0]).toBeCloseTo(BASE, 5);
    const after = volumes.slice(1);
    expect(after.length).toBeGreaterThan(0);
    for (const v of after) expect(v).toBeCloseTo(BASE - 4 / 64, 5);
  });

  it('D4F steps up by 4/64 once and holds', () => {
    const volumes = volumesFor(songWith(0x4f));
    expect(volumes[0]).toBeCloseTo(BASE, 5);
    const after = volumes.slice(1);
    expect(after.length).toBeGreaterThan(0);
    for (const v of after) expect(v).toBeCloseTo(BASE + 4 / 64, 5);
  });

  it('DF4 is not the MOD/XM reading, which walked the channel to full scale', () => {
    // The regression this pins: reading 0xF4 the MOD/XM way lets the up
    // nibble (0xF) win, so the channel gains 15/64 per tick and reaches 1.0
    // inside the row.
    const volumes = volumesFor(songWith(0xf4));
    expect(Math.max(...volumes)).toBeLessThanOrEqual(BASE + 1e-9);
  });
});

describe('S3M Dxy: the down nibble wins when both are set', () => {
  it('D48 slides down by 8/64 a tick, not up by 4', () => {
    const volumes = volumesFor(songWith(0x48));
    expect(volumes[0]).toBeCloseTo(BASE, 5);
    // Five sliding ticks after tick 0: 0.502 - 5*8/64 is below zero, clamped.
    expect(volumes[volumes.length - 1]).toBeCloseTo(0, 5);
    // Every value moves down, never up.
    for (const v of volumes) expect(v).toBeLessThanOrEqual(BASE + 1e-9);
  });
});

describe('S3M Dxy: D0F and DF0 slide on every tick', () => {
  it('D0F takes its first 15/64 step on tick 0', () => {
    const volumes = volumesFor(songWith(0x0f));
    // The row's own first scheduled value already carries a step, unlike an
    // ordinary Dxy where tick 0 only re-states the level.
    expect(volumes[1]).toBeCloseTo(BASE - 15 / 64, 5);
  });

  it('DF0 takes its first 15/64 step up on tick 0', () => {
    const volumes = volumesFor(songWith(0xf0));
    expect(volumes[1]).toBeCloseTo(BASE + 15 / 64, 5);
  });
});

describe('S3M fast volume slides (ST3.00 / header flag 0x40)', () => {
  it('an ordinary D04 does not step on tick 0 by default', () => {
    const volumes = volumesFor(songWith(0x04, { cwtv: 0x1320 }));
    expect(volumes[1]).toBeCloseTo(BASE, 5);
  });

  it('the same D04 steps on tick 0 on an ST3.00 file', () => {
    const volumes = volumesFor(songWith(0x04, { cwtv: 0x1300 }));
    expect(volumes[1]).toBeCloseTo(BASE - 4 / 64, 5);
  });

  it('and on any file carrying header flag 0x40', () => {
    const volumes = volumesFor(songWith(0x04, { cwtv: 0x1320, flags: 0x40 }));
    expect(volumes[1]).toBeCloseTo(BASE - 4 / 64, 5);
  });

  it('is a version equality, not "older than 3.20" -- 3.01 slides normally', () => {
    // OpenMPT's rule is `cwtv == trkST3_00`, and trkST3_00 is 0x1300 exactly.
    const file = importS3mToTrackerSong(
      buildS3m(songWith(0x04, { cwtv: 0x1301 })).buffer.slice(0) as ArrayBuffer,
    );
    expect(file.data.fastVolumeSlides).toBeUndefined();
  });

  it('the importer records the flag for an ST3.00 file', () => {
    const file = importS3mToTrackerSong(
      buildS3m(songWith(0x04, { cwtv: 0x1300 })).buffer.slice(0) as ArrayBuffer,
    );
    expect(file.data.fastVolumeSlides).toBe(true);
  });
});

describe('the profile carries the two readings, and only S3M gets the new one', () => {
  it('MOD, XM and native keep the MOD/XM nibble priority', () => {
    for (const format of ['protracker', 'xm', 'native'] as const) {
      const profile = profileForFormat(format);
      expect(profile.volumeSlideNibbles).toBe('modxm');
      expect(profile.fastVolumeSlides).toBe(false);
    }
  });

  it('S3M reads the ST3 dialect, with fast slides off unless asked for', () => {
    expect(profileForFormat('s3m').volumeSlideNibbles).toBe('s3m');
    expect(profileForFormat('s3m').fastVolumeSlides).toBe(false);
    expect(
      profileForFormat('s3m', { fastVolumeSlides: true }).fastVolumeSlides,
    ).toBe(true);
  });

  it('fast slides compose with the amiga-limits profile rather than replacing it', () => {
    const both = profileForFormat('s3m', {
      amigaLimits: true,
      fastVolumeSlides: true,
    });
    expect(both.fastVolumeSlides).toBe(true);
    expect(both.pitch).toBe(profileForFormat('s3m', { amigaLimits: true }).pitch);
  });
});
