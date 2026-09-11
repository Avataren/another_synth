import { describe, it, expect, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';
import type { Patch } from 'src/audio/types/preset-types';

/**
 * syncSlots' play-start burst fix (microstutter investigation, "play-start
 * blocking burst"): instrument building runs in small idle-scheduled slices
 * instead of one flat batch-of-8 + fixed sleep, so the browser gets real
 * idle windows between groups of instruments instead of one uninterrupted
 * run of synchronous decode/mip-build work. syncSlots' external contract is
 * unchanged: it still only resolves once every desired instrument has
 * actually been ensured.
 */

// Mirrors deep-link-suspended-load.test.ts's minimal AudioContext/AudioSystem.
function createMockAudioSystem() {
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
}

function makeSlots(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    instrumentId: `inst-${i}`,
    patch: { metadata: { id: `patch-${i}` } } as unknown as Patch,
  }));
}

function spyOnEnsureInstrument(bank: TrackerSongBank) {
  return vi.spyOn(
    bank as unknown as {
      ensureInstrument: (id: string, patch: Patch) => Promise<void>;
    },
    'ensureInstrument',
  );
}

describe('TrackerSongBank.syncSlots: idle-scheduled instrument build slicing', () => {
  it('yields to requestIdleCallback between slices and still builds every instrument', async () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );
    const ensureInstrument = spyOnEnsureInstrument(bank).mockResolvedValue(
      undefined,
    );

    const idleCalls: { timeout?: number }[] = [];
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn(
        (
          cb: (d: { didTimeout: boolean; timeRemaining: () => number }) => void,
          opts?: { timeout: number },
        ) => {
          idleCalls.push(opts ?? {});
          cb({ didTimeout: false, timeRemaining: () => 0 });
          return idleCalls.length;
        },
      ),
    );

    const slots = makeSlots(5);
    await bank.syncSlots(slots);

    // 5 instruments at a slice of 2 makes three slices, so two yields
    // between them. On the old flat-batch-of-8 code this is 0: everything
    // fit in one batch and the only wait was a plain setTimeout.
    expect(idleCalls.length).toBeGreaterThanOrEqual(2);
    expect(ensureInstrument).toHaveBeenCalledTimes(5);
    for (const slot of slots) {
      expect(ensureInstrument).toHaveBeenCalledWith(
        slot.instrumentId,
        slot.patch,
      );
    }

    vi.unstubAllGlobals();
  });

  it('resolves only once every desired instrument has actually been ensured', async () => {
    const bank = new TrackerSongBank(
      createMockAudioSystem() as unknown as AudioSystem,
    );
    let resolveLastInstrument = (): void => {};
    const ensureInstrument = spyOnEnsureInstrument(bank).mockImplementation(
      (id: string) => {
        if (id === 'inst-4') {
          return new Promise<void>((resolve) => {
            resolveLastInstrument = () => resolve();
          });
        }
        return Promise.resolve();
      },
    );

    const slots = makeSlots(5);
    let settled = false;
    const syncPromise = bank.syncSlots(slots).then(() => {
      settled = true;
    });

    // Let every slice that doesn't depend on the last instrument run its
    // course (real timers: idleYield's non-rIC fallback is a macrotask).
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(settled).toBe(false);

    resolveLastInstrument();
    await syncPromise;
    expect(settled).toBe(true);
    expect(ensureInstrument).toHaveBeenCalledTimes(5);
  });
});
