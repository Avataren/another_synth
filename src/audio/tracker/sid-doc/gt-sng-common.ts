import { SID_CHANNELS, type SidChipModel, type SidOrderEntry, type SidOrderlist } from './types';

/**
 * What the GoatTracker `.sng` reader and writer share (plan-sid-tracking.md
 * S5). Written from GoatTracker v2.72's readme §6.1 (the format) and §3.1
 * (orderlist semantics) and from the bytes of the curated corpus; no
 * GoatTracker source was read (the D-log, `.ai/sid-import-dlog.md`, cites
 * each offset and marks what the readme does not say as INFERRED). S5.10
 * corrected the repeat count against GT2's player source (gplay.c, read for
 * its facts only).
 */

/** Readme §6.1.1: the 4-byte identification string at +0. */
export const GT_MAGIC_GTS5 = 'GTS5';
/** GoatTracker v1's song identification (not in the v2 readme; measured on 22 corpus files). */
export const GT_MAGIC_GT1 = 'GTS!';
/** Readme §6.1.1: song name +4, author +36, copyright +68, each 32 bytes padded with zeros. */
export const GT_TEXT_OFFSETS = [4, 36, 68] as const;
export const GT_TEXT_LENGTH = 32;
/** Readme §6.1.1: the number of subtunes, the byte at +100; the orderlists follow at +101. */
export const GT_SUBTUNE_COUNT_OFFSET = 100;
/** Readme §6.1.3: the instrument name is the last 16 of an instrument's 25 bytes. */
export const GT_INSTRUMENT_NAME_LENGTH = 16;
/**
 * Readme §6.1.2: orderlist values. A repeat byte $D0 + k plays the next
 * pattern k + 1 times, $D0 once to $DF 16 times: GT stores k and replays the
 * pattern while it counts down (gplay.c:977-986), and shows R((k + 1) & 15),
 * so "R0" is 16 plays (gdisplay.c:265, readme §3.1). S5.10: S5 read it as
 * `k || 16` plays, one short (and $D0 as 16).
 */
export const GT_ORDER_REPEAT = 0xd0;
/** The doc's repeat (plays, 1..16) of repeat byte `v` ($D0-$DF). */
export const gtRepeatPlays = (v: number): number => (v & 0x0f) + 1;
/** The repeat byte of `plays` (2..16; 1 needs none). */
export const gtRepeatByte = (plays: number): number => GT_ORDER_REPEAT + plays - 1;
export const GT_ORDER_TRANSPOSE = 0xe0;
export const GT_ORDER_END = 0xff;
/** Readme §3.1: transpose 0 is $F0 (up 0-14 = $F0-$FE, down 1-15 = $EF-$E1; $E0 is -16, INFERRED). */
export const GT_TRANSPOSE_ZERO = 0xf0;
export const GT_MIN_TRANSPOSE = -16;
export const GT_MAX_TRANSPOSE = 14;
/** Readme §3.1: "254 pattern numbers/commands + the endmark". */
export const GT_MAX_ORDERLIST_BYTES = 254;

/** Something the import did that the `.sng` does not say, or could not carry into the doc. */
export type GtImportNoteKind =
  /** An instrument pointed past its table's stored rows: the table was padded with blank rows. */
  | 'table-padded'
  /** HR/Gate Timer bit $40 (no gate-off): the doc has no such flag; imported as timer 0, no hard restart. */
  | 'no-gateoff'
  /** An orderlist loops to a point where GT's running transpose/repeat differs from the first pass. */
  | 'loop-transpose'
  /** GoatTracker v1 conversions (each INFERRED from the corpus bytes, see the D-log). */
  | 'gt1-convert'
  /** GoatTracker v1 data the doc cannot hold, dropped. */
  | 'gt1-dropped';

export interface GtImportNote {
  readonly kind: GtImportNoteKind;
  readonly message: string;
}

/** The playback facts a `.sng` file does not carry (GoatTracker takes them from its command line). */
export interface GtSongHints {
  /** GT's `-E` option; default: the house default (`SID_DEFAULT_CHIP_MODEL`). */
  chipModel?: SidChipModel;
  /** GT's `-S` option (1 = 50 Hz); default 1. */
  speedMultiplier?: number;
}

/**
 * The hints a corpus file's NAME gives: GoatTracker authors tag what the file
 * cannot hold in the file name (`defunkt_final_fv_po_ro_6581_ffff.sng`,
 * `space_2x.sng`, `mw title remix, 2x-speed.sng`). A `6581`/`8580` token names
 * the chip, an `Nx` token (N 2..16) the speed multiplier. INFERRED: a naming
 * convention of the corpus, not part of any format.
 */
export function gtSongHintsFromName(name: string): GtSongHints {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    // A name with a stray '%' is used as it is.
  }
  const base = decoded.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.sng$/, '');
  const hints: GtSongHints = {};
  const chip = /(?:^|[^0-9a-z])(6581|8580)(?![0-9a-z])/.exec(base);
  if (chip) hints.chipModel = chip[1] as SidChipModel;
  const speed = /(?:^|[^0-9a-z])(\d{1,2})x(?![0-9a-z])/.exec(base);
  if (speed) {
    const n = Number(speed[1]);
    if (n >= 2 && n <= 16) hints.speedMultiplier = n;
  }
  return hints;
}

