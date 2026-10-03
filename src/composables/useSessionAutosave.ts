import { watch, type Ref } from 'vue';
import {
  createIndexedDbSessionStorage,
  createSessionAutosaver,
  type SessionRecord,
  type SessionStorage,
} from 'src/audio/tracker/session-autosave';
import type { TrackerSongFile, useTrackerStore } from 'src/stores/tracker-store';

type TrackerStore = ReturnType<typeof useTrackerStore>;

/** Mutations this soon after a load are the load settling (slots, instruments), not edits. */
const LOAD_SETTLE_MS = 2000;

/** Whether the restore prompt was already decided this page load (the tracker page mounts many times). */
let restoreOffered = false;

export interface SessionAutosaveContext {
  trackerStore: TrackerStore;
  isLoadingSong: Ref<boolean>;
  /** Parse a song's bytes into a song file (`useTrackerFileIO.parseSongBuffer`). */
  parseSongBuffer: (data: ArrayBuffer, name?: string) => Promise<TrackerSongFile>;
  applySongFile: (file: TrackerSongFile) => Promise<void>;
  /** Show the restore offer; call `restore` if they accept. */
  offerRestore: (record: SessionRecord, restore: () => Promise<void>) => void;
  /** Skip the restore offer (a demo deep link is about to load a song). */
  suppressRestore?: () => boolean;
  storage?: SessionStorage | null;
}

/** The song as a record, or `null` for one that cannot be saved or restored. */
export function snapshotSession(store: TrackerStore): SessionRecord | null {
  if (store.moduleFormat === 'ahx' && !store.isAhxEditable) return null;
  if (store.moduleFormat === 'sid' && store.sidDoc === null) return null;
  try {
    const file = store.serializeSong();
    if (file.data.moduleFormat === 'ahx' && file.data.ahxFile === undefined) return null;
    if (file.data.moduleFormat === 'sid' && file.data.sidFile === undefined) return null;
    return {
      savedAt: Date.now(),
      title: store.currentSong.title,
      format: store.moduleFormat,
      json: JSON.stringify(file),
    };
  } catch (error) {
    console.warn('[session-autosave] could not serialize the song', error);
    return null;
  }
}

/**
 * Autosave the song after edits and offer it back after a reload.
 * Returns `start`, to call once from the page's mount.
 */
export function useSessionAutosave(context: SessionAutosaveContext) {
  const storage = context.storage === undefined ? createIndexedDbSessionStorage() : context.storage;
  if (storage === null) return { start: () => undefined };
  const store = context.trackerStore;
  const autosaver = createSessionAutosaver({ storage, snapshot: () => snapshotSession(store) });
  let settledAt = 0;
  let started = false;

  // Sync, so the settle window opens before the store's own (queued) subscriber
  // reports the load's last mutations.
  watch(
    context.isLoadingSong,
    (loading) => {
      // A loaded song is not an edit: forget the load's own mutations.
      if (!loading) {
        settledAt = Date.now() + LOAD_SETTLE_MS;
        autosaver.cancel();
      }
    },
    { flush: 'sync' },
  );

  async function restore(record: SessionRecord): Promise<void> {
    const bytes = new TextEncoder().encode(record.json);
    const file = await context.parseSongBuffer(bytes.buffer as ArrayBuffer, 'session.json');
    await context.applySongFile(file);
  }

  function isPristine(): boolean {
    return store.undoStack.length === 0 && store.redoStack.length === 0;
  }

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    store.$subscribe(() => {
      if (context.isLoadingSong.value || Date.now() < settledAt) return;
      autosaver.markDirty();
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void autosaver.flush();
      });
    }
    if (restoreOffered) return;
    restoreOffered = true;
    if (context.suppressRestore?.() || !isPristine()) return;
    try {
      const record = await storage!.get();
      if (record && isPristine() && !context.isLoadingSong.value) {
        context.offerRestore(record, () => restore(record));
      }
    } catch (error) {
      console.warn('[session-autosave] could not read the last session', error);
    }
  }

  return { start };
}

/** For tests: forget that the restore was offered. */
export function resetSessionRestoreOffered(): void {
  restoreOffered = false;
}
