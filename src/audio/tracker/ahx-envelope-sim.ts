/**
 * The AHX volume envelope as the engine plays it (editor plan E1): a pure TS
 * port of `AdsrState::trigger/step/hard_cut_release`
 * (`rust-wasm/src/ahx/envelope.rs:41-97`, itself `hvl_replay.c:895-901,
 * 1174-1214`), so the editor draws what the replayer does, not what the four
 * numbers seem to say.
 *
 * What differs from the "ideal" polyline (`ahxEnvelopePoints`):
 * - A stage with 0 frames is skipped by `step`; its target is never applied
 *   directly. With `aFrames = 0` the decay ramps from a real 0 by
 *   `(dVolume - aVolume) * 256 / dFrames`, so it undershoots the attack level and
 *   then snaps to `dVolume` on its last frame.
 * - With `dFrames = 0` the sustain holds the attack level, not `dVolume`.
 * - With `rFrames = 0` the note never releases.
 *
 * Levels are the engine's own `<<8` fixed point (`vc_ADSRVolume`); the
 * per-frame deltas are wrapped to 16 bits and divided with truncation toward
 * zero, exactly as the Rust does. The fixture in
 * `src/tests/fixtures/ahx-envelope-parity.json` is dumped from the real
 * `envelope.rs` (`ahx-envelope-parity.gen.rs.txt` is the dumper).
 */
import type { AhxEnvelope } from '@another-synth/tracker-playback';
import { ahxEnvelopePoints, type AhxEnvelopePoint } from 'src/audio/tracker/ahx-instrument-display';

/** Frames simulated past the last stage, so the tail of a release shows. */
export const AHX_ENVELOPE_TAIL_FRAMES = 4;

export interface AhxEnvelopeSample {
  /** Frames since the note started (one frame = one replay tick). */
  frame: number;
  /** `vc_ADSRVolume`: the volume `<< 8`. Can go negative (see `ahxEnvelopeNeverRises`). */
  level: number;
  /** The volume the voice outputs: `((level >> 8) * volume) >> 6` (`voice.rs:649`, before the PList and track scaling). */
  output: number;
}

export interface AhxHardCut {
  /** Envelope steps taken before the cut fires (the release ramp then starts). */
  before: number;
  /** `hardCutReleaseFrames`: length of the forced release ramp. */
  frames: number;
  /** `hardCutRelease`: true ramps to the release level, false mutes the note (`voice.rs:488-495`). */
  release: boolean;
}

export interface AhxEnvelopeSimulation {
  /** One sample per frame from the trigger (frame 0, level 0) to the end of release plus a short tail. */
  samples: AhxEnvelopeSample[];
  /** The ideal polyline (the four numbers taken at face value); it is what the nodes sit on. */
  ideal: AhxEnvelopePoint[];
  /** Frame at which the last stage ends (`a + d + s + r` frames). */
  endFrame: number;
  /** Lowest `level` reached (`<< 8`); below 0 means the volume swings negative. */
  lowest: number;
  /** True when some ideal point is not where the engine's curve is. */
  differs: boolean;
}

/** `wrap_i16`: the reference stores the per-frame deltas in `int16`. */
const wrapI16 = (x: number): number => (x << 16) >> 16;
/** C / Rust integer division truncates toward zero. */
const idiv = (a: number, b: number): number => Math.trunc(a / b);

interface AdsrState {
  aFrames: number;
  aDelta: number;
  dFrames: number;
  dDelta: number;
  sFrames: number;
  rFrames: number;
  rDelta: number;
  level: number;
}

