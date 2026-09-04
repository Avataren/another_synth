import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ref } from 'vue';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import { buildXm, cell, emptyCell } from './helpers/xm-builder';

/**
 * FT2's global volume, and the period limits a portamento actually obeys.
 *
 * Reported on "im in love with you.xm": a drum pitched down at the end of the
 * pattern at order 15 keeps rumbling through the next pattern, whose only
 * command on that channel is a `G40` at the top. The `G40` turned out to be
 * innocent -- it sets global volume to its maximum, which it already was --
 * and the cause was the pitch clamp. See D80.
 */

function buildFrom(file: ReturnType<typeof importXmToTrackerSong>) {
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

/** Drive one synthetic pattern and report the global volumes it scheduled. */
function globalVolumesFor(cells: ReturnType<typeof cell>[][]) {
  const xm = buildXm({
    numChannels: 1,
    linearFrequency: true,
    speed: 6,
    instruments: [{ samples: [{ frames: [0, 1, 0, -1] }] }],
    patterns: [{ numRows: cells.length, cells }],
  });
  const song = buildFrom(
    importXmToTrackerSong(xm.buffer.slice(0) as ArrayBuffer),
  );
  const volumes: number[] = [];
  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: () => {},
    scheduledGlobalVolumeHandler: (gain) => volumes.push(gain),
  });
  engine.loadSong(song);
  engine.loadPattern(song.patterns[0]!.id);
  for (let row = 0; row < cells.length; row++) {
    (
      engine as unknown as { scheduleRow: (r: number, t: number) => void }
    ).scheduleRow(row, 0);
  }
  return volumes;
}

/** Gxx is effect 0x10 in an XM cell; Hxy is 0x11. */
const G = (param: number) => cell(0, { effectType: 0x10, effectParam: param });
const H = (param: number) => cell(0, { effectType: 0x11, effectParam: param });

describe('Gxx sets global volume the way FT2 does', () => {
  // ft2-clone, setGlobalVolume():  if (param > 64) param = 64;
  //                                song.globalVolume = param;
  it('treats 0x40 as the maximum, not as a fraction of 0xFF', () => {
    expect(globalVolumesFor([[G(0x40)], [emptyCell()]])).toEqual([1]);
  });

  it('scales linearly against 64', () => {
    expect(globalVolumesFor([[G(0x20)], [emptyCell()]])).toEqual([0.5]);
    expect(globalVolumesFor([[G(0x10)], [emptyCell()]])).toEqual([0.25]);
    expect(globalVolumesFor([[G(0x00)], [emptyCell()]])).toEqual([0]);
  });

  it('clamps a parameter above 64 rather than exceeding unity', () => {
    // FT2's own maximum is 64; a G80 must not make the song twice as loud.
    expect(globalVolumesFor([[G(0x80)], [emptyCell()]])).toEqual([1]);
    expect(globalVolumesFor([[G(0xff)], [emptyCell()]])).toEqual([1]);
  });
});

describe('Hxy global volume slide', () => {
  /**
   * KNOWN DEVIATION, pinned so that changing it is deliberate (the same
   * treatment D71 gives EEx).
   *
   * FT2 runs Hxy once per tick, from JumpTab_TickNonZero -- at speed 6 that is
   * five steps per row, so `H10` from 32 reaches 37 by the next row. This
   * applies it once per row instead, reaching 33.
   *
   * Nothing in the demo corpus can tell the difference: Hxy appears in exactly
   * one of the sixty-one modules ("im in love with you.xm", 32 rows of `H10`), and
   * there the global volume is already at maximum every time one runs, so both
   * readings clamp to the same value. Left alone rather than changed blind.
   */
  it('slides once per row, where FT2 slides once per tick', () => {
    const volumes = globalVolumesFor([[G(0x20)], [H(0x10)], [emptyCell()]]);
    expect(volumes[0]).toBeCloseTo(32 / 64, 9);
    expect(volumes[1]).toBeCloseTo(33 / 64, 9); // FT2 at speed 6: 37/64
  });

  it('is a no-op at maximum, which is every occurrence in the corpus', () => {
    const volumes = globalVolumesFor([[G(0x40)], [H(0x10)], [emptyCell()]]);
    expect(volumes[0]).toBe(1);
    expect(volumes[1]).toBe(1);
  });
});

describe('a runaway 2xx follows FT2 past the note range', () => {
  /**
   * "im in love with you.xm", order 15 -> 16, channel 8 (track 9 counting from
   * one). Six rows of `240` after an F-5 take the period to 11200, far below
   * C-0's 7680. Clamping there left the sample at 1/43 of its rate -- audible,
   * and 43 times as long, so it ran on through the next pattern. FT2 clamps at
   * 32000-1 instead, which puts it at ~1/1000: silence.
   */
  const TRACK = 8;

  const pitchesAcrossTheTransition = () => {
    const buf = fs.readFileSync(
      path.resolve(__dirname, '../../public/demos/ft2/im in love with you.xm'),
    );
    const song = buildFrom(
      importXmToTrackerSong(
        buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer,
      ),
    );
    const pitches: number[] = [];
    let noteFrequency = 0;
    let globalVolume = -1;
    const engine = new PlaybackEngine({
      scheduler: { start: vi.fn(), stop: vi.fn() },
      audioContext: { currentTime: 0 } as unknown as AudioContext,
      scheduledNoteHandler: (e) => {
        if (e.trackIndex === TRACK && e.type === 'noteOn' && e.frequency) {
          noteFrequency = e.frequency;
        }
      },
      scheduledPitchHandler: (_i, _v, frequency, _t, trackIndex) => {
        if (trackIndex === TRACK) pitches.push(frequency);
      },
      scheduledGlobalVolumeHandler: (gain) => {
        globalVolume = gain;
      },
    });
    engine.loadSong(song);
    const internals = engine as unknown as {
      scheduleRow: (row: number, time: number) => void;
    };
    for (const order of [15, 16]) {
      const pattern = song.patterns.find(
        (p) => p.id === song.sequence![order]!,
      )!;
      engine.loadPattern(pattern.id);
      for (let row = 0; row < (pattern.length ?? 64); row++) {
        internals.scheduleRow(row, 0);
      }
    }
    return { pitches, noteFrequency, globalVolume };
  };

  it('slides the drum below audibility instead of parking it at C-0', () => {
    const { pitches, noteFrequency } = pitchesAcrossTheTransition();
    expect(noteFrequency).toBeGreaterThan(600); // the F-5 it started from
    const last = pitches[pitches.length - 1]!;
    expect(last / noteFrequency).toBeLessThan(1 / 500);
  });

  it('never parks a pitch on the old C-0 clamp', () => {
    // 16.334 Hz is frequencyFromPeriod(7680). Landing there repeatedly is the
    // signature of the bug: the slide stops moving and the sample rumbles on.
    const { pitches } = pitchesAcrossTheTransition();
    const atOldClamp = pitches.filter((f) => Math.abs(f - 16.334) < 0.001);
    expect(atOldClamp).toHaveLength(0);
  });

  it('carries the drum into the next pattern still inaudible', () => {
    // The next pattern says nothing to this channel but `G40`, so whatever the
    // slide left sounding is what plays on. Global volume is at maximum, which
    // is what makes the pitch the only thing that can save it.
    const { pitches, noteFrequency, globalVolume } =
      pitchesAcrossTheTransition();
    expect(globalVolume).toBe(1);
    expect(pitches[pitches.length - 1]! / noteFrequency).toBeLessThan(1 / 500);
  });
});
