/**
 * Effect reference audit, second pass (D88+).
 *
 * Every number quoted from 8bitbubsy's replayer clones:
 *   - pt2-clone  src/pt2_replayer.c  (ProTracker)
 *   - ft2-clone  src/ft2_replayer.c  (FastTracker 2)
 *
 * Covers the fine-slide parameter memory (D88), the pan-slide unit (D89),
 * Rxy's tick-0 count (D90) and F00 (D91) found by auditing against the C.
 */

import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import {
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN,
  processVolumeColumnTick0,
  processVolumeColumnTickN,
  type TrackEffectState,
} from '../../packages/tracker-playback/src/effect-processor';
import {
  PROTRACKER_PROFILE,
  XM_PROFILE,
  type FormatProfile,
} from '../../packages/tracker-playback/src/format-profile';
import type { EffectCommand, VolumeColumnCommand } from '../../packages/tracker-playback/src/types';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import { buildSoundtrackerMod } from './helpers/mod-builder';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';

function stateFor(profile: FormatProfile): TrackEffectState {
  const state = createTrackEffectState(profile);
  state.currentVolume = 0.5;
  return state;
}

const effect = (
  type: EffectCommand['type'],
  x: number,
  y: number,
  extSubtype?: string,
): EffectCommand =>
  ({
    type,
    paramX: x,
    paramY: y,
    ...(extSubtype ? { extSubtype } : {}),
  }) as EffectCommand;

const volCmd = (type: VolumeColumnCommand['type'], value: number): VolumeColumnCommand =>
  ({ type, value }) as VolumeColumnCommand;

describe('D88: fine slides remember their parameter on XM', () => {
  /**
   * ft2_replayer.c, fineVolSlideUp (fineVolSlideDown, finePitchSlideUp,
   * finePitchSlideDown and extraFinePitchSlide are the same shape):
   *
   *   if (param == 0)
   *       param = ch->fVolSlideUpSpeed;
   *   ch->fVolSlideUpSpeed = param;
   *
   * ProTracker's volumeFineUp/Down read the command byte raw: no memory.
   */
  it('EB0 after EB2 keeps sliding down by 2 per row', () => {
    const state = stateFor(XM_PROFILE);
    processEffectTick0(state, effect('volSlide', 0, 2, 'fineVolDown'));
    expect(state.currentVolume).toBeCloseTo(0.5 - 2 / 64, 9);
    // Old code: EA0/EB0 were no-ops, so the volume stopped at 31/64.
    processEffectTick0(state, effect('volSlide', 0, 0, 'fineVolDown'));
    expect(state.currentVolume).toBeCloseTo(0.5 - 4 / 64, 9);
  });

  it('EA0 after EA1 keeps sliding up by 1 per row', () => {
    const state = stateFor(XM_PROFILE);
    processEffectTick0(state, effect('volSlide', 0, 1, 'fineVolUp'));
    processEffectTick0(state, effect('volSlide', 0, 0, 'fineVolUp'));
    expect(state.currentVolume).toBeCloseTo(0.5 + 2 / 64, 9);
  });

  it('E10 after E12 keeps the fine portamento running', () => {
    const state = stateFor(XM_PROFILE);
    state.currentPeriod = 4608;
    state.currentFrequency = XM_PROFILE.pitch.frequencyFromPeriod(4608);
    processEffectTick0(state, effect('finePortaUp', 0, 2));
    const after = state.currentPeriod!;
    processEffectTick0(state, effect('finePortaUp', 0, 0));
    expect(state.currentPeriod).toBeCloseTo(after - 2 * 4, 9);
  });

  it('Xx0 after Xx3 repeats the extra-fine step', () => {
    const state = stateFor(XM_PROFILE);
    state.currentPeriod = 4608;
    state.currentFrequency = XM_PROFILE.pitch.frequencyFromPeriod(4608);
    processEffectTick0(state, effect('extraFinePorta', 1, 3));
    const first = state.currentPeriod!;
    processEffectTick0(state, effect('extraFinePorta', 1, 0));
    expect(state.currentPeriod).toBeCloseTo(first - 3, 9);
  });

  it('Xxy and E1x have separate memories, as FT2 keeps them', () => {
    const state = stateFor(XM_PROFILE);
    state.currentPeriod = 4608;
    state.currentFrequency = XM_PROFILE.pitch.frequencyFromPeriod(4608);
    processEffectTick0(state, effect('extraFinePorta', 1, 3));
    // The extra-fine step moved it to 4605 (one period unit is 1 here).
    expect(state.currentPeriod).toBe(4605);
    // E1x0 has no memory of its own yet -> no further movement.
    processEffectTick0(state, effect('finePortaUp', 0, 0));
    expect(state.currentPeriod).toBe(4605);
  });

  it('ProTracker fine slides stay memoryless: EB0 is a no-op', () => {
    const state = stateFor(PROTRACKER_PROFILE);
    processEffectTick0(state, effect('volSlide', 0, 2, 'fineVolDown'));
    processEffectTick0(state, effect('volSlide', 0, 0, 'fineVolDown'));
    expect(state.currentVolume).toBeCloseTo(0.5 - 2 / 64, 9);
  });

  it('native keeps the memoryless reading its songs were written against', () => {
    const state = stateFor({ ...PROTRACKER_PROFILE, format: 'native', fineSlideHasMemory: false });
    processEffectTick0(state, effect('volSlide', 0, 2, 'fineVolDown'));
    processEffectTick0(state, effect('volSlide', 0, 0, 'fineVolDown'));
    expect(state.currentVolume).toBeCloseTo(0.5 - 2 / 64, 9);
  });
});

