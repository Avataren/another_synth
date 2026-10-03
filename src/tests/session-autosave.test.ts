import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import {
  createSessionAutosaver,
  type SessionRecord,
  type SessionStorage,
} from 'src/audio/tracker/session-autosave';
import { resetSessionRestoreOffered, snapshotSession, useSessionAutosave } from 'src/composables/useSessionAutosave';
import { useTrackerStore } from 'src/stores/tracker-store';

function memoryStorage(initial: SessionRecord | null = null) {
  let record = initial;
  const storage: SessionStorage & { puts: SessionRecord[] } = {
    puts: [],
    put: async (r) => {
      record = r;
      storage.puts.push(r);
    },
    get: async () => record,
    clear: async () => {
      record = null;
    },
  };
  return storage;
}

const record = (title = 'x'): SessionRecord => ({ savedAt: 1, title, format: 'sid', json: '{}' });

beforeEach(() => {
  vi.useFakeTimers();
  setActivePinia(createPinia());
  resetSessionRestoreOffered();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createSessionAutosaver timing', () => {
  it('writes once, after the quiet time, however many edits came', async () => {
    const storage = memoryStorage();
    const saver = createSessionAutosaver({ storage, snapshot: () => record(), delayMs: 1000, maxWaitMs: 5000 });
    saver.markDirty();
    await vi.advanceTimersByTimeAsync(600);
    saver.markDirty();
    await vi.advanceTimersByTimeAsync(600);
    expect(storage.puts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(storage.puts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(storage.puts).toHaveLength(1);
  });

  it('a song edited without pause still gets written at the maximum wait', async () => {
    const storage = memoryStorage();
    const saver = createSessionAutosaver({ storage, snapshot: () => record(), delayMs: 1000, maxWaitMs: 4000 });
    for (let t = 0; t < 4200; t += 500) {
      saver.markDirty();
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(storage.puts.length).toBeGreaterThanOrEqual(1);
  });

  it('flush writes at once and only when something changed; a null snapshot writes nothing', async () => {
    const storage = memoryStorage();
    let next: SessionRecord | null = record();
    const saver = createSessionAutosaver({ storage, snapshot: () => next });
    await saver.flush();
    expect(storage.puts).toHaveLength(0);
    saver.markDirty();
    await saver.flush();
    expect(storage.puts).toHaveLength(1);
    next = null;
    saver.markDirty();
    await saver.flush();
    expect(storage.puts).toHaveLength(1);
  });

  it('a failing store is survived', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = memoryStorage();
    storage.put = async () => {
      throw new Error('quota');
    };
    const saver = createSessionAutosaver({ storage, snapshot: () => record() });
    saver.markDirty();
    await expect(saver.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe('snapshotSession', () => {
  it('serializes the current song as the JSON a .cmod holds', () => {
    const store = useTrackerStore();
    store.currentSong.title = 'My tune';
    const snap = snapshotSession(store);
    expect(snap?.title).toBe('My tune');
    expect(JSON.parse(snap!.json).data).toBeDefined();
  });
});

describe('useSessionAutosave', () => {
  function setup(storage: SessionStorage, extra: Partial<Parameters<typeof useSessionAutosave>[0]> = {}) {
    const store = useTrackerStore();
    const isLoadingSong = ref(false);
    const offerRestore = vi.fn();
    const applySongFile = vi.fn(async () => {});
    const parseSongBuffer = vi.fn(async () => ({}) as never);
    const api = useSessionAutosave({ trackerStore: store, isLoadingSong, parseSongBuffer, applySongFile, offerRestore, storage, ...extra });
    return { store, isLoadingSong, offerRestore, applySongFile, parseSongBuffer, api };
  }

  it('saves after an edit, but not for the changes of a load', async () => {
    const storage = memoryStorage();
    const { store, isLoadingSong, api } = setup(storage);
    await api.start();
    isLoadingSong.value = true;
    store.currentSong.title = 'loading';
    isLoadingSong.value = false;
    await nextTick();
    store.currentSong.title = 'still settling';
    await nextTick();
    await vi.advanceTimersByTimeAsync(20000);
    expect(storage.puts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);
    store.currentSong.title = 'edited';
    await nextTick();
    await vi.advanceTimersByTimeAsync(4000);
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]!.title).toBe('edited');
  });

  it('offers the last session once on a fresh page, and restoring applies it', async () => {
    const storage = memoryStorage(record('Old tune'));
    const { offerRestore, applySongFile, parseSongBuffer, api } = setup(storage);
    await api.start();
    expect(offerRestore).toHaveBeenCalledTimes(1);
    expect(offerRestore.mock.calls[0]![0].title).toBe('Old tune');
    await offerRestore.mock.calls[0]![1]();
    expect(parseSongBuffer).toHaveBeenCalledTimes(1);
    expect(applySongFile).toHaveBeenCalledTimes(1);
  });

  it('dismissing the offer deletes the saved session, so a later page load does not offer it again', async () => {
    const storage = memoryStorage(record('Old tune'));
    const first = setup(storage);
    await first.api.start();
    expect(first.offerRestore).toHaveBeenCalledTimes(1);
    await first.offerRestore.mock.calls[0]![2]();
    expect(await storage.get()).toBeNull();

    // The next page load (a new module state): nothing left to offer.
    resetSessionRestoreOffered();
    setActivePinia(createPinia());
    const next = setup(storage);
    await next.api.start();
    expect(next.offerRestore).not.toHaveBeenCalled();
  });

  it('does not offer it again when the page mounts again, over a song already edited, or under a deep link', async () => {
    const storage = memoryStorage(record());
    const first = setup(storage);
    await first.api.start();
    expect(first.offerRestore).toHaveBeenCalledTimes(1);
    const second = setup(storage);
    await second.api.start();
    expect(second.offerRestore).not.toHaveBeenCalled();

    resetSessionRestoreOffered();
    const store = useTrackerStore();
    store.pushHistory();
    const edited = setup(storage);
    await edited.api.start();
    expect(edited.offerRestore).not.toHaveBeenCalled();

    resetSessionRestoreOffered();
    setActivePinia(createPinia());
    const linked = setup(storage, { suppressRestore: () => true });
    await linked.api.start();
    expect(linked.offerRestore).not.toHaveBeenCalled();
  });

  it('is inert where there is no IndexedDB', async () => {
    const { api, offerRestore } = setup(memoryStorage(record()), { storage: null });
    await api.start();
    expect(offerRestore).not.toHaveBeenCalled();
  });
});
