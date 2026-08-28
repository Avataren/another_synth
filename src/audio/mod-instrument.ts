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
import {
  SamplerLoopMode,
  type SamplerState,
  type TrackerVolumeEnvelope,
} from './types/synth-layout';
import { decodeAudioAssetToFloat32Array } from './serialization/audio-asset-encoder';
import { AudioAssetType } from './types/preset-types';

/**
 * Fallback tick duration when a caller does not supply one: 2.5 / 125 BPM,
 * the tracker default. A tick is 2.5/BPM seconds in both ProTracker and FT2.
 */
const DEFAULT_TICK_SECONDS = 2.5 / 125;

/** Voices assumed when a patch does not state a count. */
const DEFAULT_VOICE_COUNT = 4;

/** Upper bound, so a malformed patch cannot allocate unbounded voices. */
const MAX_VOICE_COUNT = 64;

interface ActiveVoice {
  source: AudioBufferSourceNode;
  gainNode: GainNode;
  /**
   * Separate stage for the instrument's volume envelope, so it multiplies with
   * the channel volume on `gainNode` rather than fighting the automation that
   * volume effects schedule there.
   */
  envelopeGain: GainNode | null;
  panNode: StereoPannerNode;
  noteNumber: number;
  startTime: number;
  /** Tick duration in force when this voice started, for envelope release. */
  tickSeconds: number;
  frequency: number;
  targetGain: number; // Track scheduled gain value (Web Audio param.value doesn't reflect scheduled changes)
}

export default class ModInstrument {
  /**
   * Voices available to this instrument.
   *
   * Taken from the patch layout rather than fixed. One sample is one
   * instrument here, so an instrument played on several channels at once
   * shares this pool -- an XM module can have nine channels sounding the same
   * instrument, and a fixed four meant the fifth onward stole a voice from a
   * note that was still playing. Audibly: notes simply missing.
   */
  private voiceCount = DEFAULT_VOICE_COUNT;

  get num_voices(): number {
    return this.voiceCount;
  }
  outputNode: GainNode;

  private audioContext: AudioContext;
  private audioBuffer: AudioBuffer | null = null;
  private samplerState: SamplerState | null = null;
  private activeVoices: Map<number, ActiveVoice> = new Map();
  private voiceRoundRobinIndex = 0;
  private ready = false;
  /**
   * Sample offset (0-1) set by a 9xx row that carried no note of its own,
   * waiting to be consumed by the next note. Mirrors ProTracker's per-channel
   * offset memory. Offsets that arrive *with* a note bypass this and are
   * passed straight to noteOnAtTime.
   */
  private pendingSampleOffset: number | undefined;

  /**
   * Which voice each tracker channel owns.
   *
   * A tracker channel is monophonic, so a channel's note should only ever
   * replace that channel's own note. Allocating from a shared pool instead let
   * a new note on one channel steal a voice from a different channel that was
   * still sounding, which is heard as notes going missing. Ownership is
   * permanent for the life of the instrument so a channel keeps its voice
   * across notes.
   */
  private trackVoices: Map<number, number> = new Map();

  /**
   * Voices that have been released but are still sounding out their fadeout.
   *
   * They are removed from `activeVoices` at release so the slot can be reused
   * immediately, which means a later note on the same channel would otherwise
   * have no way to find and stop them -- the released note simply carried on
   * underneath the new one. That was inaudible while releases lasted 10ms and
   * obvious once XM fadeouts stretched them past a second.
   */
  private releasingVoices: Map<number, ActiveVoice> = new Map();

  /** Loop bounds in buffer seconds, resolved once at load time. */
  private loopEnabled = false;
  private loopStartSeconds = 0;
  private loopEndSeconds = 0;

  public get isReady(): boolean {
    return this.ready;
  }

  constructor(destination: AudioNode, audioContext: AudioContext) {
    this.audioContext = audioContext;
    this.outputNode = audioContext.createGain();
    this.outputNode.gain.value = 1.0;
    this.outputNode.connect(destination);
  }

