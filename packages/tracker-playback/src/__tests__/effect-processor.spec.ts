import { describe, expect, it } from 'vitest';

import {
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN,
  processVolumeColumnTick0,
} from '../effect-processor';
import type { EffectCommand, VolumeColumnCommand } from '../types';

describe('effect-processor command batches', () => {
  it('delays note-on until the configured tick', () => {
    const state = createTrackEffectState();
    const ticksPerRow = 6;
    const delayEffect: EffectCommand = {
      type: 'noteDelay',
      paramX: 0,
      paramY: 1,
    };

    const tick0 = processEffectTick0(
      state,
      delayEffect,
      60,
      200,
      undefined,
      ticksPerRow,
    );
    expect(tick0.commands.find((cmd) => cmd.kind === 'noteOn')).toBeUndefined();

    const tick1 = processEffectTickN(state, delayEffect, 1, ticksPerRow);
    const noteOn = tick1.commands.find((cmd) => cmd.kind === 'noteOn');
    expect(noteOn).toBeDefined();
    expect(noteOn).toMatchObject({ kind: 'noteOn', midi: 60 });

    // Note delay should also emit pitch/volume so downstream handlers can start automation
    expect(tick1.commands.find((cmd) => cmd.kind === 'pitch')).toBeDefined();
    expect(tick1.commands.find((cmd) => cmd.kind === 'volume')).toBeDefined();
  });

  /**
   * Regression coverage found while auditing all effect commands: a
   * delayed note (EDx) was triggered via `midiToFrequency(Math.round(...))`,
   * discarding the MOD's exact period-derived frequency (which encodes
   * finetune and the discrete ProTracker period table, not pure 12-TET).
   * That can land a delayed note several cents off pitch compared to an
   * immediate trigger of the same period, which normal (non-delayed) notes
   * already avoid by using the precise `noteFrequency` argument directly.
   */
  it('preserves the exact MOD period-derived frequency for a delayed note, not a MIDI-rounded one', () => {
    const state = createTrackEffectState();
    const ticksPerRow = 6;
    const delayEffect: EffectCommand = {
      type: 'noteDelay',
      paramX: 0,
      paramY: 1,
    };
    // Period 320 -> ~87.395Hz, which does not land exactly on a 12-TET
    // semitone (nearest MIDI note 41 is ~87.12Hz -- a ~5 cent difference).
    const preciseFrequency = 87.394822438;

    processEffectTick0(
      state,
      delayEffect,
      41,
      200,
      preciseFrequency,
      ticksPerRow,
    );
    const tick1 = processEffectTickN(state, delayEffect, 1, ticksPerRow);
    const noteOn = tick1.commands.find((cmd) => cmd.kind === 'noteOn');
    expect(noteOn).toBeDefined();
    if (!noteOn || noteOn.kind !== 'noteOn') return;
    expect(noteOn.frequency).toBeCloseTo(preciseFrequency, 5);

    const pitchCmd = tick1.commands.find((cmd) => cmd.kind === 'pitch');
    expect(pitchCmd).toBeDefined();
    if (!pitchCmd || pitchCmd.kind !== 'pitch') return;
    expect(pitchCmd.frequency).toBeCloseTo(preciseFrequency, 5);
  });

  /**
   * Regression coverage for using the real ProTracker period table (rather
   * than a continuous period/frequency formula) for arpeggio's semitone
   * offsets. ProTracker's table isn't a clean formula (see e.g. Raylight's
   * "Karsten-Lars Manuscript" writeup), so basePeriod/2^(n/12) can land on
   * a different period than the table -- period 856 shifted by 2
   * semitones continuously rounds to 763, but the real table entry two
   * positions up from 856 is 762.
   */
  it('arpeggio uses the real ProTracker period table, not a continuous formula', () => {
    const state = createTrackEffectState();
    const AMIGA_CLOCK = 7159090.5;
    const PAULA_TO_SYNTH_SCALE = 128;
    const freqForPeriod = (period: number) =>
      AMIGA_CLOCK / (2 * period * PAULA_TO_SYNTH_SCALE);

    const arp: EffectCommand = { type: 'arpeggio', paramX: 2, paramY: 0 };
    // Trigger a note at period 856 (period-domain, as MOD imports do via
    // noteFrequency) so arpeggio takes the table-lookup path.
    processEffectTick0(state, arp, 24, 200, freqForPeriod(856));
    const tick1 = processEffectTickN(state, arp, 1, 6); // arpeggioTick 1 -> +paramX semitones
    const pitchCmd = tick1.commands.find((cmd) => cmd.kind === 'pitch');
    expect(pitchCmd).toBeDefined();
    if (!pitchCmd || pitchCmd.kind !== 'pitch') return;

    const tableFrequency = freqForPeriod(762); // real table entry, 2 up from 856
    const continuousFrequency = freqForPeriod(763); // old formula's rounded result
    expect(pitchCmd.frequency).toBeCloseTo(tableFrequency, 6);
    expect(pitchCmd.frequency).not.toBeCloseTo(continuousFrequency, 6);
  });

  /**
   * Regression coverage for glissando control (E3x) snapping to the real
   * ProTracker period table instead of the nearest equal-tempered MIDI
   * note -- the two disagree by a fraction of a semitone in general.
   */
  it('glissando control snaps to the real ProTracker period table on a MOD/period-domain track', () => {
    const state = createTrackEffectState();
    const AMIGA_CLOCK = 7159090.5;
    const PAULA_TO_SYNTH_SCALE = 128;
    const freqForPeriod = (period: number) =>
      AMIGA_CLOCK / (2 * period * PAULA_TO_SYNTH_SCALE);

    // Trigger a note at period 856 (period-domain).
    processEffectTick0(state, undefined, 24, 200, freqForPeriod(856));

    // E3x: enable glissando control.
    const glissCtrl: EffectCommand = {
      type: 'extEffect',
      extSubtype: 'glissandoCtrl',
      paramX: 0,
      paramY: 1,
    };
    processEffectTick0(state, glissCtrl);
    expect(state.glissandoEnabled).toBe(true);

    // 3xx: tone porta with a large speed (30) towards a much lower period.
    // Real ProTracker never slides on tick 0 (tick 0 only triggers/targets
    // the row); the slide starts on tick 1, landing at exactly period 826
    // (856 - 30) before snapping -- not on a table entry.
    const tonePorta: EffectCommand = {
      type: 'tonePorta',
      paramX: 0,
      paramY: 30,
    };
    processEffectTick0(state, tonePorta, 12, 200, freqForPeriod(400));
    const tick1 = processEffectTickN(state, tonePorta, 1, 6);
    const pitchCmd = tick1.commands.find((cmd) => cmd.kind === 'pitch');
    expect(pitchCmd).toBeDefined();
    if (!pitchCmd || pitchCmd.kind !== 'pitch') return;

    const tableFrequency = freqForPeriod(808); // nearest real table entry to 826
    expect(pitchCmd.frequency).toBeCloseTo(tableFrequency, 6);
    // The old equal-tempered-MIDI snap for period 826 lands on a
    // detectably different frequency (~0.037Hz / ~2 cents off here).
    const oldEqualTemperedSnap = 34.64782887210901;
    expect(pitchCmd.frequency).not.toBeCloseTo(oldEqualTemperedSnap, 4);
  });

  /**
   * space_debris.mod, order 1 -> order 2 on channel 4: a 304/300 run slides
   * towards C-2 but runs out of pattern long before it arrives, and order 2
   * opens with A10 and then blank cells. ProTracker re-reads the effect
   * column every row, so the slide simply stops where the last 300 row left
   * it. The engine used to keep stepping it through rows that carry no tone
   * portamento, which walked the pitch far past the target.
   */
  it('stops a tone portamento on rows that carry no tone portamento', () => {
    const state = createTrackEffectState();
    const AMIGA_CLOCK = 7159090.5;
    const PAULA_TO_SYNTH_SCALE = 128;
    const freqForPeriod = (period: number) =>
      AMIGA_CLOCK / (2 * period * PAULA_TO_SYNTH_SCALE);

    // A high note, then a slow slide down towards period 856 (C-2).
    processEffectTick0(state, undefined, 53, 200, freqForPeriod(214));
    const tonePorta: EffectCommand = {
      type: 'tonePorta',
      paramX: 0,
      paramY: 4,
    };
    processEffectTick0(state, tonePorta, 24, 200, freqForPeriod(856));
    for (let tick = 1; tick < 6; tick++) {
      processEffectTickN(state, tonePorta, tick, 6);
    }
    const periodAfterSlide = state.currentPeriod;
    expect(periodAfterSlide).toBeGreaterThan(214);
    expect(periodAfterSlide).toBeLessThan(856); // nowhere near the target yet

    // Next row: a volume slide, no tone portamento.
    const volSlide: EffectCommand = { type: 'volSlide', paramX: 1, paramY: 0 };
    processEffectTick0(state, volSlide);
    for (let tick = 1; tick < 6; tick++) {
      processEffectTickN(state, volSlide, tick, 6);
    }
    expect(state.currentPeriod).toBe(periodAfterSlide);

    // And a blank row: no effect at all.
    processEffectTick0(state, undefined);
    for (let tick = 1; tick < 6; tick++) {
      const batch = processEffectTickN(state, undefined, tick, 6);
      expect(batch.commands.filter((cmd) => cmd.kind === 'pitch')).toEqual([]);
    }
    expect(state.currentPeriod).toBe(periodAfterSlide);
  });

  /**
   * Regression coverage found while auditing all effect commands: E8y
   * (extended/coarse set-pan) shares the 'setPan' EffectType with the
   * full-byte 8xx command, but encodes its value completely differently
   * (a 4-bit nibble vs. a full 0-255 byte across two params). Running E8y
   * through the 8xx formula treated its subtype marker as part of the pan
   * byte, producing a near-center-left result for every E8y value.
   */
  it('E8y (extended set-pan) uses its own 4-bit formula, not the 8xx byte formula', () => {
    const state = createTrackEffectState();
    // E8F: hard right (nibble value 15/15).
    const e8f: EffectCommand = {
      type: 'setPan',
      paramX: 8,
      paramY: 15,
      extSubtype: 'setPan',
    };
    processEffectTick0(state, e8f);
    expect(state.currentPan).toBeCloseTo(1, 5);

    const state2 = createTrackEffectState();
    // E80: hard left (nibble value 0/15).
    const e80: EffectCommand = {
      type: 'setPan',
      paramX: 8,
      paramY: 0,
      extSubtype: 'setPan',
    };
    processEffectTick0(state2, e80);
    expect(state2.currentPan).toBeCloseTo(-1, 5);

    // The plain 8xx command still uses the full-byte formula unchanged.
    const state3 = createTrackEffectState();
    const eightFF: EffectCommand = { type: 'setPan', paramX: 15, paramY: 15 };
    processEffectTick0(state3, eightFF);
    expect(state3.currentPan).toBeCloseTo((255 - 128) / 128, 5);
  });

  /**
   * Same class of bug, for Rxy/E9x retrigger: the retrigger command only
   * carried a rounded `midi` value, forcing the downstream handler to
   * fall back to an equal-tempered midiToFrequency() reconstruction
   * instead of the exact pitch that was actually sounding.
   */
  it('carries the exact currently-sounding frequency on a retrigger command', () => {
    const state = createTrackEffectState();
    const preciseFrequency = 87.394822438;
    // Establish a precise (non-12-TET-aligned) current pitch, as a normal
    // MOD note trigger would via noteFrequency.
    processEffectTick0(state, undefined, 41, 200, preciseFrequency);

    const retrigger: EffectCommand = {
      type: 'retrigVol',
      paramX: 0,
      paramY: 1,
      extSubtype: 'retrigger',
    };
    processEffectTick0(state, retrigger);
    const tick1 = processEffectTickN(state, retrigger, 1, 6);
    const retriggerCmd = tick1.commands.find((cmd) => cmd.kind === 'retrigger');
    expect(retriggerCmd).toBeDefined();
    if (!retriggerCmd || retriggerCmd.kind !== 'retrigger') return;
    expect(retriggerCmd.frequency).toBeCloseTo(preciseFrequency, 5);
  });

  it('emits volume slide commands across ticks', () => {
    const state = createTrackEffectState();
    const volSlide: EffectCommand = { type: 'volSlide', paramX: 0, paramY: 2 };

    // Prime tick 0 to capture volume slide delta
    processEffectTick0(state, volSlide, 60, 255);

    // The commands array is a per-state reusable buffer reset on every call
    // (TickCommandBatch contract: read the batch before the next call on the
    // same state), so capture tick 1's command before calling tick 2.
    const vol1 = processEffectTickN(state, volSlide, 1, 6).commands.find(
      (cmd) => cmd.kind === 'volume',
    );
    const tick2 = processEffectTickN(state, volSlide, 2, 6);
    const vol2 = tick2.commands.find((cmd) => cmd.kind === 'volume');

    // One ProTracker volume unit is 1/64 of full scale (PT volume is 0-64,
    // ours is 0-1), applied once per tick from tick 1. A02 therefore drops
    // 2/64 per tick. This deliberately states the format's rule rather than
    // mirroring the implementation constant -- it previously asserted 1/128
    // "matches vol slide scaling in effect-processor", which made the test
    // agree with a halved slide rate instead of checking it.
    const step = 1 / 64;
    expect(vol1 && 'volume' in vol1 ? vol1.volume : undefined).toBeCloseTo(
      1 - 2 * step,
      5,
    );
    expect(vol2 && 'volume' in vol2 ? vol2.volume : undefined).toBeCloseTo(
      1 - 4 * step,
      5,
    );
  });

  it('slides a full row at the authentic ProTracker rate', () => {
    // At speed 6 the slide runs on ticks 1-5, so A06 drops 5 x 6/64.
    const state = createTrackEffectState();
    const volSlide: EffectCommand = { type: 'volSlide', paramX: 0, paramY: 6 };

    processEffectTick0(state, undefined, 60, 255);
    processEffectTick0(state, volSlide, undefined);
    for (let tick = 1; tick < 6; tick++) {
      processEffectTickN(state, volSlide, tick, 6);
    }

    expect(state.currentVolume).toBeCloseTo(1 - (5 * 6) / 64, 5);
  });

  /**
   * Regression coverage for "one pattern mutes the next, but the next
   * pattern plays fine on its own": a track's currentVolume decays via a
   * volume slide (e.g. a fade-out near the end of one pattern), and a
   * later, completely unrelated new note trigger -- with no explicit
   * volume-column entry -- used to silently inherit that stale decayed
   * value instead of resetting, because processEffectTick0 only ever
   * wrote state.currentVolume when newVelocity was explicitly provided.
   * Playing the next pattern "alone" started from a fresh
   * createTrackEffectState() (currentVolume 1.0), which is why the bug
   * only showed up when patterns played back to back in the same session.
   *
   * The real fix is upstream (useTrackerSongBuilder.ts defaults
   * step.velocity to 255 for a genuine new note+instrument trigger that
   * has no explicit volume column value), but this test exercises the
   * actual engine-level symptom directly: does a fresh note-on that
   * *does* carry an explicit velocity correctly override a decayed
   * currentVolume, and does one *without* an explicit velocity correctly
   * preserve it (the deliberate "no instrument number" tracker
   * convention) -- proving the fix is precise, not a blanket reset.
   */
  it('a fresh note trigger with an explicit velocity resets a decayed currentVolume', () => {
    const state = createTrackEffectState();
    const volSlide: EffectCommand = { type: 'volSlide', paramX: 0, paramY: 15 };

    // Decay the channel's volume hard, as if fading out near the end of a
    // pattern (many ticks of a steep slide-down).
    processEffectTick0(state, volSlide, 60, 255);
    for (let tick = 1; tick <= 6; tick++) {
      processEffectTickN(state, volSlide, tick, 6);
    }
    expect(state.currentVolume).toBeLessThan(0.35);

    // A brand new note, on a genuinely different row, WITH an explicit
    // velocity (this is what useTrackerSongBuilder now supplies whenever
    // the row has an explicit instrument number, even if the tracker's own
    // volume column was left blank). processEffectTick0 doesn't emit a
    // 'volume' command for a plain note with no accompanying effect --
    // engine.ts's scheduleRow does that separately, driven directly by
    // step.velocity (see the `step.velocity !== undefined` gain push right
    // after dispatching tick 0's commands). What matters here is that the
    // *state* used as the baseline for any future slides/effects on this
    // track is correctly reset, not left at the decayed value.
    processEffectTick0(state, undefined, 64, 255);
    expect(state.currentVolume).toBeCloseTo(1.0, 5);
  });

  it('a fresh note trigger with no velocity at all preserves the current volume (no-instrument convention)', () => {
    const state = createTrackEffectState();
    const volSlide: EffectCommand = { type: 'volSlide', paramX: 0, paramY: 15 };

    processEffectTick0(state, volSlide, 60, 255);
    for (let tick = 1; tick <= 6; tick++) {
      processEffectTickN(state, volSlide, tick, 6);
    }
    const decayedVolume = state.currentVolume;
    expect(decayedVolume).toBeLessThan(0.35);

    // A note with no instrument number and no explicit volume column entry
    // -- real trackers deliberately preserve the running volume here (the
    // "record with sample 0" convention), so this must NOT reset.
    processEffectTick0(state, undefined, 64, undefined);
    expect(state.currentVolume).toBeCloseTo(decayedVolume, 5);
  });
});