describe('D89: one pan-slide unit is 2/255 of full swing on XM', () => {
  /**
   * ft2_replayer.c: FT2 pan is one 0..255 byte.
   *
   *   static void v_PanSlideRight(channel_t *ch)
   *   {
   *       uint16_t tmp16 = ch->outPan + (ch->volColumnVol & 0x0F);
   *       if (tmp16 > 255) tmp16 = 255;
   *       ch->outPan = (uint8_t)tmp16;
   *
   * The processor's -1..1 pan is that byte mapped by (byte-128)/128, so a
   * unit is 2/255. The old code borrowed the volume-slide 1/64, which is
   * almost exactly twice as far.
   */
  it('a volume-column Ex4 pan slide moves 4*2/255 per tick', () => {
    const state = stateFor(XM_PROFILE);
    state.currentPan = 0;
    processVolumeColumnTick0(state, volCmd('panSlideRight', 4));
    for (let tick = 1; tick <= 8; tick++) {
      processVolumeColumnTickN(state, volCmd('panSlideRight', 4));
    }
    // Old code: 0.5 (8 * 4/64). FT2: 8 * 4 * 2/255.
    expect(state.currentPan).toBeCloseTo((8 * 4 * 2) / 255, 9);
  });

  it('a volume-column Dx pan slide moves left at the same rate', () => {
    const state = stateFor(XM_PROFILE);
    state.currentPan = 0;
    processVolumeColumnTick0(state, volCmd('panSlideLeft', 2));
    for (let tick = 1; tick <= 4; tick++) {
      processVolumeColumnTickN(state, volCmd('panSlideLeft', 2));
    }
    expect(state.currentPan).toBeCloseTo((-4 * 2 * 2) / 255, 9);
  });

  it('Pxy slides by the same unit', () => {
    const state = stateFor(XM_PROFILE);
    state.currentPan = 0;
    processEffectTick0(state, effect('panSlide', 4, 0));
    for (let tick = 1; tick <= 8; tick++) {
      processEffectTickN(state, effect('panSlide', 4, 0), tick, 6);
    }
    expect(state.currentPan).toBeCloseTo((8 * 4 * 2) / 255, 9);
  });

  it('still clamps a left slide at hard left', () => {
    const state = stateFor(XM_PROFILE);
    state.currentPan = -0.5;
    processVolumeColumnTick0(state, volCmd('panSlideLeft', 8));
    for (let tick = 1; tick <= 8; tick++) {
      processVolumeColumnTickN(state, volCmd('panSlideLeft', 8));
    }
    // 0.5 + 8 * 16 * 2/255 overshoots full left; FT2's v_PanSlideLeft wraps
    // the same overshoot back to 0, which the -1..1 mapping reads as the
    // clamp at -1.
    expect(state.currentPan).toBe(-1);
  });
});

