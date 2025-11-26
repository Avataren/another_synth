import type { Ref } from 'vue';
import JSZip from 'jszip';
import type { JSZipObject } from 'jszip';
import type { TrackerSongFile, useTrackerStore } from 'src/stores/tracker-store';

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
              description: 'Chord Mod Song',
              accept: { 'application/json': ['.cmod', '.json'] }
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
      input.accept = '.cmod,application/json,.json';
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
      let text: string;

      if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
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
        text = await zipFile.async('string');
      } else {
        const decoder = new TextDecoder('utf-8');
        text = decoder.decode(buffer);
      }

      const parsed = JSON.parse(text) as TrackerSongFile;

      // Set flag to prevent watcher interference during explicit load
      context.isLoadingSong.value = true;

      // Stop playback before loading new song to cleanup audio nodes
      console.log('[FileIO] Stopping playback before load');
      context.stopPlayback();

      // Load song data and rebuild instruments
      console.log('[FileIO] Loading song data');
      context.trackerStore.loadSongFile(parsed);
      context.ensureActiveInstrument();

      console.log('[FileIO] Syncing song bank from slots');
      await context.syncSongBankFromSlots();
      console.log('[FileIO] Song bank sync complete');

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
