// src/audio/mod-instrument.ts
/**
 * Lightweight instrument for MOD file playback using native Web Audio API.
 *
 * Unlike the full WASM-based InstrumentV2, this uses AudioBufferSourceNode
 * for sample playback, avoiding AudioWorklet limits and reducing memory usage.
 *
 * Perfect for MOD files which only need simple sample playback with
 * volume, panning, and pitch control.
 */

import type { Patch } from './types/preset-types';
import type { SamplerState } from './types/synth-layout';
import { decodeAudioAssetToFloat32Array } from './serialization/audio-asset-encoder';
import { AudioAssetType } from './types/preset-types';

interface ActiveVoice {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  panNode: StereoPannerNode;
  noteNumber: number;
  startTime: number;
  frequency: number;
}

export default class ModInstrument {
  readonly num_voices = 4; // MOD instruments use 4 voices
  outputNode: GainNode;

  private audioContext: AudioContext;
  private audioBuffer: AudioBuffer | null = null;
  private samplerState: SamplerState | null = null;
  private activeVoices: Map<number, ActiveVoice> = new Map();
  private voiceRoundRobinIndex = 0;
  private ready = false;

  public get isReady(): boolean {
    return this.ready;
  }

  constructor(
    destination: AudioNode,
    audioContext: AudioContext,
  ) {
    this.audioContext = audioContext;
    this.outputNode = audioContext.createGain();
    this.outputNode.gain.value = 1.0;
    this.outputNode.connect(destination);
  }

  async loadPatch(patch: Patch): Promise<void> {
    console.log('[ModInstrument] loadPatch called for:', patch.metadata.name);
    console.log('[ModInstrument] Available audioAssets:', Object.keys(patch.audioAssets));
    // Extract sampler state
    const samplerStates = Object.values(patch.synthState.samplers);
    if (samplerStates.length === 0) {
      throw new Error('MOD patch must have a sampler node');
    }

    this.samplerState = samplerStates[0]!;

    console.log('[ModInstrument] Sampler state ID:', this.samplerState.id);

    // For MOD instruments, the audio asset ID should match the sampler ID
    // But if it doesn't (due to normalization), use the first available sample asset
    let assetId = this.samplerState.id;
    let asset = patch.audioAssets[assetId];

    // If not found by sampler ID, try to find the first sample asset
    if (!asset || asset.type !== AudioAssetType.Sample) {
      const sampleAssets = Object.entries(patch.audioAssets).filter(
        ([, a]) => a.type === AudioAssetType.Sample
      );

      if (sampleAssets.length > 0) {
        [assetId, asset] = sampleAssets[0]!;
      } else {
        throw new Error(`No sample assets found in patch. Available assets: ${Object.keys(patch.audioAssets).join(', ')}`);
      }
    }

    if (asset.type !== AudioAssetType.Sample) {
      throw new Error(`Asset ${assetId} is not a sample (type: ${asset.type})`);
    }

    console.log('[ModInstrument] Decoding sample, sampleRate:', asset.sampleRate, 'channels:', asset.channels);
    // Decode audio asset to Float32Array
    const data = decodeAudioAssetToFloat32Array(asset);
    const sampleRate = asset.sampleRate;
    const channels = asset.channels;

    // Create AudioBuffer
    this.audioBuffer = this.audioContext.createBuffer(
      channels,
      data.length / channels,
      sampleRate
    );

    // Copy audio data to buffer
    for (let ch = 0; ch < channels; ch++) {
      const channelData = this.audioBuffer.getChannelData(ch);
      for (let i = 0; i < channelData.length; i++) {
        channelData[i] = data[i * channels + ch] ?? 0;
      }
    }

    this.ready = true;
    console.log('[ModInstrument] loadPatch complete, buffer length:', this.audioBuffer.length, 'frames');
  }

  noteOn(
    noteNumber: number,
    velocity: number,
    options?: { allowDuplicate?: boolean; frequency?: number; pan?: number },
  ): void {
    if (!this.audioBuffer || !this.samplerState) {
      console.warn('[ModInstrument] noteOn skipped - buffer or state not ready');
      return;
    }

    console.log('[ModInstrument] noteOn: note', noteNumber, 'velocity', velocity, 'buffer length', this.audioBuffer.length);

    // Allocate a voice (round-robin for now)
    const voiceIndex = this.voiceRoundRobinIndex;
    this.voiceRoundRobinIndex = (this.voiceRoundRobinIndex + 1) % this.num_voices;

    // Stop existing voice if playing (unless allowDuplicate is true)
    if (!options?.allowDuplicate) {
      // Check if this note is already playing on another voice
      for (const [vIdx, voice] of this.activeVoices.entries()) {
        if (voice.noteNumber === noteNumber) {
          this.noteOff(noteNumber, vIdx);
          break;
        }
      }
    }

    // Create audio nodes for this voice
    const source = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();
    const panNode = this.audioContext.createStereoPanner();

    source.buffer = this.audioBuffer;

    // Configure looping
    if (this.samplerState.loopMode === 1) { // Loop mode
      source.loop = true;
      const bufferLength = this.audioBuffer.length;
      source.loopStart = this.samplerState.loopStart * bufferLength / this.audioBuffer.sampleRate;
      source.loopEnd = this.samplerState.loopEnd * bufferLength / this.audioBuffer.sampleRate;
    }

    // Set gain based on velocity and sampler gain
    const noteGain = (velocity / 127) * this.samplerState.gain;
    gainNode.gain.value = noteGain;

    // Set panning (0-1 maps to -1 to 1)
    const pan = options?.pan;
    if (pan !== undefined) {
      panNode.pan.value = (pan - 0.5) * 2;
    }

    // Calculate playback rate from frequency
    const frequency = options?.frequency ?? this.midiNoteToFrequency(noteNumber);
    const playbackRate = this.calculatePlaybackRate(frequency);
    source.playbackRate.value = playbackRate;

    // Connect audio graph: source -> gain -> pan -> output
    source.connect(gainNode);
    gainNode.connect(panNode);
    panNode.connect(this.outputNode);

    // Start playback
    source.start();

    console.log('[ModInstrument] Started voice', voiceIndex, 'playbackRate', playbackRate, 'gain', noteGain, 'loop', source.loop);

    // Store active voice
    this.activeVoices.set(voiceIndex, {
      source,
      gainNode,
      panNode,
      noteNumber,
      startTime: this.audioContext.currentTime,
      frequency: frequency ?? 440,
    });
  }

  noteOff(noteNumber: number, voiceIndex?: number): void {
    // If voiceIndex is specified, stop that specific voice
    if (voiceIndex !== undefined) {
      const voice = this.activeVoices.get(voiceIndex);
      if (!voice || voice.noteNumber !== noteNumber) {
        return;
      }

      // Apply quick release envelope (10ms ramp to prevent clicks)
      const releaseTime = 0.01;
      voice.gainNode.gain.setValueAtTime(voice.gainNode.gain.value, this.audioContext.currentTime);
      voice.gainNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + releaseTime);

      // Stop and disconnect after release
      const stopTime = this.audioContext.currentTime + releaseTime;
      voice.source.stop(stopTime);

      // Disconnect nodes after the release completes
      setTimeout(() => {
        try {
          voice.source.disconnect();
          voice.gainNode.disconnect();
          voice.panNode.disconnect();
        } catch (e) {
          // Nodes may already be disconnected, ignore
        }
      }, releaseTime * 1000 + 10);

      this.activeVoices.delete(voiceIndex);
      return;
    }

    // Otherwise, find and stop all voices playing this note
    for (const [vIdx, voice] of this.activeVoices.entries()) {
      if (voice.noteNumber === noteNumber) {
        const releaseTime = 0.01;
        voice.gainNode.gain.setValueAtTime(voice.gainNode.gain.value, this.audioContext.currentTime);
        voice.gainNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + releaseTime);
        const stopTime = this.audioContext.currentTime + releaseTime;
        voice.source.stop(stopTime);

        // Disconnect nodes after the release completes
        setTimeout(() => {
          try {
            voice.source.disconnect();
            voice.gainNode.disconnect();
            voice.panNode.disconnect();
          } catch (e) {
            // Nodes may already be disconnected, ignore
          }
        }, releaseTime * 1000 + 10);

        this.activeVoices.delete(vIdx);
      }
    }
  }

  // Old noteOff implementation for internal use
  private noteOffVoice(noteNumber: number, voiceIndex: number): void {
    const voice = this.activeVoices.get(voiceIndex);
    if (!voice || voice.noteNumber !== noteNumber) {
      return;
    }

    // Apply quick release envelope (10ms ramp to prevent clicks)
    const releaseTime = 0.01;
    voice.gainNode.gain.setValueAtTime(voice.gainNode.gain.value, this.audioContext.currentTime);
    voice.gainNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + releaseTime);

    // Stop and disconnect after release
    const stopTime = this.audioContext.currentTime + releaseTime;
    voice.source.stop(stopTime);

    // Disconnect nodes after the release completes
    setTimeout(() => {
      try {
        voice.source.disconnect();
        voice.gainNode.disconnect();
        voice.panNode.disconnect();
      } catch (e) {
        // Nodes may already be disconnected, ignore
      }
    }, releaseTime * 1000 + 10);

    this.activeVoices.delete(voiceIndex);
  }

  setFrequency(voiceIndex: number, frequency: number): void {
    const voice = this.activeVoices.get(voiceIndex);
    if (!voice) {
      return;
    }

    const playbackRate = this.calculatePlaybackRate(frequency);
    const now = this.audioContext.currentTime;

    // Smooth frequency changes to avoid clicks
    voice.source.playbackRate.setValueAtTime(voice.source.playbackRate.value, now);
    voice.source.playbackRate.linearRampToValueAtTime(playbackRate, now + 0.005);
    voice.frequency = frequency;
  }

  setGain(voiceIndex: number, gain: number): void {
    const voice = this.activeVoices.get(voiceIndex);
    if (!voice) {
      return;
    }

    const now = this.audioContext.currentTime;
    voice.gainNode.gain.setValueAtTime(voice.gainNode.gain.value, now);
    voice.gainNode.gain.linearRampToValueAtTime(gain, now + 0.005);
  }

  setPan(voiceIndex: number, pan: number): void {
    const voice = this.activeVoices.get(voiceIndex);
    if (!voice) {
      return;
    }

    // Pan value 0-1 maps to -1 to 1
    const panValue = (pan - 0.5) * 2;
    const now = this.audioContext.currentTime;
    voice.panNode.pan.setValueAtTime(voice.panNode.pan.value, now);
    voice.panNode.pan.linearRampToValueAtTime(panValue, now + 0.005);
  }

  allNotesOff(): void {
    for (const [voiceIndex, voice] of this.activeVoices.entries()) {
      this.noteOff(voice.noteNumber, voiceIndex);
    }
  }

  setInstrumentGain(gain: number): void {
    this.outputNode.gain.value = gain;
  }

  destroy(): void {
    console.log('[ModInstrument] Destroying instrument, active voices:', this.activeVoices.size);

    // Immediately stop and disconnect all active voices without release envelope
    for (const voice of this.activeVoices.values()) {
      try {
        // Stop the source immediately
        voice.source.stop();
      } catch (e) {
        // Source may already be stopped, ignore
      }

      // Disconnect all nodes immediately
      try {
        voice.source.disconnect();
        voice.gainNode.disconnect();
        voice.panNode.disconnect();
      } catch (e) {
        // Nodes may already be disconnected, ignore
      }
    }

    // Clear the active voices map
    this.activeVoices.clear();

    // Disconnect output node
    try {
      this.outputNode.disconnect();
    } catch (e) {
      // Already disconnected, ignore
    }

    // Clear the audio buffer reference for GC
    this.audioBuffer = null;
    this.samplerState = null;
    this.ready = false;

    console.log('[ModInstrument] Destroyed successfully');
  }

  // Alias for compatibility with InstrumentV2 interface
  dispose(): void {
    this.destroy();
  }

  // Compatibility method with InstrumentV2
  setGainForAllVoices(gain: number): void {
    // For MOD instruments, this sets the master output gain
    this.setInstrumentGain(gain);
  }

  private calculatePlaybackRate(frequency: number): number {
    if (!this.samplerState) {
      return 1.0;
    }

    // Calculate playback rate based on frequency relative to root note
    // frequency = root_frequency * 2^(semitones/12)
    // playbackRate = frequency / root_frequency

    const rootNote = this.samplerState.rootNote;
    const rootFrequency = 440 * Math.pow(2, (rootNote - 69) / 12);

    // Apply detune
    const detuneCents = this.samplerState.detune ?? 0;
    const detuneRatio = Math.pow(2, detuneCents / 1200);

    return (frequency / rootFrequency) * detuneRatio;
  }

  // Stub methods for compatibility with InstrumentV2 interface
  async waitForReady(): Promise<void> {
    if (this.ready) {
      return;
    }
    // Wait up to 5 seconds
    const startTime = Date.now();
    while (!this.ready && Date.now() - startTime < 5000) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!this.ready) {
      throw new Error('ModInstrument failed to initialize');
    }
  }

  setMacroParameter(_voiceIndex: number, _macroIndex: number, _value: number): void {
    // MOD instruments don't use macro parameters
    // Macros are handled directly via setPan, setFrequency, etc.
  }

  // Additional compatibility methods for InstrumentV2 interface

  noteOnAtTime(
    noteNumber: number,
    velocity: number,
    time: number,
    options?: { allowDuplicate?: boolean; frequency?: number },
  ): number | undefined {
    if (!this.audioBuffer || !this.samplerState) {
      console.warn('[ModInstrument] noteOnAtTime skipped - buffer or state not ready');
      return undefined;
    }

    console.log('[ModInstrument] noteOnAtTime: note', noteNumber, 'at time', time.toFixed(3));

    // Allocate a voice (round-robin)
    const voiceIndex = this.voiceRoundRobinIndex;
    this.voiceRoundRobinIndex = (this.voiceRoundRobinIndex + 1) % this.num_voices;

    // Stop existing voice if playing (unless allowDuplicate is true)
    if (!options?.allowDuplicate) {
      for (const [vIdx, voice] of this.activeVoices.entries()) {
        if (voice.noteNumber === noteNumber) {
          this.noteOff(noteNumber, vIdx);
          break;
        }
      }
    }

    // Create audio nodes for this voice
    const source = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();
    const panNode = this.audioContext.createStereoPanner();

    source.buffer = this.audioBuffer;

    // Configure looping
    if (this.samplerState.loopMode === 1) {
      source.loop = true;
      const bufferLength = this.audioBuffer.length;
      source.loopStart = this.samplerState.loopStart * bufferLength / this.audioBuffer.sampleRate;
      source.loopEnd = this.samplerState.loopEnd * bufferLength / this.audioBuffer.sampleRate;
    }

    // Set gain based on velocity and sampler gain
    const noteGain = (velocity / 127) * this.samplerState.gain;
    gainNode.gain.value = noteGain;

    // Set panning
    const pan = options?.pan;
    if (pan !== undefined) {
      panNode.pan.value = (pan - 0.5) * 2;
    }

    // Calculate playback rate from frequency
    const frequency = options?.frequency ?? this.midiNoteToFrequency(noteNumber);
    const playbackRate = this.calculatePlaybackRate(frequency);
    source.playbackRate.value = playbackRate;

    // Connect audio graph
    source.connect(gainNode);
    gainNode.connect(panNode);
    panNode.connect(this.outputNode);

    // Schedule playback at the specified time
    const startTime = Math.max(time, this.audioContext.currentTime);
    source.start(startTime);

    console.log('[ModInstrument] Scheduled voice', voiceIndex, 'at', startTime.toFixed(3), 'playbackRate', playbackRate);

    // Store active voice
    this.activeVoices.set(voiceIndex, {
      source,
      gainNode,
      panNode,
      noteNumber,
      startTime: startTime,
      frequency: frequency ?? 440,
    });

    return voiceIndex;
  }

  noteOffAtTime(noteNumber: number, time: number, _trackIndex?: number): void {
    const now = this.audioContext.currentTime;
    if (time <= now + 0.1) {
      this.noteOff(noteNumber);
    }
  }

  gateOffVoiceAtTime(voiceIndex: number, _time: number): void {
    const voice = this.activeVoices.get(voiceIndex);
    if (voice) {
      this.noteOffVoice(voice.noteNumber, voiceIndex);
    }
  }

  setVoiceFrequencyAtTime(voiceIndex: number, frequency: number, _time: number): void {
    this.setFrequency(voiceIndex, frequency);
  }

  setVoiceGainAtTime(voiceIndex: number, gain: number, _time: number): void {
    this.setGain(voiceIndex, gain);
  }

  setVoiceMacroAtTime(voiceIndex: number, macroIndex: number, value: number, _time: number): void {
    // Macro 0 is pan for MOD instruments
    if (macroIndex === 0) {
      this.setPan(voiceIndex, value);
    }
  }

  cancelScheduledNotes(): void {
    // ModInstrument doesn't schedule notes
  }

  cancelAndSilenceVoice(voiceIndex: number): void {
    const voice = this.activeVoices.get(voiceIndex);
    if (voice) {
      this.noteOffVoice(voice.noteNumber, voiceIndex);
    }
  }

  private midiNoteToFrequency(noteNumber: number): number {
    // Standard MIDI note to frequency conversion: A4 (69) = 440 Hz
    return 440 * Math.pow(2, (noteNumber - 69) / 12);
  }

  setOutputGain(gain: number): void {
    this.setInstrumentGain(gain);
  }

  getOutputGain(): number {
    return this.outputNode.gain.value;
  }

  setMacro(_macroIndex: number, _value: number): void {
    // MOD instruments don't use global macros
  }

  getVoiceLimit(): number {
    return this.num_voices;
  }

  getQuantumDurationSeconds(): number {
    // Web Audio processes in 128-frame blocks at the context sample rate
    return 128 / this.audioContext.sampleRate;
  }

  // Properties for compatibility
  workletNode: AudioWorkletNode | null = null;
}
