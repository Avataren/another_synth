/**
 * P2 -- AHX/HVL pattern-effect semantics (`.ai/ahx/p2-report.md`).
 *
 * Two layers, matching the two places AHX_PROFILE/effect-processor.ts
 * changed:
 *  - `decodeRawEffect` against `AHX_PROFILE`: does the right raw byte
 *    produce the right EffectType/extSubtype/params?
 *  - `processEffectTick0` against those decoded commands: does the right
 *    TrackEffectState mutation happen?
 *
 * Evidence for every case is the corresponding doc comment in
 * `format-profile.ts`'s `AHX_PROFILE` / `types.ts`'s new `EffectType`
 * members, which cite exact `hvl_replay.c` line numbers; not re-quoted here.
 */
import { describe, expect, it } from 'vitest';

import { AHX_PROFILE } from '../format-profile';
import { decodeRawEffect } from '../note-utils';
import {
  createTrackEffectState,
  processEffectTick0,
} from '../effect-processor';
import type { EffectCommand } from '../types';

describe('AHX_PROFILE: decodeRawEffect', () => {
  it('decodes 0x1/0x2 as portaUp/portaDown, 0x3 as tonePorta, 0x5 as tonePortaVol, 0xa as volSlide', () => {
    expect(decodeRawEffect(0x1, 0x05, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'portaUp', paramX: 0, paramY: 5 },
    });
    expect(decodeRawEffect(0x2, 0x05, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'portaDown', paramX: 0, paramY: 5 },
    });
    expect(decodeRawEffect(0x3, 0x0a, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'tonePorta' },
    });
    expect(decodeRawEffect(0x5, 0x21, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'tonePortaVol', paramX: 2, paramY: 1 },
    });
    expect(decodeRawEffect(0xa, 0x21, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'volSlide', paramX: 2, paramY: 1 },
    });
  });

  it('decodes 0xd (pattern break) with the existing decimal Dxx formula', () => {
    // hvl_replay.c:652-658: PosJumpNote = (param&0xf) + (param>>4)*10.
    // Byte 0x21 -> tens=2, ones=1 -> decimal 21, same reconstruction this
    // engine's engine.ts already applies to patBreak's paramX*10+paramY.
    expect(decodeRawEffect(0xd, 0x21, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'patBreak', paramX: 2, paramY: 1 },
    });
  });

  it('leaves 0x0 (Position Jump HI) and 0xb (Position Jump) undecoded (deferred, see p2-report.md)', () => {
    expect(decodeRawEffect(0x0, 0x03, AHX_PROFILE)).toBeUndefined();
    expect(decodeRawEffect(0xb, 0x21, AHX_PROFILE)).toBeUndefined();
  });

  it('does not misdecode 0x0 as arpeggio (arpeggioCommandByte must not collide with Position Jump HI)', () => {
    // A naive AHX_PROFILE inheriting ProTracker's arpeggioCommandByte (0x00)
    // would read this as an arpeggio(3,0) command instead of leaving it
    // undecoded.
    const result = decodeRawEffect(0x0, 0x30, AHX_PROFILE);
    expect(result).toBeUndefined();
  });

  it('Fxx (0xf) always decodes as plain speed, never a tempo/BPM split', () => {
    // 0x20 would be read as tempo=32 under the MOD/XM speedTempoCommandByte
    // split; AHX has no such split.
    expect(decodeRawEffect(0xf, 0x20, AHX_PROFILE)).toEqual({
      type: 'speed',
      speed: 0x20,
    });
    expect(decodeRawEffect(0xf, 0x02, AHX_PROFILE)).toEqual({
      type: 'speed',
      speed: 0x02,
    });
    // Fxx=0 reuses the ProTracker F00 "stop the song" reading.
    expect(decodeRawEffect(0xf, 0x00, AHX_PROFILE)).toEqual({
      type: 'speed',
      speed: 0,
    });
  });

  it('decodes 0x4 as setFilterPos, 0x9 as setSquarePos, 0xc as setTrackVolume, 0x7 as setPan', () => {
    expect(decodeRawEffect(0x4, 0x50, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'setFilterPos' },
    });
    expect(decodeRawEffect(0x9, 0x10, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'setSquarePos' },
    });
    expect(decodeRawEffect(0xc, 0x30, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'setTrackVolume' },
    });
    expect(decodeRawEffect(0x7, 0x00, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'setPan' },
    });
  });

  it('decodes extended sub 0x4 as vibratoDepth (not vibratoWave), 0x1/0x2 as fine porta, 0xc as noteCut', () => {
    expect(decodeRawEffect(0xe, 0x4a, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'vibrato', extSubtype: 'vibratoDepth', paramY: 0xa },
    });
    expect(decodeRawEffect(0xe, 0x13, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'finePortaUp', paramY: 3 },
    });
    expect(decodeRawEffect(0xe, 0x22, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'finePortaDown', paramY: 2 },
    });
    expect(decodeRawEffect(0xe, 0xc3, AHX_PROFILE)).toMatchObject({
      type: 'effect',
      effect: { type: 'noteCut', paramY: 3 },
    });
  });

  it('leaves extended sub 0xd (note delay) undecoded -- AHX postpones the whole step, not just the note', () => {
    expect(decodeRawEffect(0xe, 0xd3, AHX_PROFILE)).toBeUndefined();
  });
});

