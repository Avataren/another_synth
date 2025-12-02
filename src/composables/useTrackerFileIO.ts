import type { Ref } from 'vue';
import JSZip from 'jszip';
import type { JSZipObject } from 'jszip';
import type { TrackerSongFile, useTrackerStore } from 'src/stores/tracker-store';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { looksLikeMod, importModToTrackerSong } from 'src/audio/tracker/mod-import';

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
              description: 'Chord Mod Song / MOD Module',
              accept: {
                'application/json': ['.cmod', '.json'],
                'audio/x-mod': ['.mod'],
                'audio/mod': ['.mod']
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
      input.accept = '.cmod,application/json,.json,.mod';
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

  /**
   * Save the current song to a .cmod file (zipped JSON)
   */
  async function handleSaveSongFile() {
    try {
      const songFile = context.trackerStore.serializeSong();
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
    try {
      const data = await promptOpenFile();
      if (!data) return;

      const buffer = new Uint8Array(data);

      // Set flag to prevent watcher interference during explicit load
      context.isLoadingSong.value = true;

      let songFile: TrackerSongFile;

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
        songFile = JSON.parse(text) as TrackerSongFile;
      } else if (looksLikeMod(buffer)) {
        // Raw Amiga-style MOD module
        songFile = importModToTrackerSong(data);
      } else {
        // Plain JSON .cmod/.json file
        const decoder = new TextDecoder('utf-8');
        const text = decoder.decode(buffer);
        songFile = JSON.parse(text) as TrackerSongFile;
      }

      // Stop playback before loading new song to cleanup audio nodes
      console.log('[FileIO] Stopping playback before load');
      context.stopPlayback();

      // Ensure AudioContext is running before loading instruments
      // This prevents silent playback when loading songs with many instruments
      console.log('[FileIO] Ensuring AudioContext is running...');
      const audioCtx = context.songBank.audioContext;
      if (audioCtx.state !== 'running') {
        console.log(`[FileIO] AudioContext state is ${audioCtx.state}, attempting to resume...`);
        try {
          await audioCtx.resume();
          // Use string variable to avoid TypeScript's type narrowing issue
          const currentState: string = audioCtx.state;
          if (currentState === 'running') {
            console.log('[FileIO] AudioContext successfully resumed');
          } else {
            console.warn(
              '[FileIO] AudioContext did not resume. Click anywhere on the page to enable audio.',
              `Current state: ${currentState}`
            );
          }
        } catch (err) {
          console.error('[FileIO] Failed to resume AudioContext:', err);
        }
      } else {
        console.log('[FileIO] AudioContext already running');
      }

      // Drop all existing tracker instruments before wiring up the next song
      context.songBank.resetForNewSong();

      // Load song data and rebuild instruments
      console.log('[FileIO] Loading song data');
      context.trackerStore.loadSongFile(songFile);
      context.ensureActiveInstrument();

      // Reset sequence index to 0 AFTER song is loaded so it operates on new data
      console.log('[FileIO] Resetting sequence index to 0');
      context.resetSequenceIndex();

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
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load song', error);
    } finally {
      // Always clear the flag when done
      context.isLoadingSong.value = false;
    }
  }

  return {
    promptSaveFile,
    promptOpenFile,
    handleSaveSongFile,
    handleLoadSongFile
  };
}
