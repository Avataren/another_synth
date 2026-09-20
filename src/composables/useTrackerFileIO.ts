import type { Ref } from 'vue';
import JSZip from 'jszip';
import type { JSZipObject } from 'jszip';
import type { TrackerSongFile, useTrackerStore } from 'src/stores/tracker-store';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { looksLikeMod, importModToTrackerSong } from 'src/audio/tracker/mod-import';
import { looksLikeXm, importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { looksLikeS3m, importS3mToTrackerSong } from 'src/audio/tracker/s3m-import';
import { looksLikeAhxModule, importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { attachAhxSource, ahxSourceRecordOf, setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { decodeAhxFile } from 'src/audio/tracker/ahx-doc';
import { recordLoadedSongHash } from 'src/composables/song-identity';
import { usePostFxStore } from 'src/stores/post-fx-store';

/**
 * File picker types for File System Access API
 */
interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  types?: FilePickerAcceptType[];
}

/**
 * Dependencies required by the file I/O composable
 */
export interface TrackerFileIOContext {
  // Store
  trackerStore: ReturnType<typeof useTrackerStore>;
  songBank: TrackerSongBank;

  // State refs
  currentSong: Ref<{ title: string; author: string; bpm: number }>;
  playbackMode: Ref<'pattern' | 'song'>;
  /** Flag to prevent watcher interference during explicit file load */
  isLoadingSong: Ref<boolean>;

  // Functions
  ensureActiveInstrument: () => void;
  syncSongBankFromSlots: () => Promise<void>;
  initializePlayback: (mode: 'pattern' | 'song', skipIfPlaying?: boolean) => Promise<boolean>;
  stopPlayback: () => void;
  resetSequenceIndex: () => void;

  /**
   * Tell the user something in the UI. Optional so a host without a toast
   * (a test, a headless caller) still works; it then falls back to the log.
   */
  notify?: (message: string) => void;
}

/**
 * Extensions a dropped file may have to be opened as a song. The drop handler
 * filters on it so an image or WAV dragged onto the page is left alone.
 */
export const SONG_FILE_EXTENSIONS = [
  '.cmod',
  '.json',
  '.mod',
  '.xm',
  '.s3m',
  '.ahx',
  '.hvl',
] as const;

/** Whether `name` looks like a song file `parseSongBuffer` might read. */
export function hasSongFileExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return SONG_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Composable for managing tracker file I/O operations
 *
 * Handles:
 * - File system access (save/open)
 * - Song serialization and deserialization
 * - ZIP compression/decompression for .cmod files
 * - Loading song files and initializing playback
 *
 * @param context - File I/O context with all dependencies
 */
export function useTrackerFileIO(context: TrackerFileIOContext) {
  /**
   * Prompt user to save a file using File System Access API or fallback to download
   */
  async function promptSaveFile(contents: Blob, suggestedName: string) {
    const anyWindow = window as typeof window & {
      showSaveFilePicker?: (
        options?: SaveFilePickerOptions
      ) => Promise<FileSystemFileHandle>;
    };

    if (anyWindow.showSaveFilePicker) {
      const handle = await anyWindow.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: 'Chord Mod Song',
            accept: { 'application/octet-stream': ['.cmod'] }
          }
        ]
      });
      const writable = await handle.createWritable();
      await writable.write(contents);
      await writable.close();
      return;
    }

    const url = URL.createObjectURL(contents);
    const link = document.createElement('a');
    link.href = url;
    link.download = suggestedName;
    link.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Prompt user to open a file using File System Access API or fallback to file input
   */
  async function promptOpenFile(): Promise<ArrayBuffer | null> {
    const anyWindow = window as typeof window & {
      showOpenFilePicker?: (
        options?: OpenFilePickerOptions
      ) => Promise<FileSystemFileHandle[]>;
    };

    if (anyWindow.showOpenFilePicker) {
      const [handle] =
        (await anyWindow.showOpenFilePicker({
          types: [
            {
              description: 'Chord Mod Song / Tracker Module',
              accept: {
                'application/json': ['.cmod', '.json'],
                'audio/x-mod': ['.mod'],
                'audio/mod': ['.mod'],
                'audio/x-xm': ['.xm'],
                'application/octet-stream': ['.ahx', '.hvl']
              }
            }
          ],
          multiple: false
        })) ?? [];
      if (!handle) return null;
      const file = await handle.getFile();
      return await file.arrayBuffer();
    }

    return await new Promise<ArrayBuffer | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.cmod,application/json,.json,.mod,.xm,.s3m,.ahx,.hvl';
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) {
          resolve(null);
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => resolve(null);
        reader.readAsArrayBuffer(file);
      };
      input.click();
    });
  }

  function refuseSavingAhx(): void {
    const message = "AHX/HVL songs can't be saved as .cmod. Use Export to save an .ahx or .hvl file.";
    if (context.notify) {
      context.notify(message);
    } else {
      // eslint-disable-next-line no-console
      console.warn(message);
    }
  }

  /**
   * Save the current song to a .cmod file (zipped JSON)
   */
  async function handleSaveSongFile() {
    // An editable AHX song saves its file inside the .cmod (`data.ahxFile`). One
    // the editor has no doc for (an HVL song, or an AHX file it could not read)
    // is only a display model of a file it plays from, which a .cmod cannot turn
    // back into sound: saving it would write a file that never plays.
    if (context.trackerStore.moduleFormat === 'ahx' && !context.trackerStore.isAhxEditable) {
      refuseSavingAhx();
      return;
    }
    try {
      const songFile = context.trackerStore.serializeSong();
      // The belt to the check above: an AHX song that could not be written
      // carries no file, and a .cmod without one would never play.
      if (songFile.data.moduleFormat === 'ahx' && songFile.data.ahxFile === undefined) {
        refuseSavingAhx();
        return;
      }
      const json = JSON.stringify(songFile, null, 2);
      const safeTitle = (context.currentSong.value.title || 'song').replace(/[^a-z0-9-_]+/gi, '_');
      const zip = new JSZip();
      zip.file('song.json', json);
      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });
      await promptSaveFile(zipBlob, `${safeTitle || 'song'}.cmod`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to save song', error);
    }
  }

  /**
   * Load a song from a .cmod or .json file
   */
  async function handleLoadSongFile() {
    const data = await promptOpenFile();
    if (!data) return;
    await loadSongFromBuffer(data);
  }

  /**
   * Load a song from a `File` the user dropped on the page: the same path as
   * the picker, minus the picker.
   */
  async function loadSongFromFile(file: File): Promise<void> {
    await loadSongFromBuffer(await file.arrayBuffer());
  }

  /**
   * Load a song served over HTTP, e.g. one of the bundled demo modules.
   */
  async function loadSongFromUrl(url: string): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      await loadSongFromBuffer(await response.arrayBuffer());
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to load song from ${url}`, error);
      throw error;
    }
  }

  /**
   * Turn raw bytes into a song, without touching the tracker.
   *
   * Split out from the load so it can run *ahead* of time: the jukebox parses
   * the next module while the current one is still playing, which takes the
   * fetch and the parse out of the gap between songs. Nothing here reads or
   * writes tracker state, so it is safe to run during playback.
   */
  async function parseSongBuffer(data: ArrayBuffer): Promise<TrackerSongFile> {
    const buffer = new Uint8Array(data);

    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      // .cmod ZIP container
      const zip = await JSZip.loadAsync(buffer);
      const fileNames = Object.keys(zip.files);
      if (fileNames.length === 0) {
        throw new Error('Song archive is empty');
      }
      const preferredJsonName = fileNames.find((name) =>
        name.toLowerCase().endsWith('.json')
      );
      const jsonName = preferredJsonName ?? fileNames[0];
      if (!jsonName) {
        throw new Error('No JSON filename found in song archive');
      }
      const zipFile = zip.file(jsonName) as JSZipObject | null;
      if (!zipFile) {
        throw new Error('No JSON file found in song archive');
      }
      const text = await zipFile.async('string');
      return finishSongFile(JSON.parse(text) as TrackerSongFile);
    }
    if (looksLikeMod(buffer)) {
      // Raw Amiga-style MOD module
      return importModToTrackerSong(data);
    }
    if (looksLikeXm(buffer)) {
      // FastTracker 2 module
      return importXmToTrackerSong(data);
    }
    if (looksLikeS3m(buffer)) {
      // Scream Tracker 3 module
      return importS3mToTrackerSong(data);
    }
    if (looksLikeAhxModule(buffer)) {
      // AHX / HivelyTracker module: played by the worklet's own engine, this
      // is only the display model
      return importAhxToTrackerSong(data);
    }
    // Plain JSON .cmod/.json file
    const decoder = new TextDecoder('utf-8');
    return finishSongFile(JSON.parse(decoder.decode(buffer)) as TrackerSongFile);
  }

  /**
   * What both JSON paths of `parseSongBuffer` (the zipped `.cmod` and the plain
   * JSON) do with a parsed song file. A v5 AHX song carries its file
   * (`data.ahxFile`); when it is valid its bytes are attached as the song's
   * source record, so the consumers that read the record before the store has
   * loaded the song (the exporter) see the bytes the store will build from. The
   * store prefers the file to the record, so the two cannot disagree; an
   * unusable file is left for the store, which warns and keeps the song
   * read-only.
   */
  function finishSongFile(songFile: TrackerSongFile): TrackerSongFile {
    const data = songFile?.data;
    if (data?.moduleFormat === 'ahx' && data.ahxFile !== undefined) {
      const decoded = decodeAhxFile(data.ahxFile);
      if (decoded.ok) attachAhxSource(songFile, decoded.bytes);
    }
    return songFile;
  }

  /**
   * Load a song from raw bytes, whatever their origin.
   *
   * Shared by the file picker and the demo browser so both take exactly the
   * same path through format detection, instrument rebuild and playback
   * re-initialisation.
   */
  async function loadSongFromBuffer(data: ArrayBuffer) {
    try {
      context.isLoadingSong.value = true;
      const songFile = await parseSongBuffer(data);
      // The report tool hashes the bytes as loaded, never by re-fetching. Only
      // once they parse: bytes that were not a song must not replace the hash
      // of the song that is still loaded.
      recordLoadedSongHash(data);
      await applySongFile(songFile);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load song', error);
    } finally {
      context.isLoadingSong.value = false;
    }
  }

  /**
   * Put an already-parsed song into the tracker: stop what is playing, rebuild
   * the instruments, and re-initialise playback.
   *
   * The caller owns `isLoadingSong` so that a load which parsed ahead of time
   * still shows as one continuous load rather than flickering.
   */
  async function applySongFile(songFile: TrackerSongFile): Promise<void> {
    // Stop playback before loading new song to cleanup audio nodes
    console.log('[FileIO] Stopping playback before load');
    context.stopPlayback();

    // Best-effort, bounded resume attempt. Without a user gesture the
    // browser keeps the context suspended and leaves `resume()`'s promise
    // pending indefinitely (fresh-tab deep links: ?demo=<file>), so awaiting
    // it unconditionally would hang the whole song load. The song must load
    // fully while suspended; only playback needs the running context. Keep
    // the "click anywhere to enable audio" warning.
    console.log('[FileIO] Ensuring AudioContext is running (best effort)...');
    const audioCtx = context.songBank.audioContext;
    if (audioCtx.state !== 'running') {
      console.log(`[FileIO] AudioContext state is ${audioCtx.state}, attempting bounded resume...`);
      try {
        await Promise.race([
          audioCtx.resume(),
          new Promise((resolve) => setTimeout(resolve, 300)),
        ]);
      } catch (err) {
        console.error('[FileIO] Failed to resume AudioContext:', err);
      }
      // Use string variable to avoid TypeScript's type narrowing issue
      const currentState: string = audioCtx.state;
      if (currentState !== 'running') {
        console.warn(
          '[FileIO] AudioContext did not resume. Loading the song anyway; click anywhere on the page to enable audio.',
          `Current state: ${currentState}`
        );
      }
    } else {
      console.log('[FileIO] AudioContext already running');
    }

    // Drop all existing tracker instruments before wiring up the next song
    context.songBank.resetForNewSong();
    // Load song data and rebuild instruments
    console.log('[FileIO] Loading song data');
    context.trackerStore.loadSongFile(songFile);
    // An AHX/HVL song is played from its file, not from the store: keep the
    // bytes the import attached for the playback store to hand to the worklet.
    // Any other song clears them.
    // An editable song's bytes are the store's own (the doc, the slots and the
    // title, through the one writer the save and the export use), so slots, doc,
    // engine and file cannot disagree; the recorded edits are baked into them.
    // Any other AHX song has its record; every other format clears the bytes.
    const store = context.trackerStore;
    const ahxBytes = store.currentAhxBytes();
    if (ahxBytes !== null && store.ahxDoc !== null) {
      setCurrentAhxSource(ahxBytes, { format: 'ahx', version: store.ahxDoc.version, edits: [] });
    } else {
      const ahxSource = ahxSourceRecordOf(songFile);
      setCurrentAhxSource(ahxSource?.bytes ?? null, ahxSource ?? {});
    }

    // AUTO resets its LED-filter state on every song replacement -- this path
    // covers file open, the demo browser, URL loads and the jukebox (all
    // funnel through applySongFile). The New Song path hooks the same event
    // in TrackerPage's handleNewSong. Manual on/off modes persist (D116).
    // After loadSongFile, not before: the store resolves the module format
    // (legacy JSON songs infer it), and AUTO only models the Amiga output
    // chain for formats that had one.
    usePostFxStore().onSongLoad(context.trackerStore.moduleFormat);
    context.ensureActiveInstrument();

    // Reset sequence index to 0 AFTER song is loaded so it operates on new data
    console.log('[FileIO] Resetting sequence index to 0');
    context.resetSequenceIndex();

    // Before the instruments, not after: syncSongBankFromSlots builds every
    // ModInstrument, and each one takes the bank's current pitch model at
    // construction. Playback sets the format too (loadSong ->
    // setModuleFormat, which re-points instruments that already exist), so
    // this is the belt to that fix's braces -- it means the instruments are
    // born with the song's model rather than corrected into it.
    console.log('[FileIO] Setting module format on the song bank');
    context.songBank.setModuleFormat(
      context.trackerStore.moduleFormat,
      context.trackerStore.linearFrequency,
      context.trackerStore.amigaLimits,
    );

    console.log('[FileIO] Syncing song bank from slots');
    await context.syncSongBankFromSlots();
    console.log('[FileIO] Song bank sync complete');

    // Give worklets additional time to fully initialize voice structures
    // With many instruments (32+), worklets need time to stabilize after batched loading
    // This prevents "Node not found" errors and ensures audio output to speakers
    const numSlots = context.trackerStore.instrumentSlots.filter(s => s.patchId).length;
    const stabilizationDelay = Math.max(100, Math.min(500, numSlots * 10));
    console.log(`[FileIO] Waiting ${stabilizationDelay}ms for ${numSlots} worklets to stabilize...`);
    await new Promise((resolve) => setTimeout(resolve, stabilizationDelay));

    // Force re-initialization of playback with the new song
    console.log('[FileIO] Initializing playback');
    await context.initializePlayback(context.playbackMode.value, false);
    console.log('[FileIO] Song loaded successfully');
  }

  return {
    promptSaveFile,
    promptOpenFile,
    handleSaveSongFile,
    handleLoadSongFile,
    loadSongFromFile,
    loadSongFromUrl,
    parseSongBuffer,
    applySongFile
  };
}
