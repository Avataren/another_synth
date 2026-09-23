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