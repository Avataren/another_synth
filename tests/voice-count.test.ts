import { describe, expect, it } from 'vitest';
import { resolvePatchVoiceCount } from '../src/audio/utils/voice-count';
import type { Patch, PatchMetadata } from '../src/audio/types/preset-types';
import type { VoiceNode, VoiceLayout } from '../src/audio/types/synth-layout';
import { VoiceNodeType } from '../src/audio/types/synth-layout';

const emptyNodes: Record<VoiceNodeType, VoiceNode[]> = {
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

function buildPatchWithVoiceCount(metadata: PatchMetadata, voiceCount: number): Patch {
  const canonicalVoice: VoiceLayout = {
    id: 0,
    nodes: { ...emptyNodes },
    connections: [],
  };
  return {
    metadata,
    synthState: {
      layout: {
        voiceCount,
        canonicalVoice,
      },
      oscillators: {},
      wavetableOscillators: {},
      filters: {},
      envelopes: {},
      lfos: {},
      samplers: {},
      glides: {},
      convolvers: {},
      delays: {},
      choruses: {},
      reverbs: {},
      compressors: {},
      saturations: {},
    bitcrushers: {},
    },
    audioAssets: {},
  };
}

describe('resolvePatchVoiceCount', () => {
  it('uses the patch voiceCount even when a previous layout might differ', () => {
    const patch = buildPatchWithVoiceCount(
      {
        id: 'patch-1',
        name: 'Test Patch',
        created: Date.now(),
        modified: Date.now(),
        version: 1,
      },
      8,
    );

    expect(resolvePatchVoiceCount(patch)).toBe(8);
  });

  it('clamps invalid or missing counts to at least 1', () => {
    const patch = buildPatchWithVoiceCount(
      {
        id: 'patch-2',
        name: 'Invalid Voice Count',
        created: Date.now(),
        modified: Date.now(),
        version: 1,
      },
      0,
    );

    expect(resolvePatchVoiceCount(patch)).toBe(1);
  });
});
