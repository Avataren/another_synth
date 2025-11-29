import { describe, expect, it } from 'vitest';
import { deserializePatch, serializeCurrentPatch } from '../src/audio/serialization/patch-serializer';
import { synthLayoutToPatchLayout, patchLayoutToSynthLayout } from '../src/audio/types/synth-layout';
import type { Patch } from '../src/audio/types/preset-types';
import type { SynthLayout, VoiceLayout, VoiceNode } from '../src/audio/types/synth-layout';
import { VoiceNodeType } from '../src/audio/types/synth-layout';

const createEmptyNodes = (): Record<VoiceNodeType, VoiceNode[]> => ({
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
});

// Helper to create a test patch with specific configuration
function createTestPatch(
  name: string,
  voiceCount: number,
  options?: {
    hasConvolver?: boolean;
    convolverHasGenerator?: boolean;
  }
): Patch {
  const canonicalVoice: VoiceLayout = {
    id: 0,
    nodes: {
      ...createEmptyNodes(),
      [VoiceNodeType.Convolver]: options?.hasConvolver ? [{
        id: 'conv-1',
        type: VoiceNodeType.Convolver,
        name: 'Test Convolver',
      }] : [],
    },
    connections: [],
  };

  const layout: SynthLayout = {
    voiceCount,
    canonicalVoice,
    voices: Array.from({ length: voiceCount }, (_, i) => ({
      ...canonicalVoice,
      id: i,
    })),
    globalNodes: {},
  };

  const convolvers = options?.hasConvolver && options?.convolverHasGenerator
    ? new Map([['conv-1', {
        id: 'conv-1',
        wetMix: 0.5,
        active: true,
        generator: {
          type: 'hall' as const,
          decayTime: 2.0,
          size: 0.8,
          sampleRate: 48000,
        },
      }]])
    : options?.hasConvolver
      ? new Map([['conv-1', {
          id: 'conv-1',
          wetMix: 0.5,
          active: true,
        }]])
      : new Map();

  return serializeCurrentPatch({
    name,
    layout,
    oscillators: new Map(), // oscillators
    wavetableOscillators: new Map(), // wavetableOscillators
    filters: new Map(), // filters
    envelopes: new Map(), // envelopes
    lfos: new Map(), // lfos
    samplers: new Map(), // samplers
    glides: new Map(), // glides
    convolvers,
    delays: new Map(), // delays
    choruses: new Map(), // choruses
    reverbs: new Map(), // reverbs
    compressors: new Map(), // compressors
    saturations: new Map(), // saturations
    bitcrushers: new Map(), // bitcrushers
  });
}

