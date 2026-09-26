import { sidTableFreqReg } from '@another-synth/tracker-playback';
import { importGtSong, SID_MAX_INSTRUMENTS, type SidChipModel, type SidDoc } from 'src/audio/tracker/sid-doc';
import { parseAsmTree, type AsmStmt } from 'src/audio/tracker/sid-export/asm6502';
import {
  exportSid,
  GT_PACK_DEFAULTS,
  GT_PLAYER_SOURCE,
  gtTableDuplicateRows,
  PAL_FRAME_CIA,
  SID_EXPORT_DEFAULTS,
  type GtPackOptions,
} from 'src/audio/tracker/sid-export';
import type { PsidFile } from '../psid-file';
import { matchPlayer, type PlayerMatch } from './player-match';

/**
 * A `.sid` that GoatTracker made, unpacked into the song it was made from
 * (plan-psid-import.md phase 4): the inverse of `sid-export/gt-pack.ts`.
 *
 * The file is GoatTracker's player (`player.s`, the build its relocator chose
 * for the song) with the song data after it. `player-match.ts` recovers the
 * build from the code: the defines and the address of every table the code
 * reads. The data is then read back through each of the packer's steps:
 * orderlists (a repeat is written after its pattern), patterns (an unchanged
 * command and a repeated instrument are left out, runs of rests packed, a
 * tempo's parameter one less), the instruments renumbered into normal,
 * no-hard-restart and legato groups, the tables as the build encodes them.
 * What comes out is a GoatTracker 2 song file (GTS5), read like any `.sng`,
 * so the doc is the one a `.sng` import makes.
 *
 * What the packer dropped does not come back: instrument names, instruments
 * and table rows nothing used, the instrument written again on a note that
 * already had it. None of it is heard. The unpack is checked by packing the
 * doc again: `exact` when that gives the file's bytes.
 */

