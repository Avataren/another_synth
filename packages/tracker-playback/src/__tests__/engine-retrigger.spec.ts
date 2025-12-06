import { describe, expect, it } from 'vitest';

import { shouldRetriggerLastNote } from '../engine';
import type { EffectCommand, Step } from '../types';

function makeStep(partial: Partial<Step>): Step {
  return {
    row: 0,
    ...partial,
  };
}

describe('shouldRetriggerLastNote', () => {
  const volSlide: EffectCommand = { type: 'volSlide', paramX: 0, paramY: 2 };
  const vibrato: EffectCommand = { type: 'vibrato', paramX: 1, paramY: 1 };

  it('does not retrigger naked volSlide rows (no instrument)', () => {
    const step = makeStep({ effect: volSlide });
    expect(shouldRetriggerLastNote(undefined, step)).toBe(false);
  });

  it('does not retrigger volSlide rows without a note even when instrument is present', () => {
    const step = makeStep({ instrumentId: '01', effect: volSlide });
    expect(shouldRetriggerLastNote(undefined, step)).toBe(false);
  });

  it('retrigger volSlide rows when instrument and note are present', () => {
    const step = makeStep({ instrumentId: '01', effect: volSlide, midi: 60 });
    expect(shouldRetriggerLastNote(undefined, step)).toBe(true);
  });

  it('does not retrigger when velocity is set', () => {
    const step = makeStep({ instrumentId: '01', velocity: 64, effect: volSlide });
    expect(shouldRetriggerLastNote(undefined, step)).toBe(false);
  });

  it('does not retrigger when another effect is present', () => {
    const step = makeStep({ instrumentId: '01', effect: vibrato });
    expect(shouldRetriggerLastNote(undefined, step)).toBe(false);
  });

  it('retrigger when instrument is present and there is no effect', () => {
    const step = makeStep({ instrumentId: '01' });
    expect(shouldRetriggerLastNote(undefined, step)).toBe(true);
  });

  it('does not retrigger when a new note is present', () => {
    const step = makeStep({ instrumentId: '01', effect: volSlide });
    expect(shouldRetriggerLastNote(60, step)).toBe(false);
  });
});