describe('song bank patch normalization', () => {
  it('preserves voice count through deserialize + normalize cycle', () => {
    const voiceCounts = [1, 2, 4, 8];

    voiceCounts.forEach(voiceCount => {
      const patch = createTestPatch(`${voiceCount}-Voice Test`, voiceCount);

      // This is what song-bank does: deserialize, then convert to patch layout
      const deserialized = deserializePatch(patch);
      expect(deserialized.layout.voiceCount).toBe(voiceCount);

      // Normalize layout (synthLayoutToPatchLayout)
      const normalized = synthLayoutToPatchLayout(deserialized.layout);
      expect(normalized.voiceCount).toBe(voiceCount);

      // Convert back to synth layout (what the worklet receives)
      const reconstructed = patchLayoutToSynthLayout(normalized);
      expect(reconstructed.voiceCount).toBe(voiceCount);
      expect(reconstructed.voices.length).toBe(voiceCount);
    });
  });

  it('preserves voice count when voices array is empty', () => {
    const patch = createTestPatch('Test', 4);

    // Simulate what happens when patch has voiceCount but empty voices array
    const modifiedPatch = {
      ...patch,
      synthState: {
        ...patch.synthState,
        layout: {
          ...patch.synthState.layout,
          voices: [], // Empty voices array
          voiceCount: 4, // But voiceCount is set
        },
      },
    };

    const deserialized = deserializePatch(modifiedPatch);

    // Should use voiceCount, not voices.length
    expect(deserialized.layout.voiceCount).toBe(4);
    expect(deserialized.layout.voices.length).toBe(4);
  });

  it('generates voices from canonical voice when missing', () => {
    const patch = createTestPatch('Test', 1);

    // Start with 1 voice
    expect(patch.synthState.layout.voiceCount).toBe(1);

    // Change to 8 voices
    const updatedPatch = {
      ...patch,
      synthState: {
        ...patch.synthState,
        layout: {
          ...patch.synthState.layout,
          voiceCount: 8,
        },
      },
    };

    const deserialized = deserializePatch(updatedPatch);

    // Should generate 8 voices from canonical
    expect(deserialized.layout.voiceCount).toBe(8);
    expect(deserialized.layout.voices.length).toBe(8);

    // All voices should be identical (cloned from canonical)
    deserialized.layout.voices.forEach((voice, index) => {
      expect(voice.id).toBe(index);
      expect(voice.nodes).toBeDefined();
    });
  });

  it('preserves canonical voice structure', () => {
    const patch = createTestPatch('Test', 4);

    const deserialized = deserializePatch(patch);

    // Canonical voice should exist
    expect(deserialized.layout.canonicalVoice).toBeDefined();
    expect(deserialized.layout.canonicalVoice!.nodes).toBeDefined();

    // All node arrays should be present
    const canonical = deserialized.layout.canonicalVoice!;
    expect(canonical.nodes.oscillator).toEqual([]);
    expect(canonical.nodes.filter).toEqual([]);
    expect(canonical.nodes.envelope).toEqual([]);
    expect(canonical.nodes.lfo).toEqual([]);
  });

  it('handles patches with different voice counts correctly', () => {
    // Create patch with 2 voices
    const patch2Voice = createTestPatch('2-Voice', 2);
    const deserialized2 = deserializePatch(patch2Voice);
    expect(deserialized2.layout.voices.length).toBe(2);

    // Create patch with 8 voices
    const patch8Voice = createTestPatch('8-Voice', 8);
    const deserialized8 = deserializePatch(patch8Voice);
    expect(deserialized8.layout.voices.length).toBe(8);

    // Voice count should match the patch setting
    expect(deserialized2.layout.voiceCount).toBe(2);
    expect(deserialized8.layout.voiceCount).toBe(8);
  });
});

describe('patch metadata normalization', () => {
  it('deserializes metadata without adding defaults', () => {
    const patch = createTestPatch('Test', 4);

    // Remove some metadata fields
    const incompleteMetadata = {
      id: patch.metadata.id,
      name: patch.metadata.name,
      // Missing: created, modified, version
    };

    const incompletePatch = {
      ...patch,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: incompleteMetadata as any,
    };

    const deserialized = deserializePatch(incompletePatch);

    // deserializePatch just passes through metadata as-is
    expect(deserialized.metadata.id).toBeDefined();
    expect(deserialized.metadata.name).toBeDefined();
    // These are undefined because deserializePatch doesn't fill defaults
    // (That's done by song-bank's normalizePatchMetadata)
    expect(deserialized.metadata.created).toBeUndefined();
  });

  it('preserves existing metadata', () => {
    const patch = createTestPatch('Original Name', 4);

    const customMeta = {
      ...patch.metadata,
      name: 'Custom Name',
      author: 'Test Author',
      category: 'Test Category',
      tags: ['tag1', 'tag2'],
      description: 'Test description',
    };

    const customPatch = {
      ...patch,
      metadata: customMeta,
    };

    const deserialized = deserializePatch(customPatch);

    expect(deserialized.metadata.name).toBe('Custom Name');
    expect(deserialized.metadata.author).toBe('Test Author');
    expect(deserialized.metadata.category).toBe('Test Category');
    expect(deserialized.metadata.tags).toEqual(['tag1', 'tag2']);
    expect(deserialized.metadata.description).toBe('Test description');
  });
});

