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

  /**
   * Regression coverage for sound.mod (a real Amiga MOD): a sustained
   * sample on one track sat under a run of rows carrying nothing but F05/
   * F06 (speed change) commands -- no note, no other effect. speedCommand/
   * tempoCommand are tracked on their own Step fields, separate from
   * step.effect, so such a row fell through to the "naked instrument
   * number, no effect at all" case above and was treated as a revive-last-
   * note trigger. Since useTrackerSongBuilder stamps instrumentId onto
   * every row of a track sticky (not just rows with an explicit instrument
   * number), *every* F05/F06-only row satisfied `instrumentId present +
   * no note + no effect`, so the sample retriggered from the start on
   * every single row instead of sustaining -- audibly, nonstop
   * retriggering instead of the intended held/repeating note.
   */
  it('does not retrigger a bare speed-change row (F05/F06), even with instrument and no effect', () => {
    const step = makeStep({ instrumentId: '01', speedCommand: 5 });
    expect(shouldRetriggerLastNote(undefined, step)).toBe(false);
  });

  it('does not retrigger a bare tempo-change row (F20+), even with instrument and no effect', () => {
    const step = makeStep({ instrumentId: '01', tempoCommand: 125 });
    expect(shouldRetriggerLastNote(undefined, step)).toBe(false);
  });

  it('still retriggers a naked instrument-only row when no speed/tempo command is present', () => {
    const step = makeStep({ instrumentId: '01' });
    expect(shouldRetriggerLastNote(undefined, step)).toBe(true);
  });
});

/**
 * The convention belongs to songs authored here, and to nothing else.
 *
 * No module format has it: in ProTracker and FT2 alike an instrument number on
 * its own selects the sample and reloads the channel volume, and never
 * retriggers (D15, D29). It survived unnoticed for MOD only because
 * mod-import stamps a volume on those rows for unrelated reasons, which trips
 * the velocity guard above.
 *
 * XM has no such accident. Once the volume column started producing steps for
 * rows that previously made none (D50), every row carrying nothing but a
 * volume-column command began reviving the channel's last note -- 26 spurious
 * retriggers per channel on three channels of elw-sick.xm and 18 on another,
 * heard as samples restarting under the music.
 */
describe('shouldRetriggerLastNote is a native-song convention', () => {
  const nakedInstrument = makeStep({ instrumentId: '01' });

  it('revives the last note for a song authored here', () => {
    expect(shouldRetriggerLastNote(undefined, nakedInstrument, true)).toBe(true);
  });

  it('never revives one for an imported module', () => {
    expect(shouldRetriggerLastNote(undefined, nakedInstrument, false)).toBe(
      false,
    );
  });

  it('does not revive on a row carrying only a volume-column command', () => {
    // Those rows have an instrument (sticky), no note, no velocity and no
    // effect-column command, so they satisfy every other condition.
    const volumeColumnOnly = makeStep({
      instrumentId: '01',
      volumeCommand: { type: 'fineVolUp', value: 3 },
    });

    expect(shouldRetriggerLastNote(undefined, volumeColumnOnly, false)).toBe(
      false,
    );
  });
});
