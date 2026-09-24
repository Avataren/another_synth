import { SID_FILE_VERSION, makeSidDoc, sidDocProblem } from './doc';
import {
  SID_TABLE_NAMES,
  type SidChipModel,
  type SidDoc,
  type SidDocPattern,
  type SidInstrument,
  type SidOrderlist,
  type SidSubsong,
  type SidTable,
  type SidTableName,
} from './types';

/**
 * The SID song file: the bytes a `.cmod` carries for a SID song
 * (`data.sidFile`, base64) and the Rust player reads (`sid::song`,
 * `rust-wasm/src/sid/song.rs`, the same layout). Little-endian, no padding:
 *
 *   0   4  magic 'ASID'
 *   4   1  version (SID_FILE_VERSION)
 *   5   1  chip model: 0 = 8580, 1 = 6581
 *   6   1  channels (3)
 *   7   1  speed multiplier 1..16
 *   8   1  tempo 1..127
 *   9      song name, author, copyright: each a length byte 0..32, then latin-1
 *      1   subsong count 1..32; then per subsong, per channel:
 *          1 entry count E 1..254, 1 restart < E,
 *          E x (pattern, transpose as a signed byte, repeat)
 *      1   pattern count 1..208; per pattern: 1 row count R 1..128,
 *          R x (note, instrument, command, param)
 *      1   instrument count 0..63; per instrument: a length byte 0..16 and
 *          the latin-1 name, then 15 bytes:
 *          attack<<4|decay, sustain<<4|release, waveform, pulse width low,
 *          pulse width high (0..15), cutoff low, cutoff high (0..7),
 *          resonance<<4|filter-enabled<<3|mode, first-frame waveform,
 *          hard-restart<<7|no-gate-off<<6|gate timer, vibrato delay,
 *          wave, pulse, filter and speed table pointers
 *      4x  the wave, pulse, filter and speed tables: a row count N 0..255,
 *          N left bytes, then N right bytes (GoatTracker's column layout)
 *   and nothing after.
 *
 * Canonical: every field has exactly one encoding (reserved bits must be
 * clear, and the reader refuses what the model refuses), so for every file
 * `parseSidFile` accepts, `serializeSidFile(parseSidFile(bytes))` is `bytes`,
 * and for every doc, `parseSidFile(serializeSidFile(doc))` equals `doc`.
 */

const MAGIC = [0x41, 0x53, 0x49, 0x44] as const; // 'ASID'
const CHIP_CODES: Readonly<Record<SidChipModel, number>> = { '8580': 0, '6581': 1 };
const CHIP_MODELS: readonly SidChipModel[] = ['8580', '6581'];

/** The file of `doc`. Throws for a doc that breaks a rule of the model (`sidDocProblem`). */
export function serializeSidFile(doc: SidDoc): Uint8Array {
  const problem = sidDocProblem(doc);
  if (problem !== null) throw new Error(`Cannot write the SID song: ${problem}.`);
  const out: number[] = [...MAGIC, doc.version, CHIP_CODES[doc.chipModel], doc.channels, doc.speedMultiplier, doc.tempo];
  const text = (s: string) => {
    out.push(s.length);
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  };
  text(doc.songName);
  text(doc.author);
  text(doc.copyright);
  out.push(doc.subsongs.length);
  for (const subsong of doc.subsongs) {
    for (const list of subsong.orderlists) {
      out.push(list.entries.length, list.restart);
      for (const e of list.entries) out.push(e.pattern, e.transpose & 0xff, e.repeat);
    }
  }
  out.push(doc.patterns.length);
  for (const pattern of doc.patterns) {
    out.push(pattern.rows.length);
    for (const r of pattern.rows) out.push(r.note, r.instrument, r.command, r.param);
  }
  out.push(doc.instruments.length);
  for (const ins of doc.instruments) {
    text(ins.name);
    out.push(
      (ins.attack << 4) | ins.decay,
      (ins.sustain << 4) | ins.release,
      ins.waveform,
      ins.pulseWidth & 0xff,
      ins.pulseWidth >> 8,
      ins.filter.cutoff & 0xff,
      ins.filter.cutoff >> 8,
      (ins.filter.resonance << 4) | (ins.filter.enabled ? 0x08 : 0) | ins.filter.mode,
      ins.firstWave,
      (ins.hardRestart ? 0x80 : 0) | (ins.noGateOff ? 0x40 : 0) | ins.gateTimer,
      ins.vibratoDelay,
      ins.wavePtr,
      ins.pulsePtr,
      ins.filterPtr,
      ins.speedPtr,
    );
  }
  for (const name of SID_TABLE_NAMES) {
    const table = doc.tables[name];
    out.push(table.length);
    for (const row of table) out.push(row.left);
    for (const row of table) out.push(row.right);
  }
  return Uint8Array.from(out);
}

class Reader {
  at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  byte(what: string): number {
    const v = this.bytes[this.at];
    if (v === undefined) throw new Error(`the file ends inside ${what}`);
    this.at += 1;
    return v;
  }
  text(max: number, what: string): string {
    const n = this.byte(what);
    if (n > max) throw new Error(`${what} is longer than ${max} characters`);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.byte(what));
    return s;
  }
  get done(): boolean {
    return this.at === this.bytes.length;
  }
}

