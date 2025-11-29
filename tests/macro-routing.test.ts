import { describe, expect, it } from 'vitest';
import { serializeCurrentPatch, deserializePatch } from '../src/audio/serialization/patch-serializer';
import { WasmModulationType, ModulationTransformation, PortId } from 'app/public/wasm/audio_processor';
import type {
  SynthLayout,
  VoiceLayout,
  FilterState,
  EnvelopeConfig,
  LfoState,
  SamplerState,
  ConvolverState,
  DelayState,
  ChorusState,
  ReverbState,
  CompressorState,
  SaturationState,
  BitcrusherState,
  GlideState,
  VelocityState,
  VoiceNode,
} from '../src/audio/types/synth-layout';
import type { MacroState, AudioAsset, PatchMetadata } from '../src/audio/types/preset-types';
import type { NoiseState } from '../src/audio/types/noise';
import type OscillatorState from '../src/audio/models/OscillatorState';
import { VoiceNodeType } from '../src/audio/types/synth-layout';

// Helper to create a test synth layout with some nodes to target
function createTestLayout(): SynthLayout {
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
      [VoiceNodeType.Oscillator]: [
        { id: 'osc-1', type: VoiceNodeType.Oscillator, name: 'Oscillator 1' },
        { id: 'osc-2', type: VoiceNodeType.Oscillator, name: 'Oscillator 2' },
      ],
      [VoiceNodeType.Filter]: [
        { id: 'filter-1', type: VoiceNodeType.Filter, name: 'Filter 1' },
      ],
      [VoiceNodeType.Envelope]: [
        { id: 'env-1', type: VoiceNodeType.Envelope, name: 'Envelope 1' },
      ],
      [VoiceNodeType.LFO]: [
        { id: 'lfo-1', type: VoiceNodeType.LFO, name: 'LFO 1' },
      ],
    },
    connections: [],
  };

  return {
    voiceCount: 4,
    canonicalVoice,
    voices: Array.from({ length: 4 }, (_, i) => ({
      ...canonicalVoice,
      id: i,
    })),
    globalNodes: {},
  };
}

// Helper to create macro state with routes
function createMacroState(routes: MacroState['routes']): MacroState {
  return {
    values: [0, 0, 0, 0, 0, 0, 0, 0], // 8 macros, all at 0
    routes,
  };
}

type StateOverrides = Partial<{
  oscillators: Map<string, OscillatorState>;
  wavetableOscillators: Map<string, OscillatorState>;
  filters: Map<string, FilterState>;
  envelopes: Map<string, EnvelopeConfig>;
  lfos: Map<string, LfoState>;
  samplers: Map<string, SamplerState>;
  glides: Map<string, GlideState>;
  convolvers: Map<string, ConvolverState>;
  delays: Map<string, DelayState>;
  choruses: Map<string, ChorusState>;
  reverbs: Map<string, ReverbState>;
  compressors: Map<string, CompressorState>;
  saturations: Map<string, SaturationState>;
  bitcrushers: Map<string, BitcrusherState>;
  noise: NoiseState | undefined;
  velocity: VelocityState | undefined;
  audioAssets: Map<string, AudioAsset> | undefined;
  metadata: Partial<PatchMetadata> | undefined;
  instrumentGain: number | undefined;
}>;

// Helper to call serializeCurrentPatch with sensible defaults so optional args stay aligned
function serializeTestPatch(
  name: string,
  layout: SynthLayout,
  macros?: MacroState,
  overrides: StateOverrides = {},
) {
  const {
    oscillators = new Map<string, OscillatorState>(),
    wavetableOscillators = new Map<string, OscillatorState>(),
    filters = new Map<string, FilterState>(),
    envelopes = new Map<string, EnvelopeConfig>(),
    lfos = new Map<string, LfoState>(),
    samplers = new Map<string, SamplerState>(),
    glides = new Map<string, GlideState>(),
    convolvers = new Map<string, ConvolverState>(),
    delays = new Map<string, DelayState>(),
    choruses = new Map<string, ChorusState>(),
    reverbs = new Map<string, ReverbState>(),
    compressors = new Map<string, CompressorState>(),
    saturations = new Map<string, SaturationState>(),
    bitcrushers = new Map<string, BitcrusherState>(),
    noise,
    velocity,
    audioAssets,
    metadata,
    instrumentGain,
  } = overrides;

  return serializeCurrentPatch({
    name,
    layout,
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
    noise,
    velocity,
    audioAssets,
    metadata,
    macros,
    instrumentGain,
  });
}

