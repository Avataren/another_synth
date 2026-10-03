/**
 * Keeps the song being edited across a page reload.
 *
 * The page holds the song only in memory, so a reload (or a crashed tab) used
 * to lose it. This writes the serialized song to IndexedDB shortly after each
 * edit, and the tracker offers it back on the next fresh load. One slot: the
 * latest session.
 *
 * The timing and the storage are separate so each can be tested: the saver
 * takes a `SessionStorage` and a snapshot function.
 */

export interface SessionRecord {
  savedAt: number;
  title: string;
  /** The song's module format, for the restore prompt. */
  format: string;
  /** `JSON.stringify` of the `TrackerSongFile`, the same JSON a `.cmod` holds. */
  json: string;
}

export interface SessionStorage {
  put(record: SessionRecord): Promise<void>;
  get(): Promise<SessionRecord | null>;
  clear(): Promise<void>;
}

const DB_NAME = 'ferrotracker-session';
const STORE = 'session';
const KEY = 'last';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** The browser's IndexedDB, or `null` where there is none (private modes, tests). */
export function createIndexedDbSessionStorage(): SessionStorage | null {
  if (typeof indexedDB === 'undefined') return null;
  return {
    put: async (record) => {
      await withStore('readwrite', (store) => store.put(record, KEY));
    },
    get: async () => ((await withStore('readonly', (store) => store.get(KEY))) as SessionRecord | undefined) ?? null,
    clear: async () => {
      await withStore('readwrite', (store) => store.delete(KEY));
    },
  };
}

export interface SessionAutosaverOptions {
  storage: SessionStorage;
  /** The song as it is now, or `null` when it cannot be saved (nothing is written). */
  snapshot: () => SessionRecord | null;
  /** Quiet time after the last edit before writing. */
  delayMs?: number;
  /** The longest an edit waits, however busy the song is. */
  maxWaitMs?: number;
}

export interface SessionAutosaver {
  /** Something changed: write soon. */
  markDirty(): void;
  /** Write now if anything changed since the last write. */
  flush(): Promise<void>;
  /** Drop a pending write without making it. */
  cancel(): void;
}

export function createSessionAutosaver(options: SessionAutosaverOptions): SessionAutosaver {
  const delayMs = options.delayMs ?? 3000;
  const maxWaitMs = options.maxWaitMs ?? 15000;
  let dirty = false;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let maxWait: ReturnType<typeof setTimeout> | null = null;

  function clearTimers() {
    if (debounce !== null) clearTimeout(debounce);
    if (maxWait !== null) clearTimeout(maxWait);
    debounce = null;
    maxWait = null;
  }

  async function flush(): Promise<void> {
    clearTimers();
    if (!dirty) return;
    dirty = false;
    try {
      const record = options.snapshot();
      if (record !== null) await options.storage.put(record);
    } catch (error) {
      console.warn('[session-autosave] could not save the session', error);
    }
  }

  return {
    markDirty() {
      dirty = true;
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => void flush(), delayMs);
      maxWait ??= setTimeout(() => void flush(), maxWaitMs);
    },
    flush,
    cancel() {
      dirty = false;
      clearTimers();
    },
  };
}
