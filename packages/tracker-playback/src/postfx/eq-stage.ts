/**
 * The graphic equalizer stage of the post-fx rack.
 *
 * Topology (built once at construction and kept forever):
 *
 *   input --> dryGain --------------------------------> output
 *   input --> band[0] --> ... --> band[9] --> wetGain --> output
 *
 *   dryGain = 1 when bypassed, wetGain = 1 when engaged.
 *
 * Bypass is a 5 ms crossfade, like the limiter, so toggling never rewires the
 * live chain and cannot click. A bypassed EQ does not stop the biquads from
 * running; ten of them are cheap enough that the simplicity is worth it.
 */

import {
  EQ_BAND_FREQUENCIES,
  EQ_DEFAULT_PARAMS,
  EQ_PEAKING_Q,
  eqBandType,
  eqEffectiveGains,
  sanitizeEqParams,
  type EqParams,
} from './eq-math';
import {
  createDefaultNodeFactory,
  type AudioNodeFactory,
  type PostFxStage,
} from './post-fx-stage';

/** Crossfade length for bypass transitions. */
const RAMP_SECONDS = 0.005;
/** Smoothing for gain changes while the user drags a slider. */
const GAIN_SMOOTH_SECONDS = 0.02;

export class EqStage implements PostFxStage {
  readonly id = 'equalizer';

  readonly input: GainNode;
  readonly output: GainNode;

  private readonly context: BaseAudioContext;

  private readonly dryGain: GainNode;
  private readonly wetGain: GainNode;
  private readonly bands: BiquadFilterNode[] = [];

  private ownedNodes: AudioNode[] = [];

  private params: EqParams;
  private bypassed = false;

  constructor(
    context: BaseAudioContext,
    params: EqParams = EQ_DEFAULT_PARAMS,
    factory: AudioNodeFactory = createDefaultNodeFactory(context),
  ) {
    this.context = context;
    this.params = sanitizeEqParams(params);

    this.input = this.own(factory.createGain());
    this.output = this.own(factory.createGain());
    this.dryGain = this.own(factory.createGain());
    this.wetGain = this.own(factory.createGain());

    EQ_BAND_FREQUENCIES.forEach((frequency, i) => {
      const band = this.own(factory.createBiquadFilter());
      band.type = eqBandType(i);
      band.frequency.value = frequency;
      band.Q.value = EQ_PEAKING_Q;
      band.gain.value = eqEffectiveGains(this.params).gainsDb[i]!;
      this.bands.push(band);
    });

    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    let cursor: AudioNode = this.input;
    for (const band of this.bands) {
      cursor.connect(band);
      cursor = band;
    }
    cursor.connect(this.wetGain);
    this.wetGain.connect(this.output);

    // Engaged by default; the store pushes the persisted state on registration.
    this.dryGain.gain.value = 0;
    this.wetGain.gain.value = 1;
  }

  private own<T extends AudioNode>(node: T): T {
    this.ownedNodes.push(node);
    return node;
  }

  private now(): number {
    return this.context.currentTime;
  }

  /** Engage or bypass the equalizer, crossfading so the toggle cannot click. */
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

  setParams(params: EqParams): void {
    this.params = sanitizeEqParams(params);
    const at = this.now();
    // `params` are the targets the user set; the nodes get the solved gains.
    const effective = eqEffectiveGains(this.params).gainsDb;
    this.bands.forEach((band, i) => {
      band.gain.cancelScheduledValues(at);
      band.gain.setTargetAtTime(
        effective[i]!,
        at,
        GAIN_SMOOTH_SECONDS / 3,
      );
    });
  }

  getParams(): EqParams {
    return { gainsDb: [...this.params.gainsDb] };
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
    this.bands.length = 0;
  }
}
