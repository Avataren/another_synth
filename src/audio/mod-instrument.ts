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
import type {
  SamplerState,
  TrackerVolumeEnvelope,
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

    this.ready = true;
    console.log(
      '[ModInstrument] loadPatch complete, buffer length:',
      this.audioBuffer.length,
      'frames',
    );
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

    // Configure looping
    if (this.samplerState.loopMode === 1) {
      // Loop mode
      source.loop = true;
      const bufferLength = this.audioBuffer.length;
      source.loopStart =
        (this.samplerState.loopStart * bufferLength) /
        this.audioBuffer.sampleRate;
      source.loopEnd =
        (this.samplerState.loopEnd * bufferLength) /
        this.audioBuffer.sampleRate;
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
  }

  setInstrumentGain(gain: number): void {
    this.outputNode.gain.value = gain;
  }

  destroy(): void {
    console.log(
      '[ModInstrument] Destroying instrument, active voices:',
      this.activeVoices.size,
    );

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

    const sustain =
      envelope.sustainPoint >= 0 && envelope.sustainPoint < points.length
        ? envelope.sustainPoint
        : points.length - 1;

    const level = (value: number) => Math.max(0, Math.min(1, value / 64));

    param.setValueAtTime(level(points[0]!.value), startTime);
    for (let i = 1; i <= sustain; i++) {
      const point = points[i]!;
      param.linearRampToValueAtTime(
        level(point.value),
        startTime + point.tick * tickSeconds,
      );
    }
  }

  /**
   * Release an XM-style envelope: the note keeps sounding and fades out rather
   * than being cut.
   *
   * XM decrements a 65536 counter by `fadeout` every tick after key-off and
   * scales the instrument's volume by counter/65536, so silence arrives after
   * 65536/fadeout ticks and the decay is linear -- which a single linear ramp
   * reproduces exactly.
   *
   * APPROXIMATION: the envelope's own points past the sustain also continue in
   * FastTracker 2, multiplying with the fadeout. Only the fadeout is applied
   * here, since it is the term that actually takes the note to silence.
   * Instruments with a shaped release tail will decay a little differently.
   *
   * Returns how long the release lasts, so the caller can stop the source.
   */
  private scheduleTrackerRelease(
    param: AudioParam,
    envelope: TrackerVolumeEnvelope,
    releaseTime: number,
    tickSeconds: number,
  ): number {
    const MAX_RELEASE_SECONDS = 10;
    const MIN_RELEASE_SECONDS = 0.01;

    const seconds =
      envelope.fadeout > 0
        ? Math.min(
            MAX_RELEASE_SECONDS,
            (65536 / envelope.fadeout) * tickSeconds,
          )
        : MIN_RELEASE_SECONDS;

    // Freeze the envelope where it currently is, then decay from there.
    // cancelAndHoldAtTime is the correct primitive but is not universally
    // available, so fall back to sampling the parameter.
    const holdable = param as AudioParam & {
      cancelAndHoldAtTime?: (time: number) => void;
    };
    if (typeof holdable.cancelAndHoldAtTime === 'function') {
      holdable.cancelAndHoldAtTime(releaseTime);
    } else {
      param.cancelScheduledValues(releaseTime);
      param.setValueAtTime(param.value, releaseTime);
    }
    param.linearRampToValueAtTime(0, releaseTime + seconds);

    return seconds;
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

    // Retire whatever this voice was playing before reusing it.
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

    // Create audio nodes for this voice
    const source = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();
    const panNode = this.audioContext.createStereoPanner();

    source.buffer = this.audioBuffer;

    // Configure looping
    if (this.samplerState.loopMode === 1) {
      source.loop = true;
      const bufferLength = this.audioBuffer.length;
      source.loopStart =
        (this.samplerState.loopStart * bufferLength) /
        this.audioBuffer.sampleRate;
      source.loopEnd =
        (this.samplerState.loopEnd * bufferLength) /
        this.audioBuffer.sampleRate;
    }

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

  noteOffAtTime(noteNumber: number, time: number, _trackIndex?: number): void {
    const now = this.audioContext.currentTime;
    if (time <= now + 0.1) {
      this.noteOff(noteNumber);
    }
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
      releaseTime = this.scheduleTrackerRelease(
        voice.envelopeGain.gain,
        envelope,
        scheduledTime,
        voice.tickSeconds,
      );
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

    // IMMEDIATELY remove from activeVoices to free the voice slot for reuse
    // This is critical for voice allocation to work correctly
    this.activeVoices.delete(voiceIndex);

    // Disconnect nodes after the release completes
    const disconnectDelay = Math.max(0, (stopTime - now) * 1000 + 10);
    setTimeout(() => {
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
