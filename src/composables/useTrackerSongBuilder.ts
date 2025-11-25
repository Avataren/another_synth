import type { Ref } from 'vue';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';
import type { TrackerPattern, InstrumentSlot } from 'src/stores/tracker-store';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type { SongBankSlot } from 'src/audio/tracker/song-bank';
import type { Patch } from 'src/audio/types/preset-types';
import {
  parseTrackerNoteSymbol,
  parseTrackerVolume,
  parseEffectCommand
} from 'src/audio/tracker/note-utils';
import type {
  Pattern as PlaybackPattern,
  Song as PlaybackSong,
  Step as PlaybackStep
} from '../../packages/tracker-playback/src/types';

/**
 * Playback mode type
 */
export type PlaybackMode = 'pattern' | 'song';

/**
 * Track playback context for building steps
 */
interface TrackPlaybackContext {
  instrumentId?: string;
  lastMidi?: number;
}

/**
 * Dependencies required by the song builder composable
 */
export interface TrackerSongBuilderContext {
  // State refs
  currentSong: Ref<{ title: string; author: string; bpm: number }>;
  patterns: Ref<TrackerPattern[]>;
  sequence: Ref<string[]>;
  currentPatternId: Ref<string | null>;
  currentPattern: Ref<TrackerPattern | undefined>;
  patternRows: Ref<number>;
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
 * Handles:
 * - Converting tracker entries to playback steps
 * - Building playback patterns
 * - Resolving sequence for different playback modes
 * - Building complete playback song structure
 * - Syncing song bank from instrument slots
 * - Resolving instruments for tracks
 *
 * @param context - Song builder context with all dependencies
 */
export function useTrackerSongBuilder(context: TrackerSongBuilderContext) {
  /**
   * Build playback steps for a single track
   */
  function buildPlaybackStepsForTrack(track: TrackerTrackData): PlaybackStep[] {
    const ctx: TrackPlaybackContext = {};
    const steps: PlaybackStep[] = [];

    const sortedEntries = [...track.entries].sort((a, b) => a.row - b.row);
    for (const entry of sortedEntries) {
      const instrumentId = context.normalizeInstrumentId(entry.instrument) ?? ctx.instrumentId;
      const { midi, isNoteOff } = parseTrackerNoteSymbol(entry.note);
      const volumeValue = parseTrackerVolume(entry.volume);
      const effectCmd = parseEffectCommand(entry.macro);

      // Check if this entry has any meaningful data
      const hasMacro = effectCmd?.type === 'macro';
      const hasTempoEffect = effectCmd?.type === 'speed' || effectCmd?.type === 'tempo';
      const hasNoteData = isNoteOff || midi !== undefined;
      const hasVolumeData = volumeValue !== undefined;

      // Skip if no instrument and no effect command
      if (!instrumentId && !hasMacro && !hasTempoEffect) continue;
      // Skip if no meaningful data at all
      if (!hasNoteData && !hasVolumeData && !hasMacro && !hasTempoEffect) continue;

      const step: PlaybackStep = {
        row: entry.row,
        instrumentId: instrumentId ?? '',
        isNoteOff
      };

      if (midi !== undefined) {
        step.midi = midi;
        ctx.lastMidi = midi;
      } else if (isNoteOff && ctx.lastMidi !== undefined) {
        step.midi = ctx.lastMidi;
      }

      if (entry.note) {
        step.note = entry.note;
      }

      if (volumeValue !== undefined) {
        const scaledVelocity = Math.max(
          0,
          Math.min(127, Math.round((volumeValue / 255) * 127))
        );
        step.velocity = scaledVelocity;
      }

      // Handle effect commands
      if (effectCmd) {
        if (effectCmd.type === 'macro') {
          step.macroIndex = effectCmd.index;
          step.macroValue = effectCmd.value;
        } else if (effectCmd.type === 'speed') {
          step.speedCommand = effectCmd.speed;
        } else if (effectCmd.type === 'tempo') {
          step.tempoCommand = effectCmd.bpm;
        }
      }

      // Update context after building step
      if (instrumentId) {
        ctx.instrumentId = instrumentId;
      }

      steps.push(step);
    }

    return steps;
  }

  /**
   * Build all playback patterns
   */
  function buildPlaybackPatterns(): PlaybackPattern[] {
    return context.patterns.value.map((p) => ({
      id: p.id,
      length: context.patternRows.value,
      tracks: p.tracks.map((track) => ({
        id: track.id,
        steps: buildPlaybackStepsForTrack(track)
      }))
    }));
  }

  /**
   * Resolve the sequence for the given playback mode
   */
  function resolveSequenceForMode(mode: PlaybackMode): string[] {
    if (mode === 'pattern') {
      const targetId =
        context.currentPatternId.value ??
        context.currentPattern.value?.id ??
        context.patterns.value[0]?.id;
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
   * Build complete playback song structure
   */
  function buildPlaybackSong(mode: PlaybackMode): PlaybackSong {
    return {
      title: context.currentSong.value.title,
      author: context.currentSong.value.author,
      bpm: context.currentSong.value.bpm,
      patterns: buildPlaybackPatterns(),
      sequence: resolveSequenceForMode(mode)
    };
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
          patch
        } satisfies SongBankSlot;
      })
      .filter(Boolean) as SongBankSlot[];

    await context.songBank.syncSlots(slots);
  }

  /**
   * Resolve the instrument used by a track
   */
  function resolveInstrumentForTrack(
    track: TrackerTrackData | undefined,
    _trackIndex: number
  ): string | undefined {
    if (!track) return undefined;
    const steps = buildPlaybackStepsForTrack(track);
    for (let i = steps.length - 1; i >= 0; i--) {
      const instrumentId = context.normalizeInstrumentId(steps[i]?.instrumentId);
      if (instrumentId) return instrumentId;
    }
    return undefined;
  }

  return {
    buildPlaybackStepsForTrack,
    buildPlaybackPatterns,
    resolveSequenceForMode,
    buildPlaybackSong,
    syncSongBankFromSlots,
    resolveInstrumentForTrack
  };
}