describe('macro routing persistence', () => {
  it('preserves macro routes through serialize/deserialize cycle', () => {
    const layout = createTestLayout();
    const macros = createMacroState([
      {
        macroIndex: 0,
        targetId: 'osc-1',
        targetPort: PortId.FrequencyMod,
        amount: 0.5,
        modulationType: WasmModulationType.Bipolar,
        modulationTransformation: ModulationTransformation.Square,
      },
      {
        macroIndex: 1,
        targetId: 'filter-1',
        targetPort: PortId.CutoffMod,
        amount: 0.75,
        modulationType: WasmModulationType.VCA,
        modulationTransformation: ModulationTransformation.Cube,
      },
    ]);

    const patch = serializeTestPatch('Macro Test', layout, macros);

    const deserialized = deserializePatch(patch);

    expect(deserialized.macros).toBeDefined();
    expect(deserialized.macros!.routes).toHaveLength(2);

    // First route
    const route1 = deserialized.macros!.routes[0]!;
    expect(route1.macroIndex).toBe(0);
    expect(route1.targetId).toBe('osc-1');
    expect(route1.targetPort).toBe(PortId.FrequencyMod);
    expect(route1.amount).toBe(0.5);
    expect(route1.modulationType).toBe(WasmModulationType.Bipolar);
    expect(route1.modulationTransformation).toBe(ModulationTransformation.Square);

    // Second route
    const route2 = deserialized.macros!.routes[1]!;
    expect(route2.macroIndex).toBe(1);
    expect(route2.targetId).toBe('filter-1');
    expect(route2.targetPort).toBe(PortId.CutoffMod);
    expect(route2.amount).toBe(0.75);
    expect(route2.modulationType).toBe(WasmModulationType.VCA);
    expect(route2.modulationTransformation).toBe(ModulationTransformation.Cube);
  });

  it('preserves macro values through serialize/deserialize cycle', () => {
    const layout = createTestLayout();
    const macros = createMacroState([]);
    macros.values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

    const patch = serializeTestPatch('Macro Values Test', layout, macros);

    const deserialized = deserializePatch(patch);

    expect(deserialized.macros).toBeDefined();
    expect(deserialized.macros!.values).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  });

  it('handles multiple routes for the same macro', () => {
    const layout = createTestLayout();
    const macros = createMacroState([
      {
        macroIndex: 0,
        targetId: 'osc-1',
        targetPort: PortId.FrequencyMod,
        amount: 0.3,
      },
      {
        macroIndex: 0,
        targetId: 'osc-2',
        targetPort: PortId.FrequencyMod,
        amount: 0.6,
      },
      {
        macroIndex: 0,
        targetId: 'filter-1',
        targetPort: PortId.CutoffMod,
        amount: 0.9,
      },
    ]);

    const patch = serializeTestPatch('Multi-Route Test', layout, macros);

    const deserialized = deserializePatch(patch);

    expect(deserialized.macros).toBeDefined();
    expect(deserialized.macros!.routes).toHaveLength(3);

    // All routes should be for macro 0
    deserialized.macros!.routes.forEach((route) => {
      expect(route.macroIndex).toBe(0);
    });

    // Check unique targets
    const targets = deserialized.macros!.routes.map((r) => r.targetId);
    expect(targets).toContain('osc-1');
    expect(targets).toContain('osc-2');
    expect(targets).toContain('filter-1');
  });

  it('handles empty routes array', () => {
    const layout = createTestLayout();
    const macros = createMacroState([]);

    const patch = serializeTestPatch('Empty Routes Test', layout, macros);

    const deserialized = deserializePatch(patch);

    expect(deserialized.macros).toBeDefined();
    expect(deserialized.macros!.routes).toEqual([]);
    expect(deserialized.macros!.values).toBeDefined();
  });

  it('handles patch without macros', () => {
    const layout = createTestLayout();

    const patch = serializeTestPatch('No Macros Test', layout);

    const deserialized = deserializePatch(patch);

    expect(deserialized.macros).toBeUndefined();
  });
});

