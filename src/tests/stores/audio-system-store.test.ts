import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('app/public/wasm/audio_processor', () => ({
  ModulationTransformation: {
    None: 0,
    Invert: 1,
    Square: 2,
    Cube: 3,
  },
  WasmModulationType: {
    VCA: 'VCA',
    Bipolar: 'Bipolar',
    Additive: 'Additive',
  },
  PortId: {
    AudioInput0: 0,
    AudioInput1: 1,
    AudioOutput0: 4,
    AudioOutput1: 5,
    GainMod: 17,
    CombinedGate: 26,
  },
}));
import { createPinia, setActivePinia } from 'pinia';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import {
  type VoiceNode,
  type VoiceLayout,
  type SynthLayout,
  VoiceNodeType,
} from 'src/audio/types/synth-layout';

const createEmptyVoiceNodes = (): Record<VoiceNodeType, VoiceNode[]> => {
  return Object.values(VoiceNodeType).reduce(
    (acc, type) => {
      acc[type as VoiceNodeType] = [];
      return acc;
    },
    {} as Record<VoiceNodeType, VoiceNode[]>,
  );
};

const createVoiceLayout = (
  id: number,
  oscillatorIds: string[],
): VoiceLayout => {
  const nodes = createEmptyVoiceNodes();
  oscillatorIds.forEach((oscId) => {
    nodes[VoiceNodeType.Oscillator].push({
      id: oscId,
      type: VoiceNodeType.Oscillator,
      name: `Osc ${oscId}`,
    });
  });

  return {
    id,
    nodes,
    connections: [],
  };
};

const cloneLayout = (layout: SynthLayout): SynthLayout =>
  JSON.parse(JSON.stringify(layout));

describe('audio-system-store layout syncing', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('preserves voice count after syncing a canonical-only layout (node deletion scenario)', () => {
    const store = useAudioSystemStore();
    const voiceCount = 4;
    (store as unknown as { currentInstrument: { num_voices: number } | null }).currentInstrument =
      { num_voices: voiceCount };
    const initialLayout: SynthLayout = {
      voices: Array.from({ length: voiceCount }, (_, index) =>
        createVoiceLayout(index, ['osc-keep', 'osc-remove']),
      ),
      canonicalVoice: createVoiceLayout(0, ['osc-keep', 'osc-remove']),
      globalNodes: {},
      voiceCount,
    };

    store.synthLayout = cloneLayout(initialLayout);

    const wasmLayout: SynthLayout = {
      voices: [createVoiceLayout(0, ['osc-keep'])],
      globalNodes: {},
    };

    store.updateSynthLayout(wasmLayout);

    const updated = store.synthLayout;
    expect(updated).toBeTruthy();
    expect(updated?.voiceCount).toBe(voiceCount);
    expect(updated?.voices).toHaveLength(voiceCount);
    expect(updated?.canonicalVoice?.nodes[VoiceNodeType.Oscillator].map((n) => n.id)).toEqual([
      'osc-keep',
    ]);

    updated!.voices.forEach((voice, index) => {
      expect(voice.id).toBe(index);
      const oscIds = voice.nodes[VoiceNodeType.Oscillator].map((n) => n.id);
      expect(oscIds).toEqual(['osc-keep']);
    });
  });
});
