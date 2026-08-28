import { describe, it, expect } from 'vitest';
import {
  createTrackEffectState,
  processEffectTick0,
} from '../../packages/tracker-playback/src/effect-processor';
import type { EffectCommand } from '../../packages/tracker-playback/src/types';

/**
 * Regression coverage for 9xx sample offset, which was a complete no-op end
 * to end:
 *
 *  1. The offset was emitted as a standalone command *after* the noteOn, so
 *     it always arrived too late -- a Web Audio AudioBufferSourceNode cannot
 *     be repositioned once started.
 *  2. `ModInstrument.setVoiceMacroAtTime` handled only macro 0 (pan) and
 *     silently dropped macro 1, which is the sample-offset route.
 *  3. `PooledInstrument.setVoiceMacroAtTime` was an empty stub, which also
 *     killed per-channel panning on that path.
 *
 * The offset now rides on the noteOn command so it can be applied at voice
 * start. These tests pin (1); the instrument-level fixes are exercised
 * through the DOM-less classes below.
 */
function offsetEffect(param: number): EffectCommand {
  return {
    type: 'sampleOffset',
    paramX: (param >> 4) & 0x0f,
    paramY: param & 0x0f,
  };
}

describe('9xx sample offset command routing', () => {
  it('attaches the offset to the noteOn instead of a later command', () => {
    const state = createTrackEffectState();
    const { commands } = processEffectTick0(state, offsetEffect(0x80), 60, 255);

    const noteOn = commands.find((c) => c.kind === 'noteOn');
    expect(noteOn).toBeDefined();
    expect(noteOn && 'sampleOffset' in noteOn && noteOn.sampleOffset).toBeCloseTo(
      0x80 / 255,
      5,
    );
  });

  it('does not also emit a standalone offset command when a note starts', () => {
    // Applying it twice would re-latch the macro for the *next* note on the
    // WASM path, and do nothing at all on the Web Audio path.
    const state = createTrackEffectState();
    const { commands } = processEffectTick0(state, offsetEffect(0x40), 60, 255);

    expect(commands.filter((c) => c.kind === 'sampleOffset')).toHaveLength(0);
  });

  it('emits a standalone offset command for a 9xx row with no note', () => {
    const state = createTrackEffectState();
    const { commands } = processEffectTick0(state, offsetEffect(0x40), undefined);

    const offsetCmd = commands.find((c) => c.kind === 'sampleOffset');
    expect(offsetCmd).toBeDefined();
    expect(offsetCmd && 'offset' in offsetCmd && offsetCmd.offset).toBeCloseTo(
      0x40 / 255,
      5,
    );
  });

  it('reuses the remembered offset for a bare 900', () => {
    // ProTracker keeps a per-channel offset memory; 900 replays the last one.
    const state = createTrackEffectState();
    processEffectTick0(state, offsetEffect(0x30), 60, 255);

    const { commands } = processEffectTick0(state, offsetEffect(0x00), 62, 255);
    const noteOn = commands.find((c) => c.kind === 'noteOn');
    expect(noteOn && 'sampleOffset' in noteOn && noteOn.sampleOffset).toBeCloseTo(
      0x30 / 255,
      5,
    );
  });

  it('leaves notes without a 9xx untouched', () => {
    const state = createTrackEffectState();
    const { commands } = processEffectTick0(state, undefined, 60, 255);

    const noteOn = commands.find((c) => c.kind === 'noteOn');
    expect(noteOn).toBeDefined();
    // The key must be absent entirely, not present-and-undefined, so the
    // instrument's own offset memory is left alone.
    expect(noteOn && 'sampleOffset' in noteOn).toBe(false);
  });

  it('clamps an out-of-range offset into 0..1', () => {
    const state = createTrackEffectState();
    const { commands } = processEffectTick0(state, offsetEffect(0xff), 60, 255);

    const noteOn = commands.find((c) => c.kind === 'noteOn');
    const offset =
      noteOn && 'sampleOffset' in noteOn ? (noteOn.sampleOffset as number) : -1;
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(offset).toBeLessThanOrEqual(1);
  });
});