/** A bounds-checked byte reader whose failures say where the file ended. */
export class GtReader {
  at: number;
  constructor(
    readonly bytes: Uint8Array,
    at = 0,
  ) {
    this.at = at;
  }
  byte(what: string): number {
    const v = this.bytes[this.at];
    if (v === undefined) throw new GtFormatError(`the file ends inside ${what}`);
    this.at += 1;
    return v;
  }
  take(n: number, what: string): Uint8Array {
    if (this.at + n > this.bytes.length) throw new GtFormatError(`the file ends inside ${what}`);
    const out = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  get left(): number {
    return this.bytes.length - this.at;
  }
}

/** A reason the bytes are not a song this reader accepts. Caught at the API edge, never escapes. */
export class GtFormatError extends Error {}

/** Latin-1 text of a zero-padded field: up to the first NUL (readme §6.1.1 "padded with zeros"). */
export function gtText(field: Uint8Array): string {
  let s = '';
  for (const b of field) {
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/** A byte as two upper-case hex digits (for refusal texts). */
export const hex = (b: number): string => b.toString(16).toUpperCase().padStart(2, '0');

export function magicOf(bytes: Uint8Array): string {
  return bytes.length < 4 ? '' : String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
}

/**
 * Reads the orderlists (readme §6.1.2): for each subtune, for each channel, a
 * length byte n, then n+1 bytes: n bytes of data whose last is the RST
 * endmark $FF (measured: n counts the endmark), then the restart position.
 */
export function readGtOrderlists(r: GtReader, subtunes: number, channels = SID_CHANNELS): Uint8Array[][] {
  const out: Uint8Array[][] = [];
  for (let s = 0; s < subtunes; s++) {
    const lists: Uint8Array[] = [];
    for (let c = 0; c < channels; c++) {
      const n = r.byte(`subtune ${s} channel ${c + 1}'s orderlist`);
      lists.push(r.take(n + 1, `subtune ${s} channel ${c + 1}'s orderlist`));
    }
    out.push(lists);
  }
  return out;
}

/**
 * One raw orderlist as the doc's: GoatTracker's commands are state (readme
 * §3.1: a TRANSPOSE holds until the next one; a REPEAT applies to the pattern
 * after it), the doc's entries each carry their own, so the first pass is
 * played through and every pattern gets the transpose and repeat it plays
 * with. The restart byte indexes the orderlist BYTES; it becomes the entry
 * whose command run (or pattern byte) it points into.
 *
 * `loopDiffers`: GT keeps the running transpose when it loops (§3.1
 * "Transpose is automatically reset only when starting the song, not when
 * looping"), so a loop that does not restate it plays the looped entries with
 * the end-of-list transpose. The doc can only hold the first pass's; this says
 * when the second pass would differ.
 */
export function decodeGtOrderlist(
  data: Uint8Array,
  where: string,
  patternCount: number,
): { list: SidOrderlist; loopDiffers: boolean } {
  const n = data.length - 1;
  if (n < 1 || data[n - 1] !== GT_ORDER_END) throw new GtFormatError(`${where}'s orderlist has no RST endmark`);
  const restartByte = data[n]!;
  if (restartByte >= n - 1) throw new GtFormatError(`${where}'s orderlist restarts at byte ${restartByte}, past its end`);
  const entries: SidOrderEntry[] = [];
  const patternAt: number[] = [];
  let transpose = 0;
  let repeat = 1;
  let run = -1;
  for (let k = 0; k < n - 1; k++) {
    const v = data[k]!;
    if (run < 0) run = k;
    if (v === GT_ORDER_END) throw new GtFormatError(`${where}'s orderlist has an endmark before its end`);
    if (v >= GT_ORDER_TRANSPOSE) {
      transpose = v - GT_TRANSPOSE_ZERO;
    } else if (v >= GT_ORDER_REPEAT) {
      repeat = gtRepeatPlays(v);
    } else {
      if (v >= patternCount) throw new GtFormatError(`${where}'s orderlist plays pattern ${v}, but the song has ${patternCount}`);
      entries.push({ pattern: v, transpose, repeat });
      patternAt.push(k);
      repeat = 1;
      run = -1;
    }
  }
  if (entries.length === 0) throw new GtFormatError(`${where}'s orderlist plays no pattern`);
  if (run >= 0) throw new GtFormatError(`${where}'s orderlist ends with a command, not a pattern (readme §3.1)`);
  const restart = patternAt.findIndex((at) => at >= restartByte);
  // The second pass, from the restart byte with the running state GT keeps.
  let loopTranspose = transpose;
  let loopRepeat = 1;
  let e = restart;
  let loopDiffers = false;
  for (let k = restartByte; k < n - 1; k++) {
    const v = data[k]!;
    if (v >= GT_ORDER_TRANSPOSE) loopTranspose = v - GT_TRANSPOSE_ZERO;
    else if (v >= GT_ORDER_REPEAT) loopRepeat = gtRepeatPlays(v);
    else {
      const first = entries[e]!;
      if (first.transpose !== loopTranspose || first.repeat !== loopRepeat) loopDiffers = true;
      loopRepeat = 1;
      e += 1;
    }
  }
  return { list: { entries, restart }, loopDiffers };
}
