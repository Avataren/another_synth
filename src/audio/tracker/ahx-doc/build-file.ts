import type { AhxInstrument } from '@another-synth/tracker-playback';
import { AhxEncodeError, serializeAhx } from 'src/audio/tracker/song-export/ahx-writer';
import { docToSong } from './doc';
import { toLatin1 } from './latin1';
import type { AhxDoc } from './types';

/** What an empty song name imports as (`importAhxToTrackerSong`'s title fallback). */
export const AHX_IMPORT_FALLBACK_TITLE = 'Imported AHX';

/** The part of an instrument slot the file needs: slot `n` holds instrument `n + 1`. */
export interface AhxFileSlot {
  readonly ahxData?: AhxInstrument | undefined;
}

export interface BuildAhxFileInput {
  readonly doc: AhxDoc;
  readonly slots: readonly AhxFileSlot[];
  /** The song's title in the editor: it is the name written to the file (see `songNameFor`). */
  readonly title: string;
}

export interface BuiltAhxFile {
  readonly bytes: Uint8Array;
  /** The title had characters the format cannot hold (NUL, above U+00FF) that were removed or replaced. */
  readonly titleAltered: boolean;
  /** Some instrument name did. */
  readonly instrumentNamesAltered: boolean;
}

const PLACEHOLDER: AhxInstrument = {
  name: '',
  volume: 0,
  waveLength: 0,
  filterLowerLimit: 0,
  filterUpperLimit: 0,
  filterSpeed: 0,
  squareLowerLimit: 0,
  squareUpperLimit: 0,
  squareSpeed: 0,
  vibratoDelay: 0,
  vibratoSpeed: 0,
  vibratoDepth: 0,
  hardCutRelease: false,
  hardCutReleaseFrames: 0,
  envelope: { aFrames: 0, aVolume: 0, dFrames: 0, dVolume: 0, sFrames: 0, rFrames: 0, rVolume: 0 },
  plist: { speed: 0, entries: [] },
};

/**
 * The name to write: the doc's own raw name when the title is still what the
 * import derived from it (trimmed, with the fallback), so edge whitespace
 * survives and an unchanged rename never writes the fallback into the file;
 * otherwise the title as the format can hold it. For a new song the doc's name
 * is the title, so this is "the title, as latin-1".
 */
export function songNameFor(doc: AhxDoc, title: string): { name: string; altered: boolean } {
  if (title === (doc.songName.trim() || AHX_IMPORT_FALLBACK_TITLE)) return { name: doc.songName, altered: false };
  const { text, altered } = toLatin1(title);
  return { name: text, altered };
}

/**
 * The instruments the slots hold, as the writer's list (index 0 the unused
 * placeholder). Slot `n` is instrument `n + 1`; they are numbered without gaps.
 */
export function instrumentsFromSlots(slots: readonly AhxFileSlot[]): { instruments: AhxInstrument[]; namesAltered: boolean } {
  let count = 0;
  slots.forEach((slot, i) => {
    if (slot.ahxData !== undefined) count = i + 1;
  });
  // Index 0 is the placeholder the parser leaves; the writer never reads it.
  const instruments: AhxInstrument[] = [PLACEHOLDER];
  let namesAltered = false;
  for (let n = 1; n <= count; n++) {
    const data = slots[n - 1]?.ahxData;
    if (data === undefined) {
      throw new AhxEncodeError(`instrument ${n} is missing from the song while instrument ${count} exists (AHX numbers them without gaps)`);
    }
    const name = toLatin1(data.name);
    if (name.altered) namesAltered = true;
    instruments.push({ ...data, name: name.text });
  }
  return { instruments, namesAltered };
}

/**
 * The file: the doc's structure, the slots' instruments and the title's name,
 * written by the one writer everything shares (Export, the `.cmod`'s `ahxFile`
 * and the engine's bytes), so they cannot disagree. A doc that came from a file
 * keeps that file's bytes as `base`, so an unedited song is written back to
 * exactly the bytes it came from. Throws `AhxEncodeError` for what the format
 * cannot hold (a doc reached through the ops never does).
 */
export function buildAhxFile({ doc, slots, title }: BuildAhxFileInput): BuiltAhxFile {
  const { instruments, namesAltered } = instrumentsFromSlots(slots);
  const { name, altered } = songNameFor(doc, title);
  const song = docToSong({ ...doc, songName: name }, instruments);
  const bytes = serializeAhx(song, doc.base === undefined ? {} : { base: doc.base });
  return { bytes, titleAltered: altered, instrumentNamesAltered: namesAltered };
}
