/**
 * AHX/HVL patterns -> the tracker row model.
 *
 * AHX has no single "pattern" object the way MOD/XM/S3M do: a position
 * addresses one track number (plus a per-channel transpose) independently
 * per channel (`architecture-map.md`'s "Position list" note), so one
 * `TrackerPattern` is synthesized per position here, assembling that
 * position's per-channel track pointers into the same tracks/rows/entries
 * shape the other importers produce. There is no sample-half import to go
 * with this one -- AHX instruments are not `TrackerSample`s and stay inside
 * `AhxSong`, addressed by the file's own instrument numbering (verdict.md's
 * deliberate boundary, restated in `.ai/task.md`'s standing decisions).
 *
 * Pitch is deliberately NOT resolved to a playable frequency here. AHX's real
 * sounding pitch combines the step's note with the position's per-channel
 * transpose and runtime PList/instrument period state
 * (`hvl_replay.c:1521-1539`'s `vc_AudioPeriod` derivation) that this format-
 * only decode phase does not model, and the period-to-Hz conversion itself
 * (`Period2Freq`, `hvl_replay.h:28`) carries a `* 65536` mixer-internal
 * fixed-point factor whose exact scale isn't yet pinned down against this
 * engine's sample-rate handling. Guessing here risks exactly the "plausible
 * but not bit-faithful" failure mode `verdict.md`'s fidelity-risk #2/#4
 * warns about. `entry.note` carries a display-only text rendering of the raw
 * step note (ignoring transpose and instrument period, same as how the other
 * importers display the written note before slides are applied);
 * `entry.frequency` is left unset until the phase that builds the actual AHX
 * voice resolves the real formula.
 */
import type { AhxSong, AhxStep } from '../formats/ahx';
import { AHX_MAX_CHANNELS } from '../formats/ahx';
import type {
  TrackerPattern,
  TrackerTrackData,
  TrackerEntryData,
} from '../tracker-types';
import { formatInstrumentId } from '../instrument-ids';
import { midiToTrackerNote } from '../note-utils';

/** AHX/HVL note range: 1..60, five octaves (`.ai/p0-report.md`'s correction
 * of `architecture-map.md`'s "3-octave" claim; `period_tab` has 61 entries,
 * index 0 an unused sentinel). 0 means no note field on the step. */
const AHX_MAX_NOTE_INDEX = 60;

/** This tracker's own octave numbering puts C-1 at MIDI 24 (matching the
 * MOD/S3M importers' baseline), so AHX note index 1 -- the lowest note of
 * its five octaves -- lands on that same C-1. */
const AHX_NOTE_INDEX_TO_MIDI_OFFSET = 23; // note index 1 -> MIDI 24

/**
 * The AHX note index (1..=60, the engine's `period_tab` row) a MIDI note plays
 * at: the inverse of the mapping above, clamped to the format's five octaves.
 * The engine turns the index into a period itself, so this is the whole pitch
 * model a live player needs. `undefined` for a non-finite `midi`.
 */
export function ahxNoteIndexFromMidi(midi: number): number | undefined {
  if (!Number.isFinite(midi)) return undefined;
  return Math.max(1, Math.min(AHX_MAX_NOTE_INDEX, Math.round(midi) - AHX_NOTE_INDEX_TO_MIDI_OFFSET));
}

function ahxNoteToTrackerText(note: number): string | undefined {
  if (note <= 0) return undefined;
  const clamped = Math.min(note, AHX_MAX_NOTE_INDEX);
  return midiToTrackerNote(AHX_NOTE_INDEX_TO_MIDI_OFFSET + clamped);
}

/**
 * Presentation only (D94): the raw fx/fxb nibble and param byte rendered as
 * tracker text, with no claim about what the command does. AHX's own
 * effect-command table (`AHX_PROFILE`/new `EffectType` members) is P2 work.
 */
