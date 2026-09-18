import { hasSongFileExtension } from 'src/composables/useTrackerFileIO';

/**
 * Dropping a file on the page opens it as a song. Without a `dragover`
 * handler that says "drop is allowed", the browser would navigate to the
 * file instead; and with a `drop` handler that took every file, an image or
 * a WAV dragged in by mistake would be parsed as a song (and, before the
 * parse, overwrite the hash the bug-report tool attributes to the song that
 * is loaded).
 */
export function handleSongDragOver(event: DragEvent): void {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
}

export interface SongDropHandlers {
  /** A load is already under way: the drop is swallowed, not queued. */
  isBusy: () => boolean;
  /** Open the dropped song. */
  load: (file: File) => void;
  /** The dropped file's extension is not one a song can have. */
  reject: (file: File) => void;
}

export function handleSongDrop(event: DragEvent, handlers: SongDropHandlers): void {
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  // Every file drop is ours, so a stray one never navigates the tab away.
  event.preventDefault();
  if (!hasSongFileExtension(file.name)) {
    handlers.reject(file);
    return;
  }
  if (handlers.isBusy()) return;
  handlers.load(file);
}
