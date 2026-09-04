/**
 * The Amiga-style low-pass filter: the first stage in the post-fx rack (D114).
 *
 * Topology (all branches built once at construction and kept forever):
 *
 *   input --> dryGain -----------------------------------------> output
 *   input --> rcFilter --> ledFilter --> wetGain ---------------> output
 *   input --> rcFilter ----------------> rcBypassGain ---------> output
 *
 *   dryGain        = 1 only in manual OFF (full bypass, RC out of circuit)
 *   rcBypassGain   = 1 only when the LED filter is off (AUTO-off: the static
 *                    RC filter stays in circuit -- hardware-faithful, D116)
 *   wetGain        = 1 only when the LED filter is on (AUTO-on / manual ON)
 *
 * `IIRFilterNode` coefficients cannot be scheduled on the audio clock, and
 * the playback engine schedules 0.5-1 s ahead of the audio clock, so every
 * state change is a sample-accurate crossfade: the target branch's fader
 * ramps to 1 while the others ramp to 0, via `setValueAtTime` +
 * `linearRampToValueAtTime` AudioParam events. No main-thread timers.
 *
 * Each stereo filter node filters L and R independently with the same
 * coefficients -- equivalent to one instance per channel for an LTI stage,
 * which is what "one instance per stereo channel" needs (D114).
 */

import {
  AMIGA_LPF_DEFAULT_PARAMS,
  deriveAmigaLpfCoefficients,
  sanitizeAmigaLpfParams,
  type AmigaLpfCoefficients,
  type AmigaLpfParams,
} from './amiga-filter-math';
import {
  createDefaultNodeFactory,
  type AudioNodeFactory,
  type PostFxStage,
} from './post-fx-stage';

/** Crossfade length for branch transitions. */
const RAMP_SECONDS = 0.005;

interface BranchTargets {
  dry: number;
  rcBypass: number;
  wet: number;
}

function targetsFor(bypassed: boolean, ledActive: boolean): BranchTargets {
  if (bypassed) return { dry: 1, rcBypass: 0, wet: 0 };
  if (ledActive) return { dry: 0, rcBypass: 0, wet: 1 };
  return { dry: 0, rcBypass: 1, wet: 0 };
}

export class AmigaLpfStage implements PostFxStage {
  readonly id = 'amiga-lpf';

  readonly input: GainNode;
  readonly output: GainNode;

  private readonly context: BaseAudioContext;
  private readonly factory: AudioNodeFactory;

  private dryGain: GainNode;
  private rcBypassGain: GainNode;
  private wetGain: GainNode;
  private rcFilter: IIRFilterNode;
  private ledFilter: IIRFilterNode;

  private ownedNodes: AudioNode[] = [];

  private params: AmigaLpfParams;
  private coefficients: AmigaLpfCoefficients;

  /** The state in effect right now (or at the last applied transition). */
  private currentBypassed = false;
  private currentLedActive = false;

  /** The one pending future transition, if any. */
  private pending: { time: number; bypassed: boolean; led: boolean } | null =
    null;

  constructor(
    context: BaseAudioContext,
    params: AmigaLpfParams = AMIGA_LPF_DEFAULT_PARAMS,
    factory: AudioNodeFactory = createDefaultNodeFactory(context),
  ) {
    this.context = context;
    this.factory = factory;
    this.params = sanitizeAmigaLpfParams(params);
    this.coefficients = deriveAmigaLpfCoefficients(
      context.sampleRate,
      this.params,
    );

    this.input = this.buildGain();
    this.output = this.buildGain();

    this.dryGain = this.buildGain();
    this.rcBypassGain = this.buildGain();
    this.wetGain = this.buildGain();
    this.rcFilter = this.buildRcNode();
    this.ledFilter = this.buildLedNode();

    this.wireFilterChain();

    // Initial fader state: AUTO-off (static RC engaged, LED bypassed).
    const initial = targetsFor(this.currentBypassed, this.currentLedActive);
    this.dryGain.gain.value = initial.dry;
    this.rcBypassGain.gain.value = initial.rcBypass;
    this.wetGain.gain.value = initial.wet;
  }

  private buildGain(): GainNode {
    const node = this.factory.createGain();
    this.ownedNodes.push(node);
    return node;
  }

  private buildRcNode(): IIRFilterNode {
    const { rc } = this.coefficients;
    const node = this.factory.createIIRFilter(
      [rc.b0, rc.b1],
      [1, rc.a1],
    );
    this.ownedNodes.push(node);
    return node;
  }

  private buildLedNode(): IIRFilterNode {
    const { led } = this.coefficients;
    const node = this.factory.createIIRFilter(
      [led.b0, led.b1, led.b2],
      [1, led.a1, led.a2],
    );
    this.ownedNodes.push(node);
    return node;
  }

  private wireFilterChain(): void {
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(this.rcFilter);
    this.rcFilter.connect(this.ledFilter);
    this.ledFilter.connect(this.wetGain);
    this.wetGain.connect(this.output);
    this.rcFilter.connect(this.rcBypassGain);
    this.rcBypassGain.connect(this.output);
  }

  private now(): number {
    return this.context.currentTime;
  }

  /** The fader values that should hold at `this.now()` for the current state. */
  private currentTargets(): BranchTargets {
    return targetsFor(this.currentBypassed, this.currentLedActive);
  }

