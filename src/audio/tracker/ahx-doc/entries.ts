import { ahxNoteFromTrackerText, type TrackerEntryData } from '@another-synth/tracker-playback';
import { BLANK_STEP } from './doc';
import { HVL_BLANK_NOTE, HVL_NOTE_63_REASON, type AhxDoc, type AhxDocStep, type AhxDocTrack } from './types';

const isMissing = (value: string | undefined): boolean => value === undefined || value === '';

/** A macro's nibble: a hex digit, or `.` for a placeholder (reads as 0). */
const nibble = (char: string): number => (char === '.' ? 0 : Number.parseInt(char, 16));
const isNibble = (char: string): boolean => char === '.' || /^[0-9a-fA-F]$/.test(char);

/** A macro as `[command, parameter]`, or `null` when it is not a hex digit and two hex digits. */
function macroToEffect(macro: string): [number, number] | null {
  if (macro.length !== 3 || ![...macro].every(isNibble)) return null;
  return [nibble(macro.charAt(0)), nibble(macro.charAt(1)) * 16 + nibble(macro.charAt(2))];
}

/**
 * One grid entry as an AHX step, or the reason it has none. An HVL step also
 * holds the second effect column (`macro2`), and never note 63.
 */
function entryToStep(entry: TrackerEntryData, format: AhxDoc['format']): AhxDocStep | { error: string } {
  const at = `Row ${entry.row}`;
  const hvl = format === 'hvl';
  if (!isMissing(entry.volume) || !isMissing(entry.volumeCommand)) {
    return { error: `${at}: ${hvl ? 'HVL' : 'AHX'} steps have no volume column: use effect C.` };
  }
  if (!hvl && !isMissing(entry.macro2)) return { error: `${at}: AHX steps have one effect column.` };
  if (entry.frequency !== undefined) return { error: `${at}: ${hvl ? 'HVL' : 'AHX'} steps cannot hold an exact frequency.` };

  let note = 0;
  if (!isMissing(entry.note)) {
    const parsed = ahxNoteFromTrackerText(entry.note);
    if (parsed === undefined) return { error: `${at}: "${entry.note}" is not a note an AHX step can hold (C-1 to D-6).` };
    note = parsed;
    if (hvl && note === HVL_BLANK_NOTE) return { error: `${at}: ${HVL_NOTE_63_REASON}` };
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
    const effect = macroToEffect(macro);
    if (effect === null) {
      return { error: `${at}: "${macro}" is not an AHX effect (a hex digit and two hex digits).` };
    }
    [fx, fxParam] = effect;
  } else if (entry.effectCommand !== undefined || entry.effectParam !== undefined) {
    // An untouched imported row: the raw bytes are its only effect (D94).
    fx = entry.effectCommand ?? 0;
    fxParam = entry.effectParam ?? 0;
    if (!Number.isInteger(fx) || fx < 0 || fx > 15 || !Number.isInteger(fxParam) || fxParam < 0 || fxParam > 255) {
      return { error: `${at}: effect ${fx}/${fxParam} does not fit an AHX step.` };
    }
  }

  let fxb = 0;
  let fxbParam = 0;
  if (hvl && !isMissing(entry.macro2)) {
    const macro = entry.macro2 as string;
    const effect = macroToEffect(macro);
    if (effect === null) {
      return { error: `${at}: "${macro}" is not an HVL effect (a hex digit and two hex digits).` };
    }
    [fxb, fxbParam] = effect;
  }

  return { note, instrument, fx, fxParam, fxb, fxbParam };
}

/**
 * The inverse of the row projection: one track's grid entries as `trackLength`
 * steps. Rows with no entry are blank. Nothing is clamped or guessed: an entry
 * an AHX step cannot hold (volume column, second effect, frequency, a note
 * outside 1..63, an instrument above 63, an effect that is not a hex digit and
 * two hex digits, a row at or past `trackLength`, the same row twice) gives
 * `{ error }` naming the first one. `format` `'hvl'` reads the second effect
 * column (`macro2`) into `fxb`/`fxbParam` and refuses note 63 (the blank-step
 * escape byte).
 */
export function entriesToTrack(
  entries: readonly TrackerEntryData[],
  trackLength: number,
  format: AhxDoc['format'] = 'ahx',
): AhxDocTrack | { error: string } {
  const steps: AhxDocStep[] = Array.from({ length: trackLength }, () => BLANK_STEP);
  const seen = new Set<number>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.row) || entry.row < 0 || entry.row >= trackLength) {
      return { error: `Row ${entry.row} is outside this song's tracks (${trackLength} rows).` };
    }
    if (seen.has(entry.row)) return { error: `Row ${entry.row} appears twice.` };
    seen.add(entry.row);
    const step = entryToStep(entry, format);
    if ('error' in step) return step;
    steps[entry.row] = step;
  }
  return steps;
}
