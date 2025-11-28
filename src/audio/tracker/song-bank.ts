import type AudioSystem from 'src/audio/AudioSystem';
import InstrumentV2 from 'src/audio/instrument-v2';
import type {
  AudioAsset,
  Patch,
  MacroRouteState,
} from 'src/audio/types/preset-types';
import {
  deserializePatch,
  type DeserializedPatch,
  parseAudioAssetId,
} from 'src/audio/serialization/patch-serializer';
import {
  WasmModulationType,
  ModulationTransformation,
  PortId,
} from 'app/public/wasm/audio_processor';
import {
  synthLayoutToPatchLayout,
  type SynthLayout,
  type FilterState,
  type EnvelopeConfig,
  type LfoState,
  type SamplerState,
  type GlideState,
  type ConvolverState,
  type DelayState,
  type ChorusState,
  type ReverbState,
  type CompressorState,
  type SaturationState,
  type BitcrusherState,
} from 'src/audio/types/synth-layout';
import type OscillatorState from 'src/audio/models/OscillatorState';
import {
  PRESET_SCHEMA_VERSION,
  type PatchMetadata,
  type SynthState,
} from 'src/audio/types/preset-types';
import {
  combineDetuneParts,
  frequencyFromDetune,
} from 'src/audio/utils/sampler-detune';
import { getSharedAudioSystem } from 'src/audio/shared-audio-system';

export interface SongBankSlot {
  instrumentId: string;
  patch: Patch;
}

interface ActiveInstrument {
  instrument: InstrumentV2;
  patchId: string;
  patchSignature: string | null;
  hasPortamento: boolean;
}

type PendingScheduledEvent =
  | {
      kind: 'noteOn';
      instrumentId: string;
      midi: number;
      velocity: number;
      time: number;
      trackIndex?: number;
      enqueuedAt: number;
    }
  | {
      kind: 'noteOff';
      instrumentId: string;
      midi?: number;
      time: number;
      trackIndex?: number;
      enqueuedAt: number;
    };

const MIN_SCHEDULE_LEAD_SECONDS = 0.01;
const MAX_PENDING_SCHEDULED_EVENTS = 2048;

export class TrackerSongBank {
  private generation = 0;
  private readonly audioSystem: AudioSystem;
  private readonly masterGain: GainNode;
  private readonly desired: Map<string, Patch> = new Map();
  private readonly instruments: Map<string, ActiveInstrument> = new Map();
  private readonly activeNotes: Map<string, Map<number, Set<number>>> =
    new Map();
  private readonly lastTrackVoice: Map<string, Map<number, number>> = new Map();
  /** Track all voices allocated to each track: instrumentId -> trackIndex -> Set<voiceIndex> */
  private readonly trackVoices: Map<string, Map<number, Set<number>>> =
    new Map();
  private readonly restoredAssets: Map<string, Set<string>> = new Map();
  private readonly pendingInstruments: Map<string, Promise<void>> = new Map();
  private pendingScheduledEvents: PendingScheduledEvent[] = [];
  private flushingPendingScheduled = false;
  private wasSuspended = false;
  private needsAudioContextResume = false;
  private recorderNode: AudioWorkletNode | null = null;
  private recordedBuffers: Float32Array[] = [];
  private recording = false;

  constructor(audioSystem?: AudioSystem) {
    this.audioSystem = audioSystem ?? getSharedAudioSystem();
    this.masterGain = this.audioSystem.audioContext.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.audioSystem.destinationNode);

