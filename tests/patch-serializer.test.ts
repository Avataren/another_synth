import { describe, expect, it } from 'vitest';
import {
  createAudioAssetId,
  parseAudioAssetId,
  serializeCurrentPatch,
  deserializePatch,
  exportPatchToJSON,
  importPatchFromJSON,
} from '../src/audio/serialization/patch-serializer';
import { AudioAssetType } from '../src/audio/types/preset-types';
import type {
  SynthLayout,
  ConvolverState,
  VoiceLayout,
  VoiceNode,
  FilterState,
} from '../src/audio/types/synth-layout';
import { VoiceNodeType, FilterType, FilterSlope, SamplerLoopMode, SamplerTriggerMode } from '../src/audio/types/synth-layout';
import type {
  SerializeCurrentPatchOptions,
} from '../src/audio/serialization/patch-serializer';
import type OscillatorState from '../src/audio/models/OscillatorState';
import type {
  EnvelopeConfig,
  LfoState,
  SamplerState,
  DelayState,
  ChorusState,
  ReverbState,
  CompressorState,
  SaturationState,
  BitcrusherState,
  GlideState,
} from '../src/audio/types/synth-layout';
import { ModulationTransformation, WasmModulationType, PortId } from 'app/public/wasm/audio_processor';

// Test helper to create a valid synth layout
function createTestLayout(
  voiceCount: number,
  convolverNodes: Array<{ id: string; type: string; name: string }> = []
): SynthLayout {
  const baseNodes: Record<VoiceNodeType, VoiceNode[]> = {
    [VoiceNodeType.Oscillator]: [],
    [VoiceNodeType.WavetableOscillator]: [],
    [VoiceNodeType.Filter]: [],
    [VoiceNodeType.Envelope]: [],
    [VoiceNodeType.LFO]: [],
    [VoiceNodeType.Mixer]: [],
    [VoiceNodeType.Noise]: [],
    [VoiceNodeType.Sampler]: [],
    [VoiceNodeType.Glide]: [],
    [VoiceNodeType.GlobalFrequency]: [],
    [VoiceNodeType.GlobalVelocity]: [],
    [VoiceNodeType.Convolver]: [],
    [VoiceNodeType.Delay]: [],
    [VoiceNodeType.GateMixer]: [],
    [VoiceNodeType.ArpeggiatorGenerator]: [],
    [VoiceNodeType.Chorus]: [],
    [VoiceNodeType.Limiter]: [],
    [VoiceNodeType.Reverb]: [],
    [VoiceNodeType.Compressor]: [],
    [VoiceNodeType.Saturation]: [],
    [VoiceNodeType.Bitcrusher]: [],
  };

  const convolverNodesTyped: VoiceNode[] = convolverNodes.map(node => ({
    ...node,
    type: VoiceNodeType.Convolver,
  }));
  const canonicalVoice: VoiceLayout = {
    id: 0,
    nodes: {
      ...baseNodes,
      [VoiceNodeType.Convolver]: convolverNodesTyped,
    },
    connections: [],
  };

  return {
    voiceCount,
    canonicalVoice,
    voices: Array.from({ length: voiceCount }, (_, i) => ({
      ...canonicalVoice,
      id: i,
    })),
    globalNodes: {},
  };
}

