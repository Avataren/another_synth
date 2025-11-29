import { describe, expect, it, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTrackerStore } from '../src/stores/tracker-store';
import type { Patch } from '../src/audio/types/preset-types';
import { createDefaultPatchMetadata } from '../src/audio/types/preset-types';
import { VoiceNodeType } from '../src/audio/types/synth-layout';
import type { VoiceNode } from '../src/audio/types/synth-layout';

// Helper to create a test patch with specific voice count
function createTestPatch(name: string, voiceCount: number): Patch {
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
  return {
    metadata: createDefaultPatchMetadata(name),
    synthState: {
      layout: {
        voiceCount,
        canonicalVoice: {
          id: 0,
          nodes: {
            ...baseNodes,
          },
          connections: [],
        },
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
    },
    audioAssets: {},
  };
}

describe('tracker patch assignment', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('preserves voice count when assigning patch to slot', () => {
    const store = useTrackerStore();
    const voiceCounts = [1, 2, 4, 8];

    voiceCounts.forEach(voiceCount => {
      const patch = createTestPatch(`${voiceCount}-Voice Patch`, voiceCount);

      // Assign patch to slot 1 (slots are 1-indexed)
      store.assignPatchToSlot(1, patch, 'Test Bank');

      // Verify patch was stored
      const storedPatch = store.songPatches[patch.metadata.id];
      expect(storedPatch).toBeDefined();
      expect(storedPatch!.synthState.layout.voiceCount).toBe(voiceCount);
    });
  });

  it('deep copies patch when assigning to slot', () => {
    const store = useTrackerStore();
    const originalPatch = createTestPatch('Original', 4);
    const originalVoiceCount = originalPatch.synthState.layout.voiceCount;

    store.assignPatchToSlot(1, originalPatch, 'Test Bank');

    // Modify original patch
    originalPatch.synthState.layout.voiceCount = 1;
    originalPatch.metadata.name = 'Modified';

    // Verify stored patch is unchanged
    const storedPatch = store.songPatches[originalPatch.metadata.id];
    expect(storedPatch).toBeDefined();
    expect(storedPatch!.synthState.layout.voiceCount).toBe(originalVoiceCount);
    expect(storedPatch!.metadata.name).toBe('Original');
  });

  it('updates slot metadata when assigning patch', () => {
    const store = useTrackerStore();
    const patch = createTestPatch('Test Patch', 4);

    store.assignPatchToSlot(1, patch, 'System Bank');

    const slot = store.instrumentSlots.find(s => s.slot === 1);
    expect(slot).toBeDefined();
    expect(slot!.patchId).toBe(patch.metadata.id);
    expect(slot!.patchName).toBe('Test Patch');
    expect(slot!.bankName).toBe('System Bank');
    expect(slot!.source).toBe('song');
  });

  it('removes orphaned patches when reassigning slot', () => {
    const store = useTrackerStore();
    const patch1 = createTestPatch('Patch 1', 2);
    const patch2 = createTestPatch('Patch 2', 4);

    // Assign first patch
    store.assignPatchToSlot(1, patch1, 'Bank A');
    expect(store.songPatches[patch1.metadata.id]).toBeDefined();

    // Assign second patch to same slot (orphaning patch1)
    store.assignPatchToSlot(1, patch2, 'Bank B');

    // First patch should be removed (orphaned) - but the code checks AFTER assignment
    // So we need to check the final state
    const patch1StillExists = store.songPatches[patch1.metadata.id];
    const patch2Exists = store.songPatches[patch2.metadata.id];

    // Patch1 should be gone (orphaned), Patch2 should exist
    expect(patch1StillExists).toBeUndefined();
    expect(patch2Exists).toBeDefined();
  });

  it('keeps shared patches when one slot changes', () => {
    const store = useTrackerStore();
    const sharedPatch = createTestPatch('Shared', 4);
    const newPatch = createTestPatch('New', 2);

    // Assign same patch to two slots
    store.assignPatchToSlot(1, sharedPatch, 'Bank');
    store.assignPatchToSlot(2, sharedPatch, 'Bank');
    expect(store.songPatches[sharedPatch.metadata.id]).toBeDefined();

    // Change slot 1 to a different patch
    store.assignPatchToSlot(1, newPatch, 'Bank');

    // Shared patch should still exist (slot 1 still uses it)
    expect(store.songPatches[sharedPatch.metadata.id]).toBeDefined();
    expect(store.songPatches[newPatch.metadata.id]).toBeDefined();
  });
});