  /**
   * Write a transition into the fader AudioParams.
   *
   * Each fader is pinned to its pre-transition value at `time` and ramps to
   * its target over RAMP_SECONDS, so back-to-back scheduled transitions chain
   * correctly even when the engine schedules them seconds ahead.
   */
  private scheduleTransition(
    bypassed: boolean,
    ledActive: boolean,
    time: number,
  ): void {
    const now = this.now();
    const at = Math.max(time, now);

    // The faders must start each ramp from the value the *previous* scheduled
    // transition leaves them at, so back-to-back E0x events chain correctly
    // even when both are still in the future.
    let previousTargets: BranchTargets;
    if (this.pending && this.pending.time <= at) {
      if (this.pending.time <= now) {
        // The pending transition has already fired on the audio clock.
        this.currentBypassed = this.pending.bypassed;
        this.currentLedActive = this.pending.led;
        this.pending = null;
        previousTargets = this.currentTargets();
      } else {
        previousTargets = targetsFor(this.pending.bypassed, this.pending.led);
      }
    } else {
      previousTargets = this.currentTargets();
    }

    if (at <= now) {
      // Immediate: the state is now; drop any pending automation and assert.
      this.currentBypassed = bypassed;
      this.currentLedActive = ledActive;
      this.pending = null;
      this.cancelPending(now);
      return;
    }

    const targets = targetsFor(bypassed, ledActive);
    const faders: Array<[GainNode, number, number]> = [
      [this.dryGain, previousTargets.dry, targets.dry],
      [this.rcBypassGain, previousTargets.rcBypass, targets.rcBypass],
      [this.wetGain, previousTargets.wet, targets.wet],
    ];
    for (const [fader, from, to] of faders) {
      fader.gain.setValueAtTime(from, at);
      fader.gain.linearRampToValueAtTime(to, at + RAMP_SECONDS);
    }
    this.pending = { time: at, bypassed, led: ledActive };
  }

  /**
  /**
   * Toggle the LED filter (stage B) at audio time `time`.
   *
   * Sample-accurate and safe to call with times up to the engine's whole
   * lookahead window.
   */
  setLedActive(active: boolean, time: number): void {
    // Resolve against the pending state, not the lagging `current*` fields:
    // an un-bypass at t3 after a scheduled LED toggle at t2 must keep the
    // toggled state.
    this.scheduleTransition(this.isBypassed(), active, time);
  }

  /** Full bypass (manual OFF) or re-engage the filter chain. */
  setBypassed(bypassed: boolean, time: number): void {
    this.scheduleTransition(bypassed, this.getLedActive(), time);
  }

  /**
   * Drop every not-yet-fired transition and re-assert the current resolved
   * state at `now`. Invoked on mode switch, song load and playback stop so an
   * already-scheduled E0x cannot fire after the override (D116).
   */
  cancelPending(now: number): void {
    if (this.pending && this.pending.time > now) {
      this.pending = null;
    } else if (this.pending) {
      // Its time has passed: it *is* the current state now.
      this.currentBypassed = this.pending.bypassed;
      this.currentLedActive = this.pending.led;
      this.pending = null;
    }
    for (const fader of [this.dryGain, this.rcBypassGain, this.wetGain]) {
      fader.gain.cancelScheduledValues(now);
    }
    const targets = this.currentTargets();
    this.dryGain.gain.setValueAtTime(targets.dry, now);
    this.rcBypassGain.gain.setValueAtTime(targets.rcBypass, now);
    this.wetGain.gain.setValueAtTime(targets.wet, now);
  }

  /** The LED state this stage will be in once pending transitions resolve. */
  getLedActive(): boolean {
    if (this.pending) return this.pending.led;
    return this.currentLedActive;
  }

  isBypassed(): boolean {
    if (this.pending) return this.pending.bypassed;
    return this.currentBypassed;
  }

  /**
   * Apply a new parameter set. `IIRFilterNode` coefficients are fixed at
   * creation, so the filter nodes are rebuilt (faders and wiring untouched,
   * so any scheduled crossfade keeps its shape).
   */
  setParams(params: AmigaLpfParams): void {
    const next = sanitizeAmigaLpfParams(params);
    this.params = next;
    this.coefficients = deriveAmigaLpfCoefficients(
      this.context.sampleRate,
      this.params,
    );

    // Rebuild the filter nodes with the new coefficients. `IIRFilterNode`
    // coefficients are fixed at creation, so the nodes are swapped out;
    // faders and the bypass/dry wiring are untouched, so any scheduled
    // crossfade keeps its shape.
    const oldRc = this.rcFilter;
    const oldLed = this.ledFilter;
    this.rcFilter = this.buildRcNode();
    this.ledFilter = this.buildLedNode();

    this.input.disconnect(oldRc);
    oldLed.disconnect();
    this.ownedNodes = this.ownedNodes.filter(
      (n) => n !== oldRc && n !== oldLed,
    );

    this.input.connect(this.rcFilter);
    this.rcFilter.connect(this.ledFilter);
    this.ledFilter.connect(this.wetGain);
    this.rcFilter.connect(this.rcBypassGain);
  }

  /** Coefficients currently applied to the nodes (test seam, D114 pins). */
  getCoefficients(): AmigaLpfCoefficients {
    return this.coefficients;
  }

  getParams(): AmigaLpfParams {
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

