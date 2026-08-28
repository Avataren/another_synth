// src/audio/pooled-instrument-factory.ts
/**
 * Factory for creating instruments with worklet pooling support.
 *
 * This factory creates lightweight wrappers around shared worklets,
 * allowing multiple instruments to share the same AudioWorkletNode
 * while maintaining independent voice control.
 *
 * Design Philosophy:
 * - InstrumentV2 is complex and shouldn't be modified heavily
 * - Instead, create a PooledInstrument wrapper that maps voices through an offset
 * - For tracker playback, use PooledInstrument
 * - For patch editor, continue using InstrumentV2 directly
 */

import type { Patch, MacroRouteState } from './types/preset-types';
import type { VoiceNodeType } from './types/synth-layout';
import type { VoiceAllocation } from './worklet-pool';
import type { GlideState } from './types/synth-layout';
import { WorkletMessageHandler } from './adapters/message-handler';
import type OscillatorState from './models/OscillatorState';
import type {
  ChorusState,
  CompressorState,
  ConvolverState,
  DelayState,
  EnvelopeConfig,
  FilterState,
  LfoState,
  ReverbState,
  SaturationState,
  BitcrusherState,
  VelocityState,
} from './types/synth-layout';
import type { NodeConnectionUpdate } from './types/synth-layout';
import type { NoiseState } from './types/noise';
import { ENGINES_PER_WORKLET, VOICES_PER_ENGINE } from './worklet-config';
import { toRaw } from 'vue';
import {
  ModulationTransformation,
  WasmModulationType,
} from 'app/public/wasm/audio_processor.js';

/**
 * Lightweight instrument wrapper for shared worklets.
 * Implements the same interface as InstrumentV2 but uses a voice offset.
 */
export class PooledInstrument {
  readonly num_voices: number;
  readonly outputNode: GainNode;
  readonly workletNode: AudioWorkletNode;

  // Track which shared worklets are already connected to the destination to avoid duplicate connections.
  private static connectedWorklets = new WeakSet<AudioWorkletNode>();

  private instrumentId: string;
  private allocation: VoiceAllocation;
  private audioContext: AudioContext;
  private messageHandler: WorkletMessageHandler;
  private activeNotes: Map<number, Set<number>> = new Map();
  private voiceToNote: (number | null)[] = [];
  private voiceRoundRobinIndex = 0;
  private voiceLastUsedTime: number[] = [];
  private voiceReleaseTime: number[] = [];
  private maxReleaseTimeMs = 0;
  private ready = false;
  private quantumFrames = 128;
  private glideStates: Map<string, GlideState> = new Map();
  private outputGain = 1;
  private voiceBaseGain: number[] = [];

  constructor(
    destination: AudioNode,
    audioContext: AudioContext,
    instrumentId: string,
    allocation: VoiceAllocation,
  ) {
    this.audioContext = audioContext;
    this.instrumentId = instrumentId;
    this.allocation = allocation;
    this.num_voices = allocation.voiceCount;
    this.workletNode = allocation.workletNode;

    // Create output gain node
    this.outputNode = audioContext.createGain();
    this.outputNode.gain.value = 1.0;
    this.outputNode.connect(destination);

    // Initialize voice tracking (using local indices 0 to voiceCount-1)
    this.voiceToNote = new Array(this.num_voices).fill(null);
    this.voiceLastUsedTime = new Array(this.num_voices).fill(0);
    this.voiceReleaseTime = new Array(this.num_voices).fill(0);
    this.voiceBaseGain = new Array(this.num_voices).fill(1);

    // Create message handler for this instrument
    this.messageHandler = new WorkletMessageHandler({
      debug: false,
      defaultTimeout: 5000,
      maxQueueSize: 50,
    });

    // Attach to the shared worklet
    this.messageHandler.attachToWorklet(this.workletNode);

    // Mark as ready (worklet is already initialized)
    this.ready = true;

    // Ensure the shared worklet is connected to the destination once.
    if (!PooledInstrument.connectedWorklets.has(this.workletNode)) {
      try {
        this.workletNode.connect(destination);
        PooledInstrument.connectedWorklets.add(this.workletNode);
      } catch (err) {
        console.warn(
          '[PooledInstrument] Failed to connect worklet to destination',
          err,
        );
      }
    }

    console.log(
      `[PooledInstrument:${this.instrumentId}] Created with ${this.num_voices} voices (global indices ${allocation.startVoice}-${allocation.endVoice - 1})`,
    );
  }

  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Map local voice index (0-3) to global worklet voice index (e.g., 4-7)
   */
  private localToGlobal(localVoice: number): number {
    return this.allocation.startVoice + localVoice;
  }

  /**
   * Get parameter name for a voice (with offset applied)
   */
  private getParamName(paramType: string, localVoiceIndex: number): string {
    const globalVoiceIndex = this.localToGlobal(localVoiceIndex);
    const engineId = Math.floor(globalVoiceIndex / VOICES_PER_ENGINE);
    const voiceId = globalVoiceIndex % VOICES_PER_ENGINE;
    return `${paramType}_engine${engineId}_voice${voiceId}`;
  }

