// Shared interface for the instruments the song bank manages.
//
// N4 (arch-review-2026-09-22): `ActiveInstrument.instrument` was the raw
// union `InstrumentV2 | ModInstrument | PooledInstrument` with no common
// interface, so every capability check in the bank was a runtime `instanceof`
// probe or an `as unknown as {...}` cast (including one on every scheduled
// note-on), and the stores cast through `as InstrumentV2`. This is the
// polymorphic surface the bank actually calls; all three classes implement
// it. Members only some classes have are optional and probed through the
// type (setEnvelopePositionAtTime) instead of through inline structural
// casts.
//
// `ModInstrument` implements the surface by inheritance: the members live on
// the library's `TrackerSamplerInstrument` (its `workletNode` is always null
// there, which is what the bank's per-note param probe relies on -- it
// guards on worklet truthiness).
import type { Patch } from 'src/audio/types/preset-types';
import type {
  VoiceNodeType,
  NodeConnectionUpdate,
  EnvelopeConfig,
} from 'src/audio/types/synth-layout';
import type {
  WasmModulationType,
  ModulationTransformation,
  PortId,
} from 'app/public/wasm/audio_processor';

/** The note-on options the bank passes through from scheduled events. */
export interface BankNoteOnOptions {
  /** Reuse a voice already playing this note (tracker retrigger semantics). */
  allowDuplicate?: boolean;
  /** Explicit frequency (Ornament/finetune paths), else from the note. */
  frequency?: number;
  pan?: number;
  /** Start offset into the sample in *frames* (ProTracker 9xx: param*256). */
  sampleOffsetFrames?: number;
  /** Duration of one tracker tick in seconds, for envelope timing. */
  tickSeconds?: number;
  /** Tracker channel this note belongs to; owns a voice of its own. */
  trackIndex?: number;
  /** Per-track visualiser tap; carries this channel alone. */
  monitorNode?: AudioNode;
}

/**
 * The members `TrackerSongBank` calls on any of its three instrument
 * implementations. Voice-index, gate and gain addressing all go through
 * here, which is what keeps per-voice command dispatch (D78) typed end to
 * end.
 */
export interface BankInstrument {
  readonly isReady: boolean;
  readonly outputNode: AudioNode;
  readonly workletNode: AudioWorkletNode | null;

  loadPatch(patch: Patch): Promise<void>;
  dispose(): void;

  noteOnAtTime(
    noteNumber: number,
    velocity: number,
    time: number,
    options?: BankNoteOnOptions,
  ): number | undefined;
  noteOffAtTime(noteNumber: number, time: number, trackIndex?: number): void;
  noteOn(noteNumber: number, velocity: number): void;
  noteOff(noteNumber: number, voiceIndex?: number): void;
  gateOffVoiceAtTime(voiceIndex: number, time: number): void;
  cancelScheduledNotes(): void;
  cancelAndSilenceVoice(voiceIndex: number): void;
  allNotesOff(): void;

  setOutputGain(gain: number, time?: number): void;
  getOutputGain(): number;
  setGainForAllVoices(gain: number, time?: number): void;
  getQuantumDurationSeconds(): number;
  getVoiceLimit(): number;

  setVoiceFrequencyAtTime(
    voiceIndex: number,
    frequency: number,
    time: number,
    rampMode?: 'linear' | 'exponential',
  ): void;
  setVoiceGainAtTime(
    voiceIndex: number,
    gain: number,
    time: number,
    rampMode?: 'linear' | 'exponential' | 'step',
  ): void;
  setVoiceMacroAtTime(
    voiceIndex: number,
    macroIndex: number,
    value: number,
    time?: number,
  ): void;
  setMacro(
    macroIndex: number,
    value: number,
    time?: number,
    rampToValue?: number,
    rampTime?: number,
    interpolation?: 'linear' | 'exponential',
  ): void;
  /** Tracker auto-envelope tick; not every implementation supports it. */
  setEnvelopePositionAtTime?(
    voiceIndex: number,
    tick: number,
    time: number,
  ): void;
}

