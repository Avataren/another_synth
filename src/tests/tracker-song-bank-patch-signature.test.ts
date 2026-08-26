import { describe, it, expect, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';
import type { Patch } from 'src/audio/types/preset-types';

// Minimal AudioContext/AudioSystem mocks to satisfy constructor requirements.
const createMockAudioSystem = () => {
  const gainNode = {
    gain: { value: 1 },
    connect: vi.fn(),
    numberOfOutputs: 1,
  };
  const audioContext = {
    sampleRate: 48000,
    currentTime: 0,
    state: 'running' as const,
    createGain: () => ({ ...gainNode }),
    destination: gainNode,
    onstatechange: null as unknown,
  };

  return {
    audioContext,
    destinationNode: { connect: vi.fn(), numberOfOutputs: 1 },
  };
};

function makePatch(overrides: Partial<Patch> = {}): Patch {
  return {
    metadata: {
      id: 'patch_1',
      name: 'Test Patch',
      created: 1000,
      modified: 1000,
      version: 1,
    },
    synthState: {
      layout: {
        voiceCount: 1,
        canonicalVoice: { id: 0, nodes: {}, connections: [] },
        voices: [{ id: 0, nodes: {}, connections: [] }],
        globalNodes: {},
      },
      oscillators: {
        'osc-1': { id: 'osc-1', gain: 0.5 } as unknown as Patch['synthState']['oscillators'][string],
      },
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
    ...overrides,
  } as Patch;
}

/**
 * Regression coverage for the "editing a song patch and returning to the
 * tracker doesn't sound the same" bug.
 *
 * Root cause: the instrument editor always re-minted a fresh metadata.id
 * and always bumped `modified` on save (see IndexPage.vue saveSongPatch /
 * patch-store.ts serializePatch), and TrackerSongBank decided whether to
 * reuse the live-edited instrument or rebuild it from scratch by hashing
 * `id:modified:stateHash:assetHash`. That meant *every* return trip through
 * the editor -- even one where nothing was actually changed -- looked like
 * a content change, so the song bank tore down the live instrument (losing
 * its envelope/oscillator/LFO/etc. phase) and rebuilt a fresh one from the
 * serialized patch.
 *
 * The fix: `computePatchSignature` is content-based only (id + hash of
 * synthState/audioAssets), so a no-op save reuses the exact live instrument,
 * while a genuine edit (which changes the hashed content) still correctly
 * triggers a rebuild.
 */
describe('TrackerSongBank patch signature', () => {
  function getSignature(bank: TrackerSongBank, patch: Patch): string | null {
    const fn = Reflect.get(bank as object, 'computePatchSignature') as (
      p: Patch,
    ) => string | null;
    return fn.call(bank, patch);
  }

  it('is stable across a re-save that only bumps `modified` with unchanged content', () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );
    const original = makePatch();
    const resavedNoOp = makePatch({
      metadata: { ...original.metadata, modified: 999999 },
    });

    expect(getSignature(bank, resavedNoOp)).toBe(getSignature(bank, original));
  });

  it('changes when the actual synth state changes', () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );
    const original = makePatch();
    const edited = makePatch({
      synthState: {
        ...original.synthState,
        oscillators: {
          'osc-1': {
            id: 'osc-1',
            gain: 0.9,
          } as unknown as Patch['synthState']['oscillators'][string],
        },
      },
    });

    expect(getSignature(bank, edited)).not.toBe(getSignature(bank, original));
  });

  it('changes when the patch identity (metadata.id) changes', () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );
    const original = makePatch();
    const rebornWithNewId = makePatch({
      metadata: { ...original.metadata, id: 'patch_2' },
    });

    expect(getSignature(bank, rebornWithNewId)).not.toBe(
      getSignature(bank, original),
    );
  });
});
