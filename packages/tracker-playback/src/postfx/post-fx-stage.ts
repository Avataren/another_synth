/**
 * Post-fx stage seam: the contract every effect in the post-fx rack
 * implements, and the node factory tests inject instead of a real
 * AudioContext.
 *
 * The rack runs right before the speaker sink -- `AudioSystem.destinationNode`
 * feeds the rack, the rack feeds `audioContext.destination` -- so everything
 * the app plays (tracker bank, jukebox, patch editor) passes through it once.
 * Stages are appended in order; each owns its internal graph and is
 * responsible for its own bypass behaviour.
 */

/** A single effect stage in the post-fx chain. */
export interface PostFxStage {
  /** Stable identifier, e.g. `amiga-lpf`. */
  readonly id: string;
  /** Where the rack feeds audio into this stage. */
  readonly input: AudioNode;
  /** Where this stage hands audio to the next stage (or the output). */
  readonly output: AudioNode;
  /** Drop the whole internal graph. Called once, never reused. */
  dispose(): void;
}

/**
 * The only Web Audio construction the post-fx module performs, routed through
 * this seam. Production uses the real context methods; tests inject a stub
 * factory whose nodes record connections and AudioParam events (see
 * `__tests__/postfx-stage.spec.ts` in this package).
 */
export interface AudioNodeFactory {
  createGain(): GainNode;
  createIIRFilter(feedforward: number[], feedback: number[]): IIRFilterNode;
}

/** Real-node factory used everywhere outside tests. */
export function createDefaultNodeFactory(context: BaseAudioContext): AudioNodeFactory {
  return {
    createGain: () => context.createGain(),
    createIIRFilter: (feedforward, feedback) =>
      context.createIIRFilter(feedforward, feedback),
  };
}