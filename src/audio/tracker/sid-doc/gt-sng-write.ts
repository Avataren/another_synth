import { sidDocProblem } from './doc';
import {
  GT_INSTRUMENT_NAME_LENGTH,
  GT_MAGIC_GTS5,
  GT_MAX_ORDERLIST_BYTES,
  GT_MAX_TRANSPOSE,
  GT_MIN_TRANSPOSE,
  GT_ORDER_END,
  GT_TEXT_LENGTH,
  GT_TRANSPOSE_ZERO,
  gtRepeatByte,
} from './gt-sng-common';
import {
  GT_GATE_NO_GATEOFF,
  GT_GATE_NO_HARD_RESTART,
  GT_NOTE_FIRST,
  GT_NOTE_KEY_OFF,
  GT_NOTE_KEY_ON,
  GT_NOTE_REST,
  GT_PATTERN_END,
} from './gt-sng-read';
import {
  SID_DEFAULT_TEMPO,
  SID_NOTE_KEY_OFF,
  SID_NOTE_KEY_ON,
  SID_NOTE_NONE,
  SID_TABLE_NAMES,
  type SidDoc,
  type SidOrderlist,
} from './types';

/**
 * `SidDoc` -> GoatTracker 2 `.sng` (`GTS5`, readme §6.1), the canonical
 * writer format. For every doc it writes, `importGtSong` gives the doc back
 * (with the same hints): the round-trip gate of plan-sid-tracking.md S5.
 *
 * It refuses (the reason is TRUE and written for the user) what a `.sng`
 * cannot hold without changing the music: a starting tempo other than GT's 6,
 * a transpose outside GT's orderlist range, an
 * orderlist longer than GT's 254 bytes, a NUL inside a text. What the file has
 * no field for but GT takes from its command line (the chip model, the speed
 * multiplier) is written anyway and reported in `notes`.
 */

export type GtSongExport =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly notes: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** Why `doc` cannot be written as a `.sng`, or null. */
export function gtSongExportProblem(doc: SidDoc): string | null {
  const problem = sidDocProblem(doc);
  if (problem !== null) return `the song breaks a rule of the SID model (${problem})`;
  if (doc.tempo !== SID_DEFAULT_TEMPO) {
    return `a .sng has no tempo field (GoatTracker starts every song at tempo ${SID_DEFAULT_TEMPO}) and this song starts at tempo ${doc.tempo}; put an F command with the tempo on its first row instead`;
  }
  for (const [text, what] of [
    [doc.songName, 'the song name'],
    [doc.author, 'the author'],
    [doc.copyright, 'the copyright'],
    ...doc.instruments.map((ins, i) => [ins.name, `instrument ${i + 1}'s name`] as const),
  ] as const) {
    if (text.includes('\0')) return `${what} contains a NUL character, which ends a .sng text field early`;
  }
  for (const [s, subsong] of doc.subsongs.entries()) {
    for (const [c, list] of subsong.orderlists.entries()) {
      const bad = list.entries.findIndex((e) => e.transpose < GT_MIN_TRANSPOSE || e.transpose > GT_MAX_TRANSPOSE);
      if (bad >= 0) {
        return `subsong ${s} channel ${c + 1} entry ${bad} transposes by ${list.entries[bad]!.transpose}; a GoatTracker orderlist transposes ${GT_MIN_TRANSPOSE}..+${GT_MAX_TRANSPOSE}`;
      }
      const n = gtOrderlistByteLength(list);
      if (n > GT_MAX_ORDERLIST_BYTES) {
        return `subsong ${s} channel ${c + 1}'s orderlist needs ${n} bytes with its repeats and transposes; GoatTracker's holds ${GT_MAX_ORDERLIST_BYTES}`;
      }
    }
  }
  return null;
}

/**
 * The GT orderlist bytes of `list` (readme §6.1.2), endmark and restart
 * included: each entry's transpose when it changes (and, at the restart
 * entry, when the loop would otherwise carry the end's transpose into it),
 * its repeat when above 1 (`gtRepeatByte`; TRANSPOSE before REPEAT, readme
 * §3.1), its pattern.
 */
/** The bytes `list` takes in a `.sng` (endmark and restart not counted): at most `GT_MAX_ORDERLIST_BYTES`. */
export const gtOrderlistByteLength = (list: SidOrderlist): number => gtOrderlistBytes(list).length - 2;