  async loadPatch(patch: Patch): Promise<void> {
    console.log('[ModInstrument] loadPatch called for:', patch.metadata.name);
    console.log(
      '[ModInstrument] Available audioAssets:',
      Object.keys(patch.audioAssets),
    );
    // Extract sampler state
    const samplerStates = Object.values(patch.synthState.samplers);
    if (samplerStates.length === 0) {
      throw new Error('MOD patch must have a sampler node');
    }

    this.samplerState = samplerStates[0]!;

    const requested = patch.synthState.layout?.voiceCount;
    this.voiceCount = Math.max(
      1,
      Math.min(MAX_VOICE_COUNT, requested ?? DEFAULT_VOICE_COUNT),
    );

    console.log('[ModInstrument] Sampler state ID:', this.samplerState.id);

    // For MOD instruments, the audio asset ID should match the sampler ID
    // But if it doesn't (due to normalization), use the first available sample asset
    let assetId = this.samplerState.id;
    let asset = patch.audioAssets[assetId];

    // If not found by sampler ID, try to find the first sample asset
    if (!asset || asset.type !== AudioAssetType.Sample) {
      const sampleAssets = Object.entries(patch.audioAssets).filter(
        ([, a]) => a.type === AudioAssetType.Sample,
      );

      if (sampleAssets.length > 0) {
        [assetId, asset] = sampleAssets[0]!;
      } else {
        throw new Error(
          `No sample assets found in patch. Available assets: ${Object.keys(patch.audioAssets).join(', ')}`,
        );
      }
    }

    if (asset.type !== AudioAssetType.Sample) {
      throw new Error(`Asset ${assetId} is not a sample (type: ${asset.type})`);
    }

    console.log(
      '[ModInstrument] Decoding sample, sampleRate:',
      asset.sampleRate,
      'channels:',
      asset.channels,
    );
    // Decode audio asset to Float32Array
    const data = decodeAudioAssetToFloat32Array(asset);
    const sampleRate = asset.sampleRate;
    const channels = asset.channels;

    // Handle empty samples (0 length) - create 1 frame of silence
    const frameCount = Math.max(1, Math.floor(data.length / channels));
    const isEmpty = data.length === 0;

    // Create AudioBuffer
    this.audioBuffer = this.audioContext.createBuffer(
      channels,
      frameCount,
      sampleRate,
    );

    // Copy audio data to buffer (or leave silent if empty)
    if (!isEmpty) {
      for (let ch = 0; ch < channels; ch++) {
        const channelData = this.audioBuffer.getChannelData(ch);
        for (let i = 0; i < channelData.length; i++) {
          channelData[i] = data[i * channels + ch] ?? 0;
        }
      }
    }
    // If isEmpty, buffer is already initialized to silence

    this.prepareLoop(channels, frameCount, sampleRate);

    this.ready = true;
    console.log(
      '[ModInstrument] loadPatch complete, buffer length:',
      this.audioBuffer.length,
      'frames',
    );
  }

  /**
   * Work out the loop this instrument plays, once at load time.
   *
   * Ping-pong needs materialising: an AudioBufferSourceNode can only loop
   * forwards, so the loop region is followed by a reversed copy of itself and
   * the loop is widened to span both halves. Playing that forwards reproduces
   * the bounce exactly. Without this, ping-pong samples fell through the
   * `loopMode === 1` check and did not loop at all -- 27 samples across the
   * local XM corpus, including 10 in an-path.xm and 8 in elw-sick.xm.
   */
  private prepareLoop(
    channels: number,
    frameCount: number,
    sampleRate: number,
  ): void {
    this.loopStartSeconds = 0;
    this.loopEndSeconds = 0;
    this.loopEnabled = false;

    const state = this.samplerState;
    if (!state || !this.audioBuffer) return;
    if (state.loopMode === SamplerLoopMode.Off) return;

    const startFrame = Math.max(
      0,
      Math.min(frameCount - 1, Math.round(state.loopStart * frameCount)),
    );
    const endFrame = Math.max(
      startFrame + 1,
      Math.min(frameCount, Math.round(state.loopEnd * frameCount)),
    );
    const loopFrames = endFrame - startFrame;
    if (loopFrames < 2) return;

    if (state.loopMode === SamplerLoopMode.PingPong) {
      // [0 .. endFrame) then the loop region reversed.
      const mirrored = this.audioContext.createBuffer(
        channels,
        endFrame + loopFrames,
        sampleRate,
      );
      for (let ch = 0; ch < channels; ch++) {
        const source = this.audioBuffer.getChannelData(ch);
        const target = mirrored.getChannelData(ch);
        target.set(source.subarray(0, endFrame), 0);
        for (let i = 0; i < loopFrames; i++) {
          target[endFrame + i] = source[endFrame - 1 - i] ?? 0;
        }
      }
      this.audioBuffer = mirrored;
      this.loopStartSeconds = startFrame / sampleRate;
      this.loopEndSeconds = (endFrame + loopFrames) / sampleRate;
    } else {
      this.loopStartSeconds = startFrame / sampleRate;
      this.loopEndSeconds = endFrame / sampleRate;
    }

    this.loopEnabled = true;
  }

  /** Apply the prepared loop to a freshly created source. */
  private applyLoop(source: AudioBufferSourceNode): void {
    if (!this.loopEnabled) return;
    source.loop = true;
    source.loopStart = this.loopStartSeconds;
    source.loopEnd = this.loopEndSeconds;
  }

