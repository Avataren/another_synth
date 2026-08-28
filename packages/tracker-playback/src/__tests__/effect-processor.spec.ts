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