/** The doc a SID file holds. Throws, with the reason, for anything that is not one. */
export function parseSidFile(bytes: Uint8Array): SidDoc {
  const r = new Reader(bytes);
  for (const m of MAGIC) {
    if (r.byte('the header') !== m) throw new Error('it is not a SID song file (no ASID magic)');
  }
  const version = r.byte('the header');
  if (version !== SID_FILE_VERSION) throw new Error(`version ${version} is not supported`);
  const chipCode = r.byte('the header');
  const chipModel = CHIP_MODELS[chipCode];
  if (chipModel === undefined) throw new Error(`chip model ${chipCode} is unknown`);
  const channels = r.byte('the header');
  const speedMultiplier = r.byte('the header');
  const tempo = r.byte('the header');
  const songName = r.text(32, 'the song name');
  const author = r.text(32, 'the author');
  const copyright = r.text(32, 'the copyright');

  const subsongs: SidSubsong[] = [];
  const subsongCount = r.byte('the subsong count');
  for (let s = 0; s < subsongCount; s++) {
    const orderlists: SidOrderlist[] = [];
    for (let c = 0; c < channels; c++) {
      const count = r.byte('an orderlist');
      const restart = r.byte('an orderlist');
      const entries = [];
      for (let e = 0; e < count; e++) {
        const pattern = r.byte('an orderlist');
        const t = r.byte('an orderlist');
        entries.push({ pattern, transpose: t < 0x80 ? t : t - 0x100, repeat: r.byte('an orderlist') });
      }
      orderlists.push({ entries, restart });
    }
    subsongs.push({ orderlists });
  }

  const patterns: SidDocPattern[] = [];
  const patternCount = r.byte('the pattern count');
  for (let p = 0; p < patternCount; p++) {
    const count = r.byte('a pattern');
    const rows = [];
    for (let i = 0; i < count; i++) {
      rows.push({ note: r.byte('a pattern'), instrument: r.byte('a pattern'), command: r.byte('a pattern'), param: r.byte('a pattern') });
    }
    patterns.push({ rows });
  }

  const instruments: SidInstrument[] = [];
  const instrumentCount = r.byte('the instrument count');
  for (let i = 0; i < instrumentCount; i++) {
    const name = r.text(16, 'an instrument name');
    const b = Array.from({ length: 15 }, () => r.byte('an instrument'));
    const [ad, sr, waveform, pwLo, pwHi, cutLo, cutHi, filt, firstWave, gate, vibratoDelay, wavePtr, pulsePtr, filterPtr, speedPtr] = b as [
      number, number, number, number, number, number, number, number, number, number, number, number, number, number, number,
    ];
    if (pwHi > 0x0f) throw new Error(`instrument ${i + 1}: the pulse width's high byte is over 15`);
    if (cutHi > 0x07) throw new Error(`instrument ${i + 1}: the cutoff's high byte is over 7`);
    instruments.push({
      name,
      attack: ad >> 4,
      decay: ad & 0x0f,
      sustain: sr >> 4,
      release: sr & 0x0f,
      waveform,
      pulseWidth: (pwHi << 8) | pwLo,
      filter: { enabled: (filt & 0x08) !== 0, cutoff: (cutHi << 8) | cutLo, resonance: filt >> 4, mode: filt & 0x07 },
      firstWave,
      gateTimer: gate & 0x3f,
      hardRestart: (gate & 0x80) !== 0,
      noGateOff: (gate & 0x40) !== 0,
      vibratoDelay,
      wavePtr,
      pulsePtr,
      filterPtr,
      speedPtr,
    });
  }

  const tables = {} as Record<SidTableName, SidTable>;
  for (const tableName of SID_TABLE_NAMES) {
    const count = r.byte(`the ${tableName} table`);
    const left = Array.from({ length: count }, () => r.byte(`the ${tableName} table`));
    tables[tableName] = left.map((l) => ({ left: l, right: r.byte(`the ${tableName} table`) }));
  }
  if (!r.done) throw new Error(`${bytes.length - r.at} bytes follow the song`);

  const fields: SidDoc = {
    format: 'sid',
    version,
    songName,
    author,
    copyright,
    chipModel,
    channels,
    speedMultiplier,
    tempo,
    subsongs,
    patterns,
    instruments,
    tables,
  };
  const problem = sidDocProblem(fields);
  if (problem !== null) throw new Error(problem);
  return makeSidDoc(fields);
}

/**
 * The largest `sidFile` text read: 512 KiB of base64. The model's own limits
 * bound a file well under 256 KiB (208 patterns of 128 rows are 107 KiB).
 */
export const SID_FILE_MAX_BASE64_LENGTH = 512 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CHUNK = 0x8000;

/** `data.sidFile`: the song file as base64 text. */
export function encodeSidFile(doc: SidDoc): string {
  const bytes = serializeSidFile(doc);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export type SidFileDecoding = { ok: true; doc: SidDoc; bytes: Uint8Array } | { ok: false; reason: string };

/**
 * The doc a `data.sidFile` text holds, or why it holds none. Never throws: a
 * song file is untrusted input, so the text is bounded before it is decoded.
 */
export function decodeSidFile(text: unknown): SidFileDecoding {
  if (typeof text !== 'string') return { ok: false, reason: 'it is not text' };
  if (text.length > SID_FILE_MAX_BASE64_LENGTH) return { ok: false, reason: `it is larger than the ${SID_FILE_MAX_BASE64_LENGTH >> 10} KiB limit` };
  if (text.length % 4 !== 0 || !BASE64.test(text)) return { ok: false, reason: 'it is not valid base64' };
  let bytes: Uint8Array;
  try {
    const binary = atob(text);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return { ok: false, reason: 'it is not valid base64' };
  }
  try {
    return { ok: true, doc: parseSidFile(bytes), bytes };
  } catch (error) {
    return { ok: false, reason: `its bytes are not a readable SID song (${(error as Error).message})` };
  }
}
