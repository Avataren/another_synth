import type { TrackerSongFile } from 'src/stores/tracker-store';
import { CURRENT_SONG_FILE_VERSION, TOTAL_SLOTS } from 'src/stores/tracker-store';
import type { InstrumentSlot } from 'src/stores/tracker-store';
import { formatInstrumentId } from '@another-synth/tracker-playback';
import { createA2mPlayer, type A2mPlayerClient } from 'src/audio/tracker/a2m-player';
import { decodeA2mFile } from 'src/audio/tracker/a2m-file-codec';
import {
  a2mDocOf,
  a2mSongFromBytes,
  a2mText,
  newA2mSong,
  type A2mInstrumentJson,
  type A2mSongJson,
} from 'src/audio/tracker/a2m-codec';
import { a2mEffectColumnText, a2mGridOf, a2mPatternId } from 'src/audio/tracker/a2m-grid';
import { a2mInstrumentName, isEmptyA2mInstrument } from 'src/audio/tracker/a2m-instrument';

export { a2mPatternId };

/**
 * Adlib Tracker II (`.a2m`, .ai/plan-opl.md O7, and the editor that followed
 * it): assembly only, like the other `*-import.ts` files. The Rust parser
 * (`rust-wasm/src/opl/a2`, here through `a2m-codec.ts`) reads the module into
 * a song; `a2m-grid.ts` makes the grid of its patterns, the song's doc keeps
 * the rest, and the module is compiled back from the two to play and to
 * export. A module the player refuses (it has to play what it opens) is
 * refused here with the player's sentence, before anything is shown.
 *
 * What the grid shows: notes (AT2's note 1 is C-0), key-off as `###`, the
 * instrument number, and both effect columns in AT2's own letters (`0`..`Z`,
 * `&`, `%`, `!`, `@`, `=`, `#`, `$`, `~`, `^`, `` ` ``, `>`, `<`) with the
 * parameter in hex.
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

/** The engine's number for a v5-8 manual slide (0x16), which AT2 converts to &4x/&5y on load. */
const OLD_RAW_FINE = 0xf0;

/** One effect column as AT2 writes it, or undefined for an empty one. */
export function a2mEffectText(fx: number, param: number): string | undefined {
  if (fx === OLD_RAW_FINE && param !== 0) {
    const up = param >> 4;
    return up !== 0 ? `&4${up.toString(16).toUpperCase()}` : `&5${(param & 15).toString(16).toUpperCase()}`;
  }
  return a2mEffectColumnText(fx, param);
}

/**
 * Make `slot` the one the doc's `instrument` is: its name, and an empty one
 * left empty (it opens the editor all the same: that is where one is made).
 */
export function applyA2mSlot(slot: InstrumentSlot, instrument: A2mInstrumentJson): void {
  const name = a2mInstrumentName(instrument);
  slot.instrumentFormat = 'a2m';
  if (isEmptyA2mInstrument(instrument) && name === '') {
    slot.bankName = '';
    slot.patchName = '';
    slot.instrumentName = '';
    delete slot.source;
    delete slot.instrumentType;
    return;
  }
  const shown = name || `Instrument ${formatInstrumentId(slot.slot)}`;
  slot.bankName = 'AdLib FM';
  slot.patchName = shown;
  slot.instrumentName = shown;
  slot.source = 'song';
  slot.instrumentType = 'opl';
}

/** Name-only slots (`opl`/`a2m`, no patch): the instrument itself is the song doc's. */
function buildA2mSlots(song: A2mSongJson): InstrumentSlot[] {
  const slots: InstrumentSlot[] = Array.from({ length: TOTAL_SLOTS }, (_, i) => ({
    slot: i + 1,
    bankName: '',
    patchName: '',
    instrumentName: '',
    instrumentFormat: 'a2m' as const,
  }));
  song.instruments.forEach((instrument, i) => {
    const slot = slots[i];
    if (slot) applyA2mSlot(slot, instrument);
  });
  return slots;
}

/** The display song for `song`: the grid, the slots' names and the doc that, with the grid, is the module. */
export function buildA2mTrackerSong(song: A2mSongJson): TrackerSongFile {
  const { patterns, sequence } = a2mGridOf(song);
  return {
    version: CURRENT_SONG_FILE_VERSION,
    data: {
      currentSong: {
        title: a2mText(song.name).trim() || 'Untitled A2M module',
        author: a2mText(song.composer).trim() || 'Unknown',
        bpm: 125,
      },
      moduleFormat: 'a2m',
      patternRows: song.pattern_len,
      stepSize: 1,
      patterns,
      sequence,
      currentPatternId: sequence[0] ?? null,
      instrumentSlots: buildA2mSlots(song),
      activeInstrumentId: null,
      currentInstrumentPage: 0,
      songPatches: {},
      a2mDoc: a2mDocOf(song),
    },
  };
}

/** An empty module: one blank pattern, one usable instrument, AT2's tempo and speed. 9 tracks (OPL2) or 18 (OPL3). */
export async function createNewA2mTrackerSong(opl3: boolean): Promise<TrackerSongFile> {
  const song = buildA2mTrackerSong(await newA2mSong(opl3));
  song.data.currentSong.title = 'Untitled module';
  song.data.currentSong.author = '';
  return song;
}

/**
 * Open `data`: parse it, and load it in a throwaway OPL worklet so a module
 * the player refuses is refused here, with its one sentence (`Cannot play
 * this A2M module: ...`). The context must be able to run (a suspended one is
 * resumed; a file open is a gesture).
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
    await client.loadSong(bytes);
  } finally {
    client.dispose();
  }
  return buildA2mTrackerSong(await a2mSongFromBytes(bytes));
}

/**
 * A song file an older build saved (`data.a2mFile`: the module's bytes and a
 * read-only grid) becomes today's (`data.a2mDoc` and an editable grid), by
 * reading its module again. A file with a doc, or no module, is returned as is.
 */
export async function upgradeLegacyA2mSongFile(songFile: TrackerSongFile): Promise<TrackerSongFile> {
  const data = songFile.data;
  if (data?.moduleFormat !== 'a2m' || data.a2mDoc !== undefined || data.a2mFile === undefined) return songFile;
  const decoded = decodeA2mFile(data.a2mFile);
  if (!decoded.ok) return songFile;
  return buildA2mTrackerSong(await a2mSongFromBytes(decoded.bytes));
}
