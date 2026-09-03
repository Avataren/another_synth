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
  type TrackerEnvelopeShape,
  type TrackerAutoVibrato,
} from './types/synth-layout';
import { decodeAudioAssetToFloat32Array } from './serialization/audio-asset-encoder';
import { AudioAssetType } from './types/preset-types';
import {
  crossfadeLoop,
  lowpassForRate,
  mipLevelForRate,
  oversample,
  removeDcOffset,
  type LoopRegion,
} from './sample-conditioning';
import { getSampleQuality } from './sample-quality';

/**
 * Fallback tick duration when a caller does not supply one: 2.5 / 125 BPM,
 * the tracker default. A tick is 2.5/BPM seconds in both ProTracker and FT2.
 */
/**
 * Per-note tracing, off by default.
 *
 * Voice allocation used to `console.warn` on every note-on and again whenever
 * a one-shot ended. A 32-channel module at 125 BPM triggers on the order of a
 * hundred notes a second, so playing a song buried the console -- and every
 * one of those lines built a template string and forced the devtools console
 * to lay out a row, which is real work on the same thread that has to keep the
 * scheduler ahead of the audio clock.
 *
 * The tracing is still there, opt-in from the devtools console with
 * `__MOD_INSTRUMENT_DEBUG__ = true` (no rebuild, and it can be flipped mid-song
 * to catch a specific passage).
 */
function modInstrumentDebug(): boolean {
  return (
    (globalThis as { __MOD_INSTRUMENT_DEBUG__?: boolean })
      .__MOD_INSTRUMENT_DEBUG__ === true
  );
}

/**
 * Warnings that report a *condition* rather than an event: once a patch is
 * short of voices, or a volume command cannot find its voice, it is short of
 * them for every note that follows. Logging each occurrence says nothing the
 * first one did not, so the rest are counted and reported at a decaying rate.
 */
let nextInstrumentKey = 1;
const warnCounts = new Map<string, number>();
function warnOccasionally(key: string, message: () => string): void {
  const count = (warnCounts.get(key) ?? 0) + 1;
  warnCounts.set(key, count);
  // 1st, 2nd, ... 10th, then every 100th.
  if (count <= 10 || count % 100 === 0) {
    console.warn(`${message()}${count > 1 ? ` (occurrence ${count})` : ''}`);
  }
}

const DEFAULT_TICK_SECONDS = 2.5 / 125;

/**
 * An envelope's value at an arbitrary tick, interpolating between points.
 *
 * Needed wherever an envelope is started from somewhere other than its
 * beginning -- Lxx, and re-scheduling a panning envelope when the channel pan
 * moves under it -- since that tick rarely lands exactly on a point.
 */
function envelopeValueAtTick(
  points: ReadonlyArray<{ tick: number; value: number }>,
  tick: number,
): number {
  const first = points[0];
  if (!first) return 32;
  if (tick <= first.tick) return first.value;
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const point = points[i]!;
    if (tick > point.tick) continue;
    const span = point.tick - previous.tick;
    if (span <= 0) return point.value;
    const t = (tick - previous.tick) / span;
    return previous.value + (point.value - previous.value) * t;
  }
  return points[points.length - 1]!.value;
}

/**
 * Combine a channel's pan with a panning-envelope value, as FastTracker 2 does.
 *
 * The envelope is an *offset* around the channel pan, not a position: FT2
 * scales it by how much room the channel pan leaves, so a hard-panned channel
 * barely moves and a centred one can swing the whole field. That is what stops
 * an envelope pushing a channel past the edge.
 *
 *   final = pan + (envelope - 32) * (128 - |pan - 128|) / 32     [0..255]
 *
 * `base` and the result are in the StereoPanner's -1..1.
 */
function combinePan(base: number, envelopeValue: number): number {
  const pan255 = (Math.max(-1, Math.min(1, base)) + 1) * 127.5;
  const headroom = (128 - Math.abs(pan255 - 128)) / 32;
  const combined = pan255 + (envelopeValue - 32) * headroom;
  return Math.max(-1, Math.min(1, combined / 127.5 - 1));
}

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
  /**
   * Instrument-level ("auto") vibrato, as an LFO driving the source's `detune`.
   *
   * `detune` is a separate AudioParam from `playbackRate`, and the two compose
   * multiplicatively, so the instrument's own wobble rides on top of whatever
   * the channel is doing to the pitch -- portamento, 4xy vibrato, arpeggio --
   * without either having to know about the other. That is the same trick the
   * volume envelope uses with its own gain stage.
   */
  autoVibrato: { osc: OscillatorNode; depth: GainNode } | null;
  panNode: StereoPannerNode;
  /**
   * The channel's own pan, before any panning envelope.
   *
   * Kept because FT2's envelope is an offset *around* this rather than an
   * absolute position, so a mid-note pan command has to re-derive the whole
   * remaining envelope rather than simply overwrite the parameter.
   */
  basePan: number;
  noteNumber: number;
  startTime: number;
  /** Tick duration in force when this voice started, for envelope release. */
  tickSeconds: number;
  frequency: number;
  targetGain: number; // Track scheduled gain value (Web Audio param.value doesn't reflect scheduled changes)
}

