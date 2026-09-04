import type {
  TrackerTrackData,
  TrackerEntryData,
} from 'src/components/tracker/tracker-types';
import type { TrackerPattern } from 'src/stores/tracker-store';
import {
  parseTrackerNoteSymbol,
  parseTrackerVolume,
  parseEffectCommand,
  parseVolumeColumnCommand,
  decodeRawEffect,
} from 'src/audio/tracker/note-utils';
import type {
  Pattern as PlaybackPattern,
  Song as PlaybackSong,
  Step as PlaybackStep,
  ModuleFormat,
} from '@another-synth/tracker-playback';
import {
  DEFAULT_MODULE_FORMAT,
  profileForFormat,
} from '@another-synth/tracker-playback';

/**
 * Turning the app's song model into the engine's `PlaybackSong`.
 *
 * Plain values in, plain values out. This used to live inside
 * `useTrackerSongBuilder` and read its inputs off Vue refs, which made it look
 * reactive; it never was -- no `computed`, no `watch`, no `ref` of its own,
 * just `.value` reads. The costume cost every caller a wrapper: each test had
 * to build a dozen `ref()`s around values that never changed, and nothing but
 * the app could call it at all.
 *
 * `useTrackerSongBuilder` still exists and still takes refs -- it unwraps them
 * on each call and delegates here -- so the Vue-side API is unchanged. What is
 * new is that everything except `syncSongBankFromSlots` (the one part that
 * genuinely needs the song bank) can now be called from anywhere.
 */

/** Playback mode type */
export type PlaybackMode = 'pattern' | 'song';

/** Track playback context for building steps */
interface TrackPlaybackContext {
  instrumentId?: string;
  lastMidi?: number;
}

/**
 * Everything the conversion reads, as a snapshot.
 *
 * Fields are optional exactly where they were optional as refs: an absent one
 * means "this format does not have that concept", not "zero".
 */
export interface PlaybackSongSource {
  currentSong: { title: string; author: string; bpm: number };
  /** Ticks per row the song starts at; omitted means the tracker default of 6. */
  initialSpeed?: number;
  /** XM only: whether the module selected the linear frequency table. */
  linearFrequency?: boolean;
  /** S3M only: the per-file amiga-limits header flag (flags & 0x10). */
  amigaLimits?: boolean;
  /**
   * The song's initial global volume 0..1 (S3M's header globalVol / 64);
   * absent means full.
   */
  initialGlobalVolume?: number;
  /**
   * ProTracker only: whether Fxx always sets the speed, never the tempo.
   *
   * VBlank-timed modules run off the 50 Hz vertical blank and have no tempo
   * command at all, so their `F20`-and-above parameters are tick counts.
   * Detected on import; see `usesVBlankTiming`.
   */
  vblankTiming?: boolean;
  /**
   * Which tracker's semantics the song follows. Optional so existing tests
   * and callers keep working; omitted means DEFAULT_MODULE_FORMAT.
   */
  moduleFormat?: ModuleFormat;
  patterns: TrackerPattern[];
  sequence: string[];
  currentPatternId: string | null;
  currentPattern: TrackerPattern | undefined;
  /**
   * Row count used when a pattern does not specify its own. Patterns carry
   * `rows` since song-file v3; this is only the fallback.
   */
  defaultPatternRows: number;
  normalizeInstrumentId: (instrumentId?: string) => string | undefined;
}

/**
 * Build playback steps for a single track
 */