describe('modulation amount preservation', () => {
  it('preserves different modulation amounts', () => {
    const layout = createTestLayout();
    const amounts = [0.0, 0.25, 0.5, 0.75, 1.0];

    amounts.forEach((amount) => {
      const macros = createMacroState([
        {
          macroIndex: 0,
          targetId: 'osc-1',
          targetPort: PortId.FrequencyMod,
          amount,
        },
      ]);

      const patch = serializeTestPatch(`Amount ${amount} Test`, layout, macros);

      const deserialized = deserializePatch(patch);

      expect(deserialized.macros).toBeDefined();
      expect(deserialized.macros!.routes[0]!.amount).toBe(amount);
    });
  });

  it('preserves negative modulation amounts', () => {
    const layout = createTestLayout();
    const macros = createMacroState([
      {
        macroIndex: 0,
        targetId: 'osc-1',
        targetPort: PortId.FrequencyMod,
        amount: -0.5,
      },
    ]);

    const patch = serializeTestPatch('Negative Amount Test', layout, macros);

    const deserialized = deserializePatch(patch);

    expect(deserialized.macros).toBeDefined();
    expect(deserialized.macros!.routes[0]!.amount).toBe(-0.5);
  });

  it('preserves very small modulation amounts', () => {
    const layout = createTestLayout();
    const macros = createMacroState([
      {
        macroIndex: 0,
        targetId: 'osc-1',
        targetPort: PortId.FrequencyMod,
        amount: 0.001,
      },
    ]);

    const patch = serializeTestPatch('Small Amount Test', layout, macros);

    const deserialized = deserializePatch(patch);

    expect(deserialized.macros).toBeDefined();
    expect(deserialized.macros!.routes[0]!.amount).toBe(0.001);
  });
});

describe('modulation type and transformation preservation', () => {
  it('preserves different modulation types', () => {
    const layout = createTestLayout();
    const types = [
      WasmModulationType.VCA,
      WasmModulationType.Bipolar,
      WasmModulationType.Additive,
    ];

    types.forEach((modulationType) => {
      const macros = createMacroState([
        {
          macroIndex: 0,
          targetId: 'osc-1',
          targetPort: PortId.FrequencyMod,
          amount: 0.5,
          modulationType,
        },
      ]);

      const patch = serializeTestPatch(`ModType ${modulationType} Test`, layout, macros);

      const deserialized = deserializePatch(patch);

      expect(deserialized.macros).toBeDefined();
      expect(deserialized.macros!.routes[0]!.modulationType).toBe(modulationType);
    });
  });

  it('preserves different modulation transformations', () => {
    const layout = createTestLayout();
    const transformations = [
      ModulationTransformation.None,
      ModulationTransformation.Invert,
      ModulationTransformation.Square,
      ModulationTransformation.Cube,
    ];

    transformations.forEach((modulationTransformation) => {
      const macros = createMacroState([
        {
          macroIndex: 0,
          targetId: 'osc-1',
          targetPort: PortId.FrequencyMod,
          amount: 0.5,
          modulationTransformation,
        },
      ]);

      const patch = serializeTestPatch(
        `ModTransform ${modulationTransformation} Test`,
        layout,
        macros,
      );

      const deserialized = deserializePatch(patch);

      expect(deserialized.macros).toBeDefined();
      expect(deserialized.macros!.routes[0]!.modulationTransformation).toBe(modulationTransformation);
    });
  });

  it('handles routes with default modulation type', () => {
    const layout = createTestLayout();
    const macros = createMacroState([
      {
        macroIndex: 0,
        targetId: 'osc-1',
        targetPort: PortId.FrequencyMod,
        amount: 0.5,
        // No modulationType specified
      },
    ]);

    const patch = serializeTestPatch('Default ModType Test', layout, macros);

    const deserialized = deserializePatch(patch);

    expect(deserialized.macros).toBeDefined();
    expect(deserialized.macros!.routes[0]).toBeDefined();
    // Should have a modulationType (either explicitly set or defaulted)
  });
});

