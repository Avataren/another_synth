/**
 * Turns a library `TrackerSample` into this app's sampler `Patch`.
 *
 * This is the adapter the library extraction stops at. `TrackerSample` says
 * what an imported instrument *is* -- PCM, loop points, root note, the
 * envelopes the format attaches; a `Patch` says how *this* app sounds one: a
 * sampler feeding a mixer, an amp envelope, the standard effect nodes, and the
 * two macro routes tracker playback depends on (macro 0 = stereo pan, macro 1
 * = per-voice sample offset).
 *
 * Keeping that here is what stops the package exporting the app's synth model
 * to consumers who asked for a module player. A different host writes its own
 * adapter and never sees a `Patch`.
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
import type {
  TrackerSample,
  TrackerSampleLoop,
} from '@another-synth/tracker-playback';

/** What the app adds on top of a `TrackerSample` to make a patch. */
export interface SamplerPatchOptions {
  /** Used when the sample has no name of its own. */
  fallbackName: string;
  /** Patch metadata category, e.g. 'Imported/MOD'. */
  category: string;
}

/**
 * The library's format-native loop vocabulary, as the sampler node's enum.
 *
 * These two are deliberately not the same type: `SamplerLoopMode`'s numbers
 * are serialised into saved patches, so the library describes loops in words
 * and this adapter is where the app's numbering is applied.
 */
function toSamplerLoopMode(loop: TrackerSampleLoop): SamplerLoopMode {
  switch (loop) {
    case 'pingpong':
      return SamplerLoopMode.PingPong;
    case 'forward':
      return SamplerLoopMode.Loop;
    case 'off':
      return SamplerLoopMode.Off;
  }
}

function generateNodeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as unknown as { randomUUID: () => string }).randomUUID();
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function createSamplerPatch(
  sample: TrackerSample,
  options: SamplerPatchOptions,
): Patch {
  const loopMode = toSamplerLoopMode(sample.loop);
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
  const patchName = sample.name || options.fallbackName;
  const metadata = createDefaultPatchMetadata(patchName, options.category);
  metadata.instrumentType = 'mod';

  const audioAsset = encodeFloat32ArrayToBase64(
    sample.data,
    sample.sampleRate,
    1,
    AudioAssetType.Sample,
    samplerNodeId,
    sample.name || undefined,
    60,
  );

  const sampleLengthFrames = Math.max(1, sample.data.length);
  const loopEnabled = loopMode !== SamplerLoopMode.Off;
  const loopStartFrames = Math.min(sample.loopStartFrames, sampleLengthFrames - 1);
  const loopEndFrames = Math.min(
    loopStartFrames + sample.loopLengthFrames,
    sampleLengthFrames,
  );
  const finetuneCents = sample.detuneCents;

  const samplerState: SamplerState = {
    id: samplerNodeId,
    frequency: 440,
    gain: sample.gain,
    detune_oct: 0,
    detune_semi: 0,
    detune_cents: finetuneCents,
    detune: finetuneCents,
    loopMode: loopMode,
    loopStart: loopEnabled ? loopStartFrames / sampleLengthFrames : 0,
    loopEnd: loopEnabled ? loopEndFrames / sampleLengthFrames : 1,
    sampleLength: sampleLengthFrames,
    rootNote: sample.rootNote,
    triggerMode: SamplerTriggerMode.Gate,
    active: true,
    sampleRate: sample.sampleRate,
    channels: 1,
  };
  if (sample.name) {
    samplerState.fileName = sample.name;
  }
  if (sample.volumeEnvelope) {
    samplerState.trackerEnvelope = sample.volumeEnvelope;
  }
  if (sample.panEnvelope) {
    samplerState.trackerPanEnvelope = sample.panEnvelope;
  }
  if (sample.autoVibrato) {
    samplerState.trackerAutoVibrato = sample.autoVibrato;
  }
  // Named in SamplerState, so it survives serialization; the normalizer keeps
  // it with a 0.5 (centre) default for patches that predate the field.
  samplerState.pan = sample.pan ?? 0.5;

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
          name: sample.name || 'Sampler',
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
    voiceCount: sample.voiceCount,
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

