import { describe, it, expect } from 'vitest';
import {
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN,
  type TrackEffectState,
} from '@another-synth/tracker-playback';
import type { EffectCommand } from '@another-synth/tracker-playback';

/**
 * Regression coverage for 5xy (tone portamento + volume slide).
 *
 * The 5xy parameter is entirely the volume slide (x = up, y = down); the
 * pitch-slide speed carries over from the last 3xx. Passing those nibbles to
 * the tone-porta speed resolver reinterpreted a volume parameter as a pitch
 * speed *and* clobbered the remembered 3xx speed, so every subsequent row
 * slid at the wrong rate.
 *
 * Real-world case: GSLINGER.MOD pattern 4 track 1 sets "3F0" (speed 240) and
 * then runs a long tail of 300 / 500 / 501 rows. The first 501 dropped the
 * speed to 1, after which the pitch could never reach its targets and the
 * passage drifted badly out of tune.
 */
function effect(type: 'tonePorta' | 'tonePortaVol', param: number): EffectCommand {
  return {
    type,
    paramX: (param >> 4) & 0x0f,
    paramY: param & 0x0f,
  };
}

/** MOD-style state: a sounding note with a period, as after a real note-on. */
function stateWithNote(): TrackEffectState {
  const state = createTrackEffectState();
  // 269 -> the period at GSLINGER pattern 4 row 48.
  processEffectTick0(state, undefined, 60, 255, 7159090.5 / (2 * 269 * 128));
  return state;
}

describe('5xy tone portamento + volume slide', () => {
  it('keeps the 3xx speed instead of reading it from the volume parameter', () => {
    const state = stateWithNote();

    processEffectTick0(state, effect('tonePorta', 0xf0), undefined);
    expect(state.tonePortaSpeed).toBe(0xf0);

    // 501: volume slide down 1, pitch slide unchanged.
    processEffectTick0(state, effect('tonePortaVol', 0x01), undefined);
    expect(state.tonePortaSpeed).toBe(0xf0);
  });

  it('does not overwrite the remembered 3xx speed', () => {
    // The destructive part: a later 300 or 500 has to still find 0xF0.
    const state = stateWithNote();

    processEffectTick0(state, effect('tonePorta', 0xf0), undefined);
    processEffectTick0(state, effect('tonePortaVol', 0x01), undefined);

    expect(state.lastTonePorta).toBe(0xf0);

    processEffectTick0(state, effect('tonePorta', 0x00), undefined);
    expect(state.tonePortaSpeed).toBe(0xf0);
  });

  it('holds the speed across the GSLINGER 501/500 tail', () => {
    const state = stateWithNote();
    processEffectTick0(state, effect('tonePorta', 0xf0), undefined);

    // Rows 48-56: 501, then seven 500s, then another 501.
    const tail = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01];
    for (const param of tail) {
      processEffectTick0(state, effect('tonePortaVol', param), undefined);
      expect(state.tonePortaSpeed).toBe(0xf0);
    }
  });

  it('still applies the volume slide from the 5xy parameter', () => {
    // Guard against "fixing" the pitch by ignoring the parameter entirely.
    const state = stateWithNote();
    state.currentVolume = 1;
    processEffectTick0(state, effect('tonePorta', 0xf0), undefined);
    processEffectTick0(state, effect('tonePortaVol', 0x01), undefined);

    const before = state.currentVolume;
    processEffectTickN(state, effect('tonePortaVol', 0x01), 1, 6);
    expect(state.currentVolume).toBeLessThan(before);
  });

  it('reaches the target with a fast speed rather than crawling', () => {
    // The audible symptom: at speed 1 the pitch barely moves per tick, so the
    // note never arrives at the target and drifts out of tune.
    const state = stateWithNote();
    const targetFreq = 7159090.5 / (2 * 240 * 128);
    processEffectTick0(state, effect('tonePorta', 0xf0), 62, undefined, targetFreq);

    for (let tick = 1; tick < 6; tick++) {
      processEffectTickN(state, effect('tonePortaVol', 0x00), tick, 6);
    }

    expect(state.currentFrequency).toBeCloseTo(targetFreq, 3);
  });
});