export type GtUnpack =
  | {
      readonly ok: true;
      readonly doc: SidDoc;
      /** Packing `doc` again gives the file's C64 bytes, byte for byte. */
      readonly exact: boolean;
      /** Things the user should know. */
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

let playerTree: readonly AsmStmt[] | null = null;
function tree(): readonly AsmStmt[] {
  if (playerTree === null) {
    const parsed = parseAsmTree(GT_PLAYER_SOURCE);
    if (!parsed.ok) throw new Error(`player.s does not parse (line ${parsed.line}: ${parsed.reason})`);
    playerTree = parsed.stmts;
  }
  return playerTree;
}

class Unreadable extends Error {}

const hex4 = (v: number): string => `$${v.toString(16).toUpperCase().padStart(4, '0')}`;

/** GoatTracker's own multispeed front (`gt-psid.ts`): ldx #lo / stx $dc04 / ldx #hi / stx $dc05. */
function speedMultiplierOf(file: PsidFile, base: number): number | null {
  if (file.initAddress === base) return 1;
  if (file.initAddress !== base - 10) return null;
  const at = (a: number): number => file.data[a - file.loadAddress] ?? -1;
  const s = base - 10;
  const expect = [0xa2, -1, 0x8e, 0x04, 0xdc, 0xa2, -1, 0x8e, 0x05, 0xdc];
  if (!expect.every((b, i) => b < 0 || at(s + i) === b)) return null;
  const latch = at(s + 1) | (at(s + 6) << 8);
  const mult = Math.round(PAL_FRAME_CIA / latch);
  return mult >= 2 && mult <= 16 && Math.trunc(PAL_FRAME_CIA / mult) === latch ? mult : null;
}

/** Unpack `file` if GoatTracker made it; the reason it is not one otherwise. Never throws. */
export function unpackGtSid(file: PsidFile): GtUnpack {
  if (file.type !== 'PSID' || file.playAddress === 0) return { ok: false, reason: 'it is not a PSID with a play address' };
  const base = file.playAddress - 3;
  if (base < file.loadAddress) return { ok: false, reason: 'its play address is not 3 bytes into a player' };
  const mult = speedMultiplierOf(file, base);
  if (mult === null) return { ok: false, reason: "its init is not GoatTracker's" };
  const mem = (a: number): number | undefined => (a >= file.loadAddress && a < file.loadAddress + file.data.length ? file.data[a - file.loadAddress] : undefined);
  const match = matchPlayer(tree(), mem, new Map([['base', base]]), 'mt_freqtbllo');
  if (match === null) return { ok: false, reason: "its code is not GoatTracker 2's player (V2.73)" };
  try {
    return unpack(file, match, mem, base, mult);
  } catch (e) {
    if (e instanceof Unreadable) return { ok: false, reason: e.message };
    throw e;
  }
}

function unpack(file: PsidFile, match: PlayerMatch, mem: (a: number) => number | undefined, base: number, mult: number): GtUnpack {
  const sym = match.symbols;
  const notes: string[] = [];
  const need = (name: string): number => {
    const v = sym.get(name);
    if (v === undefined) throw new Unreadable(`its player does not show where ${name} is`);
    return v;
  };
  const flag = (name: string): boolean => sym.get(name) === 1;
  const byte = (a: number): number => {
    const v = mem(a);
    if (v === undefined) throw new Unreadable(`its song data runs past the file's end (${hex4(a)})`);
    return v;
  };
  const bytes = (a: number, n: number): number[] => Array.from({ length: n }, (_, i) => byte(a + i));

  // The frequency table: GoatTracker's, from the song's first note.
  const firstNote = sym.get('FIRSTNOTE') ?? 0;
  const freqLo = need('mt_freqtbllo');
  const freqHi = need('mt_freqtblhi');
  const noteCount = freqHi - freqLo;
  if (noteCount < 1 || noteCount > 96) throw new Unreadable('its frequency table is not one');
  let tuned = true;
  for (let i = 0; i < noteCount; i++) {
    const reg = sidTableFreqReg(firstNote + i);
    if (byte(freqLo + i) !== (reg & 0xff) || byte(freqHi + i) !== reg >> 8) tuned = false;
  }
  if (!tuned) notes.push("Its note frequencies are not GoatTracker's standard (PAL) table; the song plays in that tuning here.");

  // Song and pattern tables.
  const songLo = need('mt_songtbllo');
  const songHi = need('mt_songtblhi');
  const pattLo = need('mt_patttbllo');
  const pattHi = need('mt_patttblhi');
  if (songLo !== freqHi + noteCount || songHi <= songLo || (songHi - songLo) % 3 !== 0 || pattLo !== songHi + (songHi - songLo)) {
    throw new Unreadable('its song table is not where the player reads it');
  }
  const songs = (songHi - songLo) / 3;
  const patterns = pattHi - pattLo;
  if (patterns < 1 || pattHi + patterns !== need('mt_insad')) throw new Unreadable('its pattern table is not where the player reads it');
  const orderAt = Array.from({ length: songs * 3 }, (_, i) => byte(songLo + i) | (byte(songHi + i) << 8));
  const patternAt = Array.from({ length: patterns }, (_, i) => byte(pattLo + i) | (byte(pattHi + i) << 8));

  // Instrument columns, in the packer's order.
  const insAd = need('mt_insad');
  const count = need('mt_inssr') - insAd;
  if (count < 1 || count > SID_MAX_INSTRUMENTS) throw new Unreadable(`its instrument columns hold ${count} instruments`);
  let at = insAd;
  const column = (name: string | null): number[] | null => {
    if (name !== null && sym.get(name) !== undefined && sym.get(name) !== at) throw new Unreadable(`its ${name} is not where the packer puts it`);
    const out = bytes(at, count);
    at += count;
    return out;
  };
  const ad = column('mt_insad')!;
  const sr = column('mt_inssr')!;
  const wavePtr = column('mt_inswaveptr')!;
  const pulsePtr = !flag('NOPULSE') ? column('mt_inspulseptr') : null;
  const filtPtr = !flag('NOFILTER') ? column('mt_insfiltptr') : null;
  const vibParam = !flag('NOINSTRVIB') ? column('mt_insvibparam') : null;
  const vibDelay = !flag('NOINSTRVIB') ? column('mt_insvibdelay') : null;
  const fixed = flag('FIXEDPARAMS');
  const gateCol = fixed ? null : column('mt_insgatetimer');
  const firstCol = fixed ? null : column('mt_insfirstwave');

  // The four tables, each left bytes then right bytes; before the speed table's
  // halves a zero byte when an effect reads row 0 of it.
  const readTable = (left: string, right: string, zero: boolean): { left: number[]; right: number[] } => {
    if (zero) {
      if (byte(at) !== 0) throw new Unreadable(`${left} has no zero byte before it`);
      at++;
    }
    const l = sym.get(left) ?? at;
    if (l !== at) throw new Unreadable(`its ${left} is not where the packer puts it`);
    const r = sym.get(right);
    let n: number;
    if (r !== undefined) n = r - l - (zero ? 1 : 0);
    else {
      // A table the code never reads: the rest up to the orderlists, halved.
      n = (orderAt[0]! - at - (zero ? 1 : 0)) / 2;
      if (!Number.isInteger(n)) throw new Unreadable(`its ${left} does not split into halves`);
    }
    if (n < 0 || n > 255) throw new Unreadable(`its ${left} has ${n} rows`);
    const out = { left: bytes(l, n), right: [] as number[] };
    at = l + n;
    if (zero) {
      if (byte(at) !== 0) throw new Unreadable(`${right} has no zero byte before it`);
      at++;
    }
    out.right = bytes(at, n);
    at += n;
    return out;
  };
  const speedZero = !flag('NOVIB') || !flag('NOFUNKTEMPO') || !flag('NOPORTAMENTO') || !flag('NOTONEPORTA');
  const wave = readTable('mt_wavetbl', 'mt_notetbl', false);
  const pulse = !flag('NOPULSE') ? readTable('mt_pulsetimetbl', 'mt_pulsespdtbl', false) : { left: [], right: [] };
  const filter = !flag('NOFILTER') ? readTable('mt_filttimetbl', 'mt_filtspdtbl', false) : { left: [], right: [] };
  const speed = readTable('mt_speedlefttbl', 'mt_speedrighttbl', speedZero);
  if (at !== orderAt[0]) throw new Unreadable(`its tables end at ${hex4(at)}, not where its orderlists start (${hex4(orderAt[0]!)})`);

  // The tables as the song has them (the packer's conversions, undone).
  const waveDelay = !flag('NOWAVEDELAY');
  const waveRows = wave.left.map((l, i) => {
    const r = wave.right[i]!;
    let left = l;
    if (l >= 0xf0) left = l;
    else if (waveDelay) {
      if (l >= 0x20) left = l - 0x10;
      else if (l >= 0x10) left = 0xe0 | (l & 0x0f);
    } else if (l >= 0x01 && l <= 0x0f) left = 0xe0 | l;
    const right = left === 0xff || (left >= 0xf0 && left <= 0xfe) ? r : r ^ 0x80;
    return { left, right };
  });
  const simple = flag('SIMPLEPULSE');
  const pulseRows = pulse.left.map((l, i) => {
    const r = pulse.right[i]!;
    if (!simple || l === 0xff) return { left: l, right: r };
    if (l >= 0x80) return { left: 0x80 | (r & 0x0f), right: r & 0xf0 };
    // A speed nybble-swapped, a negative one less.
    let s = ((r & 0x0f) << 4) | (r >> 4);
    if (s & 0x80) s = (s + 1) & 0xff;
    return { left: l, right: (s & 0x0f) << 4 };
  });
  const filterRows = filter.left.map((l, i) => ({ left: l !== 0xff && l > 0x80 ? 0x80 | ((l & 0x38) << 1) : l, right: filter.right[i]! }));
  const speedRows = speed.left.map((l, i) => ({ left: l, right: speed.right[i]! }));

  // Orderlists: back to the .sng's (a repeat before its pattern).
  const orderlists = orderAt.map((start, i) => {
    const packed: number[] = [];
    for (let a = start; ; a++) {
      const v = byte(a);
      if (v === 0xff) {
        packed.push(0xff, byte(a + 1));
        break;
      }
      if (packed.length > 254) throw new Unreadable(`orderlist ${i} has no end`);
      packed.push(v);
    }
    const out: number[] = [];
    for (let k = 0; k < packed.length - 2; k++) {
      const v = packed[k]!;
      const next = packed[k + 1]!;
      if (v < 0xd0 && next > 0xd0 && next < 0xe0 && k + 1 < packed.length - 2) {
        out.push(next, v);
        k++;
      } else out.push(v);
    }
    out.push(0xff, packed[packed.length - 1]!);
    return out;
  });

  // Patterns: rows of note, instrument, command, parameter.
  const noEffects = flag('NOEFFECTS');
  const funkTempo = !flag('NOFUNKTEMPO');
  const patternRows = patternAt.map((start, p) => {
    const rows: number[][] = [];
    let command = noEffects ? 0 : -1;
    let param = noEffects ? 0 : -1;
    let instrument = 0;
    let a = start;
    const row = (note: number): void => {
      if (command < 0) throw new Unreadable(`pattern ${p} plays a note before any command`);
      rows.push([note, instrument, command, param]);
      instrument = 0;
    };
    for (;;) {
      if (a - start >= 256) break;
      const b = byte(a++);
      if (b === 0x00) break;
      if (b < 0x40) instrument = b;
      else if (b < 0x60) {
        command = b & 0x0f;
        param = command !== 0 ? byte(a++) : 0;
        if (b >= 0x50) row(0xbd);
      } else if (b < 0xc0) row(b);
      else for (let n = 0x100 - b; n > 0; n--) row(0xbd);
      if (rows.length > 128) throw new Unreadable(`pattern ${p} has more than 128 rows`);
    }
    if (rows.length === 0) throw new Unreadable(`pattern ${p} has no rows`);
    for (const r of rows) {
      // A tempo's parameter is written one less from 3 up; 0-2 as they are. So 2 is F02 or F03,
      // which play alike (3 ticks a row); F02 makes the packer keep the funktempo code.
      const t = r[3]! & 0x7f;
      if (r[2] === 0x0f && t >= 2 && !(t === 2 && funkTempo)) r[3] = r[3]! + 1;
    }
    return rows;
  });

  // Instruments: the packer's groups (hard restart, none, legato) back into their gate-timer
  // bits. The code compares with the groups' first numbers only when the song mixes them; a
  // song of one group has the hard-restart code or not. At multispeed the packer counts one
  // no-hard-restart instrument more than there is.
  let normal: number;
  let legatoFrom: number;
  const noHrFrom = sym.get('FIRSTNOHRINSTR');
  if (noHrFrom !== undefined) {
    normal = noHrFrom - 1;
    const legato = sym.get('FIRSTLEGATOINSTR');
    legatoFrom = legato !== undefined ? legato - (mult > 1 ? 1 : 0) : count + 1;
  } else {
    const hr = sym.get('NUMHRINSTR') ?? match.ranges.get('NUMHRINSTR')?.lo ?? 1;
    normal = hr > 0 ? count : 0;
    legatoFrom = count + 1;
  }
  const instruments = Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const gate = (gateCol?.[i] ?? sym.get('GATETIMERPARAM') ?? 0) & 0x3f;
    // A legato instrument's hard-restart bit is not packed (no gate-off precedes its notes,
    // so it is never heard): GoatTracker's legato instruments set both ($C0).
    const kind = n <= normal ? 0 : n < legatoFrom ? 0x80 : 0xc0;
    const vp = vibParam?.[i] ?? 0;
    const vd = vibDelay?.[i] ?? 0;
    return [
      ad[i]!,
      sr[i]!,
      wavePtr[i]!,
      pulsePtr?.[i] ?? 0,
      filtPtr?.[i] ?? 0,
      vp !== 0 || vd !== 0 ? vp : 0,
      vp !== 0 || vd !== 0 ? vd + 1 : 0,
      kind | gate,
      firstCol?.[i] ?? sym.get('FIRSTWAVEPARAM') ?? 0,
    ];
  });
  // Speed-table rows nothing points to: an instrument's vibrato row whose delay was 0 (it
  // never vibrates, so the packer writes neither; the row stays in the table). Each goes
  // back to an instrument without vibrato, where it is not heard either.
  const speedUsed = new Set<number>();
  for (const ins of instruments) if (ins[6]! > 0) speedUsed.add(ins[5]!);
  for (const rows of patternRows) {
    for (const r of rows) if ((r[2]! >= 0x1 && r[2]! <= 0x4) || r[2] === 0xe) speedUsed.add(r[3]!);
  }
  for (const r of waveRows) if (r.left >= 0xf1 && r.left <= 0xf4) speedUsed.add(r.right);
  const orphans = speedRows.map((_, i) => i + 1).filter((row) => !speedUsed.has(row));
  for (const ins of instruments) {
    if (orphans.length === 0) break;
    if (ins[5] === 0 && ins[6] === 0) ins[5] = orphans.shift()!;
  }

  // GoatTracker's packer leaves out a table part equal to an earlier one when its scan, which
  // steps from part to part through the table as the song had it (unused rows too), lands on
  // it. The packed table is those parts closed up, where the scan would land on parts the
  // song's own layout kept apart: a blank row (never reached) before such a part keeps it.
  const separate = (num: number, rows: { left: number; right: number }[], column: number, command: number, waveCommand: number | null): void => {
    const used = [false, ...rows.map(() => true)];
    for (let guard = 0; guard < 255; guard++) {
      const dup = gtTableDuplicateRows(num, rows.map((r) => r.left), rows.map((r) => r.right), used);
      if (dup.length === 0 || rows.length >= 255) return;
      const at = dup[0]!;
      const shift = (v: number): number => (v >= at ? v + 1 : v);
      rows.splice(at - 1, 0, { left: 0, right: 0 });
      used.splice(at, 0, false);
      for (const r of rows) if (r.left === 0xff) r.right = shift(r.right);
      for (const ins of instruments) ins[column] = shift(ins[column]!);
      for (const pattern of patternRows) for (const r of pattern) if (r[2] === command) r[3] = shift(r[3]!);
      if (waveCommand !== null) for (const r of waveRows) if (r.left === waveCommand) r.right = shift(r.right);
    }
  };
  separate(0, waveRows, 2, 0x8, null);
  separate(1, pulseRows, 3, 0x9, 0xf9);
  separate(2, filterRows, 4, 0xa, 0xfa);

  // GoatTracker's start tempo other than 6 a tick: the hidden last instrument's attack/decay says it.
  const tempo = sym.get('DEFAULTTEMPO');
  if (tempo !== undefined && tempo !== mult * 6 - 1) {
    while (instruments.length < SID_MAX_INSTRUMENTS) instruments.push([0, 0, 0, 0, 0, 0, 0, 0, 0]);
    instruments[SID_MAX_INSTRUMENTS - 1]![0] = tempo + 1;
  }
  if ((sym.get('ADPARAM') ?? 0x0f) !== 0x0f || (sym.get('SRPARAM') ?? 0x00) !== 0x00) {
    notes.push("Its hard restart uses another envelope than GoatTracker's default ($0F00); here it gets the default.");
  }

  const sng = gtsBytes({
    name: file.name,
    author: file.author,
    copyright: file.released,
    songs,
    orderlists,
    instruments,
    tables: [waveRows, pulseRows, filterRows, speedRows],
    patterns: patternRows,
  });
  const chipModel: SidChipModel = file.sidModel === '8580' ? '8580' : '6581';
  const imported = importGtSong(sng, { chipModel, speedMultiplier: mult });
  if (!imported.ok) throw new Unreadable(`its data does not make a GoatTracker song (${imported.reason})`);
  const doc = imported.doc;

  // The check: the doc packed again, as the file was.
  const zeroPage = sym.get('zpbase') ?? GT_PACK_DEFAULTS.zeroPage;
  const payload = file.data;
  const exact = [GT_PACK_DEFAULTS, SID_EXPORT_DEFAULTS].some((o) => samePayload(doc, { ...o, playerAddress: base, zeroPage }, file.loadAddress, payload));
  return { ok: true, doc, exact, notes };
}