function createFullStateMaps() {
  const oscillators = new Map<string, OscillatorState>([
    ['osc-1', { id: 'osc-1', gain: 0.5 } as OscillatorState],
  ]);
  const wavetableOscillators = new Map<string, OscillatorState>([
    ['wt-1', { id: 'wt-1', gain: 0.4 } as OscillatorState],
  ]);
  const filters = new Map<string, FilterState>([
    [
      'filter-1',
      {
        id: 'filter-1',
        cutoff: 800,
        resonance: 0.5,
        keytracking: 0,
        comb_frequency: 0,
        comb_dampening: 0,
        oversampling: 1,
        gain: 1,
        filter_type: FilterType.LowPass,
        filter_slope: FilterSlope.Db12,
        active: true,
      },
    ],
  ]);
  const envelopes = new Map<string, EnvelopeConfig>([
    [
      'env-1',
      {
        id: 'env-1',
        active: true,
        attack: 0,
        decay: 0.1,
        sustain: 0.5,
        release: 0.2,
        attackCurve: 0,
        decayCurve: 0,
        releaseCurve: 0,
      },
    ],
  ]);
  const lfos = new Map<string, LfoState>([
    [
      'lfo-1',
      {
        id: 'lfo-1',
        frequency: 1,
        phaseOffset: 0,
        waveform: 0,
        useAbsolute: false,
        useNormalized: false,
        triggerMode: 0,
        gain: 0.5,
        active: true,
        loopMode: 0,
        loopStart: 0,
        loopEnd: 1,
      },
    ],
  ]);
  const samplers = new Map<string, SamplerState>([
    [
      'sampler-1',
      {
        id: 'sampler-1',
        frequency: 440,
        gain: 0.8,
        detune_oct: 0,
        detune_semi: 0,
        detune_cents: 0,
        detune: 0,
        loopMode: SamplerLoopMode.Off,
        loopStart: 0,
        loopEnd: 1,
        sampleLength: 1,
        rootNote: 60,
        triggerMode: SamplerTriggerMode.Gate,
        active: true,
        sampleRate: 44100,
        channels: 1,
      },
    ],
  ]);
  const glides = new Map<string, GlideState>([
    ['glide-1', { id: 'glide-1', active: true, time: 0.05 }],
  ]);
  const convolvers = new Map<string, ConvolverState>([
    [
      'conv-1',
      {
        id: 'conv-1',
        wetMix: 0.4,
        active: true,
        generator: { type: 'hall', decayTime: 1.2, size: 0.7, sampleRate: 48000 },
      },
    ],
  ]);
  const delays = new Map<string, DelayState>([
    ['delay-1', { id: 'delay-1', delayMs: 250, feedback: 0.3, wetMix: 0.5, active: true }],
  ]);
  const choruses = new Map<string, ChorusState>([
    [
      'chorus-1',
      {
        id: 'chorus-1',
        active: true,
        baseDelayMs: 10,
        depthMs: 2,
        lfoRateHz: 1.5,
        feedback: 0.1,
        feedback_filter: 0.5,
        mix: 0.5,
        stereoPhaseOffsetDeg: 90,
      },
    ],
  ]);
  const reverbs = new Map<string, ReverbState>([
    [
      'reverb-1',
      {
        id: 'reverb-1',
        active: true,
        room_size: 0.6,
        damp: 0.2,
        wet: 0.5,
        dry: 0.5,
        width: 1,
      },
    ],
  ]);
  const compressors = new Map<string, CompressorState>([
    [
      'comp-1',
      {
        id: 'comp-1',
        active: true,
        thresholdDb: -12,
        ratio: 3,
        attackMs: 5,
        releaseMs: 50,
        makeupGainDb: 0,
        mix: 0.8,
      },
    ],
  ]);
  const saturations = new Map<string, SaturationState>([
    ['sat-1', { id: 'sat-1', active: true, drive: 0.5, mix: 0.6 }],
  ]);
  const bitcrushers = new Map<string, BitcrusherState>([
    ['bit-1', { id: 'bit-1', active: true, bits: 8, downsampleFactor: 2, mix: 0.7 }],
  ]);

  return {
    oscillators,
    wavetableOscillators,
    filters,
    envelopes,
    lfos,
    samplers,
    glides,
    convolvers,
    delays,
    choruses,
    reverbs,
    compressors,
    saturations,
    bitcrushers,
  };
}