/** `AdsrState::trigger` (`envelope.rs:41-71`). */
function trigger(env: AhxEnvelope): AdsrState {
  const aDelta = wrapI16(env.aFrames !== 0 ? idiv(env.aVolume * 256, env.aFrames) : env.aVolume * 256);
  const dDelta = wrapI16(
    env.dFrames !== 0 ? idiv((env.dVolume - env.aVolume) * 256, env.dFrames) : env.dVolume * 256,
  );
  const rDelta = wrapI16(
    env.rFrames !== 0 ? idiv((env.rVolume - env.dVolume) * 256, env.rFrames) : env.rVolume * 256,
  );
  return {
    aFrames: env.aFrames,
    aDelta,
    dFrames: env.dFrames,
    dDelta,
    sFrames: env.sFrames,
    rFrames: env.rFrames,
    rDelta,
    level: 0,
  };
}

/** `AdsrState::step` (`envelope.rs:74-97`): one replay tick. */
function step(state: AdsrState, env: AhxEnvelope): void {
  if (state.aFrames !== 0) {
    state.level += state.aDelta;
    state.aFrames -= 1;
    if (state.aFrames <= 0) state.level = env.aVolume << 8;
  } else if (state.dFrames !== 0) {
    state.level += state.dDelta;
    state.dFrames -= 1;
    if (state.dFrames <= 0) state.level = env.dVolume << 8;
  } else if (state.sFrames !== 0) {
    state.sFrames -= 1;
  } else if (state.rFrames !== 0) {
    state.level += state.rDelta;
    state.rFrames -= 1;
    if (state.rFrames <= 0) state.level = env.rVolume << 8;
  }
}

/** `AdsrState::hard_cut_release` (`envelope.rs:106-115`). */
function hardCutRelease(state: AdsrState, env: AhxEnvelope, frames: number): void {
  state.rFrames = wrapI16(frames);
  state.rDelta = 0;
  if (state.rFrames > 0) {
    state.rDelta = wrapI16(idiv(-(state.level - (env.rVolume << 8)), state.rFrames));
  }
  state.aFrames = 0;
  state.dFrames = 0;
  state.sFrames = 0;
}

/** Total frames the four stages take, however the frame counts are ordered. */
export function ahxEnvelopeLength(env: AhxEnvelope): number {
  return env.aFrames + env.dFrames + env.sFrames + env.rFrames;
}

/**
 * Levels after each replay tick, from the trigger (frame 0: level 0) through
 * the end of the release and `AHX_ENVELOPE_TAIL_FRAMES` more. `volume` is the
 * instrument's `volume` (0..=64), which scales the output.
 *
 * `hardCut` runs the forced release the replayer starts a few ticks before the
 * next row that has an instrument on the channel; it is what the editor's
 * "next note arrives here" marker draws. The audition voice has no next row,
 * so it never fires there.
 */
export function simulateAhxEnvelope(
  env: AhxEnvelope,
  volume = 64,
  hardCut: AhxHardCut | null = null,
): AhxEnvelopeSimulation {
  const cut = hardCut && hardCut.frames > 0 ? hardCut : null;
  const endFrame = ahxEnvelopeLength(env);
  const frames = Math.max(endFrame, cut ? cut.before + cut.frames : 0) + AHX_ENVELOPE_TAIL_FRAMES;
  const state = trigger(env);
  let muted = false;
  const output = (): number => (muted ? 0 : ((state.level >> 8) * volume) >> 6);
  const samples: AhxEnvelopeSample[] = [{ frame: 0, level: state.level, output: output() }];
  let lowest = state.level;
  for (let frame = 1; frame <= frames; frame++) {
    if (cut && frame - 1 === cut.before) {
      // A hard cut with the release off silences the note instead (`voice.rs:488-495`).
      if (cut.release) hardCutRelease(state, env, cut.frames);
      else muted = true;
    }
    step(state, env);
    lowest = Math.min(lowest, state.level);
    samples.push({ frame, level: state.level, output: output() });
  }
  const ideal = ahxEnvelopePoints(env);
  const differs = ideal.some((p) => samples[p.frame] !== undefined && samples[p.frame]!.level >> 8 !== p.volume);
  return { samples, ideal, endFrame, lowest, differs };
}

/** A sample's level as a volume (fractional): `level / 256`. */
export const ahxLevelToVolume = (level: number): number => level / 256;
