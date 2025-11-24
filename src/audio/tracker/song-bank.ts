import AudioSystem from 'src/audio/AudioSystem';
import InstrumentV2 from 'src/audio/instrument-v2';
import type { AudioAsset, Patch, MacroRouteState } from 'src/audio/types/preset-types';
import { parseAudioAssetId } from 'src/audio/serialization/patch-serializer';
import {
  WasmModulationType,
  ModulationTransformation,
  PortId,
} from 'app/public/wasm/audio_processor';

export interface SongBankSlot {
  instrumentId: string;
  patch: Patch;
}

interface ActiveInstrument {
  instrument: InstrumentV2;
  patchId: string;
}

export class TrackerSongBank {
  private readonly audioSystem: AudioSystem;
  private readonly masterGain: GainNode;
  private readonly desired: Map<string, Patch> = new Map();
  private readonly instruments: Map<string, ActiveInstrument> = new Map();
  private readonly activeNotes: Map<string, Map<number, Set<number>>> = new Map();
  private readonly lastTrackVoice: Map<string, Map<number, number>> = new Map();
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
    const nextDesired = new Map<string, Patch>();
    for (const slot of slots) {
      if (!slot.instrumentId) continue;
      nextDesired.set(slot.instrumentId, slot.patch);
    }
    this.desired.clear();
    for (const [id, patch] of nextDesired.entries()) {
      this.desired.set(id, patch);
    }

    const wantedIds = new Set(nextDesired.keys());
    for (const [id, active] of this.instruments.entries()) {
      if (!wantedIds.has(id)) {
        active.instrument.outputNode.disconnect();
        this.instruments.delete(id);
        this.activeNotes.delete(id);
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
    for (const active of this.instruments.values()) {
      active.instrument.outputNode.disconnect();
    }
    this.instruments.clear();
    this.activeNotes.clear();
    this.masterGain.disconnect();
    this.recorderNode?.disconnect();
    this.recorderNode = null;
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
    instrument: InstrumentV2,
    instrumentId: string,
    trackIndex: number | undefined,
    time: number,
  ) {
    const previousVoice = this.takeLastVoiceForTrack(instrumentId, trackIndex);
    if (previousVoice !== undefined) {
      instrument.gateOffVoiceAtTime(previousVoice, time);
    }
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
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    const now = this.audioContext.currentTime;
    this.gateOffPreviousTrackVoice(active.instrument, instrumentId, trackIndex, now);
    const voiceIndex = active.instrument.noteOnAtTime(midi, velocity, now);

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
    if (!notes || notes.size === 0) {
      if (midi !== undefined) {
        active.instrument.noteOff(midi);
        this.clearLastVoiceForTrack(instrumentId, trackIndex);
      }
      return;
    }

    if (midi === undefined) {
      for (const note of notes) {
        active.instrument.noteOff(note);
      }
      notes.clear();
      this.clearLastVoiceForTrack(instrumentId, trackIndex);
      return;
    }

    if (notes.has(midi)) {
      active.instrument.noteOff(midi);
      notes.delete(midi);
      this.clearLastVoiceForTrack(instrumentId, trackIndex);
    } else {
      active.instrument.noteOff(midi);
    }
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
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    this.gateOffPreviousTrackVoice(active.instrument, instrumentId, trackIndex, time);
    const voiceIndex = active.instrument.noteOnAtTime(midi, velocity, time);
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

    if (midi === undefined) {
      if (notes && notes.size > 0) {
        for (const note of notes) {
          active.instrument.noteOffAtTime(note, time);
        }
        notes.clear();
      } else {
        const lastVoice = this.takeLastVoiceForTrack(instrumentId, trackIndex);
        if (lastVoice !== undefined) {
          active.instrument.gateOffVoiceAtTime(lastVoice, time);
        }
      }
      return;
    }

    const hadMidi = notes.has(midi);
    notes.delete(midi);
    if (hadMidi) {
      active.instrument.noteOffAtTime(midi, time);
      this.clearLastVoiceForTrack(instrumentId, trackIndex);
    } else {
      const lastVoice = this.takeLastVoiceForTrack(instrumentId, trackIndex);
      if (lastVoice !== undefined) {
        active.instrument.gateOffVoiceAtTime(lastVoice, time);
      } else {
        active.instrument.noteOffAtTime(midi, time);
        this.clearLastVoiceForTrack(instrumentId, trackIndex);
      }
    }
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

  setInstrumentMacro(instrumentId: string | undefined, macroIndex: number, value: number, time?: number) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    active.instrument.setMacro(macroIndex, value, time);
  }

  private async ensureInstrument(instrumentId: string, patch: Patch): Promise<void> {
    const patchId = patch?.metadata?.id;
    if (!patchId) return;

    const existing = this.instruments.get(instrumentId);
    if (existing?.patchId === patchId) {
      this.applyMacrosFromPatch(existing.instrument, patch);
      return;
    }

    if (existing) {
      existing.instrument.outputNode.disconnect();
      this.instruments.delete(instrumentId);
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
      instrument.outputNode.disconnect();
      return;
    }

    await instrument.loadPatch(patch);
    await this.restoreAudioAssets(instrument, patch);
    this.applyMacrosFromPatch(instrument, patch);
    instrument.outputNode.connect(this.masterGain);
    this.instruments.set(instrumentId, { instrument, patchId });
  }

  private async restoreAudioAssets(instrument: InstrumentV2, patch: Patch): Promise<void> {
    const assets = patch.audioAssets;
    if (!assets || Object.keys(assets).length === 0) {
      return;
    }

    for (const [assetId, asset] of Object.entries(assets) as [string, AudioAsset][]) {
      try {
        const parsed = parseAudioAssetId(assetId);
        if (!parsed) continue;
        const { nodeType, nodeId } = parsed;

        const binaryData = atob(asset.base64Data);
        const bytes = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i);
        }

        if (nodeType === 'sample') {
          await instrument.importSampleData(nodeId, bytes);
        } else if (nodeType === 'impulse_response') {
          await instrument.importImpulseWaveformData(nodeId, bytes);
        } else if (nodeType === 'wavetable') {
          await instrument.importWavetableData(nodeId, bytes);
        }
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
}
