import type { TrackerSongFile } from 'src/stores/tracker-store';
import { CURRENT_SONG_FILE_VERSION, TOTAL_SLOTS } from 'src/stores/tracker-store';
import type { InstrumentSlot } from 'src/stores/tracker-store';
import {
  formatInstrumentId,
  midiToTrackerNote,
  type TrackerEntryData,
  type TrackerPattern,
} from '@another-synth/tracker-playback';
import { createA2mPlayer, type A2mPlayerClient, type A2mSongInfo } from 'src/audio/tracker/a2m-player';
import { encodeA2mFile } from 'src/audio/tracker/a2m-file-codec';

/**
 * Adlib Tracker II (`.a2m`, .ai/plan-opl.md O7 step 4): playback only (D3),
 * like AHX. Assembly only, like the other `*-import.ts` files, except that
 * the parser is the Rust one: the module is loaded into an OPL worklet in
 * song mode (`A2Player`), and the grid is built from what it answers
 * (`song-loaded`: the order list, the tracks, and each ordered pattern's cells
 * as the engine plays them). So a module the player refuses is refused here,
 * with its one sentence, before anything is shown. The file's bytes travel
 * in the song file (`data.a2mFile`): they are what plays.
 *
 * What the grid shows: notes (AT2's note 1 is C-0), key-off as `###`, the
 * instrument number, and both effect columns in AT2's own letters (`0`..`Z`,
 * `&`, `%`, `!`, `@`, `=`, `#`, `$`, `~`, `^`, `` ` ``, `>`, `<`) with the
 * parameter in hex: display text, decoded by nothing.
 */

/** `_A2module_`: every A2M file's first ten bytes. */
const A2M_MAGIC = '_A2module_';
/** `_A2tiny_module_`: an A2T, which the player refuses (with its reason). */
const A2T_MAGIC = '_A2tiny_module_';

function startsWith(bytes: Uint8Array, magic: string): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic.charCodeAt(i)) return false;
  return true;
}

/** An Adlib Tracker II module (A2M, or A2T so the refusal can say why). */
export function looksLikeA2m(bytes: Uint8Array): boolean {
  return startsWith(bytes, A2M_MAGIC) || startsWith(bytes, A2T_MAGIC);
}

/** AT2's effect letters by v9+ effect number (`techinfo.htm`'s table: 0x00..0x2F). */
const EFFECT_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ&%!@=#$~^`><';
/** The engine's number for a v5-8 manual slide (0x16), which AT2 converts to &4x/&5y on load. */
const OLD_RAW_FINE = 0xf0;
const KEY_OFF = 255;
/** AT2's note 1 is C-0: MIDI 12. */
const NOTE_TO_MIDI = 11;
const CELL_BYTES = 6;

const hex2 = (v: number) => v.toString(16).toUpperCase().padStart(2, '0');

/** One effect column as AT2 writes it, or undefined for an empty one. */
export function a2mEffectText(fx: number, param: number): string | undefined {
  if (fx === 0 && param === 0) return undefined;
  if (fx === OLD_RAW_FINE) {
    const up = param >> 4;
    return up !== 0 ? `&4${up.toString(16).toUpperCase()}` : `&5${(param & 15).toString(16).toUpperCase()}`;
  }
  const letter = EFFECT_CHARS[fx];
  return letter === undefined ? `?${hex2(param)}` : `${letter}${hex2(param)}`;
}

/** The id of pattern `pattern`'s grid pattern (stable, so a reload keeps a selection). */
export function a2mPatternId(pattern: number): string {
  return `a2m-pat-${pattern}`;
}

function entryFor(row: number, cell: Uint8Array | number[], at: number): TrackerEntryData | undefined {
  const note = cell[at] ?? 0;
  const instrument = cell[at + 1] ?? 0;
  const fx1 = a2mEffectText(cell[at + 2] ?? 0, cell[at + 3] ?? 0);
  const fx2 = a2mEffectText(cell[at + 4] ?? 0, cell[at + 5] ?? 0);
  if (note === 0 && instrument === 0 && fx1 === undefined && fx2 === undefined) return undefined;
  const entry: TrackerEntryData = { row };
  if (note === KEY_OFF) entry.note = '###';
  else if (note > 0) entry.note = midiToTrackerNote(note + NOTE_TO_MIDI);
  if (instrument > 0) entry.instrument = formatInstrumentId(instrument);
  if (fx1 !== undefined) entry.macro = fx1;
  if (fx2 !== undefined) entry.macro2 = fx2;
  return entry;
}

