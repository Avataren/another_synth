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
} from '../src/audio/types/synth-layout';
import { VoiceNodeType } from '../src/audio/types/synth-layout';
import type { SerializeCurrentPatchOptions } from '../src/audio/serialization/patch-serializer';

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
});