describe('effect-processor reusable command buffers', () => {
  it('gives two consecutive processEffectTickN calls independent, correctly-scoped sequences', () => {
    const state = createTrackEffectState();
    const volSlide: EffectCommand = { type: 'volSlide', paramX: 0, paramY: 2 };

    // Prime tick 0 so the slides are armed, then take two consecutive
    // tick batches from the same state.
    processEffectTick0(state, volSlide, 60, 255);

    const batch1 = processEffectTickN(state, volSlide, 1, 6);
    // Snapshot call 1's sequence before call 2 (the buffer contract allows
    // reading a batch until the next call on the same state).
    const snapshot1 = batch1.commands.map((cmd) => ({ ...cmd }));

    const batch2 = processEffectTickN(state, volSlide, 2, 6);

    // Call 1 produced its own correctly-scoped sequence: exactly one volume
    // command for tick 1 (2/64 down from full scale), nothing else.
    expect(snapshot1).toHaveLength(1);
    expect(snapshot1[0]).toMatchObject({ kind: 'volume', volume: 62 / 64 });

    // The reset must give call 2 a sequence scoped to tick 2 alone -- no
    // leftovers carried over from call 1 (a missed `length = 0` reset would
    // grow the buffer across calls instead).
    expect(batch2.commands).not.toHaveLength(0);
    expect(batch2.commands).toHaveLength(1);
    expect(batch2.commands[0]).toMatchObject({
      kind: 'volume',
      volume: 60 / 64,
    });

    // Buffer reuse, not fresh arrays: the two batches share the underlying
    // per-state buffer, which is what removes the per-call allocation.
    expect(batch1.commands).toBe(batch2.commands);
  });

  it('keeps the effect-column and volume-column tick-0 batches separate', () => {
    const state = createTrackEffectState();
    const volSlide: EffectCommand = { type: 'volSlide', paramX: 0, paramY: 2 };
    const volCol: VolumeColumnCommand = { type: 'fineVolUp', value: 8 };

    // The engine produces the effect batch, then the volume batch on the
    // same state, and only afterwards reads BOTH (dispatch +
    // hasVolumeCommand). The earlier batch must survive the later call.
    const tick0 = processEffectTick0(state, volSlide, 60, 255);
    const volume0 = processVolumeColumnTick0(state, volCol);

    // The earlier batch survives the later call: each column's commands are
    // intact, and they are distinct buffers.
    expect(tick0.commands.length).toBeGreaterThan(0);
    expect(tick0.commands.some((cmd) => cmd.kind === 'volume')).toBe(true);
    expect(volume0.commands).toHaveLength(1);
    expect(volume0.commands[0]).toMatchObject({ kind: 'volume' });
    expect(tick0.commands).not.toBe(volume0.commands);
  });
});
