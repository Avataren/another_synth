import { ahxNoteFromTrackerText, type TrackerEntryData } from '@another-synth/tracker-playback';
import { BLANK_STEP } from './doc';
import type { AhxDocStep, AhxDocTrack } from './types';

const isMissing = (value: string | undefined): boolean => value === undefined || value === '';

/** A macro's nibble: a hex digit, or `.` for a placeholder (reads as 0). */
const nibble = (char: string): number => (char === '.' ? 0 : Number.parseInt(char, 16));
const isNibble = (char: string): boolean => char === '.' || /^[0-9a-fA-F]$/.test(char);

/** One grid entry as an AHX step, or the reason it has none. */
function entryToStep(entry: TrackerEntryData): AhxDocStep | { error: string } {
  const at = `Row ${entry.row}`;
  if (!isMissing(entry.volume) || !isMissing(entry.volumeCommand)) {
    return { error: `${at}: AHX steps have no volume column: use effect C.` };
  }
  if (!isMissing(entry.macro2)) return { error: `${at}: AHX steps have one effect column.` };
  if (entry.frequency !== undefined) return { error: `${at}: AHX steps cannot hold an exact frequency.` };

  let note = 0;
  if (!isMissing(entry.note)) {
    const parsed = ahxNoteFromTrackerText(entry.note);
    if (parsed === undefined) return { error: `${at}: "${entry.note}" is not a note an AHX step can hold (C-1 to D-6).` };
    note = parsed;
  }

  let instrument = 0;
  if (!isMissing(entry.instrument)) {
    if (!/^\d{1,3}$/.test(entry.instrument as string)) return { error: `${at}: "${entry.instrument}" is not an instrument number.` };
    instrument = Number(entry.instrument);
    if (instrument > 63) return { error: `${at}: AHX instruments go up to 63 (got ${instrument}).` };
  }

  let fx = 0;
  let fxParam = 0;
  if (!isMissing(entry.macro)) {
    const macro = entry.macro as string;
    if (macro.length !== 3 || ![...macro].every(isNibble)) {
      return { error: `${at}: "${macro}" is not an AHX effect (a hex digit and two hex digits).` };
    }
    fx = nibble(macro.charAt(0));
    fxParam = nibble(macro.charAt(1)) * 16 + nibble(macro.charAt(2));
  } else if (entry.effectCommand !== undefined || entry.effectParam !== undefined) {
    // An untouched imported row: the raw bytes are its only effect (D94).
    fx = entry.effectCommand ?? 0;
    fxParam = entry.effectParam ?? 0;
    if (!Number.isInteger(fx) || fx < 0 || fx > 15 || !Number.isInteger(fxParam) || fxParam < 0 || fxParam > 255) {
      return { error: `${at}: effect ${fx}/${fxParam} does not fit an AHX step.` };
    }
  }

  return { note, instrument, fx, fxParam, fxb: 0, fxbParam: 0 };
}

/**
 * The inverse of the row projection: one track's grid entries as `trackLength`
 * steps. Rows with no entry are blank. Nothing is clamped or guessed: an entry
 * an AHX step cannot hold (volume column, second effect, frequency, a note
 * outside 1..63, an instrument above 63, an effect that is not a hex digit and
 * two hex digits, a row at or past `trackLength`, the same row twice) gives
 * `{ error }` naming the first one.
 */
export function entriesToTrack(entries: readonly TrackerEntryData[], trackLength: number): AhxDocTrack | { error: string } {
  const steps: AhxDocStep[] = Array.from({ length: trackLength }, () => BLANK_STEP);
  const seen = new Set<number>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.row) || entry.row < 0 || entry.row >= trackLength) {
      return { error: `Row ${entry.row} is outside this song's tracks (${trackLength} rows).` };
    }
    if (seen.has(entry.row)) return { error: `Row ${entry.row} appears twice.` };
    seen.add(entry.row);
    const step = entryToStep(entry);
    if ('error' in step) return step;
    steps[entry.row] = step;
  }
  return steps;
}