describe('D90: Rxy counts tick 0 as its first increment', () => {
  /**
   * ft2_replayer.c, doMultiNoteRetrig():
   *
   *   uint8_t cnt = ch->noteRetrigCounter + 1;
   *   if (cnt < ch->noteRetrigSpeed) { ch->noteRetrigCounter = cnt; return; }
   *   ch->noteRetrigCounter = 0;
   *
   * and it is reached on tick 0 too (handleEffects_TickZero ->
   * multiNoteRetrig -> doMultiNoteRetrig), with the counter reset only by
   * triggerInstrument. So at speed 6 an R2 fires on ticks 1/3/5, not 2/4.
   */
  const speed = 6;

  function retrigs(
    effectCmd: EffectCommand,
    ticks: number,
    volumeColumnVolume = false,
  ): number[] {
    const state = stateFor(XM_PROFILE);
    state.currentMidi = 60;
    state.currentFrequency = 440;
    const fired: number[] = [];
    const tick0 = processEffectTick0(
      state,
      effectCmd,
      undefined,
      undefined,
      undefined,
      speed,
      undefined,
      volumeColumnVolume,
    );
    if (tick0.commands.some((c) => c.kind === 'retrigger')) fired.push(0);
    for (let tick = 1; tick < ticks; tick++) {
      const batch = processEffectTickN(state, effectCmd, tick, speed);
      if (batch.commands.some((c) => c.kind === 'retrigger')) fired.push(tick);
    }
    return fired;
  }

  it('R2 at speed 6 fires on ticks 1, 3, 5', () => {
    expect(retrigs(effect('retrigVol', 0, 2), speed)).toEqual([1, 3, 5]);
  });

  it('R1 fires on every tick including tick 0', () => {
    expect(retrigs(effect('retrigVol', 0, 1), speed)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('a volume-column volume suppresses the tick-0 count (FT2 quirk)', () => {
    expect(retrigs(effect('retrigVol', 0, 2), speed, true)).toEqual([2, 4]);
  });

  it('E9x does not count tick 0 and fires at interval multiples', () => {
    expect(retrigs(effect('retrigVol', 0, 2, 'retrigger'), speed)).toEqual([2, 4]);
  });

  it('R00 repeats the last non-zero nibbles', () => {
    const state = stateFor(XM_PROFILE);
    processEffectTick0(state, effect('retrigVol', 2, 3));
    processEffectTick0(state, effect('retrigVol', 0, 0));
    expect(state.retriggerInterval).toBe(3);
    expect(state.retriggerVolChange).toBe(2);
  });
});

describe('D91: F00 stops a ProTracker song after its row', () => {
  /**
   * pt2_replayer.c, setSpeed():
   *
   *   if ((ch->n_cmd & 0xFF) > 0) { ... }
   *   else { // F00 - stop song
   *       doStopSong = true;
   *   }
   *
   * Both corpus F00s sit at the very end of their songs (nexus_seven.mod
   * pattern 9 row 63, oro incenso.mod pattern 22 row 62), where the old
   * clamp-to-speed-1 reading instead rushed what followed at six times
   * tempo. Built as a two-pattern song: F00 on the last row of pattern 0.
   */
  function engineFor(): PlaybackEngine {
    const bytes = buildSoundtrackerMod({
      samples: [{ lengthBytes: 256, loopStartRaw: 0, loopLengthBytes: 0 }],
      orders: [0, 1],
      patterns: [
        [
          [
            { period: 214, sample: 1, effectCmd: 0xf, effectParam: 0x00 },
            { period: 0, sample: 0 },
            { period: 0, sample: 0 },
            { period: 0, sample: 0 },
          ],
        ],
        [
          [
            { period: 214, sample: 1, effectCmd: 0, effectParam: 0 },
            { period: 0, sample: 0 },
            { period: 0, sample: 0 },
            { period: 0, sample: 0 },
          ],
        ],
      ],
    });
    const imported = importModToTrackerSong(bytes.buffer as ArrayBuffer);
    const patterns = imported.data.patterns;
    const ctx: TrackerSongBuilderContext = {
      currentSong: ref(imported.data.currentSong),
      moduleFormat: ref(imported.data.moduleFormat!),
      initialSpeed: ref(imported.data.initialSpeed ?? 6),
      linearFrequency: ref(true),
      patterns: ref(patterns),
      sequence: ref(imported.data.sequence ?? patterns.map((p) => p.id)),
      currentPatternId: ref(patterns[0]!.id),
      currentPattern: ref(patterns[0]!),
      defaultPatternRows: ref(64),
      instrumentSlots: ref(imported.data.instrumentSlots),
      songPatches: ref(imported.data.songPatches ?? {}),
      songBank: {} as TrackerSongBuilderContext['songBank'],
      normalizeInstrumentId: (id) => (id ? id : undefined),
      formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
    };
    const song = useTrackerSongBuilder(ctx).buildPlaybackSong('song');
    const engine = new PlaybackEngine({
      scheduler: { start: vi.fn(), stop: vi.fn() },
      audioContext: { currentTime: 0 } as unknown as AudioContext,
      scheduledNoteHandler: () => {},
      scheduledGlobalVolumeHandler: () => {},
    });
    engine.loadSong(song);
    engine.loadPattern(song.patterns[0]!.id);
    return engine;
  }

  it('marks the end after the F00 row instead of continuing', () => {
    const engine = engineFor();
    const inner = engine as unknown as {
      scheduleRow: (r: number, t: number) => void;
      pendingSongStop: boolean;
    };
    inner.scheduleRow(0, 0);
    expect(inner.pendingSongStop).toBe(true);
  });

  it('leaves rows without F00 alone', () => {
    const engine = engineFor();
    const inner = engine as unknown as {
      scheduleRow: (r: number, t: number) => void;
      pendingSongStop: boolean;
    };
    inner.scheduleRow(63, 0);
    expect(inner.pendingSongStop).toBe(false);
  });
});