  /**
   * Load a patch into this instrument
   */
  async loadPatch(patch: Patch): Promise<void> {
    // Extract voice limit from patch
    const patchLayout = patch.synthState?.layout as
      | { voiceCount?: number; voices?: unknown[] }
      | undefined;
    const patchVoiceCount =
      patchLayout?.voiceCount ?? patchLayout?.voices?.length ?? this.num_voices;

    // Voice limit is the minimum of what the patch expects and what we allocated
    const voiceLimit = Math.min(this.num_voices, Math.max(1, patchVoiceCount));

    console.log(
      `[PooledInstrument:${this.instrumentId}] Loading patch "${patch.metadata.name}" with voice limit ${voiceLimit}/${this.num_voices}`,
    );

    // Calculate max release time
    this.maxReleaseTimeMs = 0;
    const envelopes = patch.synthState?.envelopes;
    if (envelopes) {
      for (const env of Object.values(envelopes)) {
        if (env && typeof env.release === 'number') {
          this.maxReleaseTimeMs = Math.max(
            this.maxReleaseTimeMs,
            env.release * 1000,
          );
        }
      }
    }
    if (this.maxReleaseTimeMs > 0) {
      this.maxReleaseTimeMs += 100; // Buffer
    }

    // Store glide states for portamento detection
    this.glideStates.clear();
    const patchGlides = patch?.synthState?.glides;
    if (patchGlides) {
      Object.entries(patchGlides).forEach(([id, glide]) => {
        if (glide) {
          this.glideStates.set(id, {
            ...glide,
            id,
            time: glide.time ?? 0,
            active: !!glide.active,
          });
        }
      });
    }

    // Strip Vue reactivity
    const cleanPatch = JSON.parse(
      JSON.stringify(patch, (key, value) => {
        if (value === undefined) return null;
        if (typeof value === 'number' && !Number.isFinite(value)) return 0;
        return value;
      }),
    ) as Patch;

    // Remove audio assets (loaded separately)
    const patchWithoutAssets = { ...cleanPatch, audioAssets: {} };
    const patchJson = JSON.stringify(patchWithoutAssets);

    // Send loadPatch message to worklet
    // Note: All instruments sharing this worklet will receive this message
    // This is fine for MOD instruments where each has a separate sampler
    this.messageHandler.sendFireAndForget({
      type: 'loadPatch',
      instrumentId: this.instrumentId,
      startVoice: this.allocation.startVoice,
      voiceCount: this.num_voices,
      voiceLimit,
      patchJson,
    });

    // Wait for the worklet to finish applying the patch before allowing state
    // updates, otherwise they race with graph rebuilds.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Set output gain from patch
    const instrumentGain = patch.synthState?.instrumentGain ?? 1.0;
    this.setOutputGain(instrumentGain);

    // Initialize voice parameters
    const now = this.audioContext.currentTime;
    for (let i = 0; i < voiceLimit; i++) {
      const gateParam = this.workletNode.parameters.get(
        this.getParamName('gate', i),
      );
      if (gateParam) {
        gateParam.cancelScheduledValues(now);
        gateParam.value = 0;
      }
      const freqParam = this.workletNode.parameters.get(
        this.getParamName('frequency', i),
      );
      if (freqParam) {
        freqParam.cancelScheduledValues(now);
        freqParam.value = 440;
      }
      const gainParam = this.workletNode.parameters.get(
        this.getParamName('gain', i),
      );
      if (gainParam) {
        gainParam.cancelScheduledValues(now);
        gainParam.value = 1;
      }
    }
  }

  /**
   * Trigger a note at a specific time
   */
  noteOnAtTime(
    noteNumber: number,
    velocity: number,
    time: number,
    options?: { allowDuplicate?: boolean; frequency?: number; pan?: number },
  ): number | undefined {
    const allowDuplicate = options?.allowDuplicate ?? false;
    const { voiceIndex, stolenNote, isRetrigger } = this.allocateVoice(
      noteNumber,
      allowDuplicate,
      time,
    );

    this.markVoiceActive(noteNumber, voiceIndex, time);

    const frequency =
      options?.frequency ?? this.midiNoteToFrequency(noteNumber);

    // Set voice parameters
    const gateParam = this.workletNode.parameters.get(
      this.getParamName('gate', voiceIndex),
    );
    if (gateParam) {
      gateParam.cancelScheduledValues(time);
      const retriggering = isRetrigger || stolenNote !== null;
      const portamentoEnabled = this.isPortamentoEnabled();
      const shouldPulseGate =
        retriggering && (this.num_voices > 1 || !portamentoEnabled);

      if (shouldPulseGate) {
        const gatePulseDuration = Math.max(
          0.005,
          this.quantumFrames / this.audioContext.sampleRate,
        );
        gateParam.setValueAtTime(0, time);
        gateParam.setValueAtTime(1, time + gatePulseDuration);
      } else {
        gateParam.setValueAtTime(1, time);
      }
    }

    const freqParam = this.workletNode.parameters.get(
      this.getParamName('frequency', voiceIndex),
    );
    if (freqParam) {
      freqParam.cancelScheduledValues(time);
      freqParam.setValueAtTime(frequency, time);
    }

    const gainParam = this.workletNode.parameters.get(
      this.getParamName('gain', voiceIndex),
    );
    if (gainParam) {
      gainParam.cancelScheduledValues(time);
      const baseGain = velocity / 127;
      this.voiceBaseGain[voiceIndex] = baseGain;
      const target = Math.min(1, baseGain * this.outputGain);
      gainParam.setValueAtTime(target, time);
    }

    return voiceIndex;
  }