describe('AHX_PROFILE: processEffectTick0 state mutation', () => {
  it('portaUp/portaDown do not reuse memory on a zero parameter (portamentoHasMemory: false)', () => {
    const state = createTrackEffectState(AHX_PROFILE);
    const up: EffectCommand = { type: 'portaUp', paramX: 0, paramY: 8 };
    processEffectTick0(state, up);
    expect(state.portamentoSpeed).toBe(8);

    // A subsequent zero-parameter row must stop the slide (speed 0), not
    // repeat the last non-zero speed the way MOD/XM/S3M do.
    const zero: EffectCommand = { type: 'portaUp', paramX: 0, paramY: 0 };
    processEffectTick0(state, zero);
    expect(state.portamentoSpeed).toBe(0);
  });

  it('setPan reads a signed byte, 0 = center (panByteIsSigned)', () => {
    const state = createTrackEffectState(AHX_PROFILE);
    processEffectTick0(state, { type: 'setPan', paramX: 0, paramY: 0 });
    expect(state.currentPan).toBeCloseTo(0, 5);

    const state2 = createTrackEffectState(AHX_PROFILE);
    // 0x80 (paramX=8,paramY=0): signed -128 -> hard left.
    processEffectTick0(state2, { type: 'setPan', paramX: 8, paramY: 0 });
    expect(state2.currentPan).toBeCloseTo(-1, 5);

    const state3 = createTrackEffectState(AHX_PROFILE);
    // 0x7f (paramX=7,paramY=15): signed 127 -> near hard right.
    processEffectTick0(state3, { type: 'setPan', paramX: 7, paramY: 15 });
    expect(state3.currentPan).toBeCloseTo(127 / 128, 5);
  });

  it('vibratoDepth sets depth unconditionally (including zero), never touches speed', () => {
    const state = createTrackEffectState(AHX_PROFILE);
    state.vibratoSpeed = 7;
    processEffectTick0(state, {
      type: 'vibrato',
      extSubtype: 'vibratoDepth',
      paramX: 4,
      paramY: 3,
    });
    expect(state.vibratoDepth).toBe(3);
    expect(state.vibratoSpeed).toBe(7); // untouched

    processEffectTick0(state, {
      type: 'vibrato',
      extSubtype: 'vibratoDepth',
      paramX: 4,
      paramY: 0,
    });
    expect(state.vibratoDepth).toBe(0); // zero applies, unlike plain vibrato
  });

  it('setFilterPos: 0x41-0x7f sets an absolute cutoff, 1-0x3f latches an ignore override, 0/0x40 are no-ops', () => {
    const direct = createTrackEffectState(AHX_PROFILE);
    // raw = 0x41 + 0x10 = 0x51 -> paramX=5,paramY=1
    processEffectTick0(direct, { type: 'setFilterPos', paramX: 5, paramY: 1 });
    expect(direct.ahxFilterPos).toBe(0x51 - 0x40);
    expect(direct.ahxFilterIgnore).toBeUndefined();

    const latch = createTrackEffectState(AHX_PROFILE);
    processEffectTick0(latch, { type: 'setFilterPos', paramX: 1, paramY: 0 });
    expect(latch.ahxFilterIgnore).toBe(0x10);
    expect(latch.ahxFilterPos).toBeUndefined();

    const noop = createTrackEffectState(AHX_PROFILE);
    processEffectTick0(noop, { type: 'setFilterPos', paramX: 0, paramY: 0 });
    processEffectTick0(noop, { type: 'setFilterPos', paramX: 4, paramY: 0 });
    expect(noop.ahxFilterPos).toBeUndefined();
    expect(noop.ahxFilterIgnore).toBeUndefined();
  });

  it('setSquarePos sets ahxSquarePos directly', () => {
    const state = createTrackEffectState(AHX_PROFILE);
    processEffectTick0(state, { type: 'setSquarePos', paramX: 1, paramY: 4 });
    expect(state.ahxSquarePos).toBe(0x14);
  });

  it('setTrackVolume: tier 1 sets note volume, tier 2 is decoded but not applied, tier 3 sets ahxTrackVolume', () => {
    const tier1 = createTrackEffectState(AHX_PROFILE);
    // 0x40 -> tier 1 boundary, max note volume.
    processEffectTick0(tier1, {
      type: 'setTrackVolume',
      paramX: 4,
      paramY: 0,
    });
    expect(tier1.currentVolume).toBeCloseTo(1, 5);
    expect(tier1.ahxTrackVolume).toBeUndefined();

    const tier2 = createTrackEffectState(AHX_PROFILE);
    const before = tier2.currentVolume;
    // 0x60 -> tier 2 (all channels), deliberately not applied here.
    processEffectTick0(tier2, {
      type: 'setTrackVolume',
      paramX: 6,
      paramY: 0,
    });
    expect(tier2.currentVolume).toBe(before);
    expect(tier2.ahxTrackVolume).toBeUndefined();

    const tier3 = createTrackEffectState(AHX_PROFILE);
    // 0xc0 -> tier 3 (this channel's track-master volume): 0xc0-0xa0=0x20.
    processEffectTick0(tier3, {
      type: 'setTrackVolume',
      paramX: 0xc,
      paramY: 0,
    });
    expect(tier3.ahxTrackVolume).toBeCloseTo(0x20 / 64, 5);
  });

  it('volume slide applies on tick 0 too (fastVolumeSlides), unlike MOD/XM/native', () => {
    const state = createTrackEffectState(AHX_PROFILE);
    const before = state.currentVolume; // 1.0 (full scale) by default
    // Down nibble, so the step is visible even from full volume.
    processEffectTick0(state, { type: 'volSlide', paramX: 0, paramY: 4 });
    expect(state.volumeSlide.delta).toBeCloseTo(-4 / 64, 5);
    // Unlike ProTracker/XM/native (where a volume slide only starts moving
    // on tick 1, see resolveVolumeSlide's 'modxm' branch), AHX's
    // fastVolumeSlides: true makes resolveVolumeSlide report firstTick:
    // true, and emitTick0VolumeSlide steps currentVolume immediately.
    expect(state.currentVolume).toBeCloseTo(before - 4 / 64, 5);
  });
});