  noteOn(
    noteNumber: number,
    velocity: number,
    options?: { allowDuplicate?: boolean; frequency?: number; pan?: number },
  ): void {
    if (!this.audioBuffer || !this.samplerState) {
      console.warn(
        '[ModInstrument] noteOn skipped - buffer or state not ready',
      );
      return;
    }

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

    // Allocate a voice: prefer free voices, then use round-robin for voice stealing
    let voiceIndex = -1;

    // First, try to find a free voice
    for (let i = 0; i < this.num_voices; i++) {
      if (!this.activeVoices.has(i)) {
        voiceIndex = i;
        break;
      }
    }

    // If no free voice, use round-robin to steal one
    if (voiceIndex === -1) {
      voiceIndex = this.voiceRoundRobinIndex;
      this.voiceRoundRobinIndex =
        (this.voiceRoundRobinIndex + 1) % this.num_voices;

      // Stop the old voice on this voice slot before reusing it
      const oldVoice = this.activeVoices.get(voiceIndex);
      if (oldVoice) {
        try {
          oldVoice.source.stop();
        } catch {
          // Source may have already stopped naturally
        }
        oldVoice.source.disconnect();
        oldVoice.gainNode.disconnect();
        oldVoice.panNode.disconnect();
        oldVoice.envelopeGain?.disconnect();
        this.activeVoices.delete(voiceIndex);
      }
    }

    // Create audio nodes for this voice
    const source = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();
    const panNode = this.audioContext.createStereoPanner();

    source.buffer = this.audioBuffer;

    // Configure looping (prepared once at load time; see prepareLoop)
    this.applyLoop(source);

    // Set gain based on velocity and sampler gain
    const noteGain = (velocity / 127) * this.samplerState.gain;
    gainNode.gain.value = noteGain;

    // Set panning (0-1 maps to -1 to 1)
    const pan = options?.pan;
    if (pan !== undefined) {
      panNode.pan.value = (pan - 0.5) * 2;
    }

    // Calculate playback rate from frequency
    const frequency =
      options?.frequency ?? this.midiNoteToFrequency(noteNumber);
    const playbackRate = this.calculatePlaybackRate(frequency);
    source.playbackRate.value = playbackRate;

    // Connect audio graph: source -> gain -> pan -> output
    source.connect(gainNode);
    gainNode.connect(panNode);
    panNode.connect(this.outputNode);

    // Start playback
    source.start();

    // Store active voice
    this.activeVoices.set(voiceIndex, {
      source,
      gainNode,
      // The immediate (non-scheduled) path is used for previews, which do not
      // run tracker envelopes.
      envelopeGain: null,
      panNode,
      tickSeconds: DEFAULT_TICK_SECONDS,
      noteNumber,
      startTime: this.audioContext.currentTime,
      frequency: frequency ?? 440,
      targetGain: noteGain, // Track scheduled gain
    });

    // Clean up activeVoices when the sample finishes playing naturally
    // BUT: Only for non-looped samples! Looped samples never end, so onended never fires
    if (!source.loop) {
      source.onended = () => {
        if (this.activeVoices.get(voiceIndex)?.source === source) {
          this.activeVoices.delete(voiceIndex);
        }
      };
    }
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
      voice.gainNode.gain.setValueAtTime(
        voice.gainNode.gain.value,
        this.audioContext.currentTime,
      );
      voice.gainNode.gain.linearRampToValueAtTime(
        0,
        this.audioContext.currentTime + releaseTime,
      );

      // Stop and disconnect after release
      const stopTime = this.audioContext.currentTime + releaseTime;
      voice.source.stop(stopTime);

      // Disconnect nodes after the release completes
      setTimeout(
        () => {
          try {
            voice.source.disconnect();
            voice.gainNode.disconnect();
            voice.panNode.disconnect();
            voice.envelopeGain?.disconnect();
          } catch (e) {
            // Nodes may already be disconnected, ignore
          }
        },
        releaseTime * 1000 + 10,
      );

      this.activeVoices.delete(voiceIndex);
      return;
    }

    // Otherwise, find and stop all voices playing this note
    for (const [vIdx, voice] of this.activeVoices.entries()) {
      if (voice.noteNumber === noteNumber) {
        const releaseTime = 0.01;
        voice.gainNode.gain.setValueAtTime(
          voice.gainNode.gain.value,
          this.audioContext.currentTime,
        );
        voice.gainNode.gain.linearRampToValueAtTime(
          0,
          this.audioContext.currentTime + releaseTime,
        );
        const stopTime = this.audioContext.currentTime + releaseTime;
        voice.source.stop(stopTime);

        // Disconnect nodes after the release completes
        setTimeout(
          () => {
            try {
              voice.source.disconnect();
              voice.gainNode.disconnect();
              voice.panNode.disconnect();
              voice.envelopeGain?.disconnect();
            } catch (e) {
              // Nodes may already be disconnected, ignore
            }
          },
          releaseTime * 1000 + 10,
        );

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
    voice.gainNode.gain.setValueAtTime(
      voice.gainNode.gain.value,
      this.audioContext.currentTime,
    );
    voice.gainNode.gain.linearRampToValueAtTime(
      0,
      this.audioContext.currentTime + releaseTime,
    );

    // Stop and disconnect after release
    const stopTime = this.audioContext.currentTime + releaseTime;
    voice.source.stop(stopTime);

    // Disconnect nodes after the release completes
    setTimeout(
      () => {
        try {
          voice.source.disconnect();
          voice.gainNode.disconnect();
          voice.panNode.disconnect();
          voice.envelopeGain?.disconnect();
        } catch (e) {
          // Nodes may already be disconnected, ignore
        }
      },
      releaseTime * 1000 + 10,
    );

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
    voice.source.playbackRate.setValueAtTime(
      voice.source.playbackRate.value,
      now,
    );
    voice.source.playbackRate.linearRampToValueAtTime(
      playbackRate,
      now + 0.005,
    );
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
    // Voices part-way through a fadeout would otherwise keep sounding after
    // the transport stops.
    for (const voiceIndex of [...this.releasingVoices.keys()]) {
      this.stopReleasingVoice(voiceIndex);
    }
  }

  setInstrumentGain(gain: number): void {
    this.outputNode.gain.value = gain;
  }

  destroy(): void {
    console.log(
      '[ModInstrument] Destroying instrument, active voices:',
      this.activeVoices.size,
    );

    for (const voiceIndex of [...this.releasingVoices.keys()]) {
      this.stopReleasingVoice(voiceIndex);
    }

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
        voice.envelopeGain?.disconnect();
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!this.ready) {
      throw new Error('ModInstrument failed to initialize');
    }
  }

