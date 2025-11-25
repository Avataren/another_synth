import AudioSystem from 'src/audio/AudioSystem';
import InstrumentV2 from 'src/audio/instrument-v2';
import type { AudioAsset, Patch, MacroRouteState } from 'src/audio/types/preset-types';
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
import { PRESET_SCHEMA_VERSION, type PatchMetadata, type SynthState } from 'src/audio/types/preset-types';
import { combineDetuneParts, frequencyFromDetune } from 'src/audio/utils/sampler-detune';

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

export class TrackerSongBank {
  private readonly audioSystem: AudioSystem;
  private readonly masterGain: GainNode;
  private readonly desired: Map<string, Patch> = new Map();
  private readonly instruments: Map<string, ActiveInstrument> = new Map();
  private readonly activeNotes: Map<string, Map<number, Set<number>>> = new Map();
  private readonly lastTrackVoice: Map<string, Map<number, number>> = new Map();
  private readonly restoredAssets: Map<string, Set<string>> = new Map();
  private readonly pendingInstruments: Map<string, Promise<void>> = new Map();
  private wasSuspended = false;
  private recorderNode: AudioWorkletNode | null = null;
  private recordedBuffers: Float32Array[] = [];
  private recording = false;

  constructor() {
    this.audioSystem = new AudioSystem();
    this.masterGain = this.audioSystem.audioContext.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.audioSystem.destinationNode);
  }

  get output(): AudioNode {
    return this.masterGain;
  }

  get audioContext(): AudioContext {
    return this.audioSystem.audioContext;
  }

  /** Get the output node for a specific instrument (for visualization) */
  getInstrumentOutput(instrumentId: string): AudioNode | null {
    const active = this.instruments.get(instrumentId);
    return active?.instrument.outputNode ?? null;
  }

  async syncSlots(slots: SongBankSlot[]): Promise<void> {
    // Resume context if suspended, and set flag so we rebuild instruments
    if (this.audioContext.state === 'suspended') {
      this.wasSuspended = true;
      await this.ensureAudioContextRunning();
    }

    if (this.wasSuspended && this.audioContext.state === 'running') {
      // Recreate instruments after a resume to avoid stale worklet state
      this.disposeInstruments();
      this.wasSuspended = false;
    }

    const nextDesired = new Map<string, Patch>();
    for (const slot of slots) {
      if (!slot.instrumentId) continue;
      nextDesired.set(slot.instrumentId, this.normalizePatch(slot.patch));
    }
    this.desired.clear();
    for (const [id, patch] of nextDesired.entries()) {
      this.desired.set(id, patch);
    }

    const wantedIds = new Set(nextDesired.keys());
    for (const [id] of this.instruments.entries()) {
      if (!wantedIds.has(id)) {
        this.teardownInstrument(id);
      }
    }

    for (const [instrumentId, patch] of nextDesired.entries()) {
      await this.ensureInstrument(instrumentId, patch);
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
  async stopRecording(): Promise<{ interleaved: Float32Array; sampleRate: number }> {
    this.recording = false;
    const totalFrames = this.recordedBuffers.reduce((sum, buf) => sum + buf.length, 0);
    const merged = new Float32Array(totalFrames);
    let offset = 0;
    for (const buf of this.recordedBuffers) {
      merged.set(buf, offset);
      offset += buf.length;
    }
    return {
      interleaved: merged,
      sampleRate: this.audioSystem.audioContext.sampleRate
    };
  }

  private async ensureRecorderNode(): Promise<void> {
    if (this.recorderNode) return;
    await this.audioSystem.audioContext.audioWorklet.addModule(
      `${import.meta.env.BASE_URL}worklets/recording-worklet.js`
    );
    this.recorderNode = new AudioWorkletNode(
      this.audioSystem.audioContext,
      'recording-processor',
      { numberOfInputs: 1, numberOfOutputs: 0 }
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
    const voiceIndex = active.instrument.noteOnAtTime(midi, velocity, now, { allowDuplicate: true });

    this.getTrackNotes(instrumentId, trackIndex).add(midi);
    if (voiceIndex !== undefined) {
      this.setLastVoiceForTrack(instrumentId, trackIndex, voiceIndex);
    }
  }

  /**
   * Realtime preview note-on (no per-track voice gating/stealing).
   * Used by the tracker keyboard preview so chords behave like the patch editor.
   */
  previewNoteOn(instrumentId: string | undefined, midi: number, velocity = 100) {
    if (this.audioContext.state === 'suspended') {
      this.wasSuspended = true;
    }
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
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

  noteOff(instrumentId: string | undefined, midi?: number, trackIndex?: number) {
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
    if (this.audioContext.state === 'suspended') {
      this.wasSuspended = true;
    }
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    this.gateOffPreviousTrackVoice(instrumentId, trackIndex, time);
    const voiceIndex = active.instrument.noteOnAtTime(midi, velocity, time, { allowDuplicate: true });
    this.getTrackNotes(instrumentId, trackIndex).add(midi);
    if (voiceIndex !== undefined) {
      this.setLastVoiceForTrack(instrumentId, trackIndex, voiceIndex);
    }
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
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    const notes = this.getTrackNotes(instrumentId, trackIndex);
    const voiceIndex = this.takeLastVoiceForTrack(instrumentId, trackIndex);

    if (midi === undefined) {
      if (voiceIndex !== undefined) {
        active.instrument.gateOffVoiceAtTime(voiceIndex, time);
      } else if (notes && notes.size > 0) {
        for (const note of notes) {
          active.instrument.noteOffAtTime(note, time);
        }
      } else {
        active.instrument.cancelScheduledNotes();
      }
      notes.clear();
      return;
    }

    if (voiceIndex !== undefined) {
      active.instrument.noteOffAtTime(midi, time, voiceIndex);
    } else {
      active.instrument.noteOffAtTime(midi, time);
    }
    notes.delete(midi);
  }

  /**
   * Cancel all scheduled notes and stop all sound immediately.
   */
  cancelAllScheduled() {
    for (const active of this.instruments.values()) {
      active.instrument.cancelScheduledNotes();
    }
    this.activeNotes.clear();
  }

  setInstrumentGain(instrumentId: string | undefined, gain: number, time?: number) {
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

  setInstrumentMacro(instrumentId: string | undefined, macroIndex: number, value: number, time?: number) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    active.instrument.setMacro(macroIndex, value, time);
  }

  /**
   * Set the pitch (frequency) for a specific voice at a specific time.
   * Used for portamento, vibrato, arpeggio effects.
   */
  setVoicePitchAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    frequency: number,
    time: number
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
    time: number
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
    trackIndex?: number
  ) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    // For retrigger, we want to trigger the same note again
    // This requires briefly gating off then back on
    const voiceIndex = active.instrument.noteOnAtTime(midi, velocity, time, { allowDuplicate: true });
    this.getTrackNotes(instrumentId, trackIndex).add(midi);
    if (voiceIndex !== undefined) {
      this.setLastVoiceForTrack(instrumentId, trackIndex, voiceIndex);
    }
  }

  /** Ensure the audio context is running (resume if suspended) */
  /**
   * Ensure the audio context is running (resume if suspended).
   * Returns true if the context was resumed during this call.
   *
   * IMPORTANT: This will wait and poll for the context to become running,
   * which might require user interaction on the page.
   */
  async ensureAudioContextRunning(): Promise<boolean> {
    const ctx = this.audioContext;
    if (ctx.state === 'running') return false;

    // Try to resume - might fail if no user interaction yet
    try {
      await ctx.resume();
      // Use string variable to avoid TypeScript's type narrowing issue
      const currentState: string = ctx.state;
      if (currentState === 'running') {
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
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, pollMs));

      // Try resuming again
      try {
        await ctx.resume();
        const stateAfterResume: string = ctx.state;
        if (stateAfterResume === 'running') {
          return true;
        }
      } catch (e) {
        // Ignore - will keep polling
      }
    }

    // Timed out
    console.error('[TrackerSongBank] Timeout waiting for audio context to resume. Please interact with the page (click anywhere).');
    return false;
  }

  private async ensureInstrument(instrumentId: string, patch: Patch): Promise<void> {
    // Check if this instrument is already being initialized
    const pending = this.pendingInstruments.get(instrumentId);
    if (pending) {
      await pending;
      return;
    }

    // Start initialization and track the promise
    const initPromise = this.ensureInstrumentInternal(instrumentId, patch);
    this.pendingInstruments.set(instrumentId, initPromise);

    try {
      await initPromise;
    } finally {
      // Clean up the pending promise when done
      this.pendingInstruments.delete(instrumentId);
    }
  }

  private async ensureInstrumentInternal(instrumentId: string, patch: Patch): Promise<void> {
    await this.ensureAudioContextRunning();
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
      existing.hasPortamento = hasPortamento;
      await this.restoreAudioAssets(instrumentId, existing.instrument, normalizedPatch, deserialized);
      await this.applyNodeStates(existing.instrument, deserialized);
      this.applyMacrosFromPatch(existing.instrument, normalizedPatch);
      existing.instrument.setGainForAllVoices(1);
      return;
    }

    if (existing) {
      this.teardownInstrument(instrumentId);
    }

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

    await instrument.loadPatch(normalizedPatch);
    // Give WASM time to finish building all voice node structures before updating states
    // Without this delay, updateOscillator messages arrive before nodes exist in voices
    // This is a race condition: synthLayout response means layout is created, but WASM
    // still needs time to build the actual node structures in each voice
    await new Promise(resolve => setTimeout(resolve, 100));
    await this.restoreAudioAssets(instrumentId, instrument, normalizedPatch, deserialized);
    await this.applyNodeStates(instrument, deserialized);
    this.applyMacrosFromPatch(instrument, normalizedPatch);
    // Ensure voice gains aren't left at a previous automation value (e.g. 0)
    instrument.setGainForAllVoices(1);
    instrument.outputNode.connect(this.masterGain);
    this.instruments.set(instrumentId, { instrument, patchId, patchSignature, hasPortamento });
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
        console.error(`[TrackerSongBank] Failed to restore audio asset ${assetId}:`, error);
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
          (route.modulationTransformation as ModulationTransformation | undefined) ??
          ModulationTransformation.None;

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
        console.warn('[TrackerSongBank] Timed out waiting for instrument readiness');
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
        wavetableOscillators: this.mapToRecord(deserialized.wavetableOscillators),
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
      console.warn('[TrackerSongBank] Failed to normalize patch; using raw patch', error);
      return patch;
    }
  }

  private normalizePatchLayout(layout: SynthLayout): SynthState['layout'] {
    return synthLayoutToPatchLayout(layout);
  }

  private normalizePatchMetadata(metadata: PatchMetadata): PatchMetadata {
    const safeTags = Array.isArray(metadata?.tags) ? [...metadata.tags] : undefined;
    const created = metadata?.created ?? metadata?.modified ?? 0;
    const modified = metadata?.modified ?? metadata?.created ?? created;
    return {
      id: metadata?.id ?? `song-patch-${created || Date.now()}`,
      name: metadata?.name ?? 'Untitled',
      created,
      modified,
      version: metadata?.version ?? PRESET_SCHEMA_VERSION,
      ...(typeof metadata?.category === 'string' ? { category: metadata.category } : {}),
      ...(typeof metadata?.author === 'string' ? { author: metadata.author } : {}),
      ...(safeTags ? { tags: safeTags } : {}),
      ...(typeof metadata?.description === 'string' ? { description: metadata.description } : {}),
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
    deserialized.oscillators.forEach((state: OscillatorState, nodeId: string) => {
      instrument.updateOscillatorState(nodeId, { ...state, id: nodeId });
    });

    deserialized.wavetableOscillators.forEach((state: OscillatorState, nodeId: string) => {
      instrument.updateWavetableOscillatorState(nodeId, { ...state, id: nodeId });
    });

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

    deserialized.compressors.forEach((state: CompressorState, nodeId: string) => {
      instrument.updateCompressorState(nodeId, { ...state, id: nodeId });
    });

    deserialized.saturations.forEach((state: SaturationState, nodeId: string) => {
      instrument.updateSaturationState(nodeId, { ...state, id: nodeId });
    });

    deserialized.bitcrushers.forEach((state: BitcrusherState, nodeId: string) => {
      instrument.updateBitcrusherState(nodeId, { ...state, id: nodeId });
    });

    deserialized.samplers.forEach((state: SamplerState, nodeId: string) => {
      const sampleLength = Math.max(1, state.sampleLength || state.sampleRate || 1);
      const loopStartNorm = this.clamp01(state.loopStart ?? 0);
      const requestedEnd = this.clamp01(state.loopEnd ?? 1);
      const minDelta = 1 / sampleLength;
      const loopEndNorm =
        requestedEnd <= loopStartNorm + minDelta
          ? Math.min(1, loopStartNorm + minDelta)
          : requestedEnd;
      const detuneCents = Number.isFinite(state.detune)
        ? (state.detune as number)
        : combineDetuneParts(state.detune_oct ?? 0, state.detune_semi ?? 0, state.detune_cents ?? 0);
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
  private parseWavInfo(bytes: Uint8Array): { sampleRate: number; channels: number; frames: number } | null {
    const getString = (offset: number, length: number) =>
      String.fromCharCode(...bytes.slice(offset, offset + length));
    const getUint32LE = (offset: number) =>
      ((bytes[offset] ?? 0) |
        ((bytes[offset + 1] ?? 0) << 8) |
        ((bytes[offset + 2] ?? 0) << 16) |
        ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
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
    const stateHash = this.simpleHash(this.safeStringify(patch?.synthState ?? {}));
    const assets = patch?.audioAssets ?? {};
    const assetHash = this.simpleHash(
      Object.entries(assets)
        .map(([assetId, asset]) => `${assetId}:${this.simpleHash(asset?.base64Data ?? '')}`)
        .sort()
        .join('|'),
    );

    return `${id}:${modified}:${stateHash}:${assetHash}`;
  }

  private safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value) ?? '';
    } catch (error) {
      console.warn('[TrackerSongBank] Failed to stringify patch for signature:', error);
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
    this.restoredAssets.delete(instrumentId);
  }
}
