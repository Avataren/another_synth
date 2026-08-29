/**
 * Builds the sampler patch used by imported tracker instruments.
 *
 * This is the node-graph construction shared by every sample-based importer:
 * a sampler feeding a mixer, an amp envelope, the standard effect nodes, and
 * the two macro routes tracker playback depends on (macro 0 = stereo pan,
 * macro 1 = per-voice sample offset).
 *
 * None of it is format-specific -- only the numbers going in are -- so it is
 * shared rather than duplicated per format. Extracted from mod-import.ts,
 * where it was 368 of that file's 950 lines.
 */

import {
  type Patch,
  AudioAssetType,
  createDefaultPatchMetadata,
} from 'src/audio/types/preset-types';
import {
  SamplerLoopMode,
  SamplerTriggerMode,
  VoiceNodeType,
  type SamplerState,
  type TrackerVolumeEnvelope,
  type TrackerPanningEnvelope,
  type TrackerAutoVibrato,
  type VoiceLayout,
  type PatchLayout,
  type EnvelopeConfig,
  type LfoState,
} from 'src/audio/types/synth-layout';
import { PortId } from 'src/audio/types/generated/port-ids';
import type {
  ModulationTransformation,
  WasmModulationType,
} from 'app/public/wasm/audio_processor';
import { encodeFloat32ArrayToBase64 } from 'src/audio/serialization/audio-asset-encoder';

export interface SamplerPatchSpec {
  /** Sample name from the file; may be empty. */
  name: string;
  /** Used when `name` is empty. */
  fallbackName: string;
  /** Patch metadata category, e.g. 'Imported/MOD'. */
  category: string;
  /** Decoded PCM, normalised to -1..1. */
  data: Float32Array;
  sampleRate: number;
  /**
   * MIDI note at which the sample plays back untransposed. MOD uses an
   * empirically calibrated 65; XM derives it from the sample's relative note.
   */
  rootNote: number;
  /** Tuning offset in cents, applied as sampler detune. */
  detuneCents: number;
  /** Base gain 0..1. */
  gain: number;
  loopMode: SamplerLoopMode;
  loopStartFrames: number;
  loopLengthFrames: number;
  /** Voices allocated to this instrument. */
  voiceCount: number;
  /** Optional tracker volume envelope (XM/IT style). */
  trackerEnvelope?: TrackerVolumeEnvelope;
  /** Optional XM panning envelope. */
  panEnvelope?: TrackerPanningEnvelope;
  /** Optional XM instrument-level vibrato. */
  autoVibrato?: TrackerAutoVibrato;
}

function generateNodeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as unknown as { randomUUID: () => string }).randomUUID();
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function createSamplerPatch(spec: SamplerPatchSpec): Patch {
  const samplerNodeId = generateNodeId('sampler');
  const mixerNodeId = generateNodeId('mixer');
  const envelopeNodeId = generateNodeId('envelope');
  const lfoNodeId = generateNodeId('lfo');
  const chorusNodeId = '10000';
  const delayNodeId = '10001';
  const reverbNodeId = '10002';
  const convolverNodeId = '10003';
  const limiterNodeId = '10004';
  const compressorNodeId = '10005';
  const saturationNodeId = '10006';
  const bitcrusherNodeId = '10007';
  const patchName = spec.name || spec.fallbackName;
  const metadata = createDefaultPatchMetadata(patchName, spec.category);
  metadata.instrumentType = 'mod';

  const audioAsset = encodeFloat32ArrayToBase64(
    spec.data,
    spec.sampleRate,
    1,
    AudioAssetType.Sample,
    samplerNodeId,
    spec.name || undefined,
    60,
  );

  const sampleLengthFrames = Math.max(1, spec.data.length);
  const loopEnabled = spec.loopMode !== SamplerLoopMode.Off;
  const loopStartFrames = Math.min(spec.loopStartFrames, sampleLengthFrames - 1);
  const loopEndFrames = Math.min(
    loopStartFrames + spec.loopLengthFrames,
    sampleLengthFrames,
  );
  const finetuneCents = spec.detuneCents;

  const samplerState: SamplerState = {
    id: samplerNodeId,
    frequency: 440,
    gain: spec.gain,
    detune_oct: 0,
    detune_semi: 0,
    detune_cents: finetuneCents,
    detune: finetuneCents,
    loopMode: spec.loopMode,
    loopStart: loopEnabled ? loopStartFrames / sampleLengthFrames : 0,
    loopEnd: loopEnabled ? loopEndFrames / sampleLengthFrames : 1,
    sampleLength: sampleLengthFrames,
    rootNote: spec.rootNote,
    triggerMode: SamplerTriggerMode.Gate,
    active: true,
    sampleRate: spec.sampleRate,
    channels: 1,
  };
  if (spec.name) {
    samplerState.fileName = spec.name;
  }
  if (spec.trackerEnvelope) {
    samplerState.trackerEnvelope = spec.trackerEnvelope;
  }
  if (spec.panEnvelope) {
    samplerState.trackerPanEnvelope = spec.panEnvelope;
  }
  if (spec.autoVibrato) {
    samplerState.trackerAutoVibrato = spec.autoVibrato;
  }

  const canonicalVoice: VoiceLayout = {
    id: 0,
    nodes: {
      [VoiceNodeType.Oscillator]: [],
      [VoiceNodeType.WavetableOscillator]: [],
      [VoiceNodeType.Filter]: [],
      [VoiceNodeType.Envelope]: [
        {
          id: envelopeNodeId,
          type: VoiceNodeType.Envelope,
          name: 'Amp Envelope',
        },
      ],
      [VoiceNodeType.LFO]: [
        {
          id: lfoNodeId,
          type: VoiceNodeType.LFO,
          name: 'LFO',
        },
      ],
      [VoiceNodeType.Mixer]: [
        {
          id: mixerNodeId,
          type: VoiceNodeType.Mixer,
          name: 'Mixer',
        },
      ],
      [VoiceNodeType.Noise]: [],
      [VoiceNodeType.Sampler]: [
        {
          id: samplerNodeId,
          type: VoiceNodeType.Sampler,
          name: spec.name || 'Sampler',
        },
      ],
      [VoiceNodeType.Glide]: [],
      [VoiceNodeType.GlobalFrequency]: [
        {
          id: generateNodeId('global_frequency'),
          type: VoiceNodeType.GlobalFrequency,
          name: 'Global Frequency',
        },
      ],
      [VoiceNodeType.GlobalVelocity]: [
        {
          id: generateNodeId('global_velocity'),
          type: VoiceNodeType.GlobalVelocity,
          name: 'Global Velocity',
        },
      ],
      [VoiceNodeType.Convolver]: [
        {
          id: convolverNodeId,
          type: VoiceNodeType.Convolver,
          name: 'Convolver',
        },
      ],
      [VoiceNodeType.Delay]: [
        {
          id: delayNodeId,
          type: VoiceNodeType.Delay,
          name: 'Delay',
        },
      ],
      [VoiceNodeType.GateMixer]: [
        {
          id: generateNodeId('gatemixer'),
          type: VoiceNodeType.GateMixer,
          name: 'Gate Mixer',
        },
      ],
      [VoiceNodeType.ArpeggiatorGenerator]: [],
      [VoiceNodeType.Chorus]: [
        {
          id: chorusNodeId,
          type: VoiceNodeType.Chorus,
          name: 'Chorus',
        },
      ],
      [VoiceNodeType.Limiter]: [
        {
          id: limiterNodeId,
          type: VoiceNodeType.Limiter,
          name: 'Limiter',
        },
      ],
      [VoiceNodeType.Reverb]: [
        {
          id: reverbNodeId,
          type: VoiceNodeType.Reverb,
          name: 'Reverb',
        },
      ],
      [VoiceNodeType.Compressor]: [
        {
          id: compressorNodeId,
          type: VoiceNodeType.Compressor,
          name: 'Compressor',
        },
      ],
      [VoiceNodeType.Saturation]: [
        {
          id: saturationNodeId,
          type: VoiceNodeType.Saturation,
          name: 'Saturation',
        },
      ],
      [VoiceNodeType.Bitcrusher]: [
        {
          id: bitcrusherNodeId,
          type: VoiceNodeType.Bitcrusher,
          name: 'Bitcrusher',
        },
      ],
    },
    connections: [
      {
        fromId: samplerNodeId,
        toId: mixerNodeId,
        target: PortId.AudioInput0,
        amount: 1,
        modulationType: 2 as WasmModulationType,
        modulationTransformation: 0 as ModulationTransformation,
      },
      {
        fromId: envelopeNodeId,
        toId: mixerNodeId,
        target: PortId.GainMod,
        amount: 1,
        modulationType: 0 as WasmModulationType,
        modulationTransformation: 0 as ModulationTransformation,
      },
    ],
  };

  const layout: PatchLayout = {
    voiceCount: spec.voiceCount,
    canonicalVoice,
    globalNodes: {},
  };

  const patch: Patch = {
    metadata,
    synthState: {
      layout,
      oscillators: {},
      wavetableOscillators: {},
      filters: {},
      envelopes: {
        [envelopeNodeId]: {
          id: envelopeNodeId,
          active: true,
          attack: 0,
          decay: 0,
          sustain: 1,
          release: 0,
          attackCurve: 0,
          decayCurve: 0,
          releaseCurve: 0,
        } satisfies EnvelopeConfig,
      },
      lfos: {
        [lfoNodeId]: {
          id: lfoNodeId,
          frequency: 1.0,
          phaseOffset: 0,
          waveform: 0,
          useAbsolute: false,
          useNormalized: false,
          triggerMode: 0,
          gain: 0,
          active: false,
          loopMode: 0,
          loopStart: 0,
          loopEnd: 1,
        } satisfies LfoState,
      },
      samplers: {
        [samplerNodeId]: samplerState,
      },
      glides: {},
      convolvers: {
        [convolverNodeId]: {
          id: convolverNodeId,
          wetMix: 0.0,
          active: false,
        },
      },
      delays: {
        [delayNodeId]: {
          id: delayNodeId,
          delayMs: 250,
          feedback: 0.5,
          wetMix: 0.0,
          active: false,
        },
      },
      choruses: {
        [chorusNodeId]: {
          id: chorusNodeId,
          active: false,
          baseDelayMs: 15.0,
          depthMs: 5.0,
          lfoRateHz: 0.5,
          feedback: 0.3,
          feedback_filter: 0.5,
          mix: 0.5,
          stereoPhaseOffsetDeg: 90.0,
        },
      },
      reverbs: {
        [reverbNodeId]: {
          id: reverbNodeId,
          active: false,
          room_size: 0.95,
          damp: 0.5,
          wet: 0.3,
          dry: 0.7,
          width: 1.0,
        },
      },
      compressors: {
        [compressorNodeId]: {
          id: compressorNodeId,
          active: false,
          thresholdDb: -12,
          ratio: 4,
          attackMs: 10,
          releaseMs: 80,
          makeupGainDb: 3,
          mix: 0.5,
        },
      },
      saturations: {
        [saturationNodeId]: {
          id: saturationNodeId,
          active: false,
          drive: 2.0,
          mix: 0.5,
        },
      },
      bitcrushers: {
        [bitcrusherNodeId]: {
          id: bitcrusherNodeId,
          active: false,
          bits: 12,
          downsampleFactor: 4,
          mix: 0.5,
        },
      },
      macros: {
        // Macro 0: per-instrument stereo pan for the sampler/mixer.
        // Macro 1: per-note sample offset (0..1) for MOD 9xx.
        values: [0.5, 0.0],
        routes: [
          {
            macroIndex: 0,
            // Route pan macro to the Mixer StereoPan port so imported
            // instruments get audible stereo separation.
            targetId: mixerNodeId,
            targetPort: PortId.StereoPan,
            amount: 1,
            modulationType: 2 as WasmModulationType,
            modulationTransformation: 0 as ModulationTransformation,
          },
          {
            macroIndex: 1,
            // Route macro 1 into the sampler's SampleOffset port so per-note
            // sample offsets (MOD 9xx, XM 9xx) can be applied per voice.
            targetId: samplerNodeId,
            targetPort: PortId.SampleOffset,
            amount: 1,
            modulationType: 2 as WasmModulationType,
            modulationTransformation: 0 as ModulationTransformation,
          },
        ],
      },
      instrumentGain: 1.0,
    },
    audioAssets: {
      [audioAsset.id]: audioAsset,
    },
  };

  return patch;
}

