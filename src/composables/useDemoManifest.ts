import { ref } from 'vue';

/**
 * The manifest of demo modules published alongside the app.
 *
 * Fetched rather than imported, so a missing or unreachable collection stays
 * an expected state rather than a build error -- the modules are third-party
 * music served as plain files, and the app should still come up without them.
 *
 * Shared state rather than per-caller: the demo browser and the jukebox both
 * want the same list, and the jukebox builds its playlist from it whether or
 * not the browser has ever been opened. One in-flight request is reused by
 * everyone who asks while it is running.
 */
export interface DemoSong {
  /** Path relative to the manifest, e.g. "amiga/song.mod". */
  file: string;
  title: string;
  format: string;
  channels: number;
  bytes: number;
}

export interface DemoCollection {
  id: string;
  name: string;
  songs: DemoSong[];
}

/**
 * Collections whose import is still experimental, with what the user should
 * expect: a C64 .sid holds a player's code, not a song, so it is transcribed
 * from what the player plays, and the result only approximates the original.
 *
 * Shown with a warning in the demo browser, and left out of the jukebox's
 * standard playlist -- they can still be queued by hand or as a playlist of
 * their own.
 */
export const EXPERIMENTAL_COLLECTIONS: Readonly<Record<string, string>> = {
  sid: 'Experimental: C64 .sid files are transcribed into editable GoatTracker songs from what their player plays. The result approximates the original and can sound noticeably different.',
};

export function isExperimentalCollection(id: string): boolean {
  return id in EXPERIMENTAL_COLLECTIONS;
}

/** Directory the manifest and the modules are served from. */
export const DEMO_BASE_URL = 'demos';

const collections = ref<DemoCollection[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
let inFlight: Promise<DemoCollection[]> | null = null;
let loaded = false;

/** Absolute-from-the-app URL a manifest entry is served from. */
export function demoSongUrl(song: DemoSong, base = DEMO_BASE_URL): string {
  return `${base}/${song.file}`;
}

async function fetchManifest(base: string): Promise<DemoCollection[]> {
  loading.value = true;
  error.value = null;
  try {
    const response = await fetch(`${base}/index.json`);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const manifest = (await response.json()) as {
      collections?: DemoCollection[];
    };
    collections.value = manifest.collections ?? [];
    if (collections.value.length === 0) {
      error.value = 'No demo songs are published.';
    }
    loaded = true;
    return collections.value;
  } catch (err) {
    error.value = `Demo songs are unavailable (${(err as Error).message}).`;
    // A failed load is not cached: the collection is published separately from
    // the app, so the next attempt may well succeed.
    return [];
  } finally {
    loading.value = false;
    inFlight = null;
  }
}

export function useDemoManifest(base = DEMO_BASE_URL) {
  /** Load the manifest once; concurrent callers share the same request. */
  function load(): Promise<DemoCollection[]> {
    if (loaded) return Promise.resolve(collections.value);
    inFlight ??= fetchManifest(base);
    return inFlight;
  }

  /** Every published song, collections flattened in manifest order. */
  function allSongs(): DemoSong[] {
    return collections.value.flatMap((collection) => collection.songs);
  }

  /** Every song outside the experimental collections, in manifest order. */
  function standardSongs(): DemoSong[] {
    return collections.value
      .filter((collection) => !isExperimentalCollection(collection.id))
      .flatMap((collection) => collection.songs);
  }

  /** The songs of one collection, or none if it is not published. */
  function collectionSongs(id: string): DemoSong[] {
    return collections.value.find((collection) => collection.id === id)?.songs ?? [];
  }

  return {
    collections,
    loading,
    error,
    load,
    allSongs,
    standardSongs,
    collectionSongs,
  };
}