  /**
   * Release a note at a specific time
   */
  noteOffAtTime(noteNumber: number, time: number, voiceIndex?: number): void {
    const voicesToRelease =
      voiceIndex !== undefined
        ? [voiceIndex]
        : Array.from(this.activeNotes.get(noteNumber) ?? []);

    if (voiceIndex === undefined) {
      this.activeNotes.delete(noteNumber);
    }

    for (const voice of voicesToRelease) {
      this.releaseVoice(voice, time);
      const gateParam = this.workletNode.parameters.get(
        this.getParamName('gate', voice),
      );
      if (gateParam) {
        gateParam.setValueAtTime(0, time);
      }
    }
  }

  /**
   * Immediate note on (for preview/keyboard)
   */
  noteOn(noteNumber: number, velocity: number): void {
    this.noteOnAtTime(noteNumber, velocity, this.audioContext.currentTime);
  }

  /**
   * Immediate note off
   */
  noteOff(noteNumber: number, voiceIndex?: number): void {
    this.noteOffAtTime(noteNumber, this.audioContext.currentTime, voiceIndex);
  }

  note_on(noteNumber: number, velocity: number): void {
    this.noteOn(noteNumber, velocity);
  }

  note_off(noteNumber: number): void {
    this.noteOff(noteNumber);
  }

  /**
   * Gate off a specific voice at a specific time
   */
  gateOffVoiceAtTime(voiceIndex: number, time: number): void {
    this.releaseVoice(voiceIndex, time);
    const gateParam = this.workletNode.parameters.get(
      this.getParamName('gate', voiceIndex),
    );
    if (gateParam) {
      gateParam.setValueAtTime(0, time);
    }
  }

  /**
   * Cancel and silence a voice immediately
   */
  cancelAndSilenceVoice(voiceIndex: number): void {
    if (voiceIndex < 0 || voiceIndex >= this.num_voices) return;
    const now = this.audioContext.currentTime;

    const gateParam = this.workletNode.parameters.get(
      this.getParamName('gate', voiceIndex),
    );
    if (gateParam) {
      gateParam.cancelScheduledValues(now);
      gateParam.setValueAtTime(0, now);
    }

      const gainParam = this.workletNode.parameters.get(
        this.getParamName('gain', voiceIndex),
      );
      if (gainParam) {
        gainParam.cancelScheduledValues(now);
        // Keep the voice gain ready for the next scheduled note. The gate is
        // the authoritative silence control; zeroing gain here can leave later
        // note-ons silent if their velocity is applied before a stale ramp.
        gainParam.setValueAtTime(1, now);
      }

    this.releaseVoice(voiceIndex, now);
  }

  /**
   * Set gain for all voices
   */
  setGainForAllVoices(gain: number, time?: number): void {
    const clamped = Math.max(0, Math.min(1, gain));
    const when = time ?? this.audioContext.currentTime;
    for (let i = 0; i < this.num_voices; i++) {
      const gainParam = this.workletNode.parameters.get(
        this.getParamName('gain', i),
      );
      if (gainParam) {
        this.voiceBaseGain[i] = clamped;
        const target = Math.min(1, clamped * this.outputGain);
        gainParam.setValueAtTime(target, when);
      }
    }
  }

  /**
   * Set voice frequency at a specific time
   */
  setVoiceFrequencyAtTime(
    voiceIndex: number,
    frequency: number,
    time: number,
    rampMode?: 'linear' | 'exponential',
  ): void {
    if (voiceIndex < 0 || voiceIndex >= this.num_voices) return;

    const freqParam = this.workletNode.parameters.get(
      this.getParamName('frequency', voiceIndex),
    );
    if (!freqParam) return;

    if (rampMode === 'exponential') {
      const safeFreq = Math.max(0.01, frequency);
      freqParam.exponentialRampToValueAtTime(safeFreq, time);
    } else if (rampMode === 'linear') {
      freqParam.linearRampToValueAtTime(frequency, time);
    } else {
      freqParam.setValueAtTime(frequency, time);
    }
  }

  /**
   * Set voice gain at a specific time
   */
  setVoiceGainAtTime(
    voiceIndex: number,
    gain: number,
    time: number,
    rampMode?: 'linear' | 'exponential',
  ): void {
    if (voiceIndex < 0 || voiceIndex >= this.num_voices) return;

    const clamped = Math.max(0, Math.min(1, gain));
    this.voiceBaseGain[voiceIndex] = clamped;
    const gainParam = this.workletNode.parameters.get(
      this.getParamName('gain', voiceIndex),
    );
    if (!gainParam) return;

    const target = Math.min(1, clamped * this.outputGain);
    gainParam.cancelScheduledValues(time);
    if (rampMode === 'linear') {
      gainParam.linearRampToValueAtTime(target, time);
    } else if (rampMode === 'exponential') {
      const safeGain = Math.max(0.001, target);
      gainParam.exponentialRampToValueAtTime(safeGain, time);
    } else {
      gainParam.setValueAtTime(target, time);
    }
  }

  /**
   * Set output gain
   */
  setOutputGain(gain: number, time?: number): void {
    const clamped = Math.max(0, gain);
    this.outputGain = clamped;
    const when = time ?? this.audioContext.currentTime;
    // Re-apply current base gains with the new output gain multiplier.
    for (let i = 0; i < this.num_voices; i++) {
      const gainParam = this.workletNode.parameters.get(
        this.getParamName('gain', i),
      );
      if (!gainParam) continue;
      const base = this.voiceBaseGain[i] ?? 1;
      const target = Math.min(1, base * this.outputGain);
      gainParam.setValueAtTime(target, when);
    }
  }

