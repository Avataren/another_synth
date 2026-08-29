import type { Ref } from 'vue';
import type { TrackerTrackData, TrackerEntryData } from 'src/components/tracker/tracker-types';
import type { TrackerPattern, InstrumentSlot } from 'src/stores/tracker-store';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type { SongBankSlot } from 'src/audio/tracker/song-bank';
import type { Patch } from 'src/audio/types/preset-types';
import {
  parseTrackerNoteSymbol,
  parseTrackerVolume,
  parseEffectCommand,
  parseVolumeColumnCommand
} from 'src/audio/tracker/note-utils';
import type {
  Pattern as PlaybackPattern,
  Song as PlaybackSong,
  Step as PlaybackStep,
  ModuleFormat
} from '../../packages/tracker-playback/src/types';
import { DEFAULT_MODULE_FORMAT } from '../../packages/tracker-playback/src/types';

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
  /** Ticks per row the song starts at; omitted means the tracker default of 6. */
  initialSpeed?: Ref<number>;
  /** XM only: whether the module selected the linear frequency table. */
  linearFrequency?: Ref<boolean>;
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
  function buildPlaybackStepsForTrack(
    track: TrackerTrackData,
    rows?: number
  ): PlaybackStep[] {
    const ctx: TrackPlaybackContext = {};
    const steps: PlaybackStep[] = [];
    const patternRows = rows ?? context.defaultPatternRows.value;
    const entryByRow = new Map<number, TrackerEntryData>();
    for (const entry of track.entries) {
      entryByRow.set(entry.row, entry);
    }

    function getInterpolationsForRow(row: number) {
      const ranges = track.interpolations ?? [];
      return ranges.filter((range) => row >= range.startRow && row <= range.endRow);
    }

    function interpolateValue(
      range: { startRow: number; endRow: number; startValue: number; endValue: number },
      row: number
    ) {
      if (range.endRow === range.startRow) return range.endValue;
      const t = (row - range.startRow) / (range.endRow - range.startRow);
      return range.startValue + (range.endValue - range.startValue) * t;
    }

    // Imported modules carry their own volume semantics; see the velocity
    // fallback below for why that distinction has to be made here.
    const isNativeSong =
      (context.moduleFormat?.value ?? DEFAULT_MODULE_FORMAT) === 'native';

    for (let row = 0; row < patternRows; row += 1) {
      const entry = entryByRow.get(row);
      const instrumentId = context.normalizeInstrumentId(entry?.instrument) ?? ctx.instrumentId;
      const { midi, isNoteOff } = parseTrackerNoteSymbol(entry?.note);
      const volumeValue = parseTrackerVolume(entry?.volume);
      const effectCmd1 = parseEffectCommand(entry?.macro);
      const effectCmd2 = parseEffectCommand(entry?.macro2);
      // XM volume-column command (0x60-0xFF). Independent of the effect
      // columns: FT2 runs both on the same row.
      const volumeCmd = parseVolumeColumnCommand(entry?.volumeCommand);

      const interpolationsAtRow = getInterpolationsForRow(row);
      const startRange = interpolationsAtRow.find((r) => r.startRow === row);
      const endRange = interpolationsAtRow.find((r) => r.endRow === row && r.startRow !== row);

      // Resolve explicit commands from both effect columns
      const explicitMacroCmd =
        effectCmd2?.type === 'macro'
          ? effectCmd2
          : effectCmd1?.type === 'macro'
            ? effectCmd1
            : undefined;

      const explicitEffectCmd =
        effectCmd1?.type === 'effect'
          ? effectCmd1
          : effectCmd2?.type === 'effect'
            ? effectCmd2
            : undefined;

      let macroCmd = explicitMacroCmd;

      // Derive macro automation from interpolation ranges only when there is
      // no explicit macro command on this row (macro column 1 drives ramps).
      if (!macroCmd) {
        if (startRange) {
          macroCmd = {
            type: 'macro',
            index: startRange.macroIndex,
            value: interpolateValue(startRange, row)
          };
        } else if (endRange) {
          macroCmd = {
            type: 'macro',
            index: endRange.macroIndex,
            value: interpolateValue(endRange, row)
          };
        } else if (interpolationsAtRow.length > 0) {
          // Middle rows in the interpolation should not reset the ramp
          macroCmd = undefined;
        }
      }

      // Resolve speed/tempo commands (Fxx) from both columns, preferring the
      // first column when both are present.
      let speedCommand: number | undefined;
      let tempoCommand: number | undefined;
      for (const cmd of [effectCmd1, effectCmd2]) {
        if (!cmd) continue;
        if (cmd.type === 'speed' && speedCommand === undefined) {
          speedCommand = cmd.speed;
        } else if (cmd.type === 'tempo' && tempoCommand === undefined) {
          tempoCommand = cmd.bpm;
        }
      }

      // Check if this entry has any meaningful data
      const hasMacro = macroCmd?.type === 'macro';
      const hasTempoOrSpeed = tempoCommand !== undefined || speedCommand !== undefined;
      const hasEffect = explicitEffectCmd?.type === 'effect';
      const hasNoteData = isNoteOff || midi !== undefined;
      const hasVolumeData = volumeValue !== undefined;
      const hasVolumeCommand = volumeCmd !== undefined;

      // Skip if no instrument and no effect/automation.
      //
      // A row carrying a note or a note-off is kept even with no instrument
      // resolved here: `ctx.instrumentId` only remembers what this *pattern*
      // has played, so a pattern that opens with `###` on a channel before its
      // first note had the key-off dropped outright. The engine keeps its own
      // per-track instrument across patterns and resolves it there. elw-sick.xm
      // is full of patterns that open exactly that way -- key-offs meant to
      // clear what the previous pattern left ringing.
      if (
        !instrumentId &&
        !hasNoteData &&
        !hasMacro &&
        !hasTempoOrSpeed &&
        !hasEffect &&
        !hasVolumeCommand
      )
        continue;
      // Skip if no meaningful data at all
      if (
        !hasNoteData &&
        !hasVolumeData &&
        !hasMacro &&
        !hasTempoOrSpeed &&
        !hasEffect &&
        !hasVolumeCommand
      )
        continue;

      const step: PlaybackStep = {
        row,
        instrumentId: instrumentId ?? '',
        isNoteOff
      };

      if (midi !== undefined) {
        step.midi = midi;
        ctx.lastMidi = midi;
      } else if (isNoteOff && ctx.lastMidi !== undefined) {
        step.midi = ctx.lastMidi;
      }

      if (entry?.note) {
        step.note = entry.note;
      }

      // Pass through ProTracker frequency override (MOD imports)
      if (entry?.frequency !== undefined) {
        step.frequency = entry.frequency;
      }

      // Extract pan value from macro 0 (for MOD imports and stereo positioning)
      // Check both effect columns for macro 0 commands
      for (const cmd of [effectCmd1, effectCmd2]) {
        if (cmd?.type === 'macro' && cmd.index === 0) {
          step.pan = cmd.value;
          break;
        }
      }

      if (volumeValue !== undefined) {
        // Keep velocity in 0-255 range to preserve precision from MOD importer
        // Effect processor will divide by 255 to normalize to 0-1
        step.velocity = volumeValue;
      } else if (midi !== undefined && entry?.instrument && isNativeSong) {
        // A genuine new note+instrument trigger with no explicit volume
        // column value must still reset to a known volume, not silently
        // inherit whatever this track's currentVolume last decayed to via
        // an earlier (possibly much earlier -- even a previous pattern's)
        // volume slide. Real trackers only preserve the running volume
        // when the row deliberately omits the instrument number (the
        // "sample 0" convention); an explicit instrument number always
        // resets. Without this, a note like "C-4 01 .." right after a
        // channel that faded out via Axy plays back muted even though
        // it's a fresh trigger -- this is what made one pattern appear to
        // "mute" the next while that same pattern played back fine when
        // started from a clean state.
        //
        // Native songs only. `entry.instrument` cannot carry that meaning for
        // an imported module, because the importers stamp it onto *every* row
        // of a track so the builder knows which instrument a naked effect
        // addresses -- exactly the "row deliberately omits the instrument
        // number" case this is meant to exclude. The importers already write a
        // volume wherever the tracker resets one (the sample's default on a
        // real sample number, the Cxx or volume-column value otherwise), so
        // for those formats the absence of a volume here is meaningful and
        // must be respected.
        //
        // It also resets to *full*, where a tracker resets to the sample's
        // default. On GSLINGER.MOD pattern 2 that turned the flute echo --
        // channel 3 shadowing channel 1 at volume 11 against the lead's 24 --
        // into 64 on every row that omitted the sample number.
        step.velocity = 255;
      }

      // Handle macro automation (from explicit macro commands or interpolations)
      if (macroCmd && macroCmd.type === 'macro') {
        step.macroIndex = macroCmd.index;
        step.macroValue = macroCmd.value;
        if (startRange && startRange.macroIndex === macroCmd.index && row < startRange.endRow) {
          // Single ramp across the full interpolation span
          step.macroRamp = {
            targetRow: startRange.endRow,
            targetValue: startRange.endValue,
            interpolation: startRange.interpolation ?? 'linear'
          };
        }
      }

      // Handle tempo/speed commands (Fxx)
      if (typeof speedCommand === 'number') {
        step.speedCommand = speedCommand;
      }
      if (typeof tempoCommand === 'number') {
        step.tempoCommand = tempoCommand;
      }

      // Handle FastTracker-style effect commands (non-macro)
      if (explicitEffectCmd && explicitEffectCmd.type === 'effect') {
        step.effect = explicitEffectCmd.effect;
      }

      if (volumeCmd) {
        step.volumeCommand = volumeCmd;
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
    return context.patterns.value.map((p) => {
      const rows = p.rows ?? context.defaultPatternRows.value;
      return {
        id: p.id,
        length: rows,
        tracks: p.tracks.map((track) => ({
          id: track.id,
          steps: buildPlaybackStepsForTrack(track, rows)
        }))
      };
    });
  }

  /**
   * Resolve the sequence for the given playback mode
   */
  function resolveSequenceForMode(_mode: PlaybackMode): string[] {
    const validPatternIds = new Set(context.patterns.value.map((p) => p.id));
    const sanitizedSequence = context.sequence.value.filter((id) => validPatternIds.has(id));

    if (sanitizedSequence.length > 0) {
      return sanitizedSequence;
    }

    const fallback =
      context.currentPatternId.value ?? context.currentPattern.value?.id ?? context.patterns.value[0]?.id;
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
      sequence: resolveSequenceForMode(mode),
      moduleFormat: context.moduleFormat?.value ?? DEFAULT_MODULE_FORMAT,
      ...(context.initialSpeed ? { initialSpeed: context.initialSpeed.value } : {}),
      ...(context.linearFrequency
        ? { linearFrequency: context.linearFrequency.value }
        : {})
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