/**
 * The editor-facing instrument surface: what instrument-store, patch-store,
 * the asset store and AudioSyncManager call on `currentInstrument`.
 *
 * N4 step 2 (arch-review-2026-09-22): the stores used to cast through
 * `as InstrumentV2` even though `currentInstrument` can hold a
 * `PooledInstrument` at runtime (live editing swaps the bank's instrument
 * in). PooledInstrument carries the same editor surface (node-state updates,
 * asset import, reverb generation, arpeggiator), so both classes implement
 * this interface and the casts are gone. Editor calls type through here
 * instead of a lie about the concrete class.
 */
export interface EditableInstrument extends BankInstrument {
  connectMacroRoute(payload: {
    macroIndex: number;
    targetId: string;
    targetPort: PortId;
    amount: number;
    modulationType: WasmModulationType;
    modulationTransformation: ModulationTransformation;
  }): void;
  createNode(node: VoiceNodeType): Promise<string>;
  deleteNode(nodeId: string): void;
  updateConnection(connection: NodeConnectionUpdate): void;
  getWasmNodeConnections(): Promise<string>;
  generateHallReverb(
    nodeId: string,
    decayTime: number,
    roomSize: number,
  ): Promise<void>;
  generatePlateReverb(
    nodeId: string,
    decayTime: number,
    diffusion: number,
  ): Promise<void>;
  getFilterResponse(nodeId: string, length: number): Promise<Float32Array>;
  getLfoWaveform(
    waveform: number,
    phaseOffset: number,
    frequency: number,
    bufferSize: number,
    useAbsolute: boolean,
    useNormalized: boolean,
  ): Promise<Float32Array>;
  updateArpeggiatorPattern(nodeId: string, pattern: unknown): void;
  updateArpeggiatorStepDuration(nodeId: string, duration: number): void;

  updateOscillatorState(nodeId: string, state: unknown): void;
  updateWavetableOscillatorState(nodeId: string, state: unknown): void;
  updateEnvelopeState(nodeId: string, state: unknown): void | Promise<void>;
  updateLfoState(nodeId: string, state: unknown): void;
  updateFilterState(nodeId: string, state: unknown): void;
  updateGlideState(nodeId: string, state: unknown): void;
  updateConvolverState(nodeId: string, state: unknown): void;
  updateDelayState(nodeId: string, state: unknown): void;
  updateChorusState(nodeId: string, state: unknown): void;
  updateReverbState(nodeId: string, state: unknown): void;
  updateCompressorState(nodeId: string, state: unknown): void;
  updateSaturationState(nodeId: string, state: unknown): void;
  updateBitcrusherState(nodeId: string, state: unknown): void;
  updateNoiseState(nodeId: string, state: unknown): void;
  updateVelocityState(nodeId: string, state: unknown): void;
  updateSamplerState(nodeId: string, state: unknown): void;

  importSampleData(nodeId: string, bytes: Uint8Array): void | Promise<void>;
  importImpulseWaveformData(nodeId: string, bytes: Uint8Array): void;
  importWavetableData(nodeId: string, bytes: Uint8Array): void;

  /** Export surface; keeps EditableInstrument assignable to AudioAssetSource. */
  exportSamplerData(nodeId: string): Promise<{
    samples: Float32Array;
    sampleRate: number;
    channels: number;
    rootNote: number;
  }>;
  exportConvolverData(nodeId: string): Promise<{
    samples: Float32Array;
    sampleRate: number;
    channels: number;
  }>;

  getEnvelopePreview(
    config: EnvelopeConfig,
    previewDuration: number,
  ): Promise<Float32Array>;
  getSamplerWaveform(nodeId: string, maxLength?: number): Promise<Float32Array>;
}