/**
 * The brickwall limiter: the last stage in the post-fx rack.
 *
 * Motivation: a loud module (dope.mod is the standard example) sums four or
 * more full-scale channels into a mix that clips the output, and the only
 * remedy was to ride the master volume slider per song. This stage holds a
 * ceiling instead, so one comfortable master level works for every song.
 *
 * Topology (built once at construction and kept forever):
 *
 *   input --> dryGain -------------------------------------------> output
 *   input --> compressor --> shaper --> wetGain ------------------> output
 *
 *   dryGain = 1 when bypassed, wetGain = 1 when engaged.
 *
 * Bypass is an internal 5 ms crossfade rather than
 * `PostFxRack.setStageEnabled`, which rewires the live chain and would click.
 * See `limiter-math.ts` for why the compressor and the shaper are both
 * needed.
 *
 * Latency: `DynamicsCompressorNode` reports a small processing delay (~6 ms
 * in Chrome, from its internal lookahead). The rack sits on the master bus,
 * so that applies to live playing too; it is below the threshold of feel, and
 * the toggle is the escape hatch for anyone who disagrees.
 */

import {
  buildLimiterCurve,
  dbToLinear,
  LIMITER_ATTACK_SECONDS,
  LIMITER_DEFAULT_PARAMS,
  LIMITER_KNEE_DB,
  LIMITER_RATIO,
  sanitizeLimiterParams,
  type LimiterParams,
} from './limiter-math';
import {
  createDefaultNodeFactory,
  type AudioNodeFactory,
  type PostFxStage,
} from './post-fx-stage';

/** Crossfade length for bypass transitions. */
const RAMP_SECONDS = 0.005;

export class LimiterStage implements PostFxStage {
  readonly id = 'limiter';

  readonly input: GainNode;
  readonly output: GainNode;

  private readonly context: BaseAudioContext;

  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly compressor: DynamicsCompressorNode;
  private readonly shaper: WaveShaperNode;

  private ownedNodes: AudioNode[] = [];

  private params: LimiterParams;
  private bypassed = false;

  constructor(
    context: BaseAudioContext,
    params: LimiterParams = LIMITER_DEFAULT_PARAMS,
    factory: AudioNodeFactory = createDefaultNodeFactory(context),
  ) {
    this.context = context;
    this.params = sanitizeLimiterParams(params);

    this.input = this.own(factory.createGain());
    this.output = this.own(factory.createGain());
    this.dryGain = this.own(factory.createGain());
    this.wetGain = this.own(factory.createGain());
    this.compressor = this.own(factory.createDynamicsCompressor());
    this.shaper = this.own(factory.createWaveShaper());

    // The settings that make this a limiter rather than a compressor never
    // change, so they are written once here (see limiter-math).
    this.compressor.ratio.value = LIMITER_RATIO;
    this.compressor.knee.value = LIMITER_KNEE_DB;
    this.compressor.attack.value = LIMITER_ATTACK_SECONDS;
    // 4x oversampling: the shaper only bends the signal near the ceiling, but
    // when it does, the harmonics it generates must not fold back into the
    // audible band.
    this.shaper.oversample = '4x';
    this.applyParamsToNodes();

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.compressor);
    this.compressor.connect(this.shaper);
    this.shaper.connect(this.wetGain);
    this.wetGain.connect(this.output);

    // Engaged by default; the store pushes the persisted state on registration.
    this.dryGain.gain.value = 0;
    this.wetGain.gain.value = 1;
  }

  private own<T extends AudioNode>(node: T): T {
    this.ownedNodes.push(node);
    return node;
  }

  private applyParamsToNodes(): void {
    const ceilingLinear = dbToLinear(this.params.ceilingDb);
    this.compressor.threshold.value = this.params.ceilingDb;
    this.compressor.release.value = this.params.releaseMs / 1000;
    this.shaper.curve = buildLimiterCurve(ceilingLinear);
  }

  private now(): number {
    return this.context.currentTime;
  }

  /** Engage or bypass the limiter, crossfading so the toggle cannot click. */
  setBypassed(bypassed: boolean, time: number = this.now()): void {
    if (this.bypassed === bypassed) return;
    this.bypassed = bypassed;
    const at = Math.max(time, this.now());
    const dryTarget = bypassed ? 1 : 0;
    const faders: Array<[GainNode, number]> = [
      [this.dryGain, dryTarget],
      [this.wetGain, 1 - dryTarget],
    ];
    for (const [fader, target] of faders) {
      fader.gain.cancelScheduledValues(at);
      fader.gain.setValueAtTime(fader.gain.value, at);
      fader.gain.linearRampToValueAtTime(target, at + RAMP_SECONDS);
    }
  }

  isBypassed(): boolean {
    return this.bypassed;
  }

  /**
   * Gain reduction in dB right now (<= 0), for the UI meter. Reads 0 while
   * bypassed: the compressor is still running (it is only faded out of the
   * mix), and a meter that moved on a bypassed stage would be a lie.
   */
  getReduction(): number {
    if (this.bypassed) return 0;
    const reduction = this.compressor.reduction;
    return typeof reduction === 'number' && Number.isFinite(reduction)
      ? reduction
      : 0;
  }

  setParams(params: LimiterParams): void {
    this.params = sanitizeLimiterParams(params);
    this.applyParamsToNodes();
  }

  getParams(): LimiterParams {
    return { ...this.params };
  }

  dispose(): void {
    for (const node of this.ownedNodes) {
      try {
        node.disconnect();
      } catch {
        // A node may already be out of the graph; disconnecting twice is fine.
      }
    }
    this.ownedNodes = [];
  }
}