/** The grid pattern for pattern `pattern`'s cells. */
function buildPattern(info: A2mSongInfo, pattern: number, cells: Uint8Array): TrackerPattern {
  const tracks = info.tracks;
  const rows = info.rowsPerPattern;
  return {
    id: a2mPatternId(pattern),
    name: `Pattern ${pattern}`,
    rows,
    tracks: Array.from({ length: tracks }, (_, t) => {
      const entries: TrackerEntryData[] = [];
      for (let r = 0; r < rows; r++) {
        const at = (r * tracks + t) * CELL_BYTES;
        if (at + CELL_BYTES > cells.length) break;
        const entry = entryFor(r, cells, at);
        if (entry) entries.push(entry);
      }
      return { id: `a2m-pat-${pattern}-t${t}`, name: `Ch ${t + 1}`, entries };
    }),
  };
}

/** Name-only slots (`opl`/`a2m`, no patch, no data): the worklet plays the file's instruments. */
function buildA2mSlots(info: A2mSongInfo): InstrumentSlot[] {
  const slots: InstrumentSlot[] = Array.from({ length: TOTAL_SLOTS }, (_, i) => ({
    slot: i + 1,
    bankName: '',
    patchName: '',
    instrumentName: '',
  }));
  info.instrumentNames.forEach((raw, i) => {
    const slot = slots[i];
    if (!slot) return;
    const name = raw.trim() || `Instrument ${formatInstrumentId(i + 1)}`;
    slot.bankName = 'A2M Import';
    slot.patchName = name;
    slot.instrumentName = name;
    slot.source = 'song';
    slot.instrumentType = 'opl';
    slot.instrumentFormat = 'a2m';
  });
  return slots;
}

/** The display song for a module the worklet loaded and described as `info`. */
export function buildA2mTrackerSong(bytes: Uint8Array, info: A2mSongInfo): TrackerSongFile {
  const patterns = info.patterns.map((p) => buildPattern(info, p.pattern, p.cells));
  const sequence = info.orders.map(a2mPatternId);
  return {
    version: CURRENT_SONG_FILE_VERSION,
    data: {
      currentSong: {
        title: info.name.trim() || 'Untitled A2M module',
        author: info.composer.trim() || 'Unknown',
        bpm: 125,
      },
      moduleFormat: 'a2m',
      patternRows: info.rowsPerPattern,
      stepSize: 1,
      patterns,
      sequence,
      currentPatternId: sequence[0] ?? null,
      instrumentSlots: buildA2mSlots(info),
      activeInstrumentId: null,
      currentInstrumentPage: 0,
      songPatches: {},
      a2mFile: encodeA2mFile(bytes),
    },
  };
}

/**
 * Load `data` in a throwaway OPL worklet and build the display song from its
 * answer. Rejects with the player's refusal (`Cannot play this A2M module:
 * ...`) for a module it will not play. The context must be able to run (a
 * suspended one is resumed; a file open is a gesture).
 */
export async function importA2mToTrackerSong(
  data: ArrayBuffer,
  audioContext: BaseAudioContext,
  createPlayer: (context: BaseAudioContext) => Promise<A2mPlayerClient> = createA2mPlayer,
): Promise<TrackerSongFile> {
  const bytes = new Uint8Array(data.slice(0));
  if ('resume' in audioContext && audioContext.state === 'suspended') {
    await (audioContext as AudioContext).resume().catch(() => undefined);
  }
  const client = await createPlayer(audioContext);
  try {
    const info = await client.loadSong(bytes);
    return buildA2mTrackerSong(bytes, info);
  } finally {
    client.dispose();
  }
}