describe('tracker instrument slot management', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('clears slot and removes orphaned patch', () => {
    const store = useTrackerStore();
    const patch = createTestPatch('Test', 4);

    store.assignPatchToSlot(1, patch, 'Bank');
    expect(store.songPatches[patch.metadata.id]).toBeDefined();

    store.clearSlot(1);

    const slot = store.instrumentSlots.find(s => s.slot === 1);
    expect(slot!.patchId).toBeUndefined();
    expect(store.songPatches[patch.metadata.id]).toBeUndefined();
  });

  it('sets custom instrument name', () => {
    const store = useTrackerStore();
    const patch = createTestPatch('Original Name', 4);

    store.assignPatchToSlot(1, patch, 'Bank');
    store.setInstrumentName(1, 'Custom Name');

    const slot = store.instrumentSlots.find(s => s.slot === 1);
    expect(slot!.instrumentName).toBe('Custom Name');
    expect(slot!.patchName).toBe('Original Name'); // Patch name unchanged
  });

  it('updates patch in song patches', () => {
    const store = useTrackerStore();
    const originalPatch = createTestPatch('Original', 4);

    store.assignPatchToSlot(1, originalPatch, 'Bank');

    // Start editing the slot (required for updateEditingPatch)
    store.startEditingSlot(1);

    // Create updated version
    const updatedPatch = {
      ...originalPatch,
      synthState: {
        ...originalPatch.synthState,
        layout: {
          ...originalPatch.synthState.layout,
          voiceCount: 8, // Changed voice count
        },
      },
    };

    store.updateEditingPatch(updatedPatch);

    // Verify patch was updated
    const storedPatch = store.songPatches[originalPatch.metadata.id];
    expect(storedPatch).toBeDefined();
    expect(storedPatch!.synthState.layout.voiceCount).toBe(8);
  });
});

describe('tracker history and undo', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('can undo patch assignment', () => {
    const store = useTrackerStore();
    const patch = createTestPatch('Test', 4);

    // Initial state
    const initialSlotState = store.instrumentSlots.find(s => s.slot === 1)!.patchId;

    // Make change
    store.pushHistory();
    store.assignPatchToSlot(1, patch, 'Bank');
    expect(store.instrumentSlots.find(s => s.slot === 1)!.patchId).toBe(patch.metadata.id);

    // Undo
    store.undo();
    expect(store.instrumentSlots.find(s => s.slot === 1)!.patchId).toBe(initialSlotState);
  });

  it('can redo patch assignment', () => {
    const store = useTrackerStore();
    const patch = createTestPatch('Test', 4);

    // Save initial state
    store.pushHistory();

    // Make change
    store.assignPatchToSlot(1, patch, 'Bank');
    expect(store.instrumentSlots.find(s => s.slot === 1)!.patchId).toBe(patch.metadata.id);

    // Undo the change
    store.undo();
    expect(store.instrumentSlots.find(s => s.slot === 1)!.patchId).toBeUndefined();

    // Redo the change
    store.redo();
    expect(store.instrumentSlots.find(s => s.slot === 1)!.patchId).toBe(patch.metadata.id);
  });
});

describe('tracker slot initialization', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('creates instrument slots on initialization', () => {
    const store = useTrackerStore();

    // Should have 25 default slots
    expect(store.instrumentSlots.length).toBe(25);

    // Slots are numbered 1-25, not 0-24
    expect(store.instrumentSlots[0]).toBeDefined();
    expect(store.instrumentSlots[24]).toBeDefined();
    expect(store.instrumentSlots[0]!.slot).toBe(1);
    expect(store.instrumentSlots[24]!.slot).toBe(25);

    // Each slot should have correct structure
    store.instrumentSlots.forEach((slot) => {
      expect(slot.bankName).toBe('');
      expect(slot.patchName).toBe('');
      expect(slot.patchId).toBeUndefined();
    });
  });

  it('preserves slot numbers through operations', () => {
    const store = useTrackerStore();
    const patch1 = createTestPatch('Patch 1', 2);
    const patch2 = createTestPatch('Patch 2', 4);

    store.assignPatchToSlot(1, patch1, 'Bank');
    store.assignPatchToSlot(3, patch2, 'Bank');

    // Verify slot numbers are preserved
    expect(store.instrumentSlots.find(s => s.slot === 1)!.patchId).toBe(patch1.metadata.id);
    expect(store.instrumentSlots.find(s => s.slot === 2)!.patchId).toBeUndefined();
    expect(store.instrumentSlots.find(s => s.slot === 3)!.patchId).toBe(patch2.metadata.id);
  });
});
