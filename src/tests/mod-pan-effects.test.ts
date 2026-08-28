import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type { Song, Step } from '../../packages/tracker-playback/src/types';

/**
 * Regression coverage for 8xx / E8x / Pxy panning.
 *
 * These change the pan of a note that is already sounding, but the engine's
 * pan case was `break;` with the note "pan is conveyed on noteOn events when
 * present" -- so every mid-note pan change was silently discarded, the same
 * shape of bug as 9xx sample offset.
 *
 * The effect processor works in -1..1; the instrument pan API takes 0..1
 * (0 = hard left, 0.5 = centre, 1 = hard right), so the engine converts.
 */
function runStep(step: Step) {
  const panCalls: Array<{ voiceIndex: number; pan: number; trackIndex: number }> =
    [];

  const engine = new PlaybackEngine({
    audioContext: { currentTime: 0, sampleRate: 48000 } as unknown as AudioContext,
    scheduledNoteHandler: vi.fn(),
    scheduledPanHandler: (_instrumentId, voiceIndex, pan, _time, trackIndex) => {
      panCalls.push({ voiceIndex, pan, trackIndex });
    },
  });

  const song: Song = {
    title: '',
    author: '',
    bpm: 125,
    moduleFormat: 'protracker',
    patterns: [{ id: 'p', length: 4, tracks: [{ id: 't', steps: [step] }] }],
    sequence: ['p'],
  };
  engine.loadSong(song);
  (engine as unknown as Record<string, (...a: unknown[]) => void>).scheduleRow?.(
    0,
    0,
  );

  return panCalls;
}

describe('MOD panning effects reach the instrument', () => {
  it('8xx sets pan (00 = hard left)', () => {
    const calls = runStep({
      row: 0,
      instrumentId: '01',
      midi: 60,
      effect: { type: 'setPan', paramX: 0x0, paramY: 0x0 },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.pan).toBeCloseTo(0, 5);
  });

  it('8xx 80 is centre and FF is hard right', () => {
    const centre = runStep({
      row: 0,
      instrumentId: '01',
      midi: 60,
      effect: { type: 'setPan', paramX: 0x8, paramY: 0x0 },
    });
    expect(centre[0]!.pan).toBeCloseTo(0.5, 5);

    const right = runStep({
      row: 0,
      instrumentId: '01',
      midi: 60,
      effect: { type: 'setPan', paramX: 0xf, paramY: 0xf },
    });
    expect(right[0]!.pan).toBeGreaterThan(0.99);
  });

  it('E8x uses the nibble scale rather than the 8xx byte formula', () => {
    // E8y's paramX is the subtype marker (8), not part of the pan value;
    // running it through the 8xx formula lands near hard left regardless.
    const calls = runStep({
      row: 0,
      instrumentId: '01',
      midi: 60,
      effect: {
        type: 'setPan',
        paramX: 0x8,
        paramY: 0xf,
        extSubtype: 'setPan',
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.pan).toBeGreaterThan(0.99);
  });

  it('carries the track index so pan targets the right channel', () => {
    const calls = runStep({
      row: 0,
      instrumentId: '01',
      midi: 60,
      effect: { type: 'setPan', paramX: 0x4, paramY: 0x0 },
    });

    expect(calls[0]!.trackIndex).toBe(0);
  });
});