    // If the AudioContext resumes after we deferred a sync, rebuild instruments
    // using the last requested slot state so playback doesn't stay silent.
    this.audioSystem.audioContext.onstatechange = () => {
      if (
        this.audioSystem.audioContext.state === 'running' &&
        this.needsAudioContextResume
      ) {
        const pendingSlots: SongBankSlot[] = Array.from(
          this.desired.entries(),
        ).map(([instrumentId, patch]) => ({ instrumentId, patch }));
        if (pendingSlots.length > 0) {
          void this.syncSlots(pendingSlots);
        }
      }
    };
  }

  get output(): AudioNode {
    return this.masterGain;
  }

  get needsResume(): boolean {
    return this.needsAudioContextResume;
  }

  get audioContext(): AudioContext {
    return this.audioSystem.audioContext;
  }

  /** Get the output node for a specific instrument (for visualization) */
  getInstrumentOutput(instrumentId: string): AudioNode | null {
    const active = this.instruments.get(instrumentId);
    return active?.instrument.outputNode ?? null;
  }

  /** Get the InstrumentV2 instance for a specific instrument (for live editing) */
  getInstrument(instrumentId: string): InstrumentV2 | null {
    const active = this.instruments.get(instrumentId);
    return active?.instrument ?? null;
  }

  /** Set the master volume (0.0 to 1.0) */
  setMasterVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.masterGain.gain.value = clamped;
  }

  /** Get the current master volume */
  getMasterVolume(): number {
    return this.masterGain.gain.value;
  }

  private syncInProgress = false;

  async syncSlots(slots: SongBankSlot[]): Promise<void> {
    console.log(`[SongBank] syncSlots called with ${slots.length} slots`);
    console.log(
      `[SongBank] Current instruments before sync: [${Array.from(this.instruments.keys()).join(', ')}]`,
    );
    console.log(`[SongBank] AudioContext state: ${this.audioContext.state}`);
    console.log(
      `[SongBank] MasterGain connected: ${this.masterGain.numberOfOutputs > 0}, gain value: ${this.masterGain.gain.value}`,
    );
    // Verify destinationNode connection
    console.log(
      `[SongBank] AudioSystem destinationNode outputs: ${this.audioSystem.destinationNode.numberOfOutputs}`,
    );

    // Prevent concurrent syncs - wait for previous sync to complete
    if (this.syncInProgress) {
      console.log('[SongBank] Sync already in progress, waiting...');
      // Wait for the current sync to finish (poll every 50ms)
      while (this.syncInProgress) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      console.log('[SongBank] Previous sync completed, proceeding');
    }

    this.syncInProgress = true;
    try {
      // Build desired patch map up front so it is available even if the context
      // cannot be resumed yet. This allows prepareInstrument() during playback
      // to find the correct patch once the AudioContext is running again.
      const nextDesired = new Map<string, Patch>();
      for (const slot of slots) {
        if (!slot.instrumentId) continue;
        nextDesired.set(slot.instrumentId, this.normalizePatch(slot.patch));
      }

      // Update desired patches immediately so playback can prepare instruments
      // later even if we have to bail out before connecting to the AudioContext.
      this.desired.clear();
      for (const [id, patch] of nextDesired.entries()) {
        this.desired.set(id, patch);
      }

      // Tear down instruments no longer referenced in the slots before we try
      // to resume audio. This keeps the active set aligned with desired state
      // even if we have to defer instrument creation until after a resume.
      const wantedIds = new Set(nextDesired.keys());
      for (const [id] of this.instruments.entries()) {
        if (!wantedIds.has(id)) {
          console.log(`[SongBank] Tearing down unwanted instrument: ${id}`);
          this.teardownInstrument(id);
        }
      }

      // Resume context if suspended, and set flag so we rebuild instruments
      let contextRunning = true;
      if (this.audioContext.state === 'suspended') {
        this.wasSuspended = true;
        contextRunning = await this.ensureAudioContextRunning();
      } else {
        contextRunning = await this.ensureAudioContextRunning();
      }

      if (!contextRunning || this.audioContext.state !== 'running') {
        console.warn(
          `[SongBank] AudioContext not running after resume attempt (state=${this.audioContext.state}). Deferring syncSlots and flagging needsResume.`,
        );
        return;
      }

      if (this.wasSuspended && this.audioContext.state === 'running') {
        // Recreate instruments after a resume to avoid stale worklet state
        console.log('[SongBank] Disposing all instruments after resume');
        this.disposeInstruments();
        this.wasSuspended = false;
      }

      const ensureTasks: Promise<void>[] = [];
      for (const [instrumentId, patch] of nextDesired.entries()) {
        console.log(
          `[SongBank] Ensuring instrument: ${instrumentId}, patch: ${patch?.metadata?.id}`,
        );
        ensureTasks.push(this.ensureInstrument(instrumentId, patch));
      }

      await Promise.all(ensureTasks);

      console.log(
        `[SongBank] syncSlots complete, active instruments: ${Array.from(this.instruments.keys()).join(', ')}`,
      );
      // Verify all instruments are properly connected
      for (const [id, active] of this.instruments.entries()) {
        const hasOutput = active.instrument.outputNode.numberOfOutputs > 0;
        console.log(
          `[SongBank] Instrument ${id} output connected: ${hasOutput}`,
        );
      }

      // Try to flush any scheduled events that were queued while suspended/loading
      await this.flushPendingScheduledEvents();
    } finally {
      this.syncInProgress = false;
    }
  }

  async prepareInstrument(instrumentId?: string): Promise<void> {
    if (!instrumentId) return;
    const patch = this.desired.get(instrumentId);
    if (!patch) return;
    await this.ensureInstrument(instrumentId, patch);
  }

  dispose() {
    this.disposeInstruments();
    this.masterGain.disconnect();
    this.recorderNode?.disconnect();
    this.recorderNode = null;
  }

  private disposeInstruments() {
    for (const id of Array.from(this.instruments.keys())) {
      this.teardownInstrument(id);
    }
    this.activeNotes.clear();
    this.lastTrackVoice.clear();
    this.restoredAssets.clear();
  }

  allNotesOff() {
    for (const [instrumentId, active] of this.instruments.entries()) {
      const byTrack = this.activeNotes.get(instrumentId);
      if (byTrack) {
        for (const notes of byTrack.values()) {
          for (const note of notes) {
            active.instrument.noteOff(note);
          }
          notes.clear();
        }
        byTrack.clear();
      }
      // Also send a gate-low in case the set was empty but a gate is stuck
      active.instrument.allNotesOff();
    }
    this.trackVoices.clear();
  }

  /**
   * Stop all notes playing on a specific track across all instruments.
   * Cancels all scheduled events and silences voices immediately.
   * Used when muting a track during playback.
   */
  notesOffForTrack(trackIndex: number) {
    for (const [instrumentId, active] of this.instruments.entries()) {
      // Cancel and silence all voices allocated to this track
      const voices = this.getVoicesForTrack(instrumentId, trackIndex);
      if (voices && voices.size > 0) {
        for (const voiceIndex of voices) {
          active.instrument.cancelAndSilenceVoice(voiceIndex);
        }
      }
      this.clearVoicesForTrack(instrumentId, trackIndex);

      // Clear the note tracking for this track
      const byTrack = this.activeNotes.get(instrumentId);
      const notes = byTrack?.get(trackIndex);
      notes?.clear();

      // Clear the last voice tracking for this track
      this.clearLastVoiceForTrack(instrumentId, trackIndex);
    }
  }

  private getTrackNotes(
    instrumentId: string,
    trackIndex: number | undefined,
  ): Set<number> {
    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;
    let byTrack = this.activeNotes.get(instrumentId);
    if (!byTrack) {
      byTrack = new Map();
      this.activeNotes.set(instrumentId, byTrack);
    }
    let notes = byTrack.get(trackKey);
    if (!notes) {
      notes = new Set<number>();
      byTrack.set(trackKey, notes);
    }
    return notes;
  }

  private setLastVoiceForTrack(
    instrumentId: string,
    trackIndex: number | undefined,
    voiceIndex: number,
  ) {
    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;
    let byTrack = this.lastTrackVoice.get(instrumentId);
    if (!byTrack) {
      byTrack = new Map();
      this.lastTrackVoice.set(instrumentId, byTrack);
    }
    byTrack.set(trackKey, voiceIndex);
  }

  private takeLastVoiceForTrack(
    instrumentId: string,
    trackIndex: number | undefined,
  ): number | undefined {
    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;
    const byTrack = this.lastTrackVoice.get(instrumentId);
    const voice = byTrack?.get(trackKey);
    if (voice !== undefined) {
      byTrack?.delete(trackKey);
    }
    return voice;
  }

  private clearLastVoiceForTrack(
    instrumentId: string,
    trackIndex: number | undefined,
  ) {
    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;
    const byTrack = this.lastTrackVoice.get(instrumentId);
    byTrack?.delete(trackKey);
  }

  /**
   * Add a voice to the track's voice set
   */
  private addVoiceToTrack(
    instrumentId: string,
    trackIndex: number | undefined,
    voiceIndex: number,
  ) {
    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;
    let byTrack = this.trackVoices.get(instrumentId);
    if (!byTrack) {
      byTrack = new Map();
      this.trackVoices.set(instrumentId, byTrack);
    }
    let voices = byTrack.get(trackKey);
    if (!voices) {
      voices = new Set();
      byTrack.set(trackKey, voices);
    }
    voices.add(voiceIndex);
  }

  /**
   * Remove a voice from the track's voice set
   */
  private removeVoiceFromTrack(
    instrumentId: string,
    trackIndex: number | undefined,
    voiceIndex: number,
  ) {
    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;
    const byTrack = this.trackVoices.get(instrumentId);
    const voices = byTrack?.get(trackKey);
    voices?.delete(voiceIndex);
  }

  /**
   * Get all voices currently allocated to a track
   */
  private getVoicesForTrack(
    instrumentId: string,
    trackIndex: number,
  ): Set<number> | undefined {
    const byTrack = this.trackVoices.get(instrumentId);
    return byTrack?.get(trackIndex);
  }

  /**
   * Clear all voice tracking for a specific track
   */
  private clearVoicesForTrack(instrumentId: string, trackIndex: number) {
    const byTrack = this.trackVoices.get(instrumentId);
    byTrack?.delete(trackIndex);
  }

  private enqueueScheduledEvent(event: PendingScheduledEvent) {
    if (this.pendingScheduledEvents.length >= MAX_PENDING_SCHEDULED_EVENTS) {
      // Drop the oldest to avoid unbounded growth
      this.pendingScheduledEvents.shift();
      console.warn(
        '[SongBank] Pending scheduled event queue is full; dropping oldest event.',
      );
    }
    this.pendingScheduledEvents.push(event);
  }

  private getEnqueueTimestamp(): number {
    if (
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
    ) {
      return performance.now();
    }
    return Date.now();
  }

  private async flushPendingScheduledEvents(
    instrumentId?: string,
  ): Promise<void> {
    if (this.flushingPendingScheduled) return;
    this.flushingPendingScheduled = true;
    try {
      const now = this.audioContext.currentTime;
      const remaining: PendingScheduledEvent[] = [];

      for (const event of this.pendingScheduledEvents) {
        if (instrumentId && event.instrumentId !== instrumentId) {
          remaining.push(event);
          continue;
        }

        const active = this.instruments.get(event.instrumentId);
        const contextReady = this.audioContext.state === 'running';
        if (!active || !active.instrument.isReady || !contextReady) {
          remaining.push(event);
          continue;
        }

        const scheduledTime = Math.max(
          event.time,
          now + MIN_SCHEDULE_LEAD_SECONDS,
        );
        if (event.kind === 'noteOn') {
          this.dispatchNoteOnAtTime(
            event.instrumentId,
            event.midi,
            event.velocity,
            scheduledTime,
            event.trackIndex,
          );
        } else {
          this.dispatchNoteOffAtTime(
            event.instrumentId,
            event.midi,
            scheduledTime,
            event.trackIndex,
          );
        }
      }

      this.pendingScheduledEvents = remaining;
    } finally {
      this.flushingPendingScheduled = false;
    }
  }

  private gateOffPreviousTrackVoice(
    instrumentId: string,
    trackIndex: number | undefined,
    time: number,
  ) {
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    if (active.hasPortamento) return;
    const instrument = active.instrument;
    const previousVoice = this.takeLastVoiceForTrack(instrumentId, trackIndex);
    if (previousVoice !== undefined) {
      const gateLead = this.getGateLeadTime(instrument);
      const gateTime = Math.max(this.audioContext.currentTime, time - gateLead);
      instrument.gateOffVoiceAtTime(previousVoice, gateTime);
    }
  }

  /** Return a small lead time (seconds) to drop the gate before retriggering. */
  private getGateLeadTime(instrument: InstrumentV2): number {
    // Ensure at least one quantum of gate-low so the automation frame sees the edge.
    // Fallback to ~5ms if we don't know the block size.
    const quantum = instrument.getQuantumDurationSeconds();
    return Math.max(quantum, 0.005);
  }

  /** Start capturing stereo audio from the master bus */
  async startRecording(): Promise<void> {
    await this.ensureRecorderNode();
    this.recordedBuffers = [];
    this.recording = true;
  }

  /** Stop capture and return interleaved Float32 data */
  async stopRecording(): Promise<{
    interleaved: Float32Array;
    sampleRate: number;
  }> {
    this.recording = false;
    const totalFrames = this.recordedBuffers.reduce(
      (sum, buf) => sum + buf.length,
      0,
    );
    const merged = new Float32Array(totalFrames);
    let offset = 0;
    for (const buf of this.recordedBuffers) {
      merged.set(buf, offset);
      offset += buf.length;
    }
    return {
      interleaved: merged,
      sampleRate: this.audioSystem.audioContext.sampleRate,
    };
  }

  private async ensureRecorderNode(): Promise<void> {
    if (this.recorderNode) return;
    await this.audioSystem.audioContext.audioWorklet.addModule(
      `${import.meta.env.BASE_URL}worklets/recording-worklet.js`,
    );
    this.recorderNode = new AudioWorkletNode(
      this.audioSystem.audioContext,
      'recording-processor',
      { numberOfInputs: 1, numberOfOutputs: 0 },
    );
    this.masterGain.connect(this.recorderNode);
    this.recorderNode.port.onmessage = (event: MessageEvent) => {
      if (!this.recording) return;
      const data = event.data as Float32Array | undefined;
      if (!data) return;
      // Copy to keep buffers alive after transfer
      this.recordedBuffers.push(new Float32Array(data));
    };
  }

  noteOn(
    instrumentId: string | undefined,
    midi: number,
    velocity = 100,
    trackIndex?: number,
  ) {
    if (this.audioContext.state === 'suspended') {
      this.wasSuspended = true;
    }
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    const now = this.audioContext.currentTime;
    this.gateOffPreviousTrackVoice(instrumentId, trackIndex, now);
    const voiceIndex = active.instrument.noteOnAtTime(midi, velocity, now, {
      allowDuplicate: true,
    });

    this.getTrackNotes(instrumentId, trackIndex).add(midi);
    if (voiceIndex !== undefined) {
      this.setLastVoiceForTrack(instrumentId, trackIndex, voiceIndex);
    }
  }

  /**
   * Realtime preview note-on (no per-track voice gating/stealing).
   * Used by the tracker keyboard preview so chords behave like the patch editor.
   */
  previewNoteOn(
    instrumentId: string | undefined,
    midi: number,
    velocity = 100,
  ) {
    console.log(
      `[SongBank] previewNoteOn: inst=${instrumentId}, midi=${midi}, vel=${velocity}`,
    );
    if (this.audioContext.state === 'suspended') {
      this.wasSuspended = true;
    }
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) {
      console.warn(
        `[SongBank] previewNoteOn: instrument ${instrumentId} not found!`,
      );
      return;
    }
    console.log(
      `[SongBank] previewNoteOn: instrument found, isReady=${active.instrument.isReady}, hasWorklet=${!!active.instrument.workletNode}`,
    );
    const clampedMidi = Math.max(0, Math.min(127, Math.round(midi)));
    active.instrument.noteOn(clampedMidi, velocity);
  }

  /**
   * Realtime preview note-off companion to previewNoteOn.
   */
  previewNoteOff(instrumentId: string | undefined, midi: number) {
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    const clampedMidi = Math.max(0, Math.min(127, Math.round(midi)));
    active.instrument.noteOff(clampedMidi);
  }

  noteOff(
    instrumentId: string | undefined,
    midi?: number,
    trackIndex?: number,
  ) {
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;

    const notes = this.getTrackNotes(instrumentId, trackIndex);
    const voiceIndex = this.takeLastVoiceForTrack(instrumentId, trackIndex);
    const when = this.audioContext.currentTime;

    if (midi === undefined) {
      if (voiceIndex !== undefined) {
        active.instrument.gateOffVoiceAtTime(voiceIndex, when);
      } else if (notes.size > 0) {
        for (const note of notes) {
          active.instrument.noteOff(note);
        }
      } else {
        active.instrument.allNotesOff();
      }
      notes.clear();
      return;
    }

    if (voiceIndex !== undefined) {
      active.instrument.noteOff(midi, voiceIndex);
    } else if (notes.has(midi)) {
      active.instrument.noteOff(midi);
    } else {
      active.instrument.noteOff(midi);
    }
    notes.delete(midi);
  }

  /**
   * Schedule a note on at a specific audio context time.
   */
  noteOnAtTime(
    instrumentId: string | undefined,
    midi: number,
    velocity: number,
    time: number,
    trackIndex?: number,
  ) {
    if (instrumentId === undefined) {
      console.warn('[SongBank] noteOnAtTime: instrumentId is undefined');
      return;
    }

    const scheduledTime = Math.max(time, this.audioContext.currentTime);
    const contextRunning = this.audioContext.state === 'running';
    const active = this.instruments.get(instrumentId);
    const instrumentReady = active?.instrument.isReady;

    if (!contextRunning || !active || !instrumentReady) {
      if (!contextRunning) {
        this.wasSuspended = true;
        console.warn(
          '[SongBank] noteOnAtTime: AudioContext is suspended, queuing event.',
        );
      }
      const queued: PendingScheduledEvent = {
        kind: 'noteOn',
        instrumentId,
        midi,
        velocity,
        time: scheduledTime,
        enqueuedAt: this.getEnqueueTimestamp(),
      };
      if (trackIndex !== undefined) queued.trackIndex = trackIndex;
      this.enqueueScheduledEvent(queued);
      this.ensureInstrumentIfDesired(instrumentId);
      return;
    }

    this.dispatchNoteOnAtTime(
      instrumentId,
      midi,
      velocity,
      scheduledTime,
      trackIndex,
    );
  }

  /**
   * Schedule a note off at a specific audio context time.
   */
  noteOffAtTime(
    instrumentId: string | undefined,
    midi: number | undefined,
    time: number,
    trackIndex?: number,
  ) {
    if (instrumentId === undefined) return;

    const scheduledTime = Math.max(time, this.audioContext.currentTime);
    const contextRunning = this.audioContext.state === 'running';
    const active = this.instruments.get(instrumentId);
    const instrumentReady = active?.instrument.isReady;

    if (!contextRunning || !active || !instrumentReady) {
      if (!contextRunning) {
        this.wasSuspended = true;
        console.warn(
          '[SongBank] noteOffAtTime: AudioContext is suspended, queuing event.',
        );
      }
      const queued: PendingScheduledEvent = {
        kind: 'noteOff',
        instrumentId,
        time: scheduledTime,
        enqueuedAt: this.getEnqueueTimestamp(),
      };
      if (midi !== undefined) queued.midi = midi;
      if (trackIndex !== undefined) queued.trackIndex = trackIndex;
      this.enqueueScheduledEvent(queued);
      this.ensureInstrumentIfDesired(instrumentId);
      return;
    }

    this.dispatchNoteOffAtTime(instrumentId, midi, scheduledTime, trackIndex);
  }

  /**
   * Cancel all scheduled notes and stop all sound immediately.
   */
  cancelAllScheduled() {
    for (const active of this.instruments.values()) {
      active.instrument.cancelScheduledNotes();
    }
    this.activeNotes.clear();
    this.trackVoices.clear();
  }

  /**
   * Reset all instruments to a clean state for playback.
   * Ensures all voice gains are at 1, gates are at 0, and connections are intact.
   */
  resetForPlayback() {
    console.log('[SongBank] resetForPlayback: resetting all instruments');
    for (const [id, active] of this.instruments.entries()) {
      // Reset all voice gains to 1
      active.instrument.setGainForAllVoices(1);

      // Verify output connection, reconnect if needed
      if (active.instrument.outputNode.numberOfOutputs === 0) {
        console.warn(
          `[SongBank] resetForPlayback: instrument ${id} disconnected, reconnecting`,
        );
        active.instrument.outputNode.connect(this.masterGain);
      }

      // Log state for debugging
      const outputGain = (active.instrument.outputNode as GainNode).gain.value;
      console.log(
        `[SongBank] resetForPlayback: ${id} outputGain=${outputGain}, connected=${active.instrument.outputNode.numberOfOutputs > 0}`,
      );
    }
  }

  setInstrumentGain(
    instrumentId: string | undefined,
    gain: number,
    time?: number,
  ) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    active.instrument.setGainForAllVoices(gain, time);
  }

  /**
   * Set the output volume for a specific instrument (mixer volume).
   * This sets the gain on the instrument's output node, separate from per-voice gain.
   */
  setInstrumentOutputGain(instrumentId: string | undefined, gain: number) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    active.instrument.setOutputGain(gain);
  }

  /**
   * Get the current output gain for a specific instrument.
   */
  getInstrumentOutputGain(instrumentId: string | undefined): number {
    if (!instrumentId) return 1.0;
    const active = this.instruments.get(instrumentId);
    if (!active) return 1.0;
    return active.instrument.getOutputGain();
  }

  setInstrumentMacro(
    instrumentId: string | undefined,
    macroIndex: number,
    value: number,
    time?: number,
    ramp?: {
      targetValue: number;
      targetTime: number;
      interpolation?: 'linear' | 'exponential';
    },
  ) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    active.instrument.setMacro(
      macroIndex,
      value,
      time,
      ramp?.targetValue,
      ramp?.targetTime,
      ramp?.interpolation,
    );
  }

  private ensureInstrumentIfDesired(instrumentId: string) {
    const patch = this.desired.get(instrumentId);
    if (patch) {
      void this.ensureInstrument(instrumentId, patch);
    }
  }

  private dispatchNoteOnAtTime(
    instrumentId: string,
    midi: number,
    velocity: number,
    time: number,
    trackIndex?: number,
  ) {
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    const now = this.audioContext.currentTime;
    //const timeOffset = time - now;
    // if (timeOffset < 2) {
    //   console.log(
    //     `[SongBank] noteOnAtTime: inst=${instrumentId}, midi=${midi}, time=${time.toFixed(3)}, now=${now.toFixed(3)}, offset=${timeOffset.toFixed(3)}s`,
    //   );
    // }

    const worklet = active.instrument.workletNode;
    if (!worklet) {
      console.warn(
        `[SongBank] noteOnAtTime: instrument ${instrumentId} has NO workletNode!`,
      );
    }

    const scheduledTime = Math.max(time, now + MIN_SCHEDULE_LEAD_SECONDS);
    this.gateOffPreviousTrackVoice(instrumentId, trackIndex, scheduledTime);
    const voiceIndex = active.instrument.noteOnAtTime(
      midi,
      velocity,
      scheduledTime,
      {
        allowDuplicate: true,
      },
    );

    // Verify parameter presence for debugging
    if (voiceIndex !== undefined && worklet) {
      const gateParam = worklet.parameters.get(`gate_${voiceIndex}`);
      const freqParam = worklet.parameters.get(`frequency_${voiceIndex}`);
      if (!gateParam || !freqParam) {
        console.warn(
          `[SongBank] noteOnAtTime: instrument ${instrumentId} voice ${voiceIndex} missing params! gate=${!!gateParam}, freq=${!!freqParam}`,
        );
      }
    }

    this.getTrackNotes(instrumentId, trackIndex).add(midi);
    if (voiceIndex !== undefined) {
      this.setLastVoiceForTrack(instrumentId, trackIndex, voiceIndex);
      // Track the voice for this track (for mute/solo)
      this.addVoiceToTrack(instrumentId, trackIndex, voiceIndex);
    }
  }

  private dispatchNoteOffAtTime(
    instrumentId: string,
    midi: number | undefined,
    time: number,
    trackIndex?: number,
  ) {
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    const notes = this.getTrackNotes(instrumentId, trackIndex);
    const voiceIndex = this.takeLastVoiceForTrack(instrumentId, trackIndex);
    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;

    const scheduledTime = Math.max(time, this.audioContext.currentTime);

    if (midi === undefined) {
      if (voiceIndex !== undefined) {
        active.instrument.gateOffVoiceAtTime(voiceIndex, scheduledTime);
        // Remove voice from track tracking
        this.removeVoiceFromTrack(instrumentId, trackIndex, voiceIndex);
      } else if (notes && notes.size > 0) {
        for (const note of notes) {
          active.instrument.noteOffAtTime(note, scheduledTime);
        }
      } else {
        active.instrument.cancelScheduledNotes();
      }
      notes.clear();
      // Clear all voice tracking for this track
      this.clearVoicesForTrack(instrumentId, trackKey);
      return;
    }

    if (voiceIndex !== undefined) {
      active.instrument.noteOffAtTime(midi, scheduledTime, voiceIndex);
      // Remove voice from track tracking
      this.removeVoiceFromTrack(instrumentId, trackIndex, voiceIndex);
    } else {
      active.instrument.noteOffAtTime(midi, scheduledTime);
    }
    notes.delete(midi);
  }

  /**
   * Set the pitch (frequency) for a specific voice at a specific time.
   * Used for portamento, vibrato, arpeggio effects.
   */
  setVoicePitchAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    frequency: number,
    time: number,
  ) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    active.instrument.setVoiceFrequencyAtTime(voiceIndex, frequency, time);
  }

  /**
   * Set the volume for a specific voice at a specific time.
   * Used for tremolo, volume slide effects.
   */
  setVoiceVolumeAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    volume: number,
    time: number,
  ) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    active.instrument.setVoiceGainAtTime(voiceIndex, volume, time);
  }

  /**
   * Retrigger a note at a specific time (for E9x, Rxy effects).
   */
  retriggerNoteAtTime(
    instrumentId: string | undefined,
    midi: number,
    velocity: number,
    time: number,
    trackIndex?: number,
  ) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    // For retrigger, we want to trigger the same note again
    // This requires briefly gating off then back on
    const voiceIndex = active.instrument.noteOnAtTime(midi, velocity, time, {
      allowDuplicate: true,
    });
    this.getTrackNotes(instrumentId, trackIndex).add(midi);
    if (voiceIndex !== undefined) {
      this.setLastVoiceForTrack(instrumentId, trackIndex, voiceIndex);
    }
  }

  /** Ensure the audio context is running (resume if suspended) */
  /**
   * Ensure the audio context is running (resume if suspended).
   * Returns true if the context is running after this call (whether it was already running or successfully resumed).
   *
   * IMPORTANT: This will wait and poll for the context to become running,
   * which might require user interaction on the page.
   */
  async ensureAudioContextRunning(): Promise<boolean> {
    const ctx = this.audioContext;
    if (ctx.state === 'running') {
      this.needsAudioContextResume = false;
      void this.flushPendingScheduledEvents();
      return true;
    }

    this.needsAudioContextResume = true;
    console.warn(
      `[SongBank] AudioContext state=${ctx.state}; attempting to resume.`,
    );

    // Try to resume - might fail if no user interaction yet
    try {
      await ctx.resume();
      // Use string variable to avoid TypeScript's type narrowing issue
      const currentState: string = ctx.state;
      if (currentState === 'running') {
        this.needsAudioContextResume = false;
        void this.flushPendingScheduledEvents();
        return true;
      }
    } catch (error) {
      // Initial resume failed - will poll below
    }

    // If resume failed or context still not running, wait for it with timeout
    const maxWaitMs = 10000; // 10 seconds
    const pollMs = 100;
    const startTime = Date.now();

    // Poll until running or timeout
    while (Date.now() - startTime < maxWaitMs) {
      const currentState: string = ctx.state;
      if (currentState === 'running') {
        this.needsAudioContextResume = false;
        void this.flushPendingScheduledEvents();
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));

      // Try resuming again
      try {
        await ctx.resume();
        const stateAfterResume: string = ctx.state;
        if (stateAfterResume === 'running') {
          this.needsAudioContextResume = false;
          return true;
        }
      } catch (e) {
        // Ignore - will keep polling
      }
    }

    // Timed out
    console.error(
      '[TrackerSongBank] Timeout waiting for audio context to resume. Please interact with the page (click anywhere).',
    );
    console.warn(
      `[SongBank] AudioContext resume timed out; final state=${ctx.state}`,
    );
    this.needsAudioContextResume = true;
    return false;
  }

  private async ensureInstrument(
    instrumentId: string,
    patch: Patch,
  ): Promise<void> {
    const generation = this.generation;
    // Check if this instrument is already being initialized
    const pending = this.pendingInstruments.get(instrumentId);
    if (pending) {
      await pending;
      return;
    }

    // Start initialization and track the promise
    const initPromise = this.ensureInstrumentInternal(
      instrumentId,
      patch,
      generation,
    );
    this.pendingInstruments.set(instrumentId, initPromise);

    try {
      await initPromise;
    } finally {
      // Clean up the pending promise when done
      this.pendingInstruments.delete(instrumentId);
    }
  }

  private async ensureInstrumentInternal(
    instrumentId: string,
    patch: Patch,
    generation: number,
  ): Promise<void> {
    const contextRunning = await this.ensureAudioContextRunning();
    if (!contextRunning || this.audioContext.state !== 'running') {
      console.warn(
        `[SongBank] Skipping ensureInstrument for ${instrumentId} because AudioContext is not running (state=${this.audioContext.state}). needsResume=${this.needsAudioContextResume}`,
      );

      return;
    }
    const normalizedPatch = this.normalizePatch(patch);
    const deserialized = deserializePatch(normalizedPatch);
    const patchId = normalizedPatch?.metadata?.id;
    if (!patchId) return;
    const patchSignature = this.computePatchSignature(normalizedPatch);
    const hasPortamento = this.hasActivePortamento(normalizedPatch);

    const existing = this.instruments.get(instrumentId);
    const canReuse =
      existing &&
      existing.patchId === patchId &&
      patchSignature !== null &&
      existing.patchSignature === patchSignature;

    if (canReuse) {
      console.log(
        `[SongBank] Reusing existing instrument: ${instrumentId} (skipping state reapplication to preserve live audio)`,
      );
      existing.hasPortamento = hasPortamento;
      this.normalizeVoiceGain(existing.instrument);
      // Skip restoreAudioAssets, applyNodeStates, and applyMacros when reusing
      // These would reset effect buffers (delays, reverbs) and interrupt live playback
      // The instrument already has the correct patch loaded from previous sync
      // Verify connection is still intact, reconnect if needed
      if (existing.instrument.outputNode.numberOfOutputs === 0) {
        console.warn(
          `[SongBank] Instrument ${instrumentId} was disconnected, reconnecting...`,
        );
        existing.instrument.outputNode.connect(this.masterGain);
      }
      await this.flushPendingScheduledEvents(instrumentId);
      return;
    }

    if (existing) {
      console.log(
        `[SongBank] Tearing down existing instrument (different patch): ${instrumentId}`,
      );
      this.teardownInstrument(instrumentId);
    }

    console.log(`[SongBank] Creating new instrument: ${instrumentId}`);

    const memory = new WebAssembly.Memory({
      initial: 256,
      maximum: 1024,
      shared: true,
    });
    const instrument = new InstrumentV2(
      this.masterGain,
      this.audioSystem.audioContext,
      memory,
    );

    const ready = await this.waitForInstrumentReady(instrument);
    if (!ready) {
      console.warn('[TrackerSongBank] Instrument initialization timeout');
      instrument.outputNode.disconnect();
      return;
    }
    console.log(
      `[SongBank] Instrument ${instrumentId} worklet ready, loading patch...`,
    );

    await instrument.loadPatch(normalizedPatch);
    console.log(
      `[SongBank] Instrument ${instrumentId} patch loaded, isReady=${instrument.isReady}`,
    );
    // Give WASM time to finish building all voice node structures before updating states
    // Reduced from 100ms to 20ms - loadPatch already waits for synthLayout response,
    // this additional delay just ensures voice structures are built. Conservative reduction
    // maintains stability while reducing stutter on laptops
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Apply assets and node state in parallel to avoid serial stalls
    await Promise.all([
      this.restoreAudioAssets(
        instrumentId,
        instrument,
        normalizedPatch,
        deserialized,
      ),
      this.applyNodeStates(instrument, deserialized),
    ]);

    this.applyMacrosFromPatch(instrument, normalizedPatch);
    this.normalizeVoiceGain(instrument);
    if (generation !== this.generation) {
      console.warn(
        `[SongBank] Discarding instrument ${instrumentId} from previous generation`,
      );
      instrument.dispose();
      return;
    }
    this.instruments.set(instrumentId, {
      instrument,
      patchId,
      patchSignature,
      hasPortamento,
    });
    await this.flushPendingScheduledEvents(instrumentId);
  }

  private normalizeVoiceGain(instrument: InstrumentV2) {
    // Ensure voice gains aren't left at a previous automation value (e.g. 0)
    instrument.setGainForAllVoices(1);
  }

  private async restoreAudioAssets(
    instrumentId: string,
    instrument: InstrumentV2,
    patch: Patch,
    deserialized: DeserializedPatch,
  ): Promise<void> {
    const assets = patch.audioAssets;
    if (!assets || Object.keys(assets).length === 0) {
      return;
    }

    // Track imported assets per instrument to avoid re-importing (expensive for wavetables).
    let seen = this.restoredAssets.get(instrumentId);
    if (!seen) {
      seen = new Set<string>();
      this.restoredAssets.set(instrumentId, seen);
    }

    const assetEntries = Object.entries(assets) as [string, AudioAsset][];
    for (const [assetId, asset] of assetEntries) {
      try {
        if (seen.has(assetId)) continue;
        const parsed = parseAudioAssetId(assetId);
        if (!parsed) continue;
        const { nodeType, nodeId } = parsed;

        const binaryData = atob(asset.base64Data);
        const bytes = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i);
        }

        if (nodeType === 'sample') {
          const wavInfo = this.parseWavInfo(bytes);
          if (wavInfo) {
            const samplerState = deserialized.samplers.get(nodeId);
            if (samplerState) {
              deserialized.samplers.set(nodeId, {
                ...samplerState,
                sampleLength: wavInfo.frames,
                sampleRate: wavInfo.sampleRate,
                channels: wavInfo.channels,
              });
            }
          }
          await instrument.importSampleData(nodeId, bytes);
        } else if (nodeType === 'impulse_response') {
          await instrument.importImpulseWaveformData(nodeId, bytes);
        } else if (nodeType === 'wavetable') {
          await instrument.importWavetableData(nodeId, bytes);
        }
        seen.add(assetId);
      } catch (error) {
        console.error(
          `[TrackerSongBank] Failed to restore audio asset ${assetId}:`,
          error,
        );
      }
    }
  }

  private applyMacrosFromPatch(instrument: InstrumentV2, patch: Patch) {
    const macros = patch?.synthState?.macros;
    if (!macros) return;

    if (Array.isArray(macros.values)) {
      macros.values.forEach((value, index) => {
        if (Number.isFinite(value)) {
          instrument.setMacro(index, Number(value));
        }
      });
    }

    if (Array.isArray(macros.routes)) {
      (macros.routes as MacroRouteState[]).forEach((route) => {
        if (!route || route.targetId === undefined) return;

        const macroIndex = Number(route.macroIndex);
        if (!Number.isFinite(macroIndex) || macroIndex < 0) return;

        const targetPort = Number(route.targetPort ?? PortId.AudioInput0);
        const amount = Number(route.amount ?? 0);
        const modulationType =
          (route.modulationType as WasmModulationType | undefined) ??
          WasmModulationType.Additive;
        const modulationTransformation =
          (route.modulationTransformation as
            | ModulationTransformation
            | undefined) ?? ModulationTransformation.None;

        instrument.connectMacroRoute({
          macroIndex,
          targetId: route.targetId,
          targetPort: targetPort as PortId,
          amount,
          modulationType,
          modulationTransformation,
        });
      });
    }
  }

  private async waitForInstrumentReady(
    instrument: InstrumentV2,
    timeoutMs = 8000,
    pollMs = 50,
  ): Promise<boolean> {
    const start = Date.now();
    while (!instrument.isReady) {
      if (Date.now() - start > timeoutMs) {
        console.warn(
          '[TrackerSongBank] Timed out waiting for instrument readiness',
        );
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return true;
  }

  private hasActivePortamento(patch: Patch): boolean {
    const glides = patch?.synthState?.glides;
    if (!glides) return false;
    return Object.values(glides).some((glide) => {
      if (!glide) return false;
      const time = Number(glide.time ?? 0);
      const active = !!glide.active;
      return active && time > 0;
    });
  }

  /**
   * Normalize a patch so tracker playback uses the same upgraded shapes
   * as the patch editor (fills missing fields, canonical voice, etc.).
   */
  private normalizePatch(patch: Patch): Patch {
    try {
      const deserialized = deserializePatch(patch);
      const metadata = this.normalizePatchMetadata(patch.metadata);
      const synthState: SynthState = {
        layout: this.normalizePatchLayout(deserialized.layout),
        oscillators: this.mapToRecord(deserialized.oscillators),
        wavetableOscillators: this.mapToRecord(
          deserialized.wavetableOscillators,
        ),
        filters: this.mapToRecord(deserialized.filters),
        envelopes: this.mapToRecord(deserialized.envelopes),
        lfos: this.mapToRecord(deserialized.lfos),
        samplers: this.mapToRecord(deserialized.samplers),
        glides: this.mapToRecord(deserialized.glides),
        convolvers: this.mapToRecord(deserialized.convolvers),
        delays: this.mapToRecord(deserialized.delays),
        choruses: this.mapToRecord(deserialized.choruses),
        reverbs: this.mapToRecord(deserialized.reverbs),
        compressors: this.mapToRecord(deserialized.compressors),
        saturations: this.mapToRecord(deserialized.saturations),
        bitcrushers: this.mapToRecord(deserialized.bitcrushers),
      };

      if (deserialized.noise !== undefined) {
        synthState.noise = deserialized.noise;
      }
      if (deserialized.velocity !== undefined) {
        synthState.velocity = deserialized.velocity;
      }
      if (deserialized.macros) {
        synthState.macros = {
          values: deserialized.macros.values ?? [],
          routes: deserialized.macros.routes ?? [],
        };
      }

      return {
        metadata,
        synthState,
        audioAssets: this.mapToRecord(deserialized.audioAssets),
      };
    } catch (error) {
      console.warn(
        '[TrackerSongBank] Failed to normalize patch; using raw patch',
        error,
      );
      return patch;
    }
  }

  private normalizePatchLayout(layout: SynthLayout): SynthState['layout'] {
    return synthLayoutToPatchLayout(layout);
  }

  private normalizePatchMetadata(metadata: PatchMetadata): PatchMetadata {
    const safeTags = Array.isArray(metadata?.tags)
      ? [...metadata.tags]
      : undefined;
    const created = metadata?.created ?? metadata?.modified ?? 0;
    const modified = metadata?.modified ?? metadata?.created ?? created;
    return {
      id: metadata?.id ?? `song-patch-${created || Date.now()}`,
      name: metadata?.name ?? 'Untitled',
      created,
      modified,
      version: metadata?.version ?? PRESET_SCHEMA_VERSION,
      ...(typeof metadata?.category === 'string'
        ? { category: metadata.category }
        : {}),
      ...(typeof metadata?.author === 'string'
        ? { author: metadata.author }
        : {}),
      ...(safeTags ? { tags: safeTags } : {}),
      ...(typeof metadata?.description === 'string'
        ? { description: metadata.description }
        : {}),
    };
  }

  private mapToRecord<T>(map: Map<string, T>): Record<string, T> {
    const record: Record<string, T> = {};
    map.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }

  private async applyNodeStates(
    instrument: InstrumentV2,
    deserialized: DeserializedPatch,
  ): Promise<void> {
    deserialized.oscillators.forEach(
      (state: OscillatorState, nodeId: string) => {
        instrument.updateOscillatorState(nodeId, { ...state, id: nodeId });
      },
    );

    deserialized.wavetableOscillators.forEach(
      (state: OscillatorState, nodeId: string) => {
        instrument.updateWavetableOscillatorState(nodeId, {
          ...state,
          id: nodeId,
        });
      },
    );

    const envelopePromises: Promise<void>[] = [];
    deserialized.envelopes.forEach((state: EnvelopeConfig, nodeId: string) => {
      envelopePromises.push(
        instrument.updateEnvelopeState(nodeId, {
          ...state,
          id: nodeId,
        }),
      );
    });

    deserialized.lfos.forEach((state: LfoState, nodeId: string) => {
      instrument.updateLfoState(nodeId, {
        id: nodeId,
        frequency: state.frequency,
        phaseOffset: state.phaseOffset ?? 0,
        waveform: state.waveform,
        useAbsolute: state.useAbsolute,
        useNormalized: state.useNormalized,
        triggerMode: state.triggerMode,
        gain: state.gain,
        active: state.active,
        loopMode: state.loopMode,
        loopStart: state.loopStart,
        loopEnd: state.loopEnd,
      });
    });

    deserialized.filters.forEach((state: FilterState, nodeId: string) => {
      instrument.updateFilterState(nodeId, { ...state, id: nodeId });
    });

    deserialized.glides.forEach((state: GlideState, nodeId: string) => {
      instrument.updateGlideState(nodeId, { ...state, id: nodeId });
    });

    deserialized.convolvers.forEach((state: ConvolverState, nodeId: string) => {
      instrument.updateConvolverState(nodeId, { ...state, id: nodeId });
    });

    deserialized.delays.forEach((state: DelayState, nodeId: string) => {
      instrument.updateDelayState(nodeId, { ...state, id: nodeId });
    });

    deserialized.choruses.forEach((state: ChorusState, nodeId: string) => {
      instrument.updateChorusState(nodeId, { ...state, id: nodeId });
    });

    deserialized.reverbs.forEach((state: ReverbState, nodeId: string) => {
      instrument.updateReverbState(nodeId, { ...state, id: nodeId });
    });

    deserialized.compressors.forEach(
      (state: CompressorState, nodeId: string) => {
        instrument.updateCompressorState(nodeId, { ...state, id: nodeId });
      },
    );

    deserialized.saturations.forEach(
      (state: SaturationState, nodeId: string) => {
        instrument.updateSaturationState(nodeId, { ...state, id: nodeId });
      },
    );

    deserialized.bitcrushers.forEach(
      (state: BitcrusherState, nodeId: string) => {
        instrument.updateBitcrusherState(nodeId, { ...state, id: nodeId });
      },
    );

    deserialized.samplers.forEach((state: SamplerState, nodeId: string) => {
      const sampleLength = Math.max(
        1,
        state.sampleLength || state.sampleRate || 1,
      );
      const loopStartNorm = this.clamp01(state.loopStart ?? 0);
      const requestedEnd = this.clamp01(state.loopEnd ?? 1);
      const minDelta = 1 / sampleLength;
      const loopEndNorm =
        requestedEnd <= loopStartNorm + minDelta
          ? Math.min(1, loopStartNorm + minDelta)
          : requestedEnd;
      const detuneCents = Number.isFinite(state.detune)
        ? (state.detune as number)
        : combineDetuneParts(
            state.detune_oct ?? 0,
            state.detune_semi ?? 0,
            state.detune_cents ?? 0,
          );
      const tuningFrequency = frequencyFromDetune(detuneCents);

      instrument.updateSamplerState(nodeId, {
        frequency: tuningFrequency,
        gain: state.gain,
        loopMode: state.loopMode,
        loopStart: loopStartNorm * sampleLength,
        loopEnd: loopEndNorm * sampleLength,
        rootNote: state.rootNote,
        triggerMode: state.triggerMode,
        active: state.active,
      });
    });

    await Promise.all(envelopePromises);
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }

  /**
   * Minimal WAV header parser to extract sample rate, channels, and frame count.
   */
  private parseWavInfo(
    bytes: Uint8Array,
  ): { sampleRate: number; channels: number; frames: number } | null {
    const getString = (offset: number, length: number) =>
      String.fromCharCode(...bytes.slice(offset, offset + length));
    const getUint32LE = (offset: number) =>
      ((bytes[offset] ?? 0) |
        ((bytes[offset + 1] ?? 0) << 8) |
        ((bytes[offset + 2] ?? 0) << 16) |
        ((bytes[offset + 3] ?? 0) << 24)) >>>
      0;
    const getUint16LE = (offset: number) =>
      ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;

    if (bytes.length < 44) return null;
    if (getString(0, 4) !== 'RIFF' || getString(8, 4) !== 'WAVE') return null;

    let offset = 12;
    let fmtSampleRate = 0;
    let fmtChannels = 0;
    let bitsPerSample = 16;
    let dataSize = 0;

    while (offset + 8 <= bytes.length) {
      const chunkId = getString(offset, 4);
      const chunkSize = getUint32LE(offset + 4);
      const next = offset + 8 + chunkSize;
      if (chunkId === 'fmt ') {
        fmtChannels = getUint16LE(offset + 10);
        fmtSampleRate = getUint32LE(offset + 12);
        bitsPerSample = getUint16LE(offset + 22);
      } else if (chunkId === 'data') {
        dataSize = chunkSize;
      }
      offset = next;
    }

    if (!fmtSampleRate || !fmtChannels || !dataSize) return null;
    const bytesPerSample = (bitsPerSample / 8) * fmtChannels;
    if (!bytesPerSample) return null;
    const frames = Math.floor(dataSize / bytesPerSample);
    return {
      sampleRate: fmtSampleRate,
      channels: fmtChannels,
      frames,
    };
  }

  private computePatchSignature(patch: Patch): string | null {
    const id = patch?.metadata?.id;
    if (!id) return null;

    const modified = patch?.metadata?.modified ?? patch?.metadata?.created ?? 0;
    const stateHash = this.simpleHash(
      this.safeStringify(patch?.synthState ?? {}),
    );
    const assets = patch?.audioAssets ?? {};
    const assetHash = this.simpleHash(
      Object.entries(assets)
        .map(
          ([assetId, asset]) =>
            `${assetId}:${this.simpleHash(asset?.base64Data ?? '')}`,
        )
        .sort()
        .join('|'),
    );

    return `${id}:${modified}:${stateHash}:${assetHash}`;
  }

  private safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value) ?? '';
    } catch (error) {
      console.warn(
        '[TrackerSongBank] Failed to stringify patch for signature:',
        error,
      );
      return '';
    }
  }

  private simpleHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = (hash * 31 + input.charCodeAt(i)) | 0;
    }
    return hash.toString();
  }

  private teardownInstrument(instrumentId: string) {
    const active = this.instruments.get(instrumentId);
    if (!active) return;

    try {
      active.instrument.dispose();
    } catch (error) {
      console.warn('[TrackerSongBank] Failed to dispose instrument', error);
    }

    this.instruments.delete(instrumentId);
    this.activeNotes.delete(instrumentId);
    this.lastTrackVoice.delete(instrumentId);
    // Clear any per-track voice tracking so stale voice IDs don't linger when
    // the instrument is rebuilt for a new song/patch.
    this.trackVoices.delete(instrumentId);
    this.restoredAssets.delete(instrumentId);
  }

  /**
   * Hard reset all tracker instruments. Use when loading a new song to drop
   * every existing AudioWorklet before instantiating the next set.
   */
  resetForNewSong(): void {
    console.log(
      '[SongBank] Resetting for new song (disposing all instruments)',
    );
    this.generation += 1;
    this.pendingInstruments.clear();
    this.disposeInstruments();
    this.desired.clear();
  }

  /**
   * Update a running instrument's patch in real-time without stopping playback.
   * This is used for live editing while a song is playing.
   *
   * @param instrumentId - The instrument ID (e.g., "01", "02")
   * @param patch - The updated patch to apply
   * @returns true if the patch was applied, false if the instrument wasn't found
   */
  async updatePatchLive(instrumentId: string, patch: Patch): Promise<boolean> {
    const active = this.instruments.get(instrumentId);
    if (!active) {
      console.warn(
        '[TrackerSongBank] Cannot update patch live: instrument not found',
        instrumentId,
      );
      return false;
    }

    try {
      // Normalize and apply the patch to the active instrument
      const normalizedPatch = this.normalizePatch(patch);

      // Load the patch into the instrument (this updates all synth parameters)
      await active.instrument.loadPatch(normalizedPatch);

      // Restore audio assets (samplers, convolvers) if any
      const deserialized = deserializePatch(normalizedPatch);
      await this.restoreAudioAssets(
        instrumentId,
        active.instrument,
        normalizedPatch,
        deserialized,
      );

      // Update the stored patch reference and signature
      this.desired.set(instrumentId, normalizedPatch);
      active.patchId = normalizedPatch.metadata.id;
      active.patchSignature = this.computePatchSignature(normalizedPatch);

      // Update portamento state based on new patch
      active.hasPortamento = this.hasActivePortamento(normalizedPatch);

      return true;
    } catch (error) {
      console.error('[TrackerSongBank] Failed to update patch live:', error);
      return false;
    }
  }

  /**
   * Check if an instrument is currently active (has been synced and created)
   */
  hasActiveInstrument(instrumentId: string): boolean {
    return this.instruments.has(instrumentId);
  }

  /**
   * Update the stored patch data for an instrument after live editing.
   * This updates the "desired" patch and the instrument's stored signature
   * WITHOUT reloading the instrument (since it already has the live changes).
   *
   * Call this when saving live edits to ensure the song bank's stored data
   * matches the actual instrument state.
   *
   * @param instrumentId - The instrument ID (e.g., "01", "02")
   * @param patch - The serialized patch with the current state
   */
  updateStoredPatch(instrumentId: string, patch: Patch): void {
    const normalizedPatch = this.normalizePatch(patch);
    const patchId = normalizedPatch?.metadata?.id;
    if (!patchId) return;

    // Update the desired patch
    this.desired.set(instrumentId, normalizedPatch);

    // Update the active instrument's stored signature so it matches
    const active = this.instruments.get(instrumentId);
    if (active) {
      active.patchId = patchId;
      active.patchSignature = this.computePatchSignature(normalizedPatch);
      active.hasPortamento = this.hasActivePortamento(normalizedPatch);
    }
  }
}
