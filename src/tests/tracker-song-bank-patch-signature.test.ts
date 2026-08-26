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
      revision: 0,
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
 * tracker doesn't sound the same" bug, and its follow-up fix.
 *
 * Originally: the instrument editor always re-minted a fresh metadata.id
 * and always bumped `modified` on save. Even after fixing identity
 * preservation, TrackerSongBank still decided reuse-vs-rebuild by hashing
 * `id:stateHash:assetHash` (a JSON.stringify of the whole synthState) --
 * which worked, but meant "did this patch change" was re-derived from a
 * content hash on every sync instead of being tracked explicitly.
 *
 * Now: TrackerSongBank.getPatchReuseKey is just `id:revision`.
 * `metadata.revision` is incremented exactly once, by patchStore, each time
 * a real edit is detected and saved (see patchStore.isDirty / IndexPage.vue
 * saveSongPatch) -- so comparing it is both cheaper and a more honest
 * change signal than hashing synthState: a key that no longer depends on
 * synthState content directly is intentional, not a regression, because by
 * construction any real edit must bump the revision to be saved at all.
 */
describe('TrackerSongBank patch reuse key', () => {
  function getReuseKey(bank: TrackerSongBank, patch: Patch): string | null {
    const fn = Reflect.get(bank as object, 'getPatchReuseKey') as (
      p: Patch,
    ) => string | null;
    return fn.call(bank, patch);
  }

  it('is stable across a re-save that only bumps `modified` with the same revision', () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );
    const original = makePatch();
    const resavedNoOp = makePatch({
      metadata: { ...original.metadata, modified: 999999 },
    });

    expect(getReuseKey(bank, resavedNoOp)).toBe(getReuseKey(bank, original));
  });

  it('is stable even if synthState content differs, as long as the revision is unchanged', () => {
    // Intentional: the reuse key no longer inspects synthState at all.
    // Content changes are only ever recognized via a bumped revision --
    // patchStore.isDirty/notifyPatchChanged is what's responsible for
    // ensuring a real edit always bumps it before a save can happen.
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );
    const original = makePatch();
    const differentContentSameRevision = makePatch({
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

    expect(getReuseKey(bank, differentContentSameRevision)).toBe(
      getReuseKey(bank, original),
    );
  });

  it('changes when the revision is bumped (a real, saved edit)', () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );
    const original = makePatch();
    const edited = makePatch({
      metadata: { ...original.metadata, revision: 1 },
    });

    expect(getReuseKey(bank, edited)).not.toBe(getReuseKey(bank, original));
  });

  it('changes when the patch identity (metadata.id) changes', () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );
    const original = makePatch();
    const rebornWithNewId = makePatch({
      metadata: { ...original.metadata, id: 'patch_2' },
    });

    expect(getReuseKey(bank, rebornWithNewId)).not.toBe(
      getReuseKey(bank, original),
    );
  });
});