/** `list` as GT's orderlist bytes, the endmark and the restart byte last (what the `.sng` and GT's packer read). */
export function gtOrderlistBytes(list: SidOrderlist): number[] {
  const out: number[] = [];
  const last = list.entries[list.entries.length - 1]!.transpose;
  let transpose = 0;
  let restartByte = 0;
  for (const [i, e] of list.entries.entries()) {
    if (i === list.restart) restartByte = out.length;
    if (e.transpose !== transpose || (i === list.restart && e.transpose !== last)) {
      out.push(GT_TRANSPOSE_ZERO + e.transpose);
      transpose = e.transpose;
    }
    if (e.repeat > 1) out.push(gtRepeatByte(e.repeat));
    out.push(e.pattern);
  }
  out.push(GT_ORDER_END, restartByte);
  return out;
}

/** A doc row's note as GT's pattern byte (`REST`, `KEYOFF`, `KEYON` or `FIRSTNOTE + index`). */
export function gtNoteByte(note: number): number {
  if (note === SID_NOTE_NONE) return GT_NOTE_REST;
  if (note === SID_NOTE_KEY_OFF) return GT_NOTE_KEY_OFF;
  if (note === SID_NOTE_KEY_ON) return GT_NOTE_KEY_ON;
  return GT_NOTE_FIRST + note - 1;
}

/** The `.sng` of `doc`, or why it cannot be one. Never throws. */
export function exportGtSong(doc: SidDoc): GtSongExport {
  const problem = gtSongExportProblem(doc);
  if (problem !== null) return { ok: false, reason: problem };
  const out: number[] = [];
  const text = (s: string, length: number) => {
    for (let i = 0; i < length; i++) out.push(i < s.length ? s.charCodeAt(i) : 0);
  };
  // §6.1.1 header.
  for (let i = 0; i < 4; i++) out.push(GT_MAGIC_GTS5.charCodeAt(i));
  text(doc.songName, GT_TEXT_LENGTH);
  text(doc.author, GT_TEXT_LENGTH);
  text(doc.copyright, GT_TEXT_LENGTH);
  out.push(doc.subsongs.length);
  // §6.1.2 orderlists: length (endmark counted, restart not), data, restart.
  for (const subsong of doc.subsongs) {
    for (const list of subsong.orderlists) {
      const bytes = gtOrderlistBytes(list);
      out.push(bytes.length - 1, ...bytes);
    }
  }
  // §6.1.3 instruments.
  out.push(doc.instruments.length);
  for (const ins of doc.instruments) {
    out.push(
      (ins.attack << 4) | ins.decay,
      (ins.sustain << 4) | ins.release,
      ins.wavePtr,
      ins.pulsePtr,
      ins.filterPtr,
      ins.speedPtr,
      ins.vibratoDelay,
      (ins.hardRestart ? 0 : GT_GATE_NO_HARD_RESTART) | (ins.noGateOff ? GT_GATE_NO_GATEOFF : 0) | ins.gateTimer,
      ins.firstWave,
    );
    text(ins.name, GT_INSTRUMENT_NAME_LENGTH);
  }
  // §6.1.4 tables: n, n left bytes, n right bytes.
  for (const name of SID_TABLE_NAMES) {
    const table = doc.tables[name];
    out.push(table.length);
    for (const row of table) out.push(row.left);
    for (const row of table) out.push(row.right);
  }
  // §6.1.5/6 patterns: the stored length counts the $FF end row (measured).
  out.push(doc.patterns.length);
  for (const pattern of doc.patterns) {
    out.push(pattern.rows.length + 1);
    for (const r of pattern.rows) out.push(gtNoteByte(r.note), r.instrument, r.command, r.param);
    out.push(GT_PATTERN_END, 0, 0, 0);
  }

  const notes = [`the chip model (${doc.chipModel}) is not stored in a .sng: GoatTracker takes it from its -E option`];
  if (doc.speedMultiplier !== 1) {
    notes.push(`the ${doc.speedMultiplier}x speed is not stored in a .sng: play it in GoatTracker with -S${doc.speedMultiplier}`);
  }
  return { ok: true, bytes: Uint8Array.from(out), notes };
}