const MIP_LEVELS = 4;

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
  /** Distinguishes this instance's throttled warnings from another's. */
  private readonly instrumentKey = nextInstrumentKey++;
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
  /**
   * Length of the sample itself, in frames.
   *
   * Kept separately from `audioBuffer.length` because a ping-pong sample's
   * buffer is longer than the sample (prepareLoop appends a reversed copy of
   * the loop region), and a 9xx offset must be measured against the real
   * sample.
   */
  private sampleFrames = 0;

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

  /**
   * How many buffer frames stand for one frame of the original sample.
   *
   * Oversampling lengthens the buffer without changing the rate it is declared
   * at, so the pitch is corrected by scaling playbackRate instead -- declaring
   * a higher rate would work too, but browsers reject buffer rates outside a
   * supported range and 4x of a 44.1k asset is already past some of them.
   */
  private oversampleFactor = 1;
  /** Conditioned mono data, kept to build anti-aliased copies on demand. */
  private conditionedMono: Float32Array | null = null;
  /** The forward loop within `conditionedMono`, so filters can wrap it. */
  private conditionedLoop: LoopRegion | null = null;
  /** Anti-aliased copies by mip level; index 0 is the plain buffer. */
  private mipBuffers: (AudioBuffer | null)[] = [];

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

    // Offline conditioning. Tracker samples are mono; the interleaved path is
    // left exactly as it was rather than conditioned channel by channel for a
    // case that does not arise here.
    let buffered = data;
    let bufferFrames = frameCount;
    this.oversampleFactor = 1;
    this.conditionedMono = null;
    this.conditionedLoop = null;
    this.mipBuffers = [];

    if (!isEmpty && channels === 1) {
      buffered = this.conditionSample(Float32Array.from(data), frameCount);
      bufferFrames = buffered.length;
      this.conditionedMono = buffered;
    }

    // Create AudioBuffer
    this.audioBuffer = this.audioContext.createBuffer(
      channels,
      bufferFrames,
      sampleRate,
    );

    // Copy audio data to buffer (or leave silent if empty)
    if (!isEmpty) {
      for (let ch = 0; ch < channels; ch++) {
        const channelData = this.audioBuffer.getChannelData(ch);
        for (let i = 0; i < channelData.length; i++) {
          channelData[i] = buffered[i * channels + ch] ?? 0;
        }
      }
    }
    // If isEmpty, buffer is already initialized to silence

    // Kept in *original* frames: 9xx offsets are expressed in them, and
    // offsetSecondsForFrame scales by oversampleFactor when converting.
    this.sampleFrames = frameCount;
    // After prepareLoop, which replaces the buffer when it materialises a
    // ping-pong loop -- level 0 must be the buffer that is actually played.
    this.prepareLoop(channels, bufferFrames, sampleRate);
    this.mipBuffers = [this.audioBuffer];

    this.ready = true;
    console.log(
      '[ModInstrument] loadPatch complete, buffer length:',
      this.audioBuffer.length,
      'frames',
    );
  }

  /**
   * Apply the offline conditioning chosen in settings, in the order that keeps
   * each step meaningful.
   *
   * DC first, so the crossfade blends centred material. The crossfade next,
   * while frame indices still match the sample's own -- and only for a forward
   * loop, since ping-pong reverses at the ends and is already continuous
   * there. Oversampling last, because it invalidates those indices.
   */
  private conditionSample(
    data: Float32Array,
    frameCount: number,
  ): Float32Array {
    const quality = getSampleQuality();
    const state = this.samplerState;

    if (quality.removeDcOffset) removeDcOffset(data);

    // Only a *forward* loop, and only in the sample's own frames. Ping-pong
    // reverses rather than wraps, so the filters must not wrap it either.
    let loop: LoopRegion | undefined;
    if (state && state.loopMode === SamplerLoopMode.Loop) {
      const start = Math.max(
        0,
        Math.min(frameCount - 1, Math.round(state.loopStart * frameCount)),
      );
      const end = Math.max(
        start + 1,
        Math.min(frameCount, Math.round(state.loopEnd * frameCount)),
      );
      if (end - start > 1) loop = { start, end };
    }

    if (quality.loopCrossfadeFrames > 0 && loop) {
      crossfadeLoop(data, loop.start, loop.end, quality.loopCrossfadeFrames);
    }

    const factor = Math.max(1, Math.floor(quality.oversampleFactor));
    if (factor > 1) {
      this.oversampleFactor = factor;
      this.conditionedLoop = loop
        ? { start: loop.start * factor, end: loop.end * factor }
        : null;
      return oversample(data, factor, loop);
    }
    this.conditionedLoop = loop ?? null;
    return data;
  }

  /**
   * The buffer to play at a given musical speed-up.
   *
   * Levels are built on demand: most samples are never pitched up far enough
   * to need one, and filtering every sample for every octave at load would
   * cost far more than it saves.
   */
  private bufferForRate(musicalRate: number): AudioBuffer | null {
    const quality = getSampleQuality();
    if (!quality.antiAliasHighNotes || !this.conditionedMono) {
      return this.audioBuffer;
    }

    const level = mipLevelForRate(musicalRate, MIP_LEVELS);
    if (level <= 0) return this.audioBuffer;

    const cached = this.mipBuffers[level];
    if (cached) return cached;

    const base = this.audioBuffer;
    if (!base) return null;

    // The filter works in the buffer's own units, so the ratio it is given is
    // the rate this buffer will actually be read at -- the musical speed-up
    // times the oversampling. The worst rate in the level is used, so one copy
    // covers the whole level.
    const worstRate = Math.pow(2, level) * this.oversampleFactor;
    const filtered = lowpassForRate(
      this.conditionedMono,
      worstRate,
      this.conditionedLoop ?? undefined,
    );
    const buffer = this.audioContext.createBuffer(
      1,
      filtered.length,
      base.sampleRate,
    );
    buffer.getChannelData(0).set(filtered);
    this.mipBuffers[level] = buffer;
    return buffer;
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
      // Mirror the conditioned data, not just the buffer built from it. The
      // anti-aliased copies are filtered from `conditionedMono`, so mirroring
      // only the buffer left every copy above level 0 shorter than the loop
      // this method then declares: the browser clamps `loopEnd` to the buffer
      // it is given, and a ping-pong sample played above its own pitch lost
      // the mirrored half and looped forwards over a hard seam instead.
      if (this.conditionedMono) {
        const source = this.conditionedMono;
        const mirrored = new Float32Array(endFrame + loopFrames);
        mirrored.set(source.subarray(0, endFrame), 0);
        for (let i = 0; i < loopFrames; i++) {
          mirrored[endFrame + i] = source[endFrame - 1 - i] ?? 0;
        }
        this.conditionedMono = mirrored;
        // In the mirrored data the bounce *is* a forward loop, and it runs to
        // the end of the buffer -- so the mip filter has to wrap around it
        // rather than clamp, exactly as it does for a real forward loop.
        this.conditionedLoop = { start: startFrame, end: mirrored.length };

        const buffer = this.audioContext.createBuffer(
          1,
          mirrored.length,
          sampleRate,
        );
        buffer.getChannelData(0).set(mirrored);
        this.audioBuffer = buffer;
      } else {
        // Interleaved or unconditioned data: mirror the buffer per channel.
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
      }
      this.loopStartSeconds = startFrame / sampleRate;
      this.loopEndSeconds = (endFrame + loopFrames) / sampleRate;
    } else {
      this.loopStartSeconds = startFrame / sampleRate;
      this.loopEndSeconds = endFrame / sampleRate;
    }

    this.loopEnabled = true;
  }

  /**
   * Where a 9xx offset of `frames` starts, in seconds into the buffer.
   *
   * ProTracker adds the offset to the sample pointer and subtracts it from the
   * remaining length; if that would run past the end it sets the length to a
   * single word instead, so the one-shot part is effectively skipped and the
   * channel drops straight into the sample's loop (or falls silent when the
   * sample has none). Reproduce that rather than clamping to the end of the
   * buffer, which for a looped sample would restart the loop from an
   * arbitrary point.
   */
  private offsetSecondsForFrame(frames: number): number {
    const buffer = this.audioBuffer;
    if (!buffer) return 0;
    const rate = buffer.sampleRate;
    const factor = this.oversampleFactor;
    const sampleFrames =
      this.sampleFrames || Math.floor(buffer.length / factor);
    // `frames` counts original sample frames, which oversampling multiplied.
    if (frames < sampleFrames) return (frames * factor) / rate;
    if (this.loopEnabled) return this.loopStartSeconds;
    // No loop: start one frame from the end so the voice produces (almost)
    // nothing and still ends normally. Starting exactly at or past the end
    // yields a node that never fires onended, leaking the voice slot.
    return Math.max(0, ((sampleFrames - 1) * factor) / rate);
  }

  /**
   * Start the instrument's autovibrato on a voice, driving `source.detune`.
   *
   * A real oscillator rather than unrolled automation: FT2 advances the
   * vibrato position by `rate` every tick over a 256-step cycle, which for a
   * fast rate is only a few ticks per cycle, so sampling it per tick for the
   * life of a note would mean thousands of automation events per voice. An
   * OscillatorNode expresses the same LFO exactly and costs two nodes.
   *
   * Depth is converted from the format's period units to cents, because
   * `detune` works in cents and that is what lets it compose with
   * `playbackRate`. XM's linear frequency table is logarithmic in period --
   * 64 units to a semitone everywhere -- so the conversion is the constant
   * below. In the Amiga table the same period offset is a different musical
   * interval at every pitch; that mode is approximated here with the constant,
   * which is worth revisiting if an Amiga-table module sounds off.
   */
  private startAutoVibrato(
    source: AudioBufferSourceNode,
    vibrato: TrackerAutoVibrato,
    startTime: number,
    tickSeconds: number,
  ): { osc: OscillatorNode; depth: GainNode } | null {
    if (vibrato.depth <= 0 || vibrato.rate <= 0) return null;
    if (
      typeof this.audioContext.createOscillator !== 'function' ||
      !source.detune
    ) {
      return null;
    }

    // 64 XM period units to a semitone, 100 cents to a semitone.
    const CENTS_PER_PERIOD_UNIT = 100 / 64;
    // The position advances by `rate` per tick over a 256-step cycle.
    const AUTO_VIBRATO_CYCLE_STEPS = 256;

    const osc = this.audioContext.createOscillator();
    osc.type =
      vibrato.type === 1
        ? 'square'
        : vibrato.type === 2 || vibrato.type === 3
          ? 'sawtooth'
          : 'sine';
    osc.frequency.value =
      vibrato.rate / (AUTO_VIBRATO_CYCLE_STEPS * tickSeconds);

    const depth = this.audioContext.createGain();
    // A positive period offset lowers the pitch, so the LFO is inverted to
    // keep the wobble in the same direction FT2 takes it. Ramp-down (type 2)
    // inverts again relative to ramp-up.
    const magnitude = vibrato.depth * CENTS_PER_PERIOD_UNIT;
    const target = vibrato.type === 2 ? magnitude : -magnitude;

    // Sweep: FT2 ramps the depth in from zero over `sweepTicks` ticks.
    if (vibrato.sweepTicks > 0) {
      depth.gain.setValueAtTime(0, startTime);
      depth.gain.linearRampToValueAtTime(
        target,
        startTime + vibrato.sweepTicks * tickSeconds,
      );
    } else {
      depth.gain.setValueAtTime(target, startTime);
    }

    osc.connect(depth);
    depth.connect(source.detune);
    osc.start(startTime);
    return { osc, depth };
  }

  /**
   * Stop and release a voice's autovibrato LFO.
   *
   * Called everywhere a voice's envelope stage is torn down. An oscillator
   * left running holds its whole graph alive, and it is connected to an
   * AudioParam rather than to the output, so a leaked one is silent -- it
   * would accumulate invisibly rather than announce itself.
   */
  /**
   * Schedule the LFO to stop with its source.
   *
   * The teardown that disconnects it runs on a timer after the voice's release
   * ramp, which is late and, being a timer, not guaranteed to be prompt. The
   * oscillator has to stop when the note does regardless.
   */
  private scheduleAutoVibratoStop(voice: ActiveVoice, when: number): void {
    if (!voice.autoVibrato) return;
    try {
      voice.autoVibrato.osc.stop(when);
    } catch {
      // Already stopped, or never started.
    }
  }

  private stopAutoVibrato(voice: ActiveVoice): void {
    const vibrato = voice.autoVibrato;
    if (!vibrato) return;
    try {
      vibrato.osc.stop();
    } catch {
      // Already stopped, or never started; nothing to do.
    }
    vibrato.osc.disconnect();
    vibrato.depth.disconnect();
    voice.autoVibrato = null;
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
        this.stopAutoVibrato(oldVoice);
        this.activeVoices.delete(voiceIndex);
      }
    }

    // The rate is worked out first because it selects the buffer: a source
    // node accepts `buffer` exactly once, so it cannot be assigned a default
    // and then swapped for the anti-aliased copy.
    const frequency =
      options?.frequency ?? this.midiNoteToFrequency(noteNumber);
    const playbackRate = this.calculatePlaybackRate(frequency);

    // Create audio nodes for this voice
    const source = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();
    const panNode = this.audioContext.createStereoPanner();

    source.buffer = this.bufferForRate(playbackRate / this.oversampleFactor);
    source.playbackRate.value = playbackRate;

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
      // run tracker envelopes or the instrument's own vibrato.
      envelopeGain: null,
      autoVibrato: null,
      basePan: 0,
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
      this.scheduleAutoVibratoStop(voice, stopTime);
    this.scheduleAutoVibratoStop(voice, stopTime);

      // Disconnect nodes after the release completes
      setTimeout(
        () => {
          try {
            voice.source.disconnect();
            voice.gainNode.disconnect();
            voice.panNode.disconnect();
            voice.envelopeGain?.disconnect();
            this.stopAutoVibrato(voice);
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
      this.scheduleAutoVibratoStop(voice, stopTime);
        this.scheduleAutoVibratoStop(voice, stopTime);
    this.scheduleAutoVibratoStop(voice, stopTime);

        // Disconnect nodes after the release completes
        setTimeout(
          () => {
            try {
              voice.source.disconnect();
              voice.gainNode.disconnect();
              voice.panNode.disconnect();
              voice.envelopeGain?.disconnect();
              this.stopAutoVibrato(voice);
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
    this.scheduleAutoVibratoStop(voice, stopTime);

    // Disconnect nodes after the release completes
    setTimeout(
      () => {
        try {
          voice.source.disconnect();
          voice.gainNode.disconnect();
          voice.panNode.disconnect();
          voice.envelopeGain?.disconnect();
          this.stopAutoVibrato(voice);
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
    voice.basePan = panValue;
    const now = this.audioContext.currentTime;

    // With a panning envelope the parameter is not the channel pan -- it is
    // the channel pan with the envelope's offset already folded in -- so a pan
    // command cannot simply write to it. Re-derive the rest of the envelope
    // around the new base, from wherever the envelope has got to.
    const panEnvelope = this.samplerState?.trackerPanEnvelope;
    if (panEnvelope) {
      const elapsedTicks =
        voice.tickSeconds > 0
          ? Math.max(0, (now - voice.startTime) / voice.tickSeconds)
          : 0;
      voice.panNode.pan.cancelScheduledValues(now);
      this.scheduleTrackerEnvelope(
        voice.panNode.pan,
        panEnvelope,
        now,
        voice.tickSeconds,
        (value) => combinePan(panValue, value),
        elapsedTicks,
      );
      return;
    }

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
        this.stopAutoVibrato(voice);
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

    // Scaled for oversampling: the buffer holds `oversampleFactor` frames per
    // original frame at an unchanged declared rate, so it must be read that
    // much faster to sound at the written pitch.
    return (frequency / rootFrequency) * detuneRatio * this.oversampleFactor;
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
    envelope: TrackerEnvelopeShape,
    startTime: number,
    tickSeconds: number,
    /**
     * Maps an envelope value (0-64) onto the parameter's own units. Volume
     * wants 0..1; panning wants the channel pan combined with the envelope's
     * offset, so it cannot be a fixed division.
     */
    level: (value: number) => number = (value) =>
      Math.max(0, Math.min(1, value / 64)),
    /**
     * Envelope tick to start from, for Lxx (set envelope position) and for
     * re-scheduling a panning envelope after the channel pan moves. The
     * envelope's value at this tick is set immediately and everything after it
     * is scheduled relative to `startTime`.
     */
    fromTick = 0,
  ): void {
    const points = envelope.points;
    if (points.length === 0) {
      param.setValueAtTime(level(32), startTime);
      return;
    }

    /** Audio time for an envelope tick, with `fromTick` landing on now. */
    const at = (tick: number) => startTime + (tick - fromTick) * tickSeconds;

    const hasSustain =
      envelope.sustainPoint >= 0 && envelope.sustainPoint < points.length;

    // Start from wherever `fromTick` falls, interpolating between points if it
    // lands mid-segment.
    param.setValueAtTime(level(envelopeValueAtTick(points, fromTick)), startTime);

    // Sustain wins: the envelope runs to that point and waits for key-off.
    if (hasSustain) {
      for (let i = 1; i <= envelope.sustainPoint; i++) {
        const point = points[i]!;
        if (point.tick <= fromTick) continue;
        param.linearRampToValueAtTime(level(point.value), at(point.tick));
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
        if (point.tick <= fromTick) continue;
        param.linearRampToValueAtTime(level(point.value), at(point.tick));
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
      if (point.tick <= fromTick) continue;
      param.linearRampToValueAtTime(level(point.value), at(point.tick));
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
        const tick = offsetTicks + (point.tick - points[loopStart]!.tick);
        if (tick <= fromTick) continue;
        param.linearRampToValueAtTime(level(point.value), at(tick));
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
   * FT2 decrements `fadeoutVol`, which starts at **32768**, by the
   * instrument's raw fadeout value every tick after key-off, so silence
   * arrives after 32768/fadeout ticks with a linear decay:
   *
   *   ch->fadeoutSpeed = ins->fadeout;  ch->fadeoutVol = 32768;   // trigger
   *   ch->fadeoutVol -= ch->fadeoutSpeed;                         // each tick
   *
   * (ft2-clone, `triggerInstrument` and `updateVolPanAutoVib`; the loader
   * stores the header field unscaled, `ins->fadeout = ih.fadeout`.) This used
   * 65536 and so faded every note for twice as long as FT2 does. See D82.
   *
   * After key-off the envelope position is no longer pinned at the sustain
   * point: it advances into the points past it, and a loop that lives at or
   * after the sustain repeats for as long as the fadeout takes. The loop is
   * what the release *is* for such instruments -- the note ends when
   * `fadeoutVol` runs out, not when the envelope runs out of points
   * (ft2-clone `processVolumeEnvelope`, libxmp `update_envelope_xm`: key-off
   * clears the sustain hold and the position wraps at loopEnd). The loop is
   * unrolled here with each pass scaled by the fade progress, approximating
   * FT2's envelope-value x fadeoutVol product at each envelope point.
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
    const MAX_RELEASE_SECONDS = 30;
    const points = envelope.points;
    const level = (value: number) => Math.max(0, Math.min(1, value / 64));

    const hasSustain =
      envelope.sustainPoint >= 0 && envelope.sustainPoint < points.length;

    // An envelope with no sustain point is not released by a key-off at all.
    //
    // FT2 advances `volEnvTick` every tick unconditionally and only *holds* at
    // the sustain point, and only then while `(volEnvFlags & ENV_SUSTAIN) &&
    // !keyOff`. With sustain off there is nothing to release from: the
    // envelope was already running its whole shape and carries on doing so,
    // and `keyOff` merely starts a fadeout -- which does nothing of its own
    // when the instrument's fadeout is 0, since `fadeoutVol` is then never
    // decremented.
    //
    // Freezing it here instead stopped the decay dead. "im in love with you"
    // opens with two triads trading places every 16 rows, all on instrument 08
    // -- envelope 64 -> 41 -> 20 -> 6 -> 0 over 309 ticks, no sustain, fadeout
    // 0. At the key-off on row 16 the envelope is at 24/64 and FT2 takes it on
    // down to 7/64 by the time the channel plays again; holding it left the
    // released chord ringing at 3.4x the level it should have, for two
    // seconds, under the chord that replaced it. See D82.
    if (!hasSustain && envelope.fadeout <= 0) {
      return null;
    }

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

    // While the key is down the position is pinned at the sustain point, so
    // that is where the release starts from. With no sustain point there is
    // nothing to start from: only the fadeout acts (and it multiplies with
    // nothing, since the envelope was never held).
    const sustainTick = hasSustain
      ? points[envelope.sustainPoint]!.tick
      : 0;

    // A loop that lives at or after the sustain point repeats for as long as
    // the fadeout takes: FT2's position wraps at loopEnd after key-off, and
    // the fadeout -- not the envelope running out of points -- ends the note.
    const releaseLoop =
      hasSustain &&
      envelope.loopEnabled &&
      envelope.loopStart >= 0 &&
      envelope.loopEnd > envelope.loopStart &&
      envelope.loopEnd < points.length &&
      points[envelope.loopEnd]!.tick >= sustainTick;

    if (releaseLoop) {
      const loopStartTick = points[envelope.loopStart]!.tick;
      const loopEndTick = points[envelope.loopEnd]!.tick;
      const loopTicks = loopEndTick - loopStartTick;

      if (envelope.fadeout <= 0 || loopTicks <= 0) {
        // A loop with no fadeout repeats forever: the note has no defined end
        // and rings until the channel plays again.
        return null;
      }

      const releaseTicks = 32768 / envelope.fadeout;
      const end = Math.min(releaseTicks * tickSeconds, MAX_RELEASE_SECONDS);
      const endTicks = end / tickSeconds;
      // Fade progress at an envelope tick after key-off: fadeoutVol falls
      // linearly from 32768 to 0 over `releaseTicks` ticks.
      const fadeAt = (offsetTicks: number) =>
        Math.max(0, 1 - offsetTicks / releaseTicks);

      // Out of the sustain point and into the loop...
      for (let i = envelope.sustainPoint + 1; i <= envelope.loopEnd; i++) {
        const offset = points[i]!.tick - sustainTick;
        if (offset >= endTicks) break;
        param.linearRampToValueAtTime(
          level(points[i]!.value) * fadeAt(offset),
          releaseTime + offset * tickSeconds,
        );
      }

      // ...then the loop itself, unrolled until the fadeout ends the note.
      const approachTicks = loopEndTick - sustainTick;
      const passes =
        approachTicks >= endTicks
          ? 0
          : Math.min(
              4096,
              Math.ceil((endTicks - approachTicks) / loopTicks),
            );
      for (let pass = 0; pass < passes; pass++) {
        const base = approachTicks + pass * loopTicks;
        if (base >= endTicks) break;
        for (let i = envelope.loopStart; i <= envelope.loopEnd; i++) {
          const offset = base + (points[i]!.tick - loopStartTick);
          if (offset >= endTicks) break;
          param.linearRampToValueAtTime(
            level(points[i]!.value) * fadeAt(offset),
            releaseTime + offset * tickSeconds,
          );
        }
      }

      param.linearRampToValueAtTime(0, releaseTime + end);
      return end;
    }

    // Without such a loop the release is the envelope's own tail, in one
    // pass, for whichever of it and the fadeout ends first. The cap only
    // bounds pathological fadeouts (below a fadeout of ~22 the fade would
    // outlast 30s at the default tick); it is never what ends a musical
    // note, which is what the old 10s cap did to long fadeouts.
    const tailSeconds =
      hasSustain && envelope.sustainPoint < points.length - 1
        ? (points[points.length - 1]!.tick - sustainTick) * tickSeconds
        : Infinity;

    const fadeoutSeconds =
      envelope.fadeout > 0
        ? (32768 / envelope.fadeout) * tickSeconds
        : Infinity;

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
    if (hasSustain) {
      for (let i = envelope.sustainPoint + 1; i < points.length; i++) {
        const offset = (points[i]!.tick - sustainTick) * tickSeconds;
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
    warnOccasionally(
      `no-free-voice:${this.instrumentKey}`,
      () =>
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
      /**
       * Start offset into the sample in *frames* (ProTracker 9xx: param*256).
       */
      sampleOffsetFrames?: number;
      /** Duration of one tracker tick in seconds, for envelope timing. */
      tickSeconds?: number;
      /** Tracker channel this note belongs to; owns a voice of its own. */
      trackIndex?: number;
      /**
       * Per-track visualiser tap. The voice connects here *in addition* to the
       * instrument output, so the tap carries one channel rather than every
       * channel that happens to share this instrument.
       */
      monitorNode?: AudioNode;
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
        this.scheduleAutoVibratoStop(oldVoice, replaceAt);
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
          this.stopAutoVibrato(oldVoice);
        } catch {
          // Already disconnected
        }
      }, delay);
    }

    // The rate is worked out first because it selects the buffer: a source
    // node accepts `buffer` exactly once, so it cannot be assigned a default
    // and then swapped for the anti-aliased copy.
    const frequency =
      options?.frequency ?? this.midiNoteToFrequency(noteNumber);
    const playbackRate = this.calculatePlaybackRate(frequency);

    // Create audio nodes for this voice
    const source = this.audioContext.createBufferSource();
    const gainNode = this.audioContext.createGain();
    const panNode = this.audioContext.createStereoPanner();

    source.buffer = this.bufferForRate(playbackRate / this.oversampleFactor);
    source.playbackRate.value = playbackRate;

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

    // Connect audio graph. The envelope, when the instrument has one, gets its
    // own stage ahead of the channel-volume node.
    const envelope = this.samplerState.trackerEnvelope;
    const tickSeconds = options?.tickSeconds ?? DEFAULT_TICK_SECONDS;
    const autoVibratoSpec = this.samplerState.trackerAutoVibrato;
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
    // A second, silent destination used only for this channel's visualiser.
    // Taken after panning so the tap shows what the channel actually sounds
    // like, and disconnected with the rest of the voice's graph.
    if (options?.monitorNode) panNode.connect(options.monitorNode);

    // Schedule playback at the specified time.
    //
    // ProTracker 9xx has to be applied here: an AudioBufferSourceNode cannot
    // be seeked once started, so passing the offset to start() is the only
    // way to honour it.
    const startTime = Math.max(time, this.audioContext.currentTime);
    const offsetFrames = options?.sampleOffsetFrames;
    if (offsetFrames !== undefined && offsetFrames > 0) {
      source.start(startTime, this.offsetSecondsForFrame(offsetFrames));
    } else {
      source.start(startTime);
    }

    // The instrument's own vibrato rides on `detune`, so it survives every
    // pitch command the channel schedules on `playbackRate`.
    const autoVibrato = autoVibratoSpec
      ? this.startAutoVibrato(source, autoVibratoSpec, startTime, tickSeconds)
      : null;

    // The channel's pan, which a panning envelope offsets around.
    const basePan = pan !== undefined ? (pan - 0.5) * 2 : 0;
    const panEnvelope = this.samplerState.trackerPanEnvelope;
    if (panEnvelope) {
      this.scheduleTrackerEnvelope(
        panNode.pan,
        panEnvelope,
        startTime,
        tickSeconds,
        (value) => combinePan(basePan, value),
      );
    }

    // Store active voice
    this.activeVoices.set(voiceIndex, {
      source,
      gainNode,
      envelopeGain,
      autoVibrato,
      basePan,
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
          if (modInstrumentDebug()) {
            console.warn(
              `[ModInstrument] Voice ${voiceIndex} auto-freed (one-shot ended), activeVoices now=${this.activeVoices.size}`,
            );
          }
        }
      };
    }

    if (modInstrumentDebug()) {
      console.warn(
        `[ModInstrument] noteOnAtTime allocated voice ${voiceIndex} for note ${noteNumber}, loop=${source.loop}, activeVoices=${this.activeVoices.size}`,
      );
    }

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
      this.scheduleAutoVibratoStop(voice, stopAt);
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
          this.stopAutoVibrato(voice);
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
    this.scheduleAutoVibratoStop(voice, stopTime);

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
        this.stopAutoVibrato(voice);
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
      this.scheduleAutoVibratoStop(releasing, stopAt);
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
        this.stopAutoVibrato(releasing);
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
    rampMode?: 'linear' | 'exponential' | 'step',
  ): void {
    const voice = this.activeVoices.get(voiceIndex);
    if (!voice) {
      warnOccasionally(
        `gain-voice-missing:${this.instrumentKey}`,
        () =>
          `[ModInstrument] setVoiceGainAtTime: voice not found: ${voiceIndex} active voices: ${Array.from(this.activeVoices.keys()).join(',')}`,
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

    // An instantaneous command sets the value at its own time and cancels
    // whatever was scheduled from there on. Without the cancel, a ramp already
    // aimed past this point would keep pulling the gain afterwards.
    if (rampMode === 'step') {
      voice.gainNode.gain.cancelScheduledValues(scheduledTime);
      voice.gainNode.gain.setValueAtTime(gain, scheduledTime);
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

  /**
   * Lxx: move a voice's envelopes to a tick position.
   *
   * The note carries on untouched -- only the envelopes' read position moves,
   * which is the whole point of the command. Both envelopes are repositioned
   * together, as FastTracker 2 does.
   *
   * `startTime` stays put so `setPan` keeps measuring elapsed ticks from the
   * note's own beginning; the jump is expressed by re-scheduling from
   * `fromTick` rather than by pretending the note started elsewhere.
   */
  setEnvelopePositionAtTime(
    voiceIndex: number,
    tick: number,
    time: number,
  ): void {
    const voice = this.activeVoices.get(voiceIndex);
    if (!voice || !this.samplerState) return;

    const at = Math.max(time, this.audioContext.currentTime);
    const fromTick = Math.max(0, tick);

    const envelope = this.samplerState.trackerEnvelope;
    if (voice.envelopeGain && envelope && envelope.points.length > 0) {
      voice.envelopeGain.gain.cancelScheduledValues(at);
      this.scheduleTrackerEnvelope(
        voice.envelopeGain.gain,
        envelope,
        at,
        voice.tickSeconds,
        undefined,
        fromTick,
      );
    }

    const panEnvelope = this.samplerState.trackerPanEnvelope;
    if (panEnvelope && panEnvelope.points.length > 0) {
      const base = voice.basePan;
      voice.panNode.pan.cancelScheduledValues(at);
      this.scheduleTrackerEnvelope(
        voice.panNode.pan,
        panEnvelope,
        at,
        voice.tickSeconds,
        (value) => combinePan(base, value),
        fromTick,
      );
    }
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
    // Macro 1 used to latch a 9xx sample offset here, to be consumed by the
    // next note this instrument played. That is not what ProTracker does: its
    // offset memory is per *channel* and is only consulted when a row carries
    // a 9xx of its own, so latching applied the offset to unrelated notes --
    // on other channels, and with no 9xx anywhere near them -- which starts a
    // sample mid-waveform and clicks. A 9xx with no note is silent in
    // ProTracker, so the effect processor no longer emits anything for it and
    // there is nothing to latch.
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
