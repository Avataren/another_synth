import { describe, expect, it } from 'vitest';

import {
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN
} from '../effect-processor';
import type { EffectCommand } from '../types';

describe('effect-processor command batches', () => {
  it('delays note-on until the configured tick', () => {
    const state = createTrackEffectState();
    const ticksPerRow = 6;
    const delayEffect: EffectCommand = { type: 'noteDelay', paramX: 0, paramY: 1 };

    const tick0 = processEffectTick0(state, delayEffect, 60, 200, undefined, ticksPerRow);
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
    const delayEffect: EffectCommand = { type: 'noteDelay', paramX: 0, paramY: 1 };
    // Period 320 -> ~87.395Hz, which does not land exactly on a 12-TET
    // semitone (nearest MIDI note 41 is ~87.12Hz -- a ~5 cent difference).
    const preciseFrequency = 87.394822438;

    processEffectTick0(state, delayEffect, 41, 200, preciseFrequency, ticksPerRow);
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
    const tonePorta: EffectCommand = { type: 'tonePorta', paramX: 0, paramY: 30 };
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

    const tick1 = processEffectTickN(state, volSlide, 1, 6);
    const tick2 = processEffectTickN(state, volSlide, 2, 6);

    const vol1 = tick1.commands.find((cmd) => cmd.kind === 'volume');
    const vol2 = tick2.commands.find((cmd) => cmd.kind === 'volume');

    const step = 1 / 128; // matches vol slide scaling in effect-processor
    expect(vol1 && 'volume' in vol1 ? vol1.volume : undefined).toBeCloseTo(1 - 2 * step, 5);
    expect(vol2 && 'volume' in vol2 ? vol2.volume : undefined).toBeCloseTo(1 - 4 * step, 5);
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
