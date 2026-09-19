// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AhxEnvelope } from '@another-synth/tracker-playback';
import {
  ahxAxisFrames,
  ahxNodeDragPatch,
  ahxNodeKeyPatch,
  ahxNodePosition,
  ahxNodeValueText,
  ahxTicks,
} from 'src/audio/tracker/ahx-envelope-nodes';

const env: AhxEnvelope = { aFrames: 4, aVolume: 64, dFrames: 6, dVolume: 40, sFrames: 10, rFrames: 8, rVolume: 5 };

describe('envelope node geometry (E2)', () => {
  it('puts A, D, S and R where the ideal envelope has them', () => {
    expect(ahxNodePosition(env, 'A')).toEqual({ frame: 4, level: 64 });
    expect(ahxNodePosition(env, 'D')).toEqual({ frame: 10, level: 40 });
    expect(ahxNodePosition(env, 'S')).toEqual({ frame: 20, level: 40 }); // holds the decay level
    expect(ahxNodePosition(env, 'R')).toEqual({ frame: 28, level: 5 });
  });

  it('dragging a node sets only its stage: X becomes that stage\'s frames, later nodes ripple', () => {
    // D dragged to frame 16, level 30: decay lasts 16 - 4 = 12 frames.
    expect(ahxNodeDragPatch(env, 'D', 16, 30)).toEqual({ dFrames: 12, dVolume: 30 });
    expect(ahxNodeDragPatch(env, 'S', 30, 99)).toEqual({ sFrames: 20 }); // sustain: horizontal only
    expect(ahxNodeDragPatch(env, 'R', 40, 12)).toEqual({ rFrames: 20, rVolume: 12 });
  });

  it('snaps to integers and clamps to what a stage stores', () => {
    expect(ahxNodeDragPatch(env, 'A', 2.6, 63.4)).toEqual({ aFrames: 3, aVolume: 63 });
    expect(ahxNodeDragPatch(env, 'A', -20, 200)).toEqual({ aFrames: 0, aVolume: 64 });
    expect(ahxNodeDragPatch(env, 'A', 9999, -5)).toEqual({ aFrames: 255, aVolume: 0 });
    // Dragged left of the previous node: the stage cannot go negative.
    expect(ahxNodeDragPatch(env, 'D', 1, 40)).toEqual({ dFrames: 0, dVolume: 40 });
  });

  it('a drag that comes back to where it began names the same values, so it restores them', () => {
    expect(ahxNodeDragPatch(env, 'A', 4, 64)).toEqual({ aFrames: 4, aVolume: 64 });
  });
});

describe('envelope node keyboard (E2)', () => {
  it('left/right move frames by 1, Shift 8; up/down move the level by 1, Shift 4', () => {
    expect(ahxNodeKeyPatch(env, 'A', 'ArrowRight', false)).toEqual({ aFrames: 5, aVolume: 64 });
    expect(ahxNodeKeyPatch(env, 'A', 'ArrowLeft', true)).toEqual({ aFrames: 0, aVolume: 64 });
    expect(ahxNodeKeyPatch(env, 'D', 'ArrowUp', false)).toEqual({ dFrames: 6, dVolume: 41 });
    expect(ahxNodeKeyPatch(env, 'D', 'ArrowDown', true)).toEqual({ dFrames: 6, dVolume: 36 });
    expect(ahxNodeKeyPatch(env, 'R', 'ArrowRight', true)).toEqual({ rFrames: 16, rVolume: 5 });
  });

  it('the sustain ignores up/down, and any other key (Escape!) is not handled', () => {
    expect(ahxNodeKeyPatch(env, 'S', 'ArrowUp', false)).toBeNull();
    expect(ahxNodeKeyPatch(env, 'S', 'ArrowRight', false)).toEqual({ sFrames: 11 });
    for (const key of ['Escape', 'Tab', 'Enter', 'a']) expect(ahxNodeKeyPatch(env, 'A', key, false)).toBeNull();
  });

  it('reads like "Attack: 4 frames, level 64"', () => {
    expect(ahxNodeValueText(env, 'A')).toBe('Attack: 4 frames, level 64');
    expect(ahxNodeValueText({ ...env, aFrames: 1 }, 'A')).toBe('Attack: 1 frame, level 64');
    expect(ahxNodeValueText(env, 'S')).toBe('Sustain: 10 frames, holds the decay level');
  });
});

describe('envelope axis (E2)', () => {
  it('fits with headroom, at least 32 frames, on a whole tick', () => {
    expect(ahxAxisFrames(0)).toBe(35);
    expect(ahxAxisFrames(28)).toBe(35);
    expect(ahxAxisFrames(200)).toBeGreaterThanOrEqual(250);
  });
  it('offers nice ticks', () => {
    expect(ahxTicks(32)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(ahxTicks(400).length).toBeLessThanOrEqual(11);
  });
});
