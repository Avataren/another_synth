import { ref, computed, type Ref, type ComputedRef } from 'vue';
import type { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { encodeRecordingToMp3 } from 'src/audio/tracker/exporter';
import type { TrackerPattern } from 'src/stores/tracker-store';

/**
 * Export stage during the MP3 export process
 */
export type ExportStage = 'idle' | 'preparing' | 'recording' | 'encoding' | 'saving' | 'done' | 'error';

/**
 * Playback mode for the tracker
 */
export type PlaybackMode = 'pattern' | 'song';

/**
 * Dependencies required by the export composable
 */
export interface TrackerExportContext {
  // Playback dependencies - engine getter returns PlaybackEngine or null
  getPlaybackEngine: () => PlaybackEngine | null;
  songBank: TrackerSongBank;

  // State refs
  rowsCount: Ref<number>;
  currentSong: Ref<{ title: string; author: string; bpm: number }>;
  sequence: Ref<string[]>;
  patterns: Ref<TrackerPattern[]>;
  currentPatternId: Ref<string | null>;
  currentPattern: ComputedRef<TrackerPattern | undefined>;
  playbackMode: Ref<PlaybackMode>;
  activeRow: Ref<number>;
  playbackRow: Ref<number>;

  // Functions
  syncSongBankFromSlots: () => Promise<void>;
  initializePlayback: (mode: PlaybackMode) => Promise<boolean>;
}

/**
 * Composable for handling tracker song export to MP3
 *
 * Manages the entire export pipeline:
 * - Preparing instruments and playback
 * - Recording audio
 * - Encoding to MP3
 * - Downloading the file
 *
 * @param context - Export context with all dependencies
 */
export function useTrackerExport(context: TrackerExportContext) {
  // Export state
  const isExporting = ref(false);
  const showExportModal = ref(false);
  const exportStage = ref<ExportStage>('idle');
  const exportProgress = ref(0);
  const exportError = ref<string | null>(null);

  // Computed status text
  const exportStatusText = computed(() => {
    switch (exportStage.value) {
      case 'preparing':
        return 'Preparing instruments...';
      case 'recording':
        return 'Recording song...';
      case 'encoding':
        return 'Encoding MP3...';
      case 'saving':
        return 'Saving file...';
      case 'done':
        return 'Export complete!';
      case 'error':
        return 'Export failed';
      default:
        return '';
    }
  });

  // Computed progress percentage
  const exportProgressPercent = computed(() => Math.round(exportProgress.value * 100));

  /**
   * Get milliseconds per row based on BPM
   * @param bpm - Beats per minute
   */
  function getMsPerRow(bpm: number): number {
    const rowsPerBeat = 4; // treat one beat as 4 rows (16th grid)
    return (60_000 / bpm) / rowsPerBeat;
  }

  /**
   * Get the length of a pattern in rows
   * Currently uses the global patternRows value
   */
  function getPatternLengthForExport(_patternId: string | undefined): number {
    // Tracker currently uses a single patternRows value for all patterns.
    // When per-pattern lengths are added, look up the pattern's own length here.
    return context.rowsCount.value;
  }

  /**
   * Resolve the sequence of patterns for a given playback mode
   */
  function resolveSequenceForMode(mode: PlaybackMode): string[] {
    if (mode === 'pattern') {
      const targetId = context.currentPatternId.value ?? context.currentPattern.value?.id ?? context.patterns.value[0]?.id;
      return targetId ? [targetId] : [];
    }

    const validPatternIds = new Set(context.patterns.value.map((p) => p.id));
    const sanitizedSequence = context.sequence.value.filter((id) => validPatternIds.has(id));

    if (sanitizedSequence.length > 0) {
      return sanitizedSequence;
    }

    const fallback = context.currentPatternId.value ?? context.patterns.value[0]?.id;
    return fallback ? [fallback] : [];
  }

  /**
   * Wait for playback to stop or timeout
   */
  function waitForPlaybackStop(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const playbackEngine = context.getPlaybackEngine();
      if (!playbackEngine) {
        resolve();
        return;
      }

      const timeoutId = window.setTimeout(() => {
        playbackEngine.stop();
        unsubscribe();
        resolve();
      }, timeoutMs);

      const unsubscribe = playbackEngine.on('state', (state) => {
        if (state === 'stopped') {
          clearTimeout(timeoutId);
          unsubscribe();
          resolve();
        }
      });
    });
  }

  /**
   * Export the song to MP3 format
   *
   * This function:
   * 1. Prepares the instruments and playback engine
   * 2. Records the song playback
   * 3. Encodes the recording to MP3
   * 4. Downloads the file
   */
  async function exportSongToMp3() {
    if (isExporting.value) return;
    showExportModal.value = true;
    isExporting.value = true;
    exportError.value = null;
    exportStage.value = 'preparing';
    exportProgress.value = 0;

    let unsubscribeExportPosition: (() => void) | null = null;

    try {
      const playbackEngine = context.getPlaybackEngine();
      if (!playbackEngine) {
        throw new Error('Playback engine not initialized');
      }

      // For export, we want a single pass through the song,
      // not continuous looping.
      playbackEngine.setLoopSong(false);

      await context.syncSongBankFromSlots();
      const initialized = await context.initializePlayback('song');
      if (!initialized) {
        throw new Error('Nothing to play – please add a pattern with notes.');
      }

      playbackEngine.stop();
      context.playbackRow.value = 0;
      context.activeRow.value = 0;
      context.songBank.cancelAllScheduled();
      context.songBank.allNotesOff();
      playbackEngine.seek(0);

      // Compute total song length in rows (using the same
      // sanitized sequence the playback engine sees) so we
      // can drive a 0..1 progress value from playback
      // position, even when pattern lengths vary in future.
      const playbackSequence = resolveSequenceForMode('song');
      const rowsBeforePattern = new Map<string, number>();
      let accumulatedRows = 0;
      for (const id of playbackSequence) {
        rowsBeforePattern.set(id, accumulatedRows);
        accumulatedRows += getPatternLengthForExport(id);
      }
      const totalRows = accumulatedRows;

      const RECORDING_PROGRESS_PORTION = 0.85;

      unsubscribeExportPosition = playbackEngine.on('position', (pos) => {
        if (!pos.patternId || totalRows <= 0) return;
        const before = rowsBeforePattern.get(pos.patternId);
        if (before === undefined) return;

        const globalRow = before + pos.row;
        const clampedGlobal = Math.max(0, Math.min(totalRows, globalRow));
        const fraction = clampedGlobal / totalRows;
        const overall = Math.min(
          RECORDING_PROGRESS_PORTION,
          fraction * RECORDING_PROGRESS_PORTION
        );

        if (overall > exportProgress.value) {
          exportProgress.value = overall;
        }
      });

      exportStage.value = 'recording';
      await context.songBank.startRecording();

      const expectedRows =
        totalRows > 0
          ? totalRows
          : context.rowsCount.value * Math.max(1, context.sequence.value.length || 1);
      const expectedDurationMs = expectedRows * getMsPerRow(context.currentSong.value.bpm);
      const waitPromise = waitForPlaybackStop(expectedDurationMs + 2000);

      await playbackEngine.play();
      await waitPromise;

      // Allow a short tail so reverb/delay can decay
      // before we stop recording, to avoid the export
      // sounding abruptly cut off.
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 1000);
      });

      const recording = await context.songBank.stopRecording();

      unsubscribeExportPosition?.();
      unsubscribeExportPosition = null;

      exportStage.value = 'encoding';
      const baseProgress = exportProgress.value;
      const mp3Blob = await encodeRecordingToMp3(recording, (progress) => {
        const clamped = Math.max(0, Math.min(1, progress));
        exportProgress.value = baseProgress + (1 - baseProgress) * clamped;
      });
      exportProgress.value = 1;

      exportStage.value = 'saving';
      const filename = `tracker-export-${new Date().toISOString().replace(/[:.]/g, '-')}.mp3`;
      const url = URL.createObjectURL(mp3Blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);

      exportStage.value = 'done';
    } catch (error) {
      console.error('Failed to export song', error);
      exportError.value = error instanceof Error ? error.message : String(error);
      exportStage.value = 'error';
    } finally {
      unsubscribeExportPosition?.();
      // Restore looping behavior for normal playback.
      const playbackEngine = context.getPlaybackEngine();
      playbackEngine?.setLoopSong(true);
      isExporting.value = false;
    }
  }

  return {
    // State
    isExporting,
    showExportModal,
    exportStage,
    exportProgress,
    exportError,

    // Computed
    exportStatusText,
    exportProgressPercent,

    // Methods
    exportSongToMp3
  };
}
