import { describe, it, expect } from 'vitest';
import {
  createTrackEffectState,
  processEffectTick0,
} from '@another-synth/tracker-playback';
import type { EffectCommand } from '@another-synth/tracker-playback';

/**
 * Regression coverage for 9xx sample offset.
 *
 * Two rounds of bugs are pinned here. First, the offset used to be emitted as
 * a standalone command *after* the noteOn, so it always arrived too late -- a
 * Web Audio AudioBufferSourceNode cannot be repositioned once started -- and
 * it now rides on the noteOn itself.
 *
 * Second, the value was expressed as a 0-1 fraction of the sample
 * (`param / 255`). ProTracker's 9xx is an absolute distance, `param * 256`
 * frames, so the fraction was only right for a sample of exactly 65280
 * frames; everything else started somewhere else entirely, which is heard as
 * a click where the sample should have been picked up cleanly. The command
 * now carries frames, and the instrument that owns the buffer resolves them.
 */
function offsetEffect(param: number): EffectCommand {
  return {
    type: 'sampleOffset',
    paramX: (param >> 4) & 0x0f,
    paramY: param & 0x0f,
  };
}

describe('9xx sample offset command routing', () => {
  it('attaches the offset to the noteOn, in frames', () => {
    const state = createTrackEffectState();
    const { commands } = processEffectTick0(state, offsetEffect(0x80), 60, 255);

    const noteOn = commands.find((c) => c.kind === 'noteOn');
    expect(noteOn).toBeDefined();
    expect(
      noteOn && 'sampleOffsetFrames' in noteOn && noteOn.sampleOffsetFrames,
    ).toBe(0x80 * 256);
  });

  it('does not also emit a standalone offset command when a note starts', () => {
    // Applying it twice would re-latch the macro for the *next* note on the
    // WASM path, and do nothing at all on the Web Audio path.
    const state = createTrackEffectState();
    const { commands } = processEffectTick0(state, offsetEffect(0x40), 60, 255);

    expect(commands.filter((c) => c.kind === 'sampleOffset')).toHaveLength(0);
  });

  it('emits nothing audible for a 9xx row with no note', () => {
    // ProTracker only consults the offset where a note arms the sample
    // pointer, so a bare 9xx just updates the channel's memory. Emitting a
    // standalone command latched the offset onto whatever note came next --
    // possibly on another channel, and carrying no 9xx of its own.
    const state = createTrackEffectState();
    const { commands } = processEffectTick0(state, offsetEffect(0x40), undefined);

    expect(commands.find((c) => c.kind === 'sampleOffset')).toBeUndefined();
    expect(commands.find((c) => c.kind === 'noteOn')).toBeUndefined();
  });

  it('reuses the remembered offset for a bare 900', () => {
    // ProTracker keeps a per-channel offset memory; 900 replays the last one.
    const state = createTrackEffectState();
    processEffectTick0(state, offsetEffect(0x30), 60, 255);

    const { commands } = processEffectTick0(state, offsetEffect(0x00), 62, 255);
    const noteOn = commands.find((c) => c.kind === 'noteOn');
    expect(
      noteOn && 'sampleOffsetFrames' in noteOn && noteOn.sampleOffsetFrames,
    ).toBe(0x30 * 256);
  });

  it('remembers an offset set by a 9xx row that carried no note', () => {
    const state = createTrackEffectState();
    processEffectTick0(state, offsetEffect(0x30), undefined);

    const { commands } = processEffectTick0(state, offsetEffect(0x00), 60, 255);
    const noteOn = commands.find((c) => c.kind === 'noteOn');
    expect(
      noteOn && 'sampleOffsetFrames' in noteOn && noteOn.sampleOffsetFrames,
    ).toBe(0x30 * 256);
  });

  it('leaves notes without a 9xx untouched', () => {
    const state = createTrackEffectState();
    const { commands } = processEffectTick0(state, undefined, 60, 255);

    const noteOn = commands.find((c) => c.kind === 'noteOn');
    expect(noteOn).toBeDefined();
    // The key must be absent entirely, not present-and-undefined, so the
    // instrument's own offset memory is left alone.
    expect(noteOn && 'sampleOffsetFrames' in noteOn).toBe(false);
  });

  it('does not clamp a large offset -- the instrument resolves overruns', () => {
    // Only the instrument knows how long its sample is, so clamping here
    // (as the old 0-1 fraction had to) would throw the position away.
    const state = createTrackEffectState();
    const { commands } = processEffectTick0(state, offsetEffect(0xff), 60, 255);

    const noteOn = commands.find((c) => c.kind === 'noteOn');
    expect(
      noteOn && 'sampleOffsetFrames' in noteOn && noteOn.sampleOffsetFrames,
    ).toBe(0xff * 256);
  });
});