/** Whether `doc` packs with `options` to `payload` loaded at `load` (the PSID's C64 bytes). */
function samePayload(doc: SidDoc, options: GtPackOptions, load: number, payload: Uint8Array): boolean {
  if (options.playerAddress % 256 !== 0) return false;
  const e = exportSid(doc, options);
  if (!e.ok) return false;
  // The exported file: header, load address, then its bytes from `load`.
  const out = e.bytes.subarray(0x7c + 2);
  const outLoad = e.bytes[0x7c]! | (e.bytes[0x7d]! << 8);
  if (outLoad !== load || out.length !== payload.length) return false;
  return out.every((b, i) => b === payload[i]);
}

interface GtsParts {
  readonly name: string;
  readonly author: string;
  readonly copyright: string;
  readonly songs: number;
  /** Per subsong per voice: the orderlist's bytes, endmark and restart byte included. */
  readonly orderlists: readonly (readonly number[])[];
  /** Per instrument: AD, SR, wave, pulse, filter and speed pointers, vibrato delay, gate timer, first wave. */
  readonly instruments: readonly (readonly number[])[];
  readonly tables: readonly (readonly { left: number; right: number }[])[];
  /** Per pattern: its rows, [note, instrument, command, parameter]. */
  readonly patterns: readonly (readonly (readonly number[])[])[];
}

/** A GoatTracker 2 song file (GTS5, readme §6.1) of `parts`. */
function gtsBytes(parts: GtsParts): Uint8Array {
  const out: number[] = [...'GTS5'].map((c) => c.charCodeAt(0));
  const text = (s: string, n: number): void => {
    for (let i = 0; i < n; i++) out.push(i < s.length ? s.charCodeAt(i) & 0xff : 0);
  };
  text(parts.name, 32);
  text(parts.author, 32);
  text(parts.copyright, 32);
  out.push(parts.songs);
  for (const list of parts.orderlists) {
    out.push(list.length - 1, ...list);
  }
  out.push(parts.instruments.length);
  parts.instruments.forEach((ins, i) => {
    out.push(...ins);
    text(ins[2] !== 0 || ins[0] !== 0 || ins[1] !== 0 ? `Instrument ${i + 1}` : '', 16);
  });
  for (const t of parts.tables) {
    out.push(t.length, ...t.map((r) => r.left), ...t.map((r) => r.right));
  }
  out.push(parts.patterns.length);
  for (const rows of parts.patterns) {
    out.push(rows.length + 1);
    for (const r of rows) out.push(...r);
    out.push(0xff, 0, 0, 0);
  }
  return Uint8Array.from(out);
}