  /**
   * Update sampler state (loop points, gain, trigger mode, etc.)
   */
  updateSamplerState(
    nodeId: string,
    state: {
      frequency: number;
      gain: number;
      loopMode: number;
      loopStart: number;
      loopEnd: number;
      rootNote: number;
      triggerMode: number;
      active: boolean;
    },
  ): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateSampler',
      samplerId: nodeId,
      state,
      instrumentId: this.instrumentId,
    });
  }

  /**
   * Get output gain
   */
  getOutputGain(): number {
    return this.outputNode.gain.value;
  }

  /**
   * Stop all notes
   */
  allNotesOff(): void {
    const now = this.audioContext.currentTime;
    for (const noteNumber of Array.from(this.activeNotes.keys())) {
      this.noteOff(noteNumber);
    }

    // Force-silence every local voice to avoid any stuck gates
    for (let i = 0; i < this.num_voices; i++) {
      const gateParam = this.workletNode.parameters.get(
        this.getParamName('gate', i),
      );
      if (gateParam) {
        gateParam.cancelScheduledValues(now);
        gateParam.setValueAtTime(0, now);
      }
      const gainParam = this.workletNode.parameters.get(
        this.getParamName('gain', i),
      );
      if (gainParam) {
        gainParam.cancelScheduledValues(now);
        // Keep voice gain ready for the next scheduled note. The gate is the
        // authoritative silence control; zeroing gain here can leave later
        // note-ons silent if their velocity is applied before a stale ramp.
        gainParam.setValueAtTime(1, now);
      }
    }

    this.voiceToNote.fill(null);
    this.activeNotes.clear();
  }

  /**
   * Cancel all scheduled notes
   */
  cancelScheduledNotes(): void {
    const now = this.audioContext.currentTime;
    for (let i = 0; i < this.num_voices; i++) {
      const gateParam = this.workletNode.parameters.get(
        this.getParamName('gate', i),
      );
      if (gateParam) {
        gateParam.cancelScheduledValues(now);
        gateParam.setValueAtTime(0, now);
      }
      const freqParam = this.workletNode.parameters.get(
        this.getParamName('frequency', i),
      );
      if (freqParam) freqParam.cancelScheduledValues(now);
      const gainParam = this.workletNode.parameters.get(
        this.getParamName('gain', i),
      );
      if (gainParam) {
        gainParam.cancelScheduledValues(now);
        gainParam.setValueAtTime(1, now);
      }
    }
    this.activeNotes.clear();
    this.voiceToNote.fill(null);
  }

  /**
   * Get voice limit
   */
  getVoiceLimit(): number {
    return this.num_voices;
  }

  /**
   * Get quantum duration in seconds
   */
  getQuantumDurationSeconds(): number {
    return this.quantumFrames / this.audioContext.sampleRate;
  }

  /**
   * Dispose (doesn't disconnect worklet, just cleans up this instrument)
   */
  dispose(): void {
    console.log(
      `[PooledInstrument] Disposing (silencing voices ${this.allocation.startVoice}-${this.allocation.endVoice - 1})`,
    );

    this.allNotesOff();

    // Silence all our voices
    const now = this.audioContext.currentTime;
    for (let i = 0; i < this.num_voices; i++) {
      const gateParam = this.workletNode.parameters.get(
        this.getParamName('gate', i),
      );
      if (gateParam) {
        gateParam.cancelScheduledValues(now);
        gateParam.setValueAtTime(0, now);
      }
      const gainParam = this.workletNode.parameters.get(
        this.getParamName('gain', i),
      );
      if (gainParam) {
        gainParam.cancelScheduledValues(now);
        gainParam.setValueAtTime(0, now);
      }
    }

    // Detach message handler (doesn't destroy worklet)
    this.messageHandler.sendFireAndForget({
      type: 'unloadInstrument',
      instrumentId: this.instrumentId,
      startVoice: this.allocation.startVoice,
      voiceCount: this.num_voices,
    });

    this.messageHandler.detach();

    // Disconnect output node
    try {
      this.outputNode.disconnect();
    } catch (e) {
      console.error('[PooledInstrument] Error disconnecting output:', e);
    }
  }

  // ========================================================================
  // Private Helper Methods
  // ========================================================================

  private markVoiceActive(
    noteNumber: number,
    voiceIndex: number,
    audioTime: number,
  ): void {
    if (voiceIndex < 0 || voiceIndex >= this.num_voices) return;

    let voices = this.activeNotes.get(noteNumber);
    if (!voices) {
      voices = new Set<number>();
      this.activeNotes.set(noteNumber, voices);
    }
    voices.add(voiceIndex);
    this.voiceToNote[voiceIndex] = noteNumber;
    this.voiceLastUsedTime[voiceIndex] = audioTime;
    this.voiceReleaseTime[voiceIndex] = 0;
  }

  private releaseVoice(voiceIndex: number, audioTime?: number): number | null {
    if (voiceIndex < 0 || voiceIndex >= this.num_voices) return null;

    const noteNumber = this.voiceToNote[voiceIndex];
    if (noteNumber === null || noteNumber === undefined) return null;

    const voices = this.activeNotes.get(noteNumber);
    if (voices) {
      voices.delete(voiceIndex);
      if (voices.size === 0) {
        this.activeNotes.delete(noteNumber);
      }
    }

    const releaseTime = audioTime ?? this.audioContext.currentTime;
    this.voiceReleaseTime[voiceIndex] = releaseTime;
    this.voiceToNote[voiceIndex] = null;
    return noteNumber;
  }

  private allocateVoice(
    noteNumber: number,
    allowDuplicate: boolean,
    scheduledTime: number,
  ): { voiceIndex: number; stolenNote: number | null; isRetrigger: boolean } {
    const existingVoices = this.activeNotes.get(noteNumber);
    if (!allowDuplicate && existingVoices && existingVoices.size > 0) {
      const voiceIndex = existingVoices.values().next().value as number;
      return { voiceIndex, stolenNote: null, isRetrigger: true };
    }

    // Find free voice
    const freeVoice = this.findNextFreeVoice(scheduledTime);
    if (freeVoice !== null) {
      return {
        voiceIndex: freeVoice,
        stolenNote: null,
        isRetrigger: existingVoices?.has(freeVoice) ?? false,
      };
    }

    // Steal oldest voice
    let oldestVoice = 0;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.num_voices; i++) {
      const time = this.voiceLastUsedTime[i] ?? Number.POSITIVE_INFINITY;
      if (time < oldestTime) {
        oldestTime = time;
        oldestVoice = i;
      }
    }

    const stolenNote = this.releaseVoice(oldestVoice, scheduledTime);
    return {
      voiceIndex: oldestVoice,
      stolenNote,
      isRetrigger: stolenNote === noteNumber,
    };
  }

  private findNextFreeVoice(scheduledTime: number): number | null {
    const maxReleaseTimeSec = this.maxReleaseTimeMs / 1000;

    for (let offset = 0; offset < this.num_voices; offset++) {
      const candidate = (this.voiceRoundRobinIndex + offset) % this.num_voices;
      const voiceNote = this.voiceToNote[candidate];
      const releaseStartTime = this.voiceReleaseTime[candidate] ?? 0;
      const timeSinceRelease = scheduledTime - releaseStartTime;

      if (
        voiceNote === null &&
        (releaseStartTime === 0 || timeSinceRelease >= maxReleaseTimeSec)
      ) {
        this.voiceRoundRobinIndex = (candidate + 1) % this.num_voices;
        return candidate;
      }
    }

    return null;
  }

  private isPortamentoEnabled(): boolean {
    for (const glide of this.glideStates.values()) {
      if (glide && glide.active && (glide.time ?? 0) > 0) {
        return true;
      }
    }
    return false;
  }

  private midiNoteToFrequency(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  // Additional compatibility methods
  setVoiceMacroAtTime(
    voiceIndex: number,
    macroIndex: number,
    value: number,
    time?: number,
  ): void {
    // This was a no-op stub claiming MOD instruments don't use voice macros
    // during playback. They do: MOD-imported patches route macro 0 to the
    // mixer's stereo pan and macro 1 to the sampler's sample-offset port (see
    // mod-import.ts). Dropping them here silently killed per-channel panning
    // and every 9xx sample-offset command on the pooled path.
    if (voiceIndex < 0 || voiceIndex >= this.num_voices) return;
    const clampedValue = Math.min(1, Math.max(0, value));
    const when =
      typeof time === 'number' ? time : this.audioContext.currentTime;
    const globalVoice = this.localToGlobal(voiceIndex);
    const engineId = Math.floor(globalVoice / VOICES_PER_ENGINE);
    const voiceId = globalVoice % VOICES_PER_ENGINE;
    const param = this.workletNode.parameters.get(
      `macro_engine${engineId}_voice${voiceId}_${macroIndex}`,
    );
    if (!param) return;
    param.setValueAtTime(clampedValue, when);
  }

  setMacro(
    macroIndex: number,
    value: number,
    time?: number,
    rampToValue?: number,
    rampTime?: number,
    interpolation: 'linear' | 'exponential' = 'linear',
  ): void {
    const clampedValue = Math.min(1, Math.max(0, value));
    const when =
      typeof time === 'number' ? time : this.audioContext.currentTime;
    for (let voice = 0; voice < this.num_voices; voice++) {
      const globalVoice = this.localToGlobal(voice);
      const engineId = Math.floor(globalVoice / VOICES_PER_ENGINE);
      const voiceId = globalVoice % VOICES_PER_ENGINE;
      const paramName = `macro_engine${engineId}_voice${voiceId}_${macroIndex}`;
      const param = this.workletNode.parameters.get(paramName);
      if (param) {
        param.setValueAtTime(clampedValue, when);
        if (typeof rampToValue === 'number' && typeof rampTime === 'number') {
          const clampedRamp = Math.min(1, Math.max(0, rampToValue));
          if (interpolation === 'exponential') {
            const start = clampedValue <= 0 ? 0.0001 : clampedValue;
            const target = clampedRamp <= 0 ? 0.0001 : clampedRamp;
            param.setValueAtTime(start, when);
            param.exponentialRampToValueAtTime(target, rampTime);
          } else {
            param.linearRampToValueAtTime(clampedRamp, rampTime);
          }
        }
      }
    }
  }

  connectMacroRoute(_route: MacroRouteState): void {
    if (!_route || _route.targetId === undefined) return;
    this.messageHandler.sendFireAndForget({
      type: 'connectMacro',
      macroIndex: Number(_route.macroIndex),
      targetId: _route.targetId,
      targetPort: _route.targetPort as number,
      amount: _route.amount ?? 0,
      modulationType:
        (_route.modulationType as WasmModulationType | undefined) ??
        WasmModulationType.Additive,
      modulationTransformation:
        (_route.modulationTransformation as
          | ModulationTransformation
          | undefined) ?? ModulationTransformation.None,
      instrumentId: this.instrumentId,
    });
  }

  updateOscillatorState(nodeId: string, newState: OscillatorState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateOscillator',
      oscillatorId: nodeId,
      newState,
      instrumentId: this.instrumentId,
    });
  }

  updateWavetableOscillatorState(
    nodeId: string,
    newState: OscillatorState,
  ): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateWavetableOscillator',
      oscillatorId: nodeId,
      newState,
      instrumentId: this.instrumentId,
    });
  }

  updateEnvelopeState(nodeId: string, state: EnvelopeConfig): Promise<void> {
    this.messageHandler.sendFireAndForget({
      type: 'updateEnvelope',
      envelopeId: nodeId,
      state: JSON.parse(JSON.stringify(toRaw(state))) as EnvelopeConfig,
      instrumentId: this.instrumentId,
    });
    return Promise.resolve();
  }

  updateLfoState(nodeId: string, state: LfoState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateLfo',
      lfoId: nodeId,
      params: {
        lfoId: nodeId,
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
      },
      instrumentId: this.instrumentId,
    });
  }

  updateFilterState(nodeId: string, config: FilterState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateFilter',
      filterId: nodeId,
      config: JSON.parse(JSON.stringify(toRaw(config))) as FilterState,
      instrumentId: this.instrumentId,
    });
  }

  updateConvolverState(nodeId: string, state: ConvolverState): void {
    const plainState = JSON.parse(
      JSON.stringify(toRaw(state)),
    ) as ConvolverState;
    this.messageHandler.sendFireAndForget({
      type: 'updateConvolver',
      nodeId,
      state: plainState,
      instrumentId: this.instrumentId,
    });
  }

  updateDelayState(nodeId: string, state: DelayState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateDelay',
      nodeId,
      state,
      instrumentId: this.instrumentId,
    });
  }

  updateChorusState(nodeId: string, state: ChorusState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateChorus',
      nodeId,
      state,
      instrumentId: this.instrumentId,
    });
  }

  updateReverbState(nodeId: string, state: ReverbState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateReverb',
      nodeId,
      state,
      instrumentId: this.instrumentId,
    });
  }

  updateCompressorState(nodeId: string, state: CompressorState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateCompressor',
      nodeId,
      state,
      instrumentId: this.instrumentId,
    });
  }

  updateSaturationState(nodeId: string, state: SaturationState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateSaturation',
      nodeId,
      state,
      instrumentId: this.instrumentId,
    });
  }

  updateBitcrusherState(nodeId: string, state: BitcrusherState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateBitcrusher',
      nodeId,
      state,
      instrumentId: this.instrumentId,
    });
  }

  updateVelocityState(nodeId: string, state: VelocityState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateVelocity',
      nodeId,
      config: {
        sensitivity: state.sensitivity,
        randomize: state.randomize,
        active: state.active,
      },
      instrumentId: this.instrumentId,
    });
  }

  updateNoiseState(nodeId: string, state: NoiseState): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateNoise',
      noiseId: nodeId,
      config: {
        noise_type: state.noiseType,
        cutoff: state.cutoff,
        gain: state.gain || 1,
        enabled: !!state.is_enabled,
      },
      instrumentId: this.instrumentId,
    });
  }

  updateConnection(connection: NodeConnectionUpdate): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateConnection',
      connection,
      instrumentId: this.instrumentId,
    });
  }

  removeSpecificConnection(
    fromId: string,
    toId: string,
    targetPort: number,
  ): void {
    this.workletNode.port.postMessage({
      type: 'removeConnection',
      fromId,
      toId,
      targetPort,
      instrumentId: this.instrumentId,
    });
  }

  updateGlideState(nodeId: string, state: GlideState): void {
    const glideState = {
      ...state,
      id: state.id ?? nodeId,
      time: state.time ?? 0,
      active: !!state.active,
    };
    this.glideStates.set(nodeId, glideState);

    this.messageHandler.sendFireAndForget({
      type: 'updateGlide',
      glideId: nodeId,
      time: glideState.time,
      active: glideState.active,
      instrumentId: this.instrumentId,
    });
  }

  async importWavetableData(
    nodeId: string,
    wavData: Uint8Array,
  ): Promise<void> {
    this.messageHandler.sendFireAndForget({
      type: 'importWavetable',
      nodeId,
      data: wavData,
      tableSize: wavData.length,
      instrumentId: this.instrumentId,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  importSampleData(nodeId: string, wavData: Uint8Array): void {
    this.workletNode.port.postMessage(
      {
        type: 'importSample',
        nodeId,
        data: wavData.buffer,
        instrumentId: this.instrumentId,
      },
      [wavData.buffer],
    );
  }

  importImpulseWaveformData(nodeId: string, wavData: Uint8Array): void {
    this.messageHandler.sendFireAndForget({
      type: 'importImpulseWaveform',
      nodeId,
      data: wavData,
      instrumentId: this.instrumentId,
    });
  }

  updateArpeggiatorPattern(
    nodeId: string,
    pattern: number[] | { value: number; active: boolean }[],
  ): void {
    const numericPattern = (
      pattern as { value: number; active: boolean }[]
    ).map((step) => step.value);
    this.messageHandler.sendFireAndForget({
      type: 'updateArpeggiatorPattern',
      pattern: numericPattern,
      instrumentId: this.instrumentId,
    });
  }

  updateArpeggiatorPatternSteps(
    nodeId: string,
    pattern: { value: number; active: boolean }[],
  ): void {
    this.updateArpeggiatorPattern(
      nodeId,
      pattern.map((step) => step.value),
    );
  }

  createNode(nodeType: VoiceNodeType): Promise<string> {
    const creation = this.waitForNodeCreation();
    this.messageHandler.sendFireAndForget({
      type: 'createNode',
      nodeType,
      instrumentId: this.instrumentId,
      messageId: creation.messageId,
    });
    return creation.promise;
  }

  deleteNode(_nodeId: string): void {
    // Structural graph editing is not supported for pooled tracker slots yet.
  }

  getEnvelopePreview(
    config: EnvelopeConfig,
    previewDuration: number,
  ): Promise<Float32Array> {
    const messageId = `envelope-preview:${Date.now()}:${Math.random()}`;
    const port = this.workletNode.port;
    return new Promise((resolve, _reject) => {
      const handleMessage = (event: MessageEvent) => {
        if (
          event.data?.type === 'envelopePreview' &&
          event.data.messageId === messageId
        ) {
          port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(event.data.preview));
        }
      };
      port.addEventListener('message', handleMessage);
      port.postMessage({
        type: 'getEnvelopePreview',
        config: JSON.parse(JSON.stringify(toRaw(config))),
        previewDuration,
        messageId,
        instrumentId: this.instrumentId,
      });
      setTimeout(() => {
        port.removeEventListener('message', handleMessage);
        resolve(new Float32Array());
      }, 2000);
    });
  }

  async getSamplerWaveformEarlyUnused(
    nodeId: string,
    maxLength = 512,
  ): Promise<Float32Array> {
    const messageId = `sampler-waveform:${nodeId}:${Date.now()}`;
    const port = this.workletNode.port;
    return new Promise((resolve) => {
      const handleMessage = (event: MessageEvent) => {
        if (
          event.data?.type === 'samplerWaveform' &&
          event.data.messageId === messageId
        ) {
          port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(event.data.waveform));
        }
      };
      port.addEventListener('message', handleMessage);
      port.postMessage({
        type: 'getSamplerWaveform',
        samplerId: nodeId,
        maxLength,
        messageId,
        instrumentId: this.instrumentId,
      });
      setTimeout(() => resolve(new Float32Array()), 5000);
    });
  }

  updateArpeggiatorStepDuration(nodeId: string, stepDurationMs: number): void {
    this.messageHandler.sendFireAndForget({
      type: 'updateArpeggiatorStepDuration',
      stepDuration: stepDurationMs,
      instrumentId: this.instrumentId,
    });
  }

  async getWasmNodeConnections(): Promise<string> {
    const messageId = `${Date.now()}-${Math.random()}`;
    const port = this.workletNode.port;

    return new Promise<string>((resolve, reject) => {
      const handleMessage = (event: MessageEvent) => {
        if (
          event.data?.type === 'nodeLayout' &&
          event.data.messageId === messageId
        ) {
          port.removeEventListener('message', handleMessage);
          resolve(event.data.layout);
        } else if (
          event.data?.type === 'error' &&
          event.data.messageId === messageId
        ) {
          port.removeEventListener('message', handleMessage);
          reject(new Error(event.data.message));
        }
      };

      port.addEventListener('message', handleMessage);
      port.postMessage({
        type: 'getNodeLayout',
        messageId,
        instrumentId: this.instrumentId,
      });
      setTimeout(() => {
        port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for node layout'));
      }, 5000);
    });
  }

  private waitForNodeCreation(): {
    messageId: string;
    promise: Promise<string>;
  } {
    const messageId = `node-created:${Date.now()}:${Math.random()}`;
    const port = this.workletNode.port;

    const promise = new Promise<string>((resolve, reject) => {
      const handleMessage = (event: MessageEvent) => {
        const data = event.data as {
          type?: string;
          nodeId?: unknown;
          messageId?: string;
          message?: string;
        };

        if (data?.type === 'nodeCreated' && data.messageId === messageId) {
          if (typeof data.nodeId === 'string') {
            port.removeEventListener('message', handleMessage);
            resolve(data.nodeId);
          }
          return;
        }

        if (
          data?.type === 'error' &&
          data.messageId === messageId
        ) {
          port.removeEventListener('message', handleMessage);
          reject(
            new Error(String(data.message ?? 'Node creation failed')),
          );
        }
      };

      port.addEventListener('message', handleMessage);
      setTimeout(() => {
        port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for node creation'));
      }, 5000);
    });

    return { messageId, promise };
  }

  async getFilterResponse(nodeId: string, length = 512): Promise<Float32Array> {
    const messageId = `${nodeId}:${Date.now()}:${Math.random()}`;
    const port = this.workletNode.port;

    return new Promise<Float32Array>((resolve, _reject) => {
      const handleMessage = (event: MessageEvent) => {
        if (
          event.data?.type === 'FilterIrWaveform' &&
          event.data.messageId === messageId
        ) {
          port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(event.data.waveform));
        }
      };

      port.addEventListener('message', handleMessage);
      port.postMessage({
        type: 'getFilterIRWaveform',
        node_id: nodeId,
        length,
        messageId,
        instrumentId: this.instrumentId,
      });
      setTimeout(() => {
        port.removeEventListener('message', handleMessage);
        resolve(new Float32Array());
      }, 1000);
    });
  }

  async getLfoWaveform(
    waveform: number,
    phaseOffset: number,
    frequency: number,
    bufferSize: number,
    useAbsolute: boolean,
    useNormalized: boolean,
  ): Promise<Float32Array> {
    const messageId = `lfo-waveform:${Date.now()}`;
    const port = this.workletNode.port;
    return new Promise((resolve) => {
      const handleMessage = (event: MessageEvent) => {
        if (
          event.data?.type === 'lfoWaveform' &&
          event.data.messageId === messageId
        ) {
          port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(event.data.waveform));
        }
      };
      port.addEventListener('message', handleMessage);
      port.postMessage({
        type: 'getLfoWaveform',
        waveform,
        phaseOffset,
        frequency,
        bufferSize,
        use_absolute: useAbsolute,
        use_normalized: useNormalized,
        messageId,
        instrumentId: this.instrumentId,
      });
      setTimeout(() => resolve(new Float32Array()), 5000);
    });
  }

  async getSamplerWaveform(
    nodeId: string,
    maxLength = 512,
  ): Promise<Float32Array> {
    const messageId = `sampler-waveform:${nodeId}:${Date.now()}`;
    const port = this.workletNode.port;
    return new Promise((resolve) => {
      const handleMessage = (event: MessageEvent) => {
        if (
          event.data?.type === 'samplerWaveform' &&
          event.data.messageId === messageId
        ) {
          port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(event.data.waveform));
        }
      };
      port.addEventListener('message', handleMessage);
      port.postMessage({
        type: 'getSamplerWaveform',
        samplerId: nodeId,
        maxLength,
        messageId,
        instrumentId: this.instrumentId,
      });
      setTimeout(() => resolve(new Float32Array()), 5000);
    });
  }

  generateHallReverb(
    nodeId: string,
    decayTime: number,
    roomSize: number,
  ): Promise<void> {
    return this.generateReverbImpulse('hall', nodeId, decayTime, roomSize);
  }

  generatePlateReverb(
    nodeId: string,
    decayTime: number,
    diffusion: number,
  ): Promise<void> {
    return this.generateReverbImpulse('plate', nodeId, decayTime, diffusion);
  }

  private generateReverbImpulse(
    type: 'hall' | 'plate',
    nodeId: string,
    primary: number,
    secondary: number,
  ): Promise<void> {
    const messageId = `reverb:${type}:${Date.now()}`;
    const port = this.workletNode.port;
    return new Promise((resolve) => {
      const handleMessage = (event: MessageEvent) => {
        if (event.data?.messageId === messageId) {
          port.removeEventListener('message', handleMessage);
          resolve();
        }
      };
      port.addEventListener('message', handleMessage);
      port.postMessage({
        type: type === 'hall' ? 'generateHallReverb' : 'generatePlateReverb',
        nodeId,
        [type === 'hall' ? 'roomSize' : 'diffusion']: secondary,
        decayTime: primary,
        sampleRate: this.audioContext.sampleRate,
        messageId,
        instrumentId: this.instrumentId,
      });
      setTimeout(resolve, 2000);
    });
  }

  readonly num_engines = ENGINES_PER_WORKLET;
  readonly voices_per_engine = VOICES_PER_ENGINE;

  remove_specific_connection(
    fromId: string,
    toId: string,
    targetPort: number,
  ): void {
    this.removeSpecificConnection(fromId, toId, targetPort);
  }

  updateWavetable(_nodeId: string, _newWavetable: unknown): void {}

  updateLayout(_layout: unknown): void {}

  async exportSamplerData(nodeId: string): Promise<{
    samples: Float32Array;
    sampleRate: number;
    channels: number;
    rootNote: number;
  }> {
    const messageId = `export-sample:${nodeId}`;
    const port = this.workletNode.port;
    return new Promise((resolve) => {
      const handleMessage = (event: MessageEvent) => {
        if (event.data?.messageId === messageId) {
          port.removeEventListener('message', handleMessage);
          resolve(
            event.data.sampleData ?? {
              samples: new Float32Array(),
              sampleRate: 44100,
              channels: 1,
              rootNote: 60,
            },
          );
        }
      };
      port.addEventListener('message', handleMessage);
      port.postMessage({
        type: 'exportSampleData',
        samplerId: nodeId,
        messageId,
        instrumentId: this.instrumentId,
      });
      setTimeout(
        () =>
          resolve({
            samples: new Float32Array(),
            sampleRate: 44100,
            channels: 1,
            rootNote: 60,
          }),
        5000,
      );
    });
  }

  async exportConvolverData(
    nodeId: string,
  ): Promise<{ samples: Float32Array; sampleRate: number; channels: number }> {
    const messageId = `export-convolver:${nodeId}`;
    const port = this.workletNode.port;
    return new Promise((resolve) => {
      const handleMessage = (event: MessageEvent) => {
        if (event.data?.messageId === messageId) {
          port.removeEventListener('message', handleMessage);
          resolve(
            event.data.convolverData ?? {
              samples: new Float32Array(),
              sampleRate: 44100,
              channels: 1,
            },
          );
        }
      };
      port.addEventListener('message', handleMessage);
      port.postMessage({
        type: 'exportConvolverData',
        convolverId: nodeId,
        messageId,
        instrumentId: this.instrumentId,
      });
      setTimeout(
        () =>
          resolve({
            samples: new Float32Array(),
            sampleRate: 44100,
            channels: 1,
          }),
        5000,
      );
    });
  }

  getFilterIRWaveform(nodeId: string, length = 512): Promise<Float32Array> {
    return this.getFilterResponse(nodeId, length);
  }

  async waitForInstrumentReady(_instrument?: unknown): Promise<boolean> {
    return true;
  }
}