export function buildPlaybackStepsForTrack(
  source: PlaybackSongSource,
  track: TrackerTrackData,
  rows?: number,
): PlaybackStep[] {
  const ctx: TrackPlaybackContext = {};
  const steps: PlaybackStep[] = [];
  const patternRows = rows ?? source.defaultPatternRows;
  const entryByRow = new Map<number, TrackerEntryData>();
  for (const entry of track.entries) {
    entryByRow.set(entry.row, entry);
  }

  function getInterpolationsForRow(row: number) {
    const ranges = track.interpolations ?? [];
    return ranges.filter(
      (range) => row >= range.startRow && row <= range.endRow,
    );
  }

  function interpolateValue(
    range: {
      startRow: number;
      endRow: number;
      startValue: number;
      endValue: number;
    },
    row: number,
  ) {
    if (range.endRow === range.startRow) return range.endValue;
    const t = (row - range.startRow) / (range.endRow - range.startRow);
    return range.startValue + (range.endValue - range.startValue) * t;
  }

  // Imported modules carry their own volume semantics; see the velocity
  // fallback below for why that distinction has to be made here.
  const isNativeSong =
    (source.moduleFormat ?? DEFAULT_MODULE_FORMAT) === 'native';

  // Hand-authored (native) rows skip the profile entirely: they carry no
  // raw bytes, so the profile is never consulted for them.
  const profile = profileForFormat(
    source.moduleFormat,
    source.linearFrequency !== undefined || source.amigaLimits !== undefined
      ? {
          ...(source.linearFrequency !== undefined
            ? { linearFrequency: source.linearFrequency }
            : {}),
          ...(source.amigaLimits ? { amigaLimits: true } : {}),
        }
      : undefined,
  );

  for (let row = 0; row < patternRows; row += 1) {
    const entry = entryByRow.get(row);
    const instrumentId =
      source.normalizeInstrumentId(entry?.instrument) ?? ctx.instrumentId;
    const { midi, isNoteOff } = parseTrackerNoteSymbol(entry?.note);
    const volumeValue = parseTrackerVolume(entry?.volume);
    // Raw format-native bytes are the source of truth for imported rows;
    // the text macro is their presentation and may collide with the
    // hand-authored shorthand dialect (D94). Hand-authored rows carry no
    // raw bytes and keep the text parse.
    const effectCmd1 =
      entry?.effectCommand !== undefined
        ? decodeRawEffect(entry.effectCommand, entry.effectParam ?? 0, profile)
        : parseEffectCommand(entry?.macro);
    const effectCmd2 = parseEffectCommand(entry?.macro2);
    // XM volume-column command (0x60-0xFF). Independent of the effect
    // columns: FT2 runs both on the same row.
    const volumeCmd = parseVolumeColumnCommand(entry?.volumeCommand);

    const interpolationsAtRow = getInterpolationsForRow(row);
    const startRange = interpolationsAtRow.find((r) => r.startRow === row);
    const endRange = interpolationsAtRow.find(
      (r) => r.endRow === row && r.startRow !== row,
    );

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
          value: interpolateValue(startRange, row),
        };
      } else if (endRange) {
        macroCmd = {
          type: 'macro',
          index: endRange.macroIndex,
          value: interpolateValue(endRange, row),
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
      } else if (cmd.type === 'tempo') {
        // A VBlank-timed module has no tempo command: the same parameter
        // that would be a BPM under CIA timing is a tick count.
        if (source.vblankTiming) {
          if (speedCommand === undefined) speedCommand = cmd.bpm;
        } else if (tempoCommand === undefined) {
          tempoCommand = cmd.bpm;
        }
      }
    }

    // Check if this entry has any meaningful data
    const hasMacro = macroCmd?.type === 'macro';
    const hasTempoOrSpeed =
      tempoCommand !== undefined || speedCommand !== undefined;
    const hasEffect = explicitEffectCmd?.type === 'effect';
    const hasNoteData = isNoteOff || midi !== undefined;
    const hasVolumeData = volumeValue !== undefined;
    const hasVolumeCommand = volumeCmd !== undefined;

    // Skip if no instrument and no effect/automation.
    //
    // A row carrying a note, a note-off or a volume is kept even with no
    // instrument resolved here: `ctx.instrumentId` only remembers what this
    // *pattern* has played, so a pattern that opens with `###` on a channel
    // before its first note had the key-off dropped outright. The engine
    // keeps its own per-track instrument across patterns and resolves it
    // there. elw-sick.xm is full of patterns that open exactly that way --
    // key-offs meant to clear what the previous pattern left ringing.
    //
    // `hasVolumeData` belongs in that list for the same reason, and its
    // absence was reported as radix_-_yuki_satellites.xm's bassline losing
    // its gating in the second pattern (D79). A set-volume row carries no
    // instrument number of its own, and that pattern's every instrument-
    // bearing row is a tone portamento -- which must not stamp the channel's
    // instrument (D55, D77) -- so `ctx.instrumentId` is never set anywhere in
    // the pattern and all eight `v00` rows were dropped. The note rows
    // survived on `hasNoteData`, so the line played on at full level instead
    // of staccato.
    if (
      !instrumentId &&
      !hasNoteData &&
      !hasVolumeData &&
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
      isNoteOff,
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
      if (
        startRange &&
        startRange.macroIndex === macroCmd.index &&
        row < startRange.endRow
      ) {
        // Single ramp across the full interpolation span
        step.macroRamp = {
          targetRow: startRange.endRow,
          targetValue: startRange.endValue,
          interpolation: startRange.interpolation ?? 'linear',
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

    // Marks the velocity as an XM volume-column set-volume; FT2's Rxy
    // tick-0 quirk keys off exactly this (see the type's comment).
    if (entry?.volumeColumnVolume) {
      step.volumeColumnVolume = true;
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
export function buildPlaybackPatterns(
  source: PlaybackSongSource,
): PlaybackPattern[] {
  return source.patterns.map((p) => {
    const rows = p.rows ?? source.defaultPatternRows;
    return {
      id: p.id,
      length: rows,
      tracks: p.tracks.map((track) => ({
        id: track.id,
        steps: buildPlaybackStepsForTrack(source, track, rows),
      })),
    };
  });
}

/**
 * Resolve the sequence for the given playback mode
 */
export function resolveSequenceForMode(
  source: PlaybackSongSource,
  _mode: PlaybackMode,
): string[] {
  const validPatternIds = new Set(source.patterns.map((p) => p.id));
  const sanitizedSequence = source.sequence.filter((id) =>
    validPatternIds.has(id),
  );

  if (sanitizedSequence.length > 0) {
    return sanitizedSequence;
  }

  const fallback =
    source.currentPatternId ??
    source.currentPattern?.id ??
    source.patterns[0]?.id;
  return fallback ? [fallback] : [];
}

/**
 * Build complete playback song structure
 */
export function buildPlaybackSong(
  source: PlaybackSongSource,
  mode: PlaybackMode,
): PlaybackSong {
  return {
    title: source.currentSong.title,
    author: source.currentSong.author,
    bpm: source.currentSong.bpm,
    patterns: buildPlaybackPatterns(source),
    sequence: resolveSequenceForMode(source, mode),
    moduleFormat: source.moduleFormat ?? DEFAULT_MODULE_FORMAT,
    ...(source.initialSpeed !== undefined
      ? { initialSpeed: source.initialSpeed }
      : {}),
    ...(source.linearFrequency !== undefined
      ? { linearFrequency: source.linearFrequency }
      : {}),
    ...(source.amigaLimits ? { amigaLimits: true } : {}),
    ...(source.initialGlobalVolume !== undefined &&
    source.initialGlobalVolume !== 1.0
      ? { initialGlobalVolume: source.initialGlobalVolume }
      : {}),
  };
}

/**
 * Resolve the instrument used by a track
 */
export function resolveInstrumentForTrack(
  source: PlaybackSongSource,
  track: TrackerTrackData | undefined,
  _trackIndex: number,
): string | undefined {
  if (!track) return undefined;
  const steps = buildPlaybackStepsForTrack(source, track);
  for (let i = steps.length - 1; i >= 0; i--) {
    const instrumentId = source.normalizeInstrumentId(steps[i]?.instrumentId);
    if (instrumentId) return instrumentId;
  }
  return undefined;
}
