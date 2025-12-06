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
});
