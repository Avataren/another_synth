import type { Ref } from 'vue';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';
import type { TrackerPattern, InstrumentSlot } from 'src/stores/tracker-store';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type { SongBankSlot } from 'src/audio/tracker/song-bank';
import type { Patch } from 'src/audio/types/preset-types';
import type { ModuleFormat } from '@another-synth/tracker-playback';
import {
  buildPlaybackSong as buildSong,
  buildPlaybackPatterns as buildPatterns,
  buildPlaybackStepsForTrack as buildStepsForTrack,
  resolveSequenceForMode as resolveSequence,
  resolveInstrumentForTrack as resolveInstrument,
  type PlaybackMode,
  type PlaybackSongSource,
} from 'src/audio/tracker/playback-song-builder';

export type { PlaybackMode };

/**
 * Dependencies required by the song builder composable
 */
export interface TrackerSongBuilderContext {
  // State refs
  currentSong: Ref<{ title: string; author: string; bpm: number }>;
  /** Ticks per row the song starts at; omitted means the tracker default of 6. */
  initialSpeed?: Ref<number>;
  /** XM only: whether the module selected the linear frequency table. */
  linearFrequency?: Ref<boolean>;
  /** S3M only: the per-file amiga-limits header flag (flags & 0x10). */
  amigaLimits?: Ref<boolean>;
  /**
   * The song's initial global volume 0..1 (S3M's header globalVol / 64);
   * absent means full.
   */
  initialGlobalVolume?: Ref<number>;
  /**
   * ProTracker only: whether Fxx always sets the speed, never the tempo.
   *
   * VBlank-timed modules run off the 50 Hz vertical blank and have no tempo
   * command at all, so their `F20`-and-above parameters are tick counts.
   * Detected on import; see `usesVBlankTiming`.
   */
  vblankTiming?: Ref<boolean>;
  /**
   * Which tracker's semantics the song follows. Optional so existing tests
   * and callers keep working; omitted means DEFAULT_MODULE_FORMAT.
   */
  moduleFormat?: Ref<ModuleFormat>;
  patterns: Ref<TrackerPattern[]>;
  sequence: Ref<string[]>;
  currentPatternId: Ref<string | null>;
  currentPattern: Ref<TrackerPattern | undefined>;
  /**
   * Row count used when a pattern does not specify its own. Patterns carry
   * `rows` since song-file v3; this is only the fallback.
   */
  defaultPatternRows: Ref<number>;
  instrumentSlots: Ref<InstrumentSlot[]>;
  songPatches: Ref<Record<string, Patch>>;

  // Audio
  songBank: TrackerSongBank;

  // Functions
  normalizeInstrumentId: (instrumentId?: string) => string | undefined;
  formatInstrumentId: (slotNumber: number) => string;
}

/**
 * Composable for building playback song structures from tracker data
 *
 * The conversion itself lives in `src/audio/tracker/playback-song-builder.ts`
 * and takes plain values. This composable is the Vue-facing wrapper: it reads
 * the refs and delegates. Only `syncSongBankFromSlots` has any logic of its
 * own, because it is the only part that touches the song bank.
 *
 * @param context - Song builder context with all dependencies
 */
export function useTrackerSongBuilder(context: TrackerSongBuilderContext) {
  /**
   * Snapshot the refs.
   *
   * Taken per call rather than once, because the refs move: a snapshot held
   * from composable-construction time would build every song from whatever
   * was loaded first.
   *
   * An absent optional ref stays absent rather than becoming `undefined`,
   * which the conversion reads as "this format has no such concept" -- the
   * distinction `profileForFormat` makes between a supplied `linearFrequency`
   * of `false` and no frequency table preference at all.
   */
  function source(): PlaybackSongSource {
    return {
      currentSong: context.currentSong.value,
      patterns: context.patterns.value,
      sequence: context.sequence.value,
      currentPatternId: context.currentPatternId.value,
      currentPattern: context.currentPattern.value,
      defaultPatternRows: context.defaultPatternRows.value,
      normalizeInstrumentId: context.normalizeInstrumentId,
      ...(context.initialSpeed
        ? { initialSpeed: context.initialSpeed.value }
        : {}),
      ...(context.linearFrequency
        ? { linearFrequency: context.linearFrequency.value }
        : {}),
      ...(context.amigaLimits
        ? { amigaLimits: context.amigaLimits.value }
        : {}),
      ...(context.initialGlobalVolume
        ? { initialGlobalVolume: context.initialGlobalVolume.value }
        : {}),
      ...(context.vblankTiming
        ? { vblankTiming: context.vblankTiming.value }
        : {}),
      ...(context.moduleFormat
        ? { moduleFormat: context.moduleFormat.value }
        : {}),
    };
  }

  function buildPlaybackStepsForTrack(track: TrackerTrackData, rows?: number) {
    return buildStepsForTrack(source(), track, rows);
  }

  function buildPlaybackPatterns() {
    return buildPatterns(source());
  }

  function resolveSequenceForMode(mode: PlaybackMode) {
    return resolveSequence(source(), mode);
  }

  function buildPlaybackSong(mode: PlaybackMode) {
    return buildSong(source(), mode);
  }

  /**
   * Sync the song bank from instrument slots
   * Note: Caller should call updateTrackAudioNodes() after this if needed
   */
  async function syncSongBankFromSlots() {
    const slots: SongBankSlot[] = context.instrumentSlots.value
      .map((slot) => {
        if (!slot.patchId) return null;
        // Use song patches (patches are copied there when assigned)
        const patch = context.songPatches.value[slot.patchId];
        if (!patch) return null;
        return {
          instrumentId: context.formatInstrumentId(slot.slot),
          patch,
        } satisfies SongBankSlot;
      })
      .filter(Boolean) as SongBankSlot[];

    await context.songBank.syncSlots(slots);
  }

  function resolveInstrumentForTrack(
    track: TrackerTrackData | undefined,
    trackIndex: number,
  ) {
    return resolveInstrument(source(), track, trackIndex);
  }

  return {
    buildPlaybackStepsForTrack,
    buildPlaybackPatterns,
    resolveSequenceForMode,
    buildPlaybackSong,
    syncSongBankFromSlots,
    resolveInstrumentForTrack,
  };
}
