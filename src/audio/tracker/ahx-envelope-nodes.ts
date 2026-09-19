/**
 * The geometry and edit rules behind the envelope editor's draggable nodes
 * (editor plan E2), kept pure so they are testable without a DOM.
 *
 * The four nodes sit on the ideal envelope (the numbers taken at face value):
 * A at `(aFrames, aVolume)`, D at `(aFrames + dFrames, dVolume)`, S (a diamond,
 * horizontal only) at `(… + sFrames, dVolume)` and R at `(… + rFrames, rVolume)`.
 * Dragging a node's X changes only that stage's frame count, so every later node
 * shifts right with it (ripple); Y changes the stage's volume.
 */
import type { AhxEnvelope } from '@another-synth/tracker-playback';

export type AhxEnvelopeNode = 'A' | 'D' | 'S' | 'R';

export const AHX_ENVELOPE_NODES: readonly AhxEnvelopeNode[] = ['A', 'D', 'S', 'R'];

interface NodeSpec {
  name: string;
  frames: keyof AhxEnvelope;
  volume?: keyof AhxEnvelope;
  /** The stages before this one, whose frames the node's X is counted after. */
  before: ReadonlyArray<keyof AhxEnvelope>;
}

const SPECS: Record<AhxEnvelopeNode, NodeSpec> = {
  A: { name: 'Attack', frames: 'aFrames', volume: 'aVolume', before: [] },
  D: { name: 'Decay', frames: 'dFrames', volume: 'dVolume', before: ['aFrames'] },
  S: { name: 'Sustain', frames: 'sFrames', before: ['aFrames', 'dFrames'] },
  R: { name: 'Release', frames: 'rFrames', volume: 'rVolume', before: ['aFrames', 'dFrames', 'sFrames'] },
};

export const MAX_STAGE_FRAMES = 255;
export const MAX_LEVEL = 64;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(v)));

export const ahxNodeName = (node: AhxEnvelopeNode): string => SPECS[node].name;
export const ahxNodeFramesField = (node: AhxEnvelopeNode): keyof AhxEnvelope => SPECS[node].frames;
export const ahxNodeVolumeField = (node: AhxEnvelopeNode): keyof AhxEnvelope | undefined => SPECS[node].volume;
/** A node with no level of its own (sustain) only moves sideways. */
export const ahxNodeIsHorizontalOnly = (node: AhxEnvelopeNode): boolean => SPECS[node].volume === undefined;

/** Frame at which the node's stage begins: the frames of every stage before it. */
export function ahxNodeStart(env: AhxEnvelope, node: AhxEnvelopeNode): number {
  return SPECS[node].before.reduce((sum, field) => sum + env[field], 0);
}

/** Where the node sits on the ideal envelope. */
export function ahxNodePosition(env: AhxEnvelope, node: AhxEnvelopeNode): { frame: number; level: number } {
  const spec = SPECS[node];
  // The sustain holds the decay level.
  const level = env[spec.volume ?? 'dVolume'];
  return { frame: ahxNodeStart(env, node) + env[spec.frames], level };
}

/**
 * The envelope fields a node dragged to `(frame, level)` sets: its stage's
 * frames and, when it has one, its level. Both are always named, never only the
 * ones that changed, so a drag that returns to where it began puts the value
 * back. Values snap to whole frames and levels and are held to what a stage can
 * store (0..=255 frames, 0..=64 level).
 */
export function ahxNodeDragPatch(
  env: AhxEnvelope,
  node: AhxEnvelopeNode,
  frame: number,
  level: number,
): Partial<AhxEnvelope> {
  const spec = SPECS[node];
  const patch: Partial<AhxEnvelope> = {
    [spec.frames]: clamp(frame - ahxNodeStart(env, node), 0, MAX_STAGE_FRAMES),
  };
  if (spec.volume) patch[spec.volume] = clamp(level, 0, MAX_LEVEL);
  return patch;
}

/** Keys a focused node answers to. */
export const ENVELOPE_NODE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const;

/**
 * The patch for an arrow key on a focused node: left/right move its frames by
 * 1 (Shift 8), up/down its level by 1 (Shift 4). `null` when the node does not
 * use the key (any other key; up/down on the sustain), so the caller leaves it
 * alone: Escape still goes back to the tracker.
 */
export function ahxNodeKeyPatch(
  env: AhxEnvelope,
  node: AhxEnvelopeNode,
  key: string,
  shift: boolean,
): Partial<AhxEnvelope> | null {
  const spec = SPECS[node];
  const { frame, level } = ahxNodePosition(env, node);
  switch (key) {
    case 'ArrowLeft':
      return ahxNodeDragPatch(env, node, frame - (shift ? 8 : 1), level);
    case 'ArrowRight':
      return ahxNodeDragPatch(env, node, frame + (shift ? 8 : 1), level);
    case 'ArrowUp':
      return spec.volume ? ahxNodeDragPatch(env, node, frame, level + (shift ? 4 : 1)) : null;
    case 'ArrowDown':
      return spec.volume ? ahxNodeDragPatch(env, node, frame, level - (shift ? 4 : 1)) : null;
    default:
      return null;
  }
}

/** "Attack: 4 frames, level 64" (the sustain has no level). */
export function ahxNodeValueText(env: AhxEnvelope, node: AhxEnvelopeNode): string {
  const spec = SPECS[node];
  const frames = env[spec.frames];
  const head = `${spec.name}: ${frames} ${frames === 1 ? 'frame' : 'frames'}`;
  return spec.volume ? `${head}, level ${env[spec.volume]}` : `${head}, holds the decay level`;
}

/**
 * The frames axis: the largest frame shown. It is fitted to the envelope with
 * headroom (`max(total * 1.25, 32)`) and rounded up to a whole tick, so one
 * arrow-key step rarely rescales the graph. A drag freezes it at pointer-down
 * (the caller keeps the value) so the graph never rescales under the cursor.
 */
export function ahxAxisFrames(totalFrames: number): number {
  const wanted = Math.max(totalFrames * 1.25, 32);
  const step = ahxTickStep(wanted);
  return Math.ceil(wanted / step) * step;
}

/** A "nice" tick spacing (1/2/5/10/25/50 x 10^n) giving about 6-10 ticks over `max`. */
export function ahxTickStep(max: number): number {
  for (const step of [1, 2, 5, 10, 25, 50, 100, 250]) {
    if (max / step <= 10) return step;
  }
  return 250;
}

export function ahxTicks(max: number): number[] {
  const step = ahxTickStep(max);
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  return ticks;
}