describe('convolver state normalization', () => {
  it('preserves convolver generator parameters', () => {
    const patch = createTestPatch('Hall Reverb', 1, {
      hasConvolver: true,
      convolverHasGenerator: true,
    });

    const deserialized = deserializePatch(patch);
    const convolver = deserialized.convolvers.get('conv-1');

    expect(convolver).toBeDefined();
    expect(convolver!.generator).toBeDefined();
    expect(convolver!.generator!.type).toBe('hall');
    expect(convolver!.generator!.decayTime).toBe(2.0);
    expect(convolver!.generator!.size).toBe(0.8);
    expect(convolver!.generator!.sampleRate).toBe(48000);
  });

  it('handles convolver without generator', () => {
    const patch = createTestPatch('Custom Impulse', 1, {
      hasConvolver: true,
      convolverHasGenerator: false,
    });

    const deserialized = deserializePatch(patch);
    const convolver = deserialized.convolvers.get('conv-1');

    expect(convolver).toBeDefined();
    expect(convolver!.generator).toBeUndefined();
    expect(convolver!.wetMix).toBe(0.5);
    expect(convolver!.active).toBe(true);
  });
});

describe('round-trip normalization fidelity', () => {
  it('maintains patch fidelity through multiple serialize/deserialize cycles', () => {
    const original = createTestPatch('Round Trip Test', 4);

    // First cycle
    const deserialized1 = deserializePatch(original);
    const reserialized1 = serializeCurrentPatch({
      name: deserialized1.metadata.name,
      layout: deserialized1.layout,
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

    // Second cycle
    const deserialized2 = deserializePatch(reserialized1);

    // Voice count should be stable
    expect(deserialized1.layout.voiceCount).toBe(4);
    expect(deserialized2.layout.voiceCount).toBe(4);

    // Metadata should be stable
    expect(deserialized2.metadata.name).toBe('Round Trip Test');
  });

  it('handles edge case voice counts correctly', () => {
    const edgeCases = [1, 2, 4, 8]; // Common voice counts

    edgeCases.forEach(count => {
      const patch = createTestPatch(`${count}V`, count);
      const deserialized = deserializePatch(patch);

      // Should maintain exact voice count
      expect(deserialized.layout.voiceCount).toBe(count);
      expect(deserialized.layout.voices.length).toBe(count);

      // Each voice should have correct ID
      deserialized.layout.voices.forEach((voice, i) => {
        expect(voice.id).toBe(i);
      });
    });
  });
});

describe('patch layout transformation', () => {
  it('converts SynthLayout to PatchLayout correctly', () => {
    const canonicalVoice: VoiceLayout = {
      id: 0,
      nodes: {
        ...createEmptyNodes(),
      },
      connections: [],
    };

    const synthLayout: SynthLayout = {
      voiceCount: 4,
      canonicalVoice,
      voices: Array.from({ length: 4 }, (_, i) => ({
        ...canonicalVoice,
        id: i,
      })),
      globalNodes: {},
    };

    const patchLayout = synthLayoutToPatchLayout(synthLayout);

    // Should have voiceCount and canonicalVoice, but NOT voices array
    expect(patchLayout.voiceCount).toBe(4);
    expect(patchLayout.canonicalVoice).toBeDefined();
    expect(patchLayout.voices).toBeUndefined(); // Compact format
  });

  it('converts PatchLayout back to SynthLayout with voices', () => {
    const canonicalVoice: VoiceLayout = {
      id: 0,
      nodes: {
        ...createEmptyNodes(),
      },
      connections: [],
    };

    const patchLayout = {
      voiceCount: 4,
      canonicalVoice,
      globalNodes: {},
    };

    const synthLayout = patchLayoutToSynthLayout(patchLayout);

    // Should regenerate voices array
    expect(synthLayout.voiceCount).toBe(4);
    expect(synthLayout.voices).toBeDefined();
    expect(synthLayout.voices.length).toBe(4);

    // Each voice should be a clone of canonical
    synthLayout.voices.forEach((voice, i) => {
      expect(voice.id).toBe(i);
      expect(voice.nodes).toBeDefined();
    });
  });
});