  setMacroParameter(
    _voiceIndex: number,
    _macroIndex: number,
    _value: number,
  ): void {
    // Intentionally empty: nothing calls this on the tracker path. Per-voice
    // macros arrive via setVoiceMacroAtTime (macro 0 = pan, macro 1 = 9xx
    // sample offset), which is implemented.
  }

  // Additional compatibility methods for InstrumentV2 interface

  /**
   * Schedule an XM-style volume envelope onto a voice's dedicated gain stage.
   *
   * Envelope positions are in ticks, so they are converted with the tick
   * duration in force when the note starts. A sustain point holds the envelope
   * until key-off; everything up to it is scheduled now, and the remainder is
   * scheduled by `releaseTrackerEnvelope` when the note is released.
   *
   * Returns the envelope value being held at, so the release can ramp from it.
   */
  private scheduleTrackerEnvelope(
    param: AudioParam,
    envelope: TrackerVolumeEnvelope,
    startTime: number,
    tickSeconds: number,
  ): void {
    const points = envelope.points;
    if (points.length === 0) {
      param.setValueAtTime(1, startTime);
      return;
    }

    const level = (value: number) => Math.max(0, Math.min(1, value / 64));
    const hasSustain =
      envelope.sustainPoint >= 0 && envelope.sustainPoint < points.length;

    param.setValueAtTime(level(points[0]!.value), startTime);

    // Sustain wins: the envelope runs to that point and waits for key-off.
    if (hasSustain) {
      for (let i = 1; i <= envelope.sustainPoint; i++) {
        const point = points[i]!;
        param.linearRampToValueAtTime(
          level(point.value),
          startTime + point.tick * tickSeconds,
        );
      }
      return;
    }

    const loopStart = envelope.loopStart;
    const loopEnd = envelope.loopEnd;
    const loops =
      envelope.loopEnabled &&
      loopEnd > loopStart &&
      loopEnd < points.length &&
      loopStart >= 0;

    if (!loops) {
      for (let i = 1; i < points.length; i++) {
        const point = points[i]!;
        param.linearRampToValueAtTime(
          level(point.value),
          startTime + point.tick * tickSeconds,
        );
      }
      return;
    }

    // A looping envelope repeats loopStart..loopEnd for as long as the note
    // is held. AudioParam automation cannot loop, so unroll enough passes to
    // outlast any realistic note. Without this the envelope was played once
    // and then held at its final value -- silence for most instruments, which
    // is what made looping instruments drop out.
    for (let i = 1; i <= loopEnd; i++) {
      const point = points[i]!;
      param.linearRampToValueAtTime(
        level(point.value),
        startTime + point.tick * tickSeconds,
      );
    }

    const loopTicks = points[loopEnd]!.tick - points[loopStart]!.tick;
    if (loopTicks <= 0) return;

    const maxUnrollSeconds = 30;
    let elapsed = points[loopEnd]!.tick * tickSeconds;
    let pass = 0;
    while (elapsed < maxUnrollSeconds && pass < 256) {
      const offsetTicks = points[loopEnd]!.tick + pass * loopTicks;
      for (let i = loopStart; i <= loopEnd; i++) {
        const point = points[i]!;
        const tick =
          offsetTicks + (point.tick - points[loopStart]!.tick);
        param.linearRampToValueAtTime(
          level(point.value),
          startTime + tick * tickSeconds,
        );
      }
      elapsed = (offsetTicks + loopTicks) * tickSeconds;
      pass++;
    }
  }