describe('macro routing round-trip fidelity', () => {
  it('maintains route fidelity through multiple serialize/deserialize cycles', () => {
    const layout = createTestLayout();
    const originalMacros = createMacroState([
      {
        macroIndex: 0,
        targetId: 'osc-1',
        targetPort: PortId.FrequencyMod,
        amount: 0.33,
        modulationType: WasmModulationType.Bipolar,
        modulationTransformation: ModulationTransformation.Square,
      },
      {
        macroIndex: 2,
        targetId: 'filter-1',
        targetPort: PortId.ResonanceMod,
        amount: 0.66,
        modulationType: WasmModulationType.VCA,
        modulationTransformation: ModulationTransformation.None,
      },
    ]);
    originalMacros.values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];

    // First cycle
    const patch1 = serializeTestPatch('Round Trip Test', layout, originalMacros);

    const deserialized1 = deserializePatch(patch1);

    // Second cycle
    const patch2 = serializeTestPatch('Round Trip Test', deserialized1.layout, deserialized1.macros, {
      oscillators: deserialized1.oscillators,
      wavetableOscillators: deserialized1.wavetableOscillators,
      filters: deserialized1.filters,
      envelopes: deserialized1.envelopes,
      lfos: deserialized1.lfos,
      samplers: deserialized1.samplers,
      glides: deserialized1.glides,
      convolvers: deserialized1.convolvers,
      delays: deserialized1.delays,
      choruses: deserialized1.choruses,
      reverbs: deserialized1.reverbs,
      compressors: deserialized1.compressors,
      saturations: deserialized1.saturations,
      bitcrushers: deserialized1.bitcrushers,
    });

    const deserialized2 = deserializePatch(patch2);

    // Both cycles should have identical macro state
    expect(deserialized2.macros).toBeDefined();
    expect(deserialized2.macros!.values).toEqual(originalMacros.values);
    expect(deserialized2.macros!.routes).toHaveLength(2);

    // Verify first route
    expect(deserialized2.macros!.routes[0]!.macroIndex).toBe(0);
    expect(deserialized2.macros!.routes[0]!.amount).toBe(0.33);
    expect(deserialized2.macros!.routes[0]!.modulationType).toBe(WasmModulationType.Bipolar);

    // Verify second route
    expect(deserialized2.macros!.routes[1]!.macroIndex).toBe(2);
    expect(deserialized2.macros!.routes[1]!.amount).toBe(0.66);
    expect(deserialized2.macros!.routes[1]!.modulationType).toBe(WasmModulationType.VCA);
  });

  it('handles complex routing scenarios', () => {
    const layout = createTestLayout();
    const macros = createMacroState([
      // Macro 0 -> multiple targets
      { macroIndex: 0, targetId: 'osc-1', targetPort: PortId.FrequencyMod, amount: 0.2 },
      { macroIndex: 0, targetId: 'osc-2', targetPort: PortId.FrequencyMod, amount: 0.3 },
      { macroIndex: 0, targetId: 'filter-1', targetPort: PortId.CutoffMod, amount: 0.4 },
      // Macro 1 -> single target, multiple ports
      { macroIndex: 1, targetId: 'osc-1', targetPort: PortId.PhaseMod, amount: 0.5 },
      { macroIndex: 1, targetId: 'osc-1', targetPort: PortId.GainMod, amount: 0.6 },
      // Macro 2 -> different target
      { macroIndex: 2, targetId: 'lfo-1', targetPort: PortId.FrequencyMod, amount: 0.7 },
    ]);

    const patch = serializeTestPatch('Complex Routing Test', layout, macros);

    const deserialized = deserializePatch(patch);

    expect(deserialized.macros).toBeDefined();
    expect(deserialized.macros!.routes).toHaveLength(6);

    // Verify macro 0 has 3 routes
    const macro0Routes = deserialized.macros!.routes.filter((r) => r.macroIndex === 0);
    expect(macro0Routes).toHaveLength(3);

    // Verify macro 1 has 2 routes
    const macro1Routes = deserialized.macros!.routes.filter((r) => r.macroIndex === 1);
    expect(macro1Routes).toHaveLength(2);

    // Verify macro 2 has 1 route
    const macro2Routes = deserialized.macros!.routes.filter((r) => r.macroIndex === 2);
    expect(macro2Routes).toHaveLength(1);

    // Verify all amounts are preserved
    expect(deserialized.macros!.routes.map((r) => r.amount)).toEqual([0.2, 0.3, 0.4, 0.5, 0.6, 0.7]);
  });
});