function serializeWithLayout(
  name: string,
  layout: SynthLayout,
  overrides: Partial<SerializeCurrentPatchOptions> = {},
) {
  return serializeCurrentPatch({
    name,
    layout,
    oscillators: new Map(),
    wavetableOscillators: new Map(),
    filters: new Map(),
    envelopes: new Map(),
    lfos: new Map(),
    samplers: new Map(),
    glides: new Map(),
    convolvers: new Map(),
    delays: new Map(),
    choruses: new Map(),
    reverbs: new Map(),
    compressors: new Map(),
    saturations: new Map(),
    bitcrushers: new Map(),
    ...overrides,
  });
}

describe('patch-serializer audio asset helpers', () => {
  it('creates asset ids with string node ids', () => {
    const id = createAudioAssetId('sampler', '123e4567-e89b-12d3-a456-426614174000');
    expect(id).toBe('sampler_123e4567-e89b-12d3-a456-426614174000');
  });

  it('parses asset ids containing uuid strings', () => {
    const result = parseAudioAssetId('convolver_123e4567-e89b-12d3-a456-426614174000');
    expect(result).toEqual({
      nodeType: 'convolver',
      nodeId: '123e4567-e89b-12d3-a456-426614174000',
    });
  });

  it('returns null for malformed asset ids', () => {
    expect(parseAudioAssetId('invalid')).toBeNull();
    expect(parseAudioAssetId('type_')).toBeNull();
  });
});

describe('patch serialization round-trips', () => {
  it('preserves voiceCount through serialize/deserialize', () => {
    const voiceCounts = [1, 2, 4, 8];

    voiceCounts.forEach(voiceCount => {
      const layout = createTestLayout(voiceCount);

      const patch = serializeWithLayout('Test Patch', layout);

      expect(patch.synthState.layout.voiceCount).toBe(voiceCount);

      const deserialized = deserializePatch(patch);
      expect(deserialized.layout.voiceCount).toBe(voiceCount);
    });
  });

  it('preserves patch through JSON export/import', () => {
    const layout = createTestLayout(4);

    const originalPatch = serializeWithLayout('Export Test', layout);

    const json = exportPatchToJSON(originalPatch);
    const result = importPatchFromJSON(json);

    expect(result.validation.valid).toBe(true);
    expect(result.patch).toBeDefined();
    expect(result.patch?.metadata.name).toBe('Export Test');
    expect(result.patch?.synthState.layout.voiceCount).toBe(4);
  });
});

describe('convolver generator asset filtering', () => {
  it('excludes binary data for hall reverb generators', () => {
    const nodeId = 'convolver-123';
    const layout = createTestLayout(1, [{
      id: nodeId,
      type: 'convolver',
      name: 'Hall Reverb',
    }]);

    const convolverState: ConvolverState = {
      id: nodeId,
      wetMix: 0.3,
      active: true,
      generator: {
        type: 'hall',
        decayTime: 2.5,
        size: 0.8,
        sampleRate: 48000,
      },
    };

    const convolvers = new Map([[nodeId, convolverState]]);

    // Create a fake audio asset for the convolver
    const audioAssets = new Map([
      [
        `impulse_response_${nodeId}`,
        {
          id: `impulse_response_${nodeId}`,
          type: AudioAssetType.ImpulseResponse,
          base64Data: 'FAKEBINARYDATA',
          sampleRate: 48000,
          channels: 2,
        },
      ],
    ]);

    const patch = serializeWithLayout('Hall Reverb Test', layout, {
      convolvers,
      audioAssets,
    });

    // The binary data should be excluded because generator exists
    expect(Object.keys(patch.audioAssets)).toHaveLength(0);
  });

  it('includes binary data for custom uploaded impulses', () => {
    const nodeId = 'convolver-456';
    const layout = createTestLayout(1, [{
      id: nodeId,
      type: 'convolver',
      name: 'Custom Impulse',
    }]);

    const convolverState: ConvolverState = {
      id: nodeId,
      wetMix: 0.5,
      active: true,
      // No generator - this is a custom upload
    };

    const convolvers = new Map([[nodeId, convolverState]]);

    // Create a fake audio asset for the custom convolver
    const audioAssets = new Map([
      [
        `impulse_response_${nodeId}`,
        {
          id: `impulse_response_${nodeId}`,
          type: AudioAssetType.ImpulseResponse,
          base64Data: 'CUSTOMWAVDATA',
          sampleRate: 44100,
          channels: 1,
        },
      ],
    ]);

    const patch = serializeWithLayout('Custom Impulse Test', layout, {
      convolvers,
      audioAssets,
    });

    // The binary data should be included because no generator exists
    expect(Object.keys(patch.audioAssets)).toHaveLength(1);
    const asset = patch.audioAssets[`impulse_response_${nodeId}`];
    expect(asset).toBeDefined();
    expect(asset!.base64Data).toBe('CUSTOMWAVDATA');
  });

  it('preserves generator parameters in patch', () => {
    const nodeId = 'convolver-789';
    const layout = createTestLayout(1, [{
      id: nodeId,
      type: 'convolver',
      name: 'Plate Reverb',
    }]);

    const convolverState: ConvolverState = {
      id: nodeId,
      wetMix: 0.4,
      active: true,
      generator: {
        type: 'plate',
        decayTime: 3.0,
        size: 0.7,
        sampleRate: 48000,
      },
    };

    const convolvers = new Map([[nodeId, convolverState]]);

    const patch = serializeWithLayout('Plate Reverb Test', layout, {
      convolvers,
    });

    const deserialized = deserializePatch(patch);
    const deserializedConvolver = deserialized.convolvers.get(nodeId);

    expect(deserializedConvolver).toBeDefined();
    expect(deserializedConvolver?.generator).toEqual({
      type: 'plate',
      decayTime: 3.0,
      size: 0.7,
      sampleRate: 48000,
    });
  });

  it('exports and imports patch JSON with all node types', () => {
    const baseNodes: Record<VoiceNodeType, VoiceNode[]> = {
      [VoiceNodeType.Oscillator]: [],
      [VoiceNodeType.WavetableOscillator]: [],
      [VoiceNodeType.Filter]: [],
      [VoiceNodeType.Envelope]: [],
      [VoiceNodeType.LFO]: [],
      [VoiceNodeType.Mixer]: [],
      [VoiceNodeType.Noise]: [],
      [VoiceNodeType.Sampler]: [],
      [VoiceNodeType.Glide]: [],
      [VoiceNodeType.GlobalFrequency]: [],
      [VoiceNodeType.GlobalVelocity]: [],
      [VoiceNodeType.Convolver]: [],
      [VoiceNodeType.Delay]: [],
      [VoiceNodeType.GateMixer]: [],
      [VoiceNodeType.ArpeggiatorGenerator]: [],
      [VoiceNodeType.Chorus]: [],
      [VoiceNodeType.Limiter]: [],
      [VoiceNodeType.Reverb]: [],
      [VoiceNodeType.Compressor]: [],
      [VoiceNodeType.Saturation]: [],
      [VoiceNodeType.Bitcrusher]: [],
    };

    const canonicalVoice: VoiceLayout = {
      id: 0,
      nodes: {
        ...baseNodes,
        [VoiceNodeType.Oscillator]: [{ id: 'osc-1', type: VoiceNodeType.Oscillator, name: 'Osc 1' }],
        [VoiceNodeType.WavetableOscillator]: [{ id: 'wt-1', type: VoiceNodeType.WavetableOscillator, name: 'WT 1' }],
        [VoiceNodeType.Filter]: [{ id: 'filter-1', type: VoiceNodeType.Filter, name: 'Filter 1' }],
        [VoiceNodeType.Envelope]: [{ id: 'env-1', type: VoiceNodeType.Envelope, name: 'Env 1' }],
        [VoiceNodeType.LFO]: [{ id: 'lfo-1', type: VoiceNodeType.LFO, name: 'LFO 1' }],
        [VoiceNodeType.Sampler]: [{ id: 'sampler-1', type: VoiceNodeType.Sampler, name: 'Sampler 1' }],
        [VoiceNodeType.Glide]: [{ id: 'glide-1', type: VoiceNodeType.Glide, name: 'Glide 1' }],
        [VoiceNodeType.Convolver]: [{ id: 'conv-1', type: VoiceNodeType.Convolver, name: 'Convolver 1' }],
        [VoiceNodeType.Delay]: [{ id: 'delay-1', type: VoiceNodeType.Delay, name: 'Delay 1' }],
        [VoiceNodeType.Chorus]: [{ id: 'chorus-1', type: VoiceNodeType.Chorus, name: 'Chorus 1' }],
        [VoiceNodeType.Reverb]: [{ id: 'reverb-1', type: VoiceNodeType.Reverb, name: 'Reverb 1' }],
        [VoiceNodeType.Compressor]: [{ id: 'comp-1', type: VoiceNodeType.Compressor, name: 'Compressor 1' }],
        [VoiceNodeType.Saturation]: [{ id: 'sat-1', type: VoiceNodeType.Saturation, name: 'Saturation 1' }],
        [VoiceNodeType.Bitcrusher]: [{ id: 'bit-1', type: VoiceNodeType.Bitcrusher, name: 'Bitcrusher 1' }],
        [VoiceNodeType.Mixer]: [{ id: 'mixer-1', type: VoiceNodeType.Mixer, name: 'Mixer' }],
      },
      connections: [],
    };

    const layout: SynthLayout = {
      voiceCount: 2,
      canonicalVoice,
      voices: Array.from({ length: 2 }, (_, i) => ({ ...canonicalVoice, id: i })),
      globalNodes: {},
    };

    const stateMaps = createFullStateMaps();
    const macros = {
      values: [0.1, 0.2, 0.3, 0.4],
      routes: [
        {
          macroIndex: 0,
          targetId: 'filter-1',
          targetPort: PortId.CutoffMod,
          amount: 0.5,
          modulationType: WasmModulationType.VCA,
          modulationTransformation: ModulationTransformation.None,
        },
      ],
    };

    const patch = serializeCurrentPatch({
      name: 'Full Export',
      layout,
      ...stateMaps,
      macros,
    });

    const json = exportPatchToJSON(patch);
    const result = importPatchFromJSON(json);

    expect(result.validation.valid).toBe(true);
    expect(result.patch).toBeDefined();

    const rehydrated = deserializePatch(result.patch!);
    expect(rehydrated.layout.voiceCount).toBe(2);
    expect(rehydrated.oscillators.has('osc-1')).toBe(true);
    expect(rehydrated.wavetableOscillators.has('wt-1')).toBe(true);
    expect(rehydrated.filters.has('filter-1')).toBe(true);
    expect(rehydrated.envelopes.has('env-1')).toBe(true);
    expect(rehydrated.lfos.has('lfo-1')).toBe(true);
    expect(rehydrated.samplers.has('sampler-1')).toBe(true);
    expect(rehydrated.glides.has('glide-1')).toBe(true);
    expect(rehydrated.convolvers.has('conv-1')).toBe(true);
    expect(rehydrated.delays.has('delay-1')).toBe(true);
    expect(rehydrated.choruses.has('chorus-1')).toBe(true);
    expect(rehydrated.reverbs.has('reverb-1')).toBe(true);
    expect(rehydrated.compressors.has('comp-1')).toBe(true);
    expect(rehydrated.saturations.has('sat-1')).toBe(true);
    expect(rehydrated.bitcrushers.has('bit-1')).toBe(true);
    expect(rehydrated.macros?.routes?.length).toBe(1);
  });
});
