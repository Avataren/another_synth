import { toRaw } from 'vue';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { importPsid, looksLikePsid, type PsidImport, type PsidImportResult } from 'src/audio/tracker/psid';
import type { PsidWorkerReply, PsidWorkerRequest } from 'src/audio/tracker/psid/psid-import-worker';
import { fileTitle, sidDocToTrackerSong } from 'src/audio/tracker/sid-import';

/**
 * Assembly only, like the other `*-import.ts` files: a C64 `.sid` (PSID or
 * RSID; plan-psid-import.md, the importer is `psid/`) becomes a SID song
 * file, the same shape a `.sng` import makes (`sidDocToTrackerSong`), so it
 * is edited, played and exported through the one SID path there is.
 *
 * `summary` tells the user what they got: a transcription of the tune's own
 * player, how many subsongs, how close the start song sounds to the
 * original, and the import's notes. It stays attached to the song file
 * (`psidImportSummaryOf`), so the load shows it when the song is applied,
 * not when it is parsed (the jukebox parses ahead of time).
 *
 * The app imports through `importPsidToTrackerSongAsync`, which runs the
 * importer in a worker (`psid/psid-import-worker.ts`) where the page has
 * one: a big tune takes seconds.
 */
export const looksLikePsidFile = looksLikePsid;

export interface PsidTrackerSong {
  readonly song: TrackerSongFile;
  readonly summary: string;
  readonly result: PsidImport;
}

const summaries = new WeakMap<TrackerSongFile, string>();

/** What the import of `songFile` has to tell the user, or null for a song that was not a `.sid`. */
export function psidImportSummaryOf(songFile: TrackerSongFile): string | null {
  return summaries.get(toRaw(songFile)) ?? null;
}

/** One line for the user about `r`. */
export function psidImportSummary(r: PsidImport): string {
  const who = [r.file.name.trim(), r.file.author.trim()].filter((x) => x !== '').join(' by ') || 'The tune';
  const subsongs = r.doc.subsongs.length;
  const count = `${subsongs} of ${r.file.songs} subsong${r.file.songs === 1 ? '' : 's'}`;
  const parts =
    r.method === 'unpacked'
      ? [`${who}: a GoatTracker song, unpacked from the file${r.exact ? ' exactly' : ''} (${count}).`]
      : [
          `${who}: transcribed from its own C64 player into a GoatTracker song (${count}).`,
          // Not the fidelity score: it matches registers frame by frame, not what the ear hears.
          'It approximates the original and can sound noticeably different.',
        ];
  parts.push(...r.notes);
  return parts.join(' ');
}

function trackerSongOf(result: PsidImportResult, name: string): PsidTrackerSong {
  if (!result.ok) throw new Error(`Cannot import this SID file: ${result.reason}.`);
  const song = sidDocToTrackerSong(result.doc, fileTitle(name));
  const summary = psidImportSummary(result);
  summaries.set(song, summary);
  return { song, summary, result };
}

/** The song file of a `.sid`, imported here. Throws, with the true reason, for bytes that are not an importable one. */
export function importPsidToTrackerSong(buffer: ArrayBuffer, name = ''): PsidTrackerSong {
  return trackerSongOf(importPsid(new Uint8Array(buffer)), name);
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (r: PsidImportResult) => void; reject: (e: Error) => void }>();

/** The import worker, started on first use; null where the page has none. */
function importWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL('./psid/psid-import-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  worker.onmessage = (e: MessageEvent<PsidWorkerReply>) => {
    const waiting = pending.get(e.data.id);
    pending.delete(e.data.id);
    waiting?.resolve(e.data.result);
  };
  worker.onerror = (e: ErrorEvent) => {
    // A worker that failed (to load, or at all) fails what waits on it, and the next import starts another.
    for (const waiting of pending.values()) waiting.reject(new Error(e.message || 'the SID import worker failed'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** `bytes` imported in the worker; here, when there is none or it fails. */
function importOffThread(bytes: Uint8Array): Promise<PsidImportResult> {
  const w = importWorker();
  if (w === null) return Promise.resolve(importPsid(bytes));
  return new Promise<PsidImportResult>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const copy = bytes.slice();
    const request: PsidWorkerRequest = { id, bytes: copy.buffer };
    w.postMessage(request, [copy.buffer]);
  }).catch(() => importPsid(bytes));
}

/** The song file of a `.sid`, imported off the main thread where the page can. Rejects, with the true reason, for bytes that are not an importable one. */
export async function importPsidToTrackerSongAsync(buffer: ArrayBuffer, name = ''): Promise<PsidTrackerSong> {
  return trackerSongOf(await importOffThread(new Uint8Array(buffer)), name);
}
