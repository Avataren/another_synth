/**
 * The post-fx rack: an ordered chain of `PostFxStage`s wired
 * `input -> stage[0] -> ... -> stage[n] -> output`.
 *
 * `AudioSystem` owns one rack: `destinationNode -> rack.input`,
 * `rack.output -> audioContext.destination`. Every stage is registered at
 * construction time and wired then -- there is no per-block rewiring. A
 * disabled stage is skipped in the chain (its input/output leave the graph)
 * rather than nulled out, so future effects can be toggled without touching
 * `AudioSystem` again.
 */

import type { PostFxStage } from './post-fx-stage';

export class PostFxRack {
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly context: BaseAudioContext;

  /** Audio clock of the owning context (store-facing time source). */
  contextTime(): number {
    return this.context.currentTime;
  }
  private readonly entries: Array<{ stage: PostFxStage; enabled: boolean }> =
    [];

  constructor(context: BaseAudioContext) {
    this.context = context;
    this.input = context.createGain();
    this.output = context.createGain();
    // Until a stage registers, pass audio straight through.
    this.input.connect(this.output);
  }

  /** Append a stage (enabled) and rewire the chain. */
  registerStage(stage: PostFxStage): void {
    this.entries.push({ stage, enabled: true });
    this.rebuild();
  }

  setStageEnabled(stage: PostFxStage, enabled: boolean): void {
    const entry = this.entries.find((e) => e.stage === stage);
    if (!entry || entry.enabled === enabled) return;
    entry.enabled = enabled;
    this.rebuild();
  }

  /** Current chain, in order, disabled stages omitted. */
  activeStages(): PostFxStage[] {
    return this.entries.filter((e) => e.enabled).map((e) => e.stage);
  }

  private rebuild(): void {
    this.input.disconnect();
    for (const { stage } of this.entries) {
      stage.output.disconnect();
    }
    let cursor: AudioNode = this.input;
    for (const { stage, enabled } of this.entries) {
      if (!enabled) continue;
      cursor.connect(stage.input);
      cursor = stage.output;
    }
    cursor.connect(this.output);
  }

  dispose(): void {
    for (const { stage } of this.entries) {
      stage.dispose();
    }
    this.entries.length = 0;
    try {
      this.input.disconnect();
      this.output.disconnect();
    } catch {
      // Already detached.
    }
  }
}