  /**
   * Release an XM-style envelope.
   *
   * Key-off is an envelope *release*, not a mute: the note carries on, the
   * envelope continues past its sustain point, and the instrument's fadeout
   * (when it has one) takes it to silence. Cutting the note instead -- which a
   * short fixed release amounts to -- removes notes that were meant to ring,
   * which is what made parts sound like they had notes missing.
   *
   * XM decrements a 65536 counter by `fadeout` every tick after key-off and
   * scales volume by counter/65536, so silence arrives after 65536/fadeout
   * ticks with a linear decay, which one linear ramp reproduces.
   *
   * Returns how long the release lasts, or null when the note has no defined
   * end -- an envelope with neither a fadeout nor points past its sustain
   * sustains indefinitely in FT2, and is left to ring until the channel plays
   * something else.
   */
  private scheduleTrackerRelease(
    param: AudioParam,
    envelope: TrackerVolumeEnvelope,
    releaseTime: number,
    tickSeconds: number,
  ): number | null {
    const MAX_RELEASE_SECONDS = 10;
    const points = envelope.points;
    const level = (value: number) => Math.max(0, Math.min(1, value / 64));

    // Points after the sustain are the envelope's own release segment.
    const hasSustain =
      envelope.sustainPoint >= 0 && envelope.sustainPoint < points.length;
    const tailStart = hasSustain ? envelope.sustainPoint : -1;
    const tailSeconds =
      tailStart >= 0 && tailStart < points.length - 1
        ? (points[points.length - 1]!.tick - points[tailStart]!.tick) *
          tickSeconds
        : Infinity;

    const fadeoutSeconds =
      envelope.fadeout > 0
        ? (65536 / envelope.fadeout) * tickSeconds
        : Infinity;

    // Freeze wherever the envelope currently is, then release from there.
    const holdable = param as AudioParam & {
      cancelAndHoldAtTime?: (time: number) => void;
    };
    if (typeof holdable.cancelAndHoldAtTime === 'function') {
      holdable.cancelAndHoldAtTime(releaseTime);
    } else {
      param.cancelScheduledValues(releaseTime);
      param.setValueAtTime(param.value, releaseTime);
    }

    // Whichever of the two release terms ends first decides the note's end.
    // Clamp only after that test, so an envelope with neither term is
    // correctly reported as having no end rather than being cut at the cap.
    const naturalEnd = Math.min(tailSeconds, fadeoutSeconds);
    if (!Number.isFinite(naturalEnd)) {
      // Sustains indefinitely; leave the envelope held where it is.
      return null;
    }
    const end = Math.min(naturalEnd, MAX_RELEASE_SECONDS);

    // Follow the envelope's release segment for as long as it runs inside the
    // release window, so a shaped release is heard rather than a plain fade.
    if (tailStart >= 0) {
      const tailBaseTick = points[tailStart]!.tick;
      for (let i = tailStart + 1; i < points.length; i++) {
        const offset = (points[i]!.tick - tailBaseTick) * tickSeconds;
        if (offset >= end) break;
        param.linearRampToValueAtTime(
          level(points[i]!.value),
          releaseTime + offset,
        );
      }
    }

    param.linearRampToValueAtTime(0, releaseTime + end);
    return end;
  }

  /**
   * The voice belonging to a tracker channel, assigning one on first use.
   *
   * Falls back to the old free-then-round-robin search when no channel is
   * given, which is the preview path rather than tracker playback.
   */
  private resolveVoiceForTrack(trackIndex: number | undefined): number {
    if (trackIndex === undefined) return this.allocateAnyVoice();

    const owned = this.trackVoices.get(trackIndex);
    if (owned !== undefined) return owned;

    const taken = new Set(this.trackVoices.values());
    for (let i = 0; i < this.voiceCount; i++) {
      if (!taken.has(i)) {
        this.trackVoices.set(trackIndex, i);
        return i;
      }
    }

    // More channels than voices: fall back rather than dropping the note, but
    // say so, since it means the patch was sized too small at import.
    console.warn(
      `[ModInstrument] No free voice for track ${trackIndex} (limit ${this.voiceCount}); reusing`,
    );
    const reused = this.allocateAnyVoice();
    this.trackVoices.set(trackIndex, reused);
    return reused;
  }

  /** Free voice if there is one, else round-robin. */
  private allocateAnyVoice(): number {
    for (let i = 0; i < this.voiceCount; i++) {
      if (!this.activeVoices.has(i)) return i;
    }
    const index = this.voiceRoundRobinIndex;
    this.voiceRoundRobinIndex = (this.voiceRoundRobinIndex + 1) % this.voiceCount;
    return index;
  }

  noteOnAtTime(
    noteNumber: number,
    velocity: number,
    time: number,
    options?: {
      allowDuplicate?: boolean;
      frequency?: number;
      pan?: number;
      /** Normalized 0-1 start offset into the sample (ProTracker 9xx). */
      sampleOffset?: number;
      /** Duration of one tracker tick in seconds, for envelope timing. */
      tickSeconds?: number;
      /** Tracker channel this note belongs to; owns a voice of its own. */
      trackIndex?: number;
    },
  ): number | undefined {
    if (!this.audioBuffer || !this.samplerState) {
      console.warn(
        '[ModInstrument] noteOnAtTime skipped - buffer or state not ready',
      );
      return undefined;
    }

    // Stop existing voice with same note number if playing (unless allowDuplicate is true)
    if (!options?.allowDuplicate) {
      for (const [vIdx, voice] of this.activeVoices.entries()) {
        if (voice.noteNumber === noteNumber) {
          this.noteOff(noteNumber, vIdx);
          break;
        }
      }
    }

    // A tracker channel owns its voice, so a note replaces that channel's own
    // note and can never cut one sounding on a different channel.
    const voiceIndex = this.resolveVoiceForTrack(options?.trackIndex);

    // A note still fading out on this slot belongs to the same channel and
    // must be cut, not left ringing under the new note.
    // The replacing note's start time; everything this voice was doing must
    // continue until then, not stop the moment this row is scheduled.
    const replaceAt = Math.max(time, this.audioContext.currentTime);

    // A note still fading out on this slot belongs to the same channel and
    // must be cut when the new note begins.
    this.stopReleasingVoice(voiceIndex, replaceAt);

    // Retire whatever this voice was playing before reusing it.
    const oldVoice = this.activeVoices.get(voiceIndex);
    if (oldVoice) {
      try {
        oldVoice.source.stop(replaceAt);
      } catch {
        // Source may have already stopped naturally
      }
      this.activeVoices.delete(voiceIndex);
      const delay = Math.max(
        0,
        (replaceAt - this.audioContext.currentTime) * 1000 + 10,
      );
      setTimeout(() => {
        try {
          oldVoice.source.disconnect();
          oldVoice.gainNode.disconnect();
          oldVoice.panNode.disconnect();
          oldVoice.envelopeGain?.disconnect();
        } catch {
          // Already disconnected
        }
      }, delay);
    }

    // Create audio nodes for this voice
    const source = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();
    const panNode = this.audioContext.createStereoPanner();

    source.buffer = this.audioBuffer;

    // Configure looping (prepared once at load time; see prepareLoop)
    this.applyLoop(source);

    // Set gain based on velocity and sampler gain
    // NOTE: For MOD instruments, "velocity" is a misnomer - it's really ProTracker volume (0-64)
    // that's been converted: volume(0-64) → internal(0-255) → velocity(0-127)
    // The conversion preserves the normalized value: velocity/127 ≈ volume/64
    const velocityNormalized = velocity / 127;
    const noteGain = velocityNormalized * this.samplerState.gain;

    gainNode.gain.value = noteGain;

    // Set panning
    const pan = options?.pan;
    if (pan !== undefined) {
      panNode.pan.value = (pan - 0.5) * 2;
    }

    // Calculate playback rate from frequency
    const frequency =
      options?.frequency ?? this.midiNoteToFrequency(noteNumber);
    const playbackRate = this.calculatePlaybackRate(frequency);
    source.playbackRate.value = playbackRate;

    // Connect audio graph. The envelope, when the instrument has one, gets its
    // own stage ahead of the channel-volume node.
    const envelope = this.samplerState.trackerEnvelope;
    const tickSeconds = options?.tickSeconds ?? DEFAULT_TICK_SECONDS;
    let envelopeGain: GainNode | null = null;
    if (envelope && (envelope.points.length > 0 || envelope.fadeout > 0)) {
      envelopeGain = this.audioContext.createGain();
      envelopeGain.gain.value = 1;
      const envelopeStart = Math.max(time, this.audioContext.currentTime);
      this.scheduleTrackerEnvelope(
        envelopeGain.gain,
        envelope,
        envelopeStart,
        tickSeconds,
      );
      source.connect(envelopeGain);
      envelopeGain.connect(gainNode);
    } else {
      source.connect(gainNode);
    }
    gainNode.connect(panNode);
    panNode.connect(this.outputNode);

    // Schedule playback at the specified time.
    //
    // ProTracker 9xx has to be applied here: an AudioBufferSourceNode cannot
    // be seeked once started, so passing the offset to start() is the only
    // way to honour it. Clamp just inside the buffer -- an offset at or past
    // the end would start a node that produces nothing and never fires
    // onended for looped samples, leaking the voice slot.
    const startTime = Math.max(time, this.audioContext.currentTime);
    const offsetNorm = options?.sampleOffset ?? this.pendingSampleOffset;
    this.pendingSampleOffset = undefined;
    if (offsetNorm !== undefined && offsetNorm > 0) {
      const duration = this.audioBuffer.duration;
      const maxOffset = Math.max(0, duration - 1 / this.audioBuffer.sampleRate);
      const offsetSeconds = Math.min(
        Math.max(0, offsetNorm) * duration,
        maxOffset,
      );
      source.start(startTime, offsetSeconds);
    } else {
      source.start(startTime);
    }

    // Store active voice
    this.activeVoices.set(voiceIndex, {
      source,
      gainNode,
      envelopeGain,
      panNode,
      tickSeconds,
      noteNumber,
      startTime: startTime,
      frequency: frequency ?? 440,
      targetGain: noteGain, // Track scheduled gain
    });

    // Clean up activeVoices when the sample finishes playing naturally
    // BUT: Only for non-looped samples! Looped samples never end, so onended never fires
    if (!source.loop) {
      source.onended = () => {
        if (this.activeVoices.get(voiceIndex)?.source === source) {
          this.activeVoices.delete(voiceIndex);
          console.warn(`[ModInstrument] Voice ${voiceIndex} auto-freed (one-shot ended), activeVoices now=${this.activeVoices.size}`);
        }
      };
    }

    console.warn(`[ModInstrument] noteOnAtTime allocated voice ${voiceIndex} for note ${noteNumber}, loop=${source.loop}, activeVoices=${this.activeVoices.size}`);

    return voiceIndex;
  }

  noteOffAtTime(noteNumber: number, time: number, trackIndex?: number): void {
    // Release at the scheduled time rather than only when it is nearly due.
    //
    // This used to act only if `time` was within 100ms of now and drop the
    // event otherwise. The engine schedules half a second to a second ahead,
    // so in practice every note-off was discarded: notes were never released
    // at all, and only stopped when their voice was stolen or the sample ran
    // out. XM key-off therefore did nothing, and the volume fadeout on release
    // never ran because nothing reached gateOffVoiceAtTime.
    //
    // A tracker channel owns its voice, so releasing that channel's voice is
    // the correct action whatever note it happens to be holding -- a key-off
    // releases the channel, not a pitch.
    if (trackIndex !== undefined) {
      const owned = this.trackVoices.get(trackIndex);
      if (owned !== undefined && this.activeVoices.has(owned)) {
        this.gateOffVoiceAtTime(owned, time);
        return;
      }
    }

    for (const [voiceIndex, voice] of this.activeVoices.entries()) {
      if (voice.noteNumber === noteNumber) {
        this.gateOffVoiceAtTime(voiceIndex, time);
        return;
      }
    }
  }

  /**
   * Stop a voice outright at a given time, with a short de-click ramp.
   *
   * This is what a *new note* does to the note it replaces. A tracker channel
   * is monophonic and has no polyphony at all, so retriggering a channel ends
   * the previous note; it does not release it. gateOffVoiceAtTime is the
   * different operation of key-off, where the envelope release and fadeout run
   * and the note is meant to ring on -- using that here left the previous note
   * sounding underneath the new one for the whole fadeout, which on XM can be
   * seconds.
   *
   * Also reaches voices already in the releasing set, since a channel that
   * was keyed off and then replaced must still be cut.
   */
  cutVoiceAtTime(voiceIndex: number, time: number): void {
    const voice =
      this.activeVoices.get(voiceIndex) ?? this.releasingVoices.get(voiceIndex);
    if (!voice) return;

    const now = this.audioContext.currentTime;
    const cutAt = Math.max(time, now);
    const rampSeconds = 0.003;

    try {
      voice.gainNode.gain.cancelScheduledValues(cutAt);
      voice.gainNode.gain.setValueAtTime(voice.targetGain, cutAt);
      voice.gainNode.gain.linearRampToValueAtTime(0, cutAt + rampSeconds);
    } catch {
      // Parameter may already be past this point
    }

    const stopAt = cutAt + rampSeconds;
    try {
      voice.source.stop(stopAt);
    } catch {
      // Already stopped
    }

    this.activeVoices.delete(voiceIndex);
    if (this.releasingVoices.get(voiceIndex) === voice) {
      this.releasingVoices.delete(voiceIndex);
    }

    setTimeout(
      () => {
        try {
          voice.source.disconnect();
          voice.gainNode.disconnect();
          voice.panNode.disconnect();
          voice.envelopeGain?.disconnect();
        } catch {
          // Already disconnected
        }
      },
      Math.max(0, (stopAt - now) * 1000 + 10),
    );
  }

  gateOffVoiceAtTime(voiceIndex: number, time: number): void {
    const voice = this.activeVoices.get(voiceIndex);
    if (!voice) return;

    const now = this.audioContext.currentTime;
    const scheduledTime = Math.max(time, now);

    // An instrument with a tracker envelope fades out on its own terms rather
    // than being cut: XM key-off starts the fadeout and the note rings on.
    const envelope = this.samplerState?.trackerEnvelope;
    let releaseTime = 0.01;
    if (voice.envelopeGain && envelope) {
      const released = this.scheduleTrackerRelease(
        voice.envelopeGain.gain,
        envelope,
        scheduledTime,
        voice.tickSeconds,
      );
      if (released === null) {
        // No defined end: the note sustains until the channel plays again.
        // Hand it to the releasing set so a later note can still cut it, but
        // schedule no stop of its own.
        this.activeVoices.delete(voiceIndex);
        this.stopReleasingVoice(voiceIndex, scheduledTime);
        this.releasingVoices.set(voiceIndex, voice);
        return;
      }
      releaseTime = released;
    } else {
      // Quick release to avoid a click.
      voice.gainNode.gain.setValueAtTime(
        voice.gainNode.gain.value,
        scheduledTime,
      );
      voice.gainNode.gain.linearRampToValueAtTime(
        0,
        scheduledTime + releaseTime,
      );
    }

    // Stop source after release
    const stopTime = scheduledTime + releaseTime;
    voice.source.stop(stopTime);

    // Free the slot immediately so allocation can reuse it, but keep hold of
    // the voice while it fades so a later note on this channel can cut it.
    this.activeVoices.delete(voiceIndex);
    this.stopReleasingVoice(voiceIndex);
    this.releasingVoices.set(voiceIndex, voice);

    // Disconnect nodes after the release completes
    const disconnectDelay = Math.max(0, (stopTime - now) * 1000 + 10);
    setTimeout(() => {
      if (this.releasingVoices.get(voiceIndex) === voice) {
        this.releasingVoices.delete(voiceIndex);
      }
      try {
        voice.source.disconnect();
        voice.gainNode.disconnect();
        voice.panNode.disconnect();
        voice.envelopeGain?.disconnect();
      } catch (e) {
        // Nodes may already be disconnected, ignore
      }
    }, disconnectDelay);
  }

  /**
   * Cut a voice that is still fading out on this slot.
   *
   * A tracker channel is monophonic: a new note replaces whatever the channel
   * was doing, including a note that is part-way through its release.
   */
  private stopReleasingVoice(voiceIndex: number, atTime?: number): void {
    const releasing = this.releasingVoices.get(voiceIndex);
    if (!releasing) return;
    this.releasingVoices.delete(voiceIndex);

    // Stop when the replacing note actually starts, NOT immediately.
    //
    // Rows are scheduled up to a second ahead, so "now" is nowhere near the
    // moment this voice is being replaced. Calling stop() with no argument
    // silenced a note the instant its *successor was scheduled* -- which, for
    // any part with notes close together, meant killing notes before they had
    // been heard at all.
    const now = this.audioContext.currentTime;
    const stopAt = Math.max(atTime ?? now, now);
    try {
      releasing.source.stop(stopAt);
    } catch {
      // Already stopped
    }

    const disconnectDelay = Math.max(0, (stopAt - now) * 1000 + 10);
    setTimeout(() => {
      try {
        releasing.source.disconnect();
        releasing.gainNode.disconnect();
        releasing.panNode.disconnect();
        releasing.envelopeGain?.disconnect();
      } catch {
        // Already disconnected
      }
    }, disconnectDelay);
  }

  setVoiceFrequencyAtTime(
    voiceIndex: number,
    frequency: number,
    time: number,
    rampMode?: 'linear' | 'exponential',
  ): void {
    const voice = this.activeVoices.get(voiceIndex);
    if (!voice) {
      return;
    }

    const playbackRate = this.calculatePlaybackRate(frequency);

    // Tracker playback schedules a whole row's worth of ticks synchronously,
    // ahead of real time. `AudioParam.value` only reflects automation that
    // has already executed on the audio thread, so reading it here (as this
    // used to) returns a stale value and, combined with a fixed 5ms ramp,
    // produced a discontinuous jump-then-plateau on every tick instead of a
    // smooth slide. Schedule directly on the native AudioParam instead and
    // let its automation-event queue chain from whatever was previously
    // scheduled -- exactly what PooledInstrument/InstrumentV2 already do.
    if (rampMode === 'exponential') {
      const safeRate = Math.max(0.0001, playbackRate);
      voice.source.playbackRate.exponentialRampToValueAtTime(safeRate, time);
    } else if (rampMode === 'linear') {
      voice.source.playbackRate.linearRampToValueAtTime(playbackRate, time);
    } else {
      voice.source.playbackRate.setValueAtTime(playbackRate, time);
    }
    voice.frequency = frequency;
  }

  setVoiceGainAtTime(
    voiceIndex: number,
    gain: number,
    time: number,
    rampMode?: 'linear' | 'exponential',
  ): void {
    const voice = this.activeVoices.get(voiceIndex);
    if (!voice) {
      console.warn(
        '[ModInstrument] setVoiceGainAtTime: voice not found:',
        voiceIndex,
        'active voices:',
        Array.from(this.activeVoices.keys()),
      );
      return;
    }

    const now = this.audioContext.currentTime;
    const scheduledTime = Math.max(time, now);
    const timeDelta = scheduledTime - now;

    // Use tracked targetGain instead of reading from audio param (which doesn't reflect scheduled changes)
    const currentGain = voice.targetGain;

    // For immediate changes (delta < 10ms), apply directly
    if (timeDelta < 0.01) {
      voice.gainNode.gain.cancelScheduledValues(now);
      voice.gainNode.gain.setValueAtTime(gain, now);
      voice.targetGain = gain;
      return;
    }

    // For scheduled changes, don't cancel pending automation - let the chain continue
    // Use linearRampToValueAtTime which will start from the current scheduled value
    if (rampMode === 'exponential' && gain > 0.001 && currentGain > 0.001) {
      voice.gainNode.gain.exponentialRampToValueAtTime(gain, scheduledTime);
    } else {
      voice.gainNode.gain.linearRampToValueAtTime(gain, scheduledTime);
    }

    voice.targetGain = gain; // Update tracked value for next call
  }

  setVoiceMacroAtTime(
    voiceIndex: number,
    macroIndex: number,
    value: number,
    _time: number,
  ): void {
    // Macro 0 is pan for MOD instruments.
    if (macroIndex === 0) {
      this.setPan(voiceIndex, value);
      return;
    }
    // Macro 1 is the MOD 9xx sample offset. A voice that has already started
    // cannot be repositioned (see noteOnAtTime), so an offset arriving as
    // automation -- a 9xx row with no note of its own -- is remembered and
    // consumed by the next note on this instrument, which is also what
    // ProTracker does with its per-channel offset memory.
    if (macroIndex === 1) {
      this.pendingSampleOffset = Math.max(0, Math.min(1, value));
    }
  }

  cancelScheduledNotes(): void {
    // Deliberately empty. ModInstrument *does* schedule notes ahead --
    // noteOnAtTime calls source.start(startTime) up to the engine's lookahead
    // in the future -- but the transport's stop path calls allNotesOff()
    // straight after cancelAllScheduled(), and noteOff()'s source.stop() on a
    // not-yet-started source cancels it outright. Adding cancellation here
    // would duplicate that.
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
    // Intentionally a no-op, and NOT an oversight.
    //
    // This is the instrument-wide macro path (songBank.setInstrumentMacro).
    // Applying it here would set the value on every voice of this instrument
    // -- but instruments are per-sample, so voices belonging to *other* tracks
    // share this instrument, and an instrument-wide pan write would stomp
    // their per-voice pan. That is exactly the cross-track corruption class
    // described in D13 of PLAN-module-format-support.md.
    //
    // MOD playback does not need it: macro 0 (pan) also travels on the note-on
    // as step.pan, and mid-note pan changes go through the per-voice
    // setVoicePanAtTime path instead.
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
