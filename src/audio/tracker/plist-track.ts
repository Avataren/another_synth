/**
 * The PList as a one-track tracker pattern: the projection the PList canvas
 * paints (plan `.ai/plan-plist-canvas.md` §1.2). Pure; no Vue state.
 *
 * `PatternCanvas` draws `TrackerTrackData`, so an instrument's PList is laid
 * onto one dual-effect track: note column <- the PList note, instrument
 * column <- the tone (waveform) tag, macro column <- command 1, macro2
 * column <- command 2. The display is lossless (every field of an entry can be
 * read back from its text) except `fixed` on a row with no note, which the
 * engine ignores and the note column has nothing to show for.
 *
 * Rows are the PList's own: entry `i` is canvas row `i`, so the hex gutter is
 * the numbering of the table and of the Jump command's parameter.
 *
 * Absent text is `undefined`, never `'---'`: `formatEntryCells` turns a set
 * `'---'` note into `###`, which means a note release in a tracker and must
 * never appear here.
 */
import { toRaw } from 'vue';
import type {
  AhxInstrument,
  AhxPListEntry,
  TrackerEntryData,
  TrackerTrackData,
} from '@another-synth/tracker-playback';
import { ahxNoteName, ahxPListFxText, ahxWaveformKind } from './ahx-instrument-display';

export const PLIST_TRACK_ID = 'ahx-plist';
export const PLIST_TRACK_NAME = 'PList';

/** The tone tags of waveforms 1..=4, two characters to fit the canvas's instrument column. */
const TONE_TAGS = ['TR', 'SA', 'SQ', 'NO'] as const;

/**
 * The note column: a fixed row shows its pitch name, a relative row shows the
 * semitones above the key played (`note - 1`, as the table's own tooltip says),
 * and a row with no note shows nothing (the pitch is left as it was).
 */
export function plistNoteText(entry: Pick<AhxPListEntry, 'note' | 'fixed'>): string | undefined {
  if (entry.note <= 0) return undefined;
  if (entry.fixed) return ahxNoteName(entry.note);
  return `+${String(entry.note - 1).padStart(2, '0')}`;
}

/** The tone column: a tag for waveforms 1..=4, `?N` for a number with no name, nothing for 0 (the tone is kept). */
export function plistToneText(waveform: number): string | undefined {
  const kind = ahxWaveformKind(waveform);
  if (kind === 'keep') return undefined;
  if (kind === 'unknown') return `?${waveform}`;
  return TONE_TAGS[waveform - 1];
}

/** One command slot's text, or undefined for the empty slot (command 0 with parameter 0). */
function commandText(entry: AhxPListEntry, slot: 0 | 1): string | undefined {
  const text = ahxPListFxText(entry.fx[slot] ?? 0, entry.fxParam[slot] ?? 0);
  return text === '' ? undefined : text;
}

/** One PList row as a tracker entry; `undefined` when every field is blank (the row still exists and still costs its ticks). */
function projectEntry(entry: AhxPListEntry, row: number): TrackerEntryData | undefined {
  const note = plistNoteText(entry);
  const tone = plistToneText(entry.waveform);
  const macro = commandText(entry, 0);
  const macro2 = commandText(entry, 1);
  if (note === undefined && tone === undefined && macro === undefined && macro2 === undefined) return undefined;
  const out: TrackerEntryData = { row };
  if (note !== undefined) out.note = note;
  if (tone !== undefined) out.instrument = tone;
  if (macro !== undefined) out.macro = macro;
  if (macro2 !== undefined) out.macro2 = macro2;
  return Object.freeze(out);
}

/** The projection: one frozen track, one entry per non-blank PList row. Reads plain data only. */
export function buildPListTrack(entries: readonly AhxPListEntry[]): TrackerTrackData {
  const projected: TrackerEntryData[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = projectEntry(entries[i] as AhxPListEntry, i);
    if (entry !== undefined) projected.push(entry);
  }
  return Object.freeze({
    id: PLIST_TRACK_ID,
    name: PLIST_TRACK_NAME,
    entries: Object.freeze(projected) as TrackerEntryData[],
  });
}

/**
 * A string over exactly the fields the canvas shows (`fixed` only where it
 * changes the picture: a row with a note). Two PLists with the same signature
 * paint identically.
 */
export function plistSignature(entries: readonly AhxPListEntry[]): string {
  const parts: string[] = [String(entries.length)];
  for (const e of entries) {
    parts.push(
      `${e.note}${e.note > 0 && e.fixed ? 'f' : ''},${e.waveform},${e.fx[0] ?? 0}.${e.fxParam[0] ?? 0},${e.fx[1] ?? 0}.${e.fxParam[1] ?? 0}`,
    );
  }
  return parts.join('|');
}

const NO_ENTRIES: readonly AhxPListEntry[] = Object.freeze([]);

/**
 * The instrument's PList entries as raw data. `slot.ahxData` is reactive
 * state; reading a Proxy inside the painter (or diffing one) is the trap the
 * B2 review named, so the projection always goes through `toRaw`.
 */
export function rawPListEntries(instrument: AhxInstrument | null | undefined): readonly AhxPListEntry[] {
  if (!instrument) return NO_ENTRIES;
  return toRaw(toRaw(instrument).plist).entries;
}

/**
 * A memoised projection. `updateAhxInstrument` replaces `slot.ahxData` on every
 * instrument edit (an envelope drag is dozens a second), and `PatternCanvas`
 * repaints its static bitmap whenever the track *object* changes, so the same
 * PList content must give back the same object.
 */
export function createPListTrackMemo(): (instrument: AhxInstrument | null | undefined) => TrackerTrackData {
  let lastSignature: string | null = null;
  let lastTrack: TrackerTrackData | null = null;
  return (instrument) => {
    const entries = rawPListEntries(instrument);
    const signature = plistSignature(entries);
    if (lastTrack !== null && signature === lastSignature) return lastTrack;
    lastTrack = buildPListTrack(entries);
    lastSignature = signature;
    return lastTrack;
  };
}