function ahxEffectToMacro(fx: number, fxParam: number): string {
  const letter = fx.toString(16).toUpperCase();
  const paramHex = fxParam.toString(16).toUpperCase().padStart(2, '0');
  return `${letter}${paramHex}`;
}

function ahxStepToTrackerEntry(
  step: AhxStep,
  row: number,
  latchedInstrument: number,
): TrackerEntryData | undefined {
  const hasNote = step.note > 0;
  const hasInstrument = step.instrument > 0;
  // AHX only ever writes fx/fxParam (fxb/fxbParam are always 0 for that
  // format); HVL's track cell carries a genuine second command
  // (`hvl_replay.c:484-487`), so a row can carry only column-2 content.
  const hasEffect1 = step.fx !== 0 || step.fxParam !== 0;
  const hasEffect2 = step.fxb !== 0 || step.fxbParam !== 0;
  const hasEffect = hasEffect1 || hasEffect2;

  if (!hasNote && !hasInstrument && !hasEffect) return undefined;

  const entry: TrackerEntryData = { row };

  // An instrument byte only reloads the voice's instrument when non-zero
  // (`hvl_replay.c:875`'s `if (Instr && Instr <= InstrumentNr)`); zero keeps
  // whatever the channel already has loaded -- the same cross-row latch
  // idiom the MOD/S3M importers already carry across pattern boundaries,
  // except here it carries across positions (AHX has no separate pattern
  // concept for it to reset at).
  const instrumentNumber = hasInstrument ? step.instrument : latchedInstrument;
  if (instrumentNumber > 0) {
    entry.instrument = formatInstrumentId(instrumentNumber);
  }

  if (hasNote) {
    const noteText = ahxNoteToTrackerText(step.note);
    if (noteText) entry.note = noteText;
  }

  if (hasEffect1) {
    entry.effectCommand = step.fx;
    entry.effectParam = step.fxParam;
    entry.macro = ahxEffectToMacro(step.fx, step.fxParam);
  }

  // HVL's second effect column rides `macro2`, the same row slot S3M's pan
  // command and MOD's synthesized pan macro use (s3m-patterns.ts:349,
  // mod-patterns.ts:476) -- consumed the same way, unconditionally, by
  // `playback-song-builder.ts`'s `parseEffectCommand(entry?.macro2)`.
  if (hasEffect2) {
    entry.macro2 = ahxEffectToMacro(step.fxb, step.fxbParam);
  }

  return entry;
}

export function buildAhxTrackerPatterns(song: AhxSong): TrackerPattern[] {
  // The engine plays at most AHX_MAX_CHANNELS voices (the reference's
  // 16-voice array); a malformed HVL header can claim more, and the editor
  // would otherwise grow tracks the engine never sounds.
  const channelCount = Math.min(AHX_MAX_CHANNELS, Math.max(1, song.channels));

  // Which instrument each channel has loaded, carried across positions (see
  // the latch note in `ahxStepToTrackerEntry`).
  const channelInstruments = new Array<number>(channelCount).fill(0);

  return song.positions.map((position, positionIndex) => {
    const tracks: TrackerTrackData[] = [];

    for (let ch = 0; ch < channelCount; ch++) {
      const trackNumber = position.track[ch] ?? 0;
      const steps = song.tracks[trackNumber] ?? [];

      const entries: TrackerEntryData[] = [];
      for (let row = 0; row < song.trackLength; row++) {
        const step = steps[row];
        if (!step) continue;
        const entry = ahxStepToTrackerEntry(
          step,
          row,
          channelInstruments[ch] ?? 0,
        );
        if (step.instrument > 0) channelInstruments[ch] = step.instrument;
        if (entry) entries.push(entry);
      }

      tracks.push({
        id: `T${(ch + 1).toString().padStart(2, '0')}`,
        name: `Track ${ch + 1}`,
        entries,
        interpolations: [],
      });
    }

    return {
      id: crypto.randomUUID(),
      name: `Position ${positionIndex + 1}`,
      rows: song.trackLength,
      tracks,
    };
  });
}
