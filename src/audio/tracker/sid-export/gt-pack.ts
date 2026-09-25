import { sidTableFreqReg } from '@another-synth/tracker-playback';
import { gtNoteByte, gtOrderlistBytes, type SidDoc } from 'src/audio/tracker/sid-doc';
import { GT_GATE_NO_GATEOFF, GT_GATE_NO_HARD_RESTART } from 'src/audio/tracker/sid-doc/gt-sng-read';

/**
 * `SidDoc` -> the assembler source GoatTracker's packer/relocator builds: the
 * feature defines, `player.s`, and the song data laid out the way `player.s`
 * reads it (plan-sid-authoring.md D2, phase 4).
 *
 * Our own code. GoatTracker's relocator (`greloc.c`, GPL) was read for its
 * FACTS only, as `gplay.c` has been: which data it keeps, in what order, how
 * each byte is converted, and when it refuses. This follows it step by step,
 * quirks included, because the gate is byte equality with the `.sid` that
 * GoatTracker 2.77's own `gt2reloc` writes for the same song
 * (`.ai/sid-oracle/psid_gate.ts`). Each step names what it does in GT's terms:
 *
 *  1. orderlists: which subsongs, patterns and voices are used, transpose range;
 *  2. patterns: which instruments and table rows they reach, note range;
 *  3. instruments: renumbered into normal, no-hard-restart ($80), legato ($40);
 *  4. table rows reached from wave-table commands; wave commands $F0, $F8 and
 *     $FE are refused (GT: "illegal wavetable command");
 *  5. table rows renumbered (only the rows something reaches are kept),
 *     duplicate self-contained parts shared; a pointer onto a jump row and a
 *     table that runs past row 255 are refused;
 *  6. options: with `optimize` off every feature is on (GT's "disable
 *     optimization"); on, only what the song uses (GT's default);
 *  7. orderlists packed (a repeat swaps with its pattern), patterns packed
 *     (FX/FXONLY bytes, tempo parameters minus one, runs of rests);
 *  8. instrument columns, the note range the frequency table must cover;
 *  9. the source: defines, `player.s`, then frequency table, song table,
 *     pattern table, instrument columns, the four tables, orderlists, patterns.
 */

export interface GtPackOptions {
  /** The player's address: a page ($xx00). GT's default $1000. */
  readonly playerAddress: number;
  /** Two zero-page bytes the player uses. GT's default $FC. */
  readonly zeroPage: number;
  /** GT's default (true): leave out the player code the song does not use. */
  readonly optimize: boolean;
}

export const GT_PACK_DEFAULTS: GtPackOptions = { playerAddress: 0x1000, zeroPage: 0xfc, optimize: true };

export type GtPack =
  | {
      readonly ok: true;
      /** Defines + `player.s` + data: what `assemble6502` takes. */
      readonly source: string;
      /** Subsongs in the file. */
      readonly songs: number;
      /**
       * Where GoatTracker's C64 player plays this song differently from GoatTracker's
       * editor, which is what this app plays (`gtPlayerDifferences`). Clauses for the user.
       */
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

// GoatTracker's constants (gcommon.h / readme), as its data uses them.
const MAX_INSTR = 64;
const MAX_TABLELEN = 255;
const MAX_NOTES = 96;
const WTBL = 0;
const PTBL = 1;
const FTBL = 2;
const STBL = 3;
const TABLE_WHAT = ['wave', 'pulse', 'filter', 'speed'] as const;
const REPEAT = 0xd0;
const TRANSDOWN = 0xe0;
const TRANSUP = 0xf0;
const FIRSTNOTE = 0x60;
const LASTNOTE = 0xbc;
const REST = 0xbd;
const KEYOFF = 0xbe;
const KEYON = 0xbf;
const FX = 0x40;
const FXONLY = 0x50;
const WAVELASTDELAY = 0x0f;
const WAVESILENT = 0xe0;
const WAVELASTSILENT = 0xef;
const WAVECMD = 0xf0;
const WAVELASTCMD = 0xfe;
const CMD_DONOTHING = 0;
const CMD_PORTAUP = 1;
const CMD_PORTADOWN = 2;
const CMD_TONEPORTA = 3;
const CMD_VIBRATO = 4;
const CMD_SETAD = 5;
const CMD_SETSR = 6;
const CMD_SETWAVE = 7;
const CMD_SETWAVEPTR = 8;
const CMD_SETPULSEPTR = 9;
const CMD_SETFILTERPTR = 10;
const CMD_SETFILTERCTRL = 11;
const CMD_SETFILTERCUTOFF = 12;
const CMD_SETMASTERVOL = 13;
const CMD_FUNKTEMPO = 14;
const CMD_SETTEMPO = 15;
/** GT's default hard-restart ADSR (`adparam`), what our player and gtref use too. */
const ADPARAM = 0x0f00;
const SIDBASE = 0xd400;

const TABLE_LEFT = ['mt_wavetbl', 'mt_pulsetimetbl', 'mt_filttimetbl', 'mt_speedlefttbl'];
const TABLE_RIGHT = ['mt_notetbl', 'mt_pulsespdtbl', 'mt_filtspdtbl', 'mt_speedrighttbl'];

/** The feature switches the relocator sets; 1 = "the song does not use it". */
const FLAG_NAMES = [
  'noeffects',
  'nogate',
  'nofilter',
  'nofiltermod',
  'nopulse',
  'nopulsemod',
  'nowavedelay',
  'nowavecmd',
  'norepeat',
  'notrans',
  'noportamento',
  'notoneporta',
  'novib',
  'noinsvib',
  'nosetad',
  'nosetsr',
  'nosetwave',
  'nosetwaveptr',
  'nosetpulseptr',
  'nosetfiltptr',
  'nosetfiltcutoff',
  'nosetfiltctrl',
  'nosetmastervol',
  'nofunktempo',
  'noglobaltempo',
  'nochanneltempo',
  'nofirstwavecmd',
  'nocalculatedspeed',
  'nonormalspeed',
  'nozerospeed',
] as const;
type Flag = (typeof FLAG_NAMES)[number];

interface GtInstr {
  ad: number;
  sr: number;
  /** wave, pulse, filter, speed. */
  ptr: [number, number, number, number];
  vibdelay: number;
  gatetimer: number;
  firstwave: number;
}

class PackRefusal extends Error {}

/** The packer's source for `doc`, or why GoatTracker's packer would refuse it. Never throws. */
export function gtPackSource(doc: SidDoc, playerSource: string, options: GtPackOptions = GT_PACK_DEFAULTS): GtPack {
  try {
    return pack(doc, playerSource, options);
  } catch (e) {
    if (e instanceof PackRefusal) return { ok: false, reason: e.message };
    throw e;
  }
}

function pack(doc: SidDoc, playerSource: string, options: GtPackOptions): GtPack {
  const multiplier = doc.speedMultiplier;

  // GT's in-memory song: the .sng as its loader leaves it.
  const songorder = doc.subsongs.map((s) => s.orderlists.map((l) => gtOrderlistBytes(l)));
  const songlen = songorder.map((s) => s.map((bytes) => bytes.length - 2));
  const pattern = doc.patterns.map((p) => p.rows.flatMap((r) => [gtNoteByte(r.note), r.instrument, r.command, r.param]));
  const pattlen = doc.patterns.map((p) => p.rows.length);
  const instr: GtInstr[] = Array.from({ length: MAX_INSTR }, (_, c) => {
    const ins = c >= 1 ? doc.instruments[c - 1] : undefined;
    if (ins === undefined) return { ad: 0, sr: 0, ptr: [0, 0, 0, 0], vibdelay: 0, gatetimer: 0, firstwave: 0 };
    return {
      ad: (ins.attack << 4) | ins.decay,
      sr: (ins.sustain << 4) | ins.release,
      ptr: [ins.wavePtr, ins.pulsePtr, ins.filterPtr, ins.speedPtr],
      vibdelay: ins.vibratoDelay,
      gatetimer: (ins.hardRestart ? 0 : GT_GATE_NO_HARD_RESTART) | (ins.noGateOff ? GT_GATE_NO_GATEOFF : 0) | ins.gateTimer,
      firstwave: ins.firstWave,
    };
  });
  const tables = [doc.tables.wave, doc.tables.pulse, doc.tables.filter, doc.tables.speed];
  const ltable = tables.map((t) => Array.from({ length: MAX_TABLELEN }, (_, i) => t[i]?.left ?? 0));
  const rtable = tables.map((t) => Array.from({ length: MAX_TABLELEN }, (_, i) => t[i]?.right ?? 0));

  const f = Object.fromEntries(FLAG_NAMES.map((n) => [n, 1])) as Record<Flag, number>;
  let channels = 3;
  let fixedparams = 1;
  let simplepulse = 1;
  let firstnote = MAX_NOTES - 1;
  let lastnote = 0;
  let patternlastnote = 0;

  const pattused = new Array<boolean>(pattern.length).fill(false);
  const pattmap = new Array<number>(pattern.length).fill(0);
  const instrused = new Array<boolean>(MAX_INSTR).fill(false);
  const instrmap = new Array<number>(MAX_INSTR).fill(0);
  const chnused = [false, false, false];
  const tableused = tables.map(() => new Array<boolean>(MAX_TABLELEN + 1).fill(false));
  const tablemap = tables.map(() => new Array<number>(MAX_TABLELEN + 1).fill(0));

  // exectable: mark the rows a pointer reaches; the first error wins.
  let tableerror: 'jump' | 'overflow' | null = null;
  const exectable = (num: number, start: number): void => {
    let ptr = start;
    if (num !== STBL && ptr && ptr <= MAX_TABLELEN && ltable[num]![ptr - 1] === 0xff) {
      tableerror = 'jump';
      return;
    }
    for (;;) {
      if (!ptr) break;
      if (num !== STBL && ptr > MAX_TABLELEN) {
        tableerror = 'overflow';
        break;
      }
      if (tableused[num]![ptr]) break;
      tableused[num]![ptr] = true;
      if (num !== STBL) ptr = ltable[num]![ptr - 1] === 0xff ? rtable[num]![ptr - 1]! : ptr + 1;
      else break;
    }
  };
  let firstTableError: string | null = null;
  const noteTableError = (where: string): void => {
    if (tableerror !== null && firstTableError === null) {
      firstTableError =
        tableerror === 'jump'
          ? `a table pointer lands on a jump row (${where}); GoatTracker's packer refuses that`
          : `a table runs past its last row, 255, without a jump (${where}); GoatTracker's packer refuses that`;
    }
  };
  const calcspeedtest = (pos: number): void => {
    if (!pos) {
      f.nozerospeed = 0;
      return;
    }
    if (ltable[STBL]![pos - 1]! >= 0x80) f.nocalculatedspeed = 0;
    else f.nonormalspeed = 0;
  };

  // 1. Orderlists.
  let transuprange = 0;
  let transdownrange = 0;
  let songs = 0;
  for (const [c, song] of songorder.entries()) {
    if (!songlen[c]!.every((n) => n > 0)) continue;
    for (const [d, bytes] of song.entries()) {
      for (let e = 0; e < songlen[c]![d]!; e++) {
        const v = bytes[e]!;
        if (v < REPEAT) {
          if (v >= pattern.length) throw new PackRefusal(`subsong ${c} voice ${d + 1} plays pattern ${v}, which the song does not have`);
          pattused[v] = true;
          for (let r = 0; r < pattlen[v]!; r++) {
            const p = pattern[v]!;
            if (p[r * 4] !== REST || p[r * 4 + 1] || p[r * 4 + 2]) chnused[d] = true;
          }
        } else if (v >= TRANSDOWN) {
          f.notrans = 0;
          if (v < TRANSUP) transdownrange = Math.max(transdownrange, -(v - TRANSUP));
          else transuprange = Math.max(transuprange, v - TRANSUP);
        } else f.norepeat = 0;
      }
      if (bytes[songlen[c]![d]! + 1]! >= songlen[c]![d]!) {
        throw new PackRefusal(`subsong ${c} voice ${d + 1} restarts past the end of its orderlist`);
      }
    }
    songs++;
  }
  if (!chnused[2]) channels = 2;
  if (!chnused[1] && !chnused[2]) channels = 1;
  if (!songs) throw new PackRefusal('the song has no subsong with notes to play on every voice');

  // 2. Patterns.
  let patterns = 0;
  instrused[1] = true;
  for (let c = 0; c < pattern.length; c++) {
    if (!pattused[c]) continue;
    pattmap[c] = patterns++;
    const p = pattern[c]!;
    for (let d = 0; d < pattlen[c]!; d++) {
      tableerror = null;
      const note = p[d * 4]!;
      const ins = p[d * 4 + 1]!;
      const cmd = p[d * 4 + 2]!;
      const param = p[d * 4 + 3]!;
      if (note === KEYOFF || note === KEYON) f.nogate = 0;
      if (ins) instrused[ins] = true;
      if (cmd) f.noeffects = 0;
      if (cmd >= CMD_SETWAVEPTR && cmd <= CMD_SETFILTERPTR) exectable(cmd - CMD_SETWAVEPTR, param);
      if (cmd >= CMD_PORTAUP && cmd <= CMD_VIBRATO) {
        exectable(STBL, param);
        calcspeedtest(param);
      }
      if (cmd === CMD_FUNKTEMPO) {
        exectable(STBL, param);
        f.nofunktempo = 0;
        f.noglobaltempo = 0;
      }
      if (cmd === CMD_SETTEMPO && (param & 0x7f) < 3) f.nofunktempo = 0;
      if (note >= FIRSTNOTE && note <= LASTNOTE) {
        const newfirstnote = Math.max(0, note - FIRSTNOTE - transdownrange);
        const newlastnote = Math.min(MAX_NOTES - 1, note - FIRSTNOTE + transuprange);
        if (newfirstnote < firstnote) firstnote = newfirstnote;
        if (newlastnote > lastnote) patternlastnote = lastnote = newlastnote;
        if (newfirstnote > lastnote) patternlastnote = lastnote = newfirstnote;
      }
      noteTableError(`pattern ${c}, row ${d}`);
    }
  }

  // 3. Instruments: counted, then numbered normal, no-hard-restart, legato.
  let numlegato = 0;
  let numnohr = 0;
  let numnormal = 0;
  for (let c = 0; c < MAX_INSTR; c++) {
    if (!instrused[c]) continue;
    const g = instr[c]!.gatetimer;
    if (g & 0x40) numlegato++;
    else if (g & 0x80) numnohr++;
    else numnormal++;
    if (!instr[c]!.firstwave || instr[c]!.firstwave >= 0xfe) f.nofirstwavecmd = 0;
  }
  let freenormal = 1;
  let freenohr = freenormal + numnormal;
  let freelegato = freenohr + numnohr;
  let instruments = 0;
  for (let c = 0; c < MAX_INSTR; c++) {
    if (!instrused[c]) continue;
    const g = instr[c]!.gatetimer;
    if (g & 0x40) instrmap[c] = freelegato++;
    else if (g & 0x80) instrmap[c] = freenohr++;
    else instrmap[c] = freenormal++;
    instruments++;
    for (let d = 0; d < 4; d++) {
      tableerror = null;
      exectable(d, instr[c]!.ptr[d]!);
      if (d === STBL) calcspeedtest(instr[c]!.ptr[d]!);
      noteTableError(`instrument ${c}'s ${TABLE_WHAT[d]} table`);
    }
  }

  // 4. Rows reached from wave-table commands.
  for (let c = 0; c < MAX_TABLELEN; c++) {
    if (!tableused[WTBL]![c + 1]) continue;
    const l = ltable[WTBL]![c]!;
    if (l < WAVECMD || l > WAVELASTCMD) continue;
    tableerror = null;
    let d = -1;
    switch (l - WAVECMD) {
      case CMD_PORTAUP:
      case CMD_PORTADOWN:
      case CMD_TONEPORTA:
      case CMD_VIBRATO:
        d = STBL;
        calcspeedtest(rtable[WTBL]![c]!);
        break;
      case CMD_SETPULSEPTR:
        d = PTBL;
        f.nopulse = 0;
        break;
      case CMD_SETFILTERPTR:
        d = FTBL;
        f.nofilter = 0;
        break;
      case CMD_DONOTHING:
      case CMD_SETWAVEPTR:
      case CMD_FUNKTEMPO:
        throw new PackRefusal(
          `wave table row ${c + 1} has command $${l.toString(16).toUpperCase()}, which GoatTracker's packer refuses in a wave table (only its editor plays it)`,
        );
    }
    if (d !== -1) exectable(d, rtable[WTBL]![c]!);
    noteTableError(`the command in wave table row ${c + 1}`);
  }

  // 5. Table rows renumbered; errors; duplicates shared.
  for (let c = 0; c < 4; c++) {
    let e = 1;
    for (let d = 0; d < MAX_TABLELEN; d++) {
      if (tableused[c]![d + 1]) tablemap[c]![d + 1] = e++;
    }
  }
  if (firstTableError !== null) throw new PackRefusal(firstTableError);
  for (let c = 0; c < 4; c++) findTableDuplicates(c, ltable, rtable, tableused, tablemap);
  const notes = [...tableDifferences(ltable, rtable, tableused), ...noteRangeDifferences(doc)];

  // 6. Options.
  if (!options.optimize) {
    fixedparams = 0;
    if (!numlegato) numlegato++;
    simplepulse = 0;
    firstnote = 0;
    lastnote = MAX_NOTES - 1;
    for (const n of FLAG_NAMES) f[n] = 0;
  }

  // 7. Orderlists and patterns packed.
  const songData: number[][][] = [];
  for (let c = 0; c < songs; c++) {
    songData.push(
      songorder[c]!.map((bytes, d) => {
        const out: number[] = [];
        const len = songlen[c]![d]!;
        let e = 0;
        for (; e < len; e++) {
          const v = bytes[e]!;
          if (v < REPEAT) out.push(pattmap[v]!);
          else if (v >= TRANSDOWN) out.push(v);
          else if (v > REPEAT) {
            // A repeat is written after its pattern.
            if (bytes[e + 1]! < REPEAT) {
              out.push(pattmap[bytes[e + 1]!]!, v);
              e++;
            } else out.push(v);
          }
        }
        out.push(bytes[e]!, bytes[e + 1]!);
        return out;
      }),
    );
  }
  const packed: number[][] = [];
  for (let c = 0; c < pattern.length; c++) {
    if (!pattused[c]) continue;
    const bytes = packPattern(pattern[c]!, pattlen[c]!, f, tablemap, instrmap);
    if (bytes === null) throw new PackRefusal(`pattern ${c} packs to more than 256 bytes; GoatTracker's player can't read it`);
    packed.push(bytes);
  }

  // 8. Instrument columns (GT's order: by new number).
  const col = (): number[] => new Array<number>(instruments).fill(0);
  const insad = col();
  const inssr = col();
  const inswave = col();
  const inspulse = col();
  const insfilt = col();
  const insvibparam = col();
  const insvibdelay = col();
  const insgate = col();
  const insfirst = col();
  for (let c = 1; c < MAX_INSTR; c++) {
    if (!instrused[c]) continue;
    const i = instr[c]!;
    const d = instrmap[c]! - 1;
    insad[d] = i.ad;
    inssr[d] = i.sr;
    inswave[d] = tablemap[WTBL]![i.ptr[WTBL]]!;
    inspulse[d] = tablemap[PTBL]![i.ptr[PTBL]]!;
    insfilt[d] = tablemap[FTBL]![i.ptr[FTBL]]!;
    if (i.vibdelay) {
      insvibparam[d] = tablemap[STBL]![i.ptr[STBL]]!;
      insvibdelay[d] = i.vibdelay - 1;
    }
    insgate[d] = i.gatetimer & 0x3f;
    insfirst[d] = i.firstwave;
    if (i.ptr[STBL]) {
      f.novib = 0;
      f.noinsvib = 0;
    }
    if (i.ptr[PTBL]) f.nopulse = 0;
    if (i.ptr[FTBL]) f.nofilter = 0;
    if (i.gatetimer !== instr[1]!.gatetimer || i.firstwave !== instr[1]!.firstwave) fixedparams = 0;
    if (!i.firstwave || i.firstwave >= 0xfe) fixedparams = 0;
  }
  if (multiplier > 1) {
    fixedparams = 0;
    numlegato++;
    numnohr++;
  }

  // Tables: the flags and the note range they need.
  for (let c = 0; c < MAX_TABLELEN; c++) {
    if (!tableused[WTBL]![c + 1]) continue;
    const l = ltable[WTBL]![c]!;
    const r = rtable[WTBL]![c]!;
    if (l >= 0x01 && l <= WAVELASTDELAY) f.nowavedelay = 0;
    if (l >= WAVECMD && l <= WAVELASTCMD) {
      f.nowavecmd = 0;
      f.noeffects = 0;
      const flag: Partial<Record<number, Flag>> = {
        [CMD_PORTAUP]: 'noportamento',
        [CMD_PORTADOWN]: 'noportamento',
        [CMD_TONEPORTA]: 'notoneporta',
        [CMD_VIBRATO]: 'novib',
        [CMD_SETAD]: 'nosetad',
        [CMD_SETSR]: 'nosetsr',
        [CMD_SETWAVE]: 'nosetwave',
        [CMD_SETPULSEPTR]: 'nosetpulseptr',
        [CMD_SETFILTERPTR]: 'nosetfiltptr',
        [CMD_SETFILTERCUTOFF]: 'nosetfiltcutoff',
        [CMD_SETFILTERCTRL]: 'nosetfiltctrl',
        [CMD_SETMASTERVOL]: 'nosetmastervol',
      };
      const which = flag[l - WAVECMD];
      if (which !== undefined) f[which] = 0;
    }
    if (l < WAVECMD) {
      if (r <= 0x80) {
        const newlastnote = Math.min(MAX_NOTES - 1, r + patternlastnote);
        if (r >= 0x20) firstnote = 0;
        if (newlastnote > lastnote) lastnote = newlastnote;
      } else {
        const n = r & 0x7f;
        if (n < firstnote) firstnote = n;
        if (Math.min(MAX_NOTES - 1, n) > lastnote) lastnote = Math.min(MAX_NOTES - 1, n);
      }
    }
  }
  for (let c = 0; c < MAX_TABLELEN; c++) {
    if (!tableused[PTBL]![c + 1]) continue;
    const l = ltable[PTBL]![c]!;
    const r = rtable[PTBL]![c]!;
    if (l >= 0x80 && l !== 0xff && r & 0xf) simplepulse = 0;
    if (l < 0x80) {
      f.nopulsemod = 0;
      if (r & 0xf) simplepulse = 0;
    }
  }
  for (let c = 0; c < MAX_TABLELEN; c++) {
    if (tableused[FTBL]![c + 1] && ltable[FTBL]![c]! < 0x80) f.nofiltermod = 0;
  }

  if (lastnote < firstnote) lastnote = firstnote;
  if (firstnote < 0) firstnote = 0;
  if (!f.nocalculatedspeed) lastnote++;
  if (lastnote > MAX_NOTES - 1) lastnote = MAX_NOTES - 1;

  // 9. The source.
  const out: string[] = [];
  const define = (name: string, value: number): void => {
    out.push(`${name.padEnd(16)} = ${value}`);
  };
  define('base', options.playerAddress);
  define('zpbase', options.zeroPage);
  define('SIDBASE', SIDBASE);
  define('SOUNDSUPPORT', 0);
  define('VOLSUPPORT', 0);
  define('BUFFEREDWRITES', 0);
  define('GHOSTREGS', 0);
  define('ZPGHOSTREGS', 0);
  define('FIXEDPARAMS', fixedparams);
  define('SIMPLEPULSE', simplepulse);
  define('PULSEOPTIMIZATION', 1);
  define('REALTIMEOPTIMIZATION', 1);
  define('NOAUTHORINFO', 1);
  // GT's define names are the flags' in capitals, but for the instrument vibrato's.
  for (const n of FLAG_NAMES) define(n === 'noinsvib' ? 'NOINSTRVIB' : n.toUpperCase(), f[n]);
  define('NUMCHANNELS', channels);
  define('NUMSONGS', songs);
  define('FIRSTNOTE', firstnote);
  define('FIRSTNOHRINSTR', numnormal + 1);
  define('FIRSTLEGATOINSTR', numnormal + numnohr + 1);
  define('NUMHRINSTR', numnormal);
  define('NUMNOHRINSTR', numnohr);
  define('NUMLEGATOINSTR', numlegato);
  define('ADPARAM', ADPARAM >> 8);
  define('SRPARAM', ADPARAM & 0xff);
  const hidden = instr[MAX_INSTR - 1]!;
  define('DEFAULTTEMPO', hidden.ad >= 2 && !hidden.ptr[WTBL] ? hidden.ad - 1 : multiplier * 6 - 1);
  if (fixedparams) {
    define('FIRSTWAVEPARAM', instr[1]!.firstwave);
    define('GATETIMERPARAM', instr[1]!.gatetimer & 0x3f);
  }
  out.push(playerSource.replace(/\r\n/g, '\n'));

  const label = (name: string): void => {
    out.push(`${name}:`);
  };
  const bytes = (values: readonly number[]): void => {
    for (let i = 0; i < values.length; i += 16) {
      out.push(`                .BYTE (${values.slice(i, i + 16).map((v) => `$${(v & 0xff).toString(16).padStart(2, '0')}`).join(',')})`);
    }
  };
  const expr = (e: string): void => {
    out.push(`                .BYTE (${e})`);
  };

  const freqs = Array.from({ length: lastnote - firstnote + 1 }, (_, i) => sidTableFreqReg(firstnote + i));
  label('mt_freqtbllo');
  bytes(freqs.map((v) => v & 0xff));
  label('mt_freqtblhi');
  bytes(freqs.map((v) => v >> 8));
  label('mt_songtbllo');
  for (let c = 0; c < songs * 3; c++) expr(`mt_song${c} % 256`);
  label('mt_songtblhi');
  for (let c = 0; c < songs * 3; c++) expr(`mt_song${c} / 256`);
  label('mt_patttbllo');
  for (let c = 0; c < patterns; c++) expr(`mt_patt${c} % 256`);
  label('mt_patttblhi');
  for (let c = 0; c < patterns; c++) expr(`mt_patt${c} / 256`);

  label('mt_insad');
  bytes(insad);
  label('mt_inssr');
  bytes(inssr);
  label('mt_inswaveptr');
  bytes(inswave);
  if (!f.nopulse) {
    label('mt_inspulseptr');
    bytes(inspulse);
  }
  if (!f.nofilter) {
    label('mt_insfiltptr');
    bytes(insfilt);
  }
  if (!f.noinsvib) {
    label('mt_insvibparam');
    bytes(insvibparam);
    label('mt_insvibdelay');
    bytes(insvibdelay);
  }
  if (!fixedparams) {
    label('mt_insgatetimer');
    bytes(insgate);
    label('mt_insfirstwave');
    bytes(insfirst);
  }

  const speedZero = !f.novib || !f.nofunktempo || !f.noportamento || !f.notoneporta;
  for (let c = 0; c < 4; c++) {
    if ((c === PTBL && f.nopulse) || (c === FTBL && f.nofilter)) continue;
    if (c === STBL && speedZero) bytes([0]);
    label(TABLE_LEFT[c]!);
    const left: number[] = [];
    for (let d = 0; d < MAX_TABLELEN; d++) {
      if (!tableused[c]![d + 1]) continue;
      const l = ltable[c]![d]!;
      if (c === WTBL) {
        let wave = l;
        if (l >= WAVESILENT && l <= WAVELASTSILENT) wave &= 0xf;
        if (l > WAVELASTDELAY && l <= WAVELASTSILENT && !f.nowavedelay) wave += 0x10;
        left.push(wave);
      } else if (c === PTBL) {
        left.push(simplepulse && l !== 0xff && l > 0x80 ? 0x80 : l);
      } else if (c === FTBL) {
        left.push(l !== 0xff && l > 0x80 ? ((l & 0x70) >> 1) | 0x80 : l);
      } else left.push(l);
    }
    bytes(left);
    if (c === STBL && speedZero) bytes([0]);
    label(TABLE_RIGHT[c]!);
    const right: number[] = [];
    for (let d = 0; d < MAX_TABLELEN; d++) {
      if (!tableused[c]![d + 1]) continue;
      const l = ltable[c]![d]!;
      const r = rtable[c]![d]!;
      if (l === 0xff && c !== STBL) {
        right.push(tablemap[c]![r]!);
      } else if (c === WTBL) {
        if (l >= WAVECMD && l <= WAVELASTCMD) {
          const cmd = l - WAVECMD;
          if (cmd >= CMD_PORTAUP && cmd <= CMD_VIBRATO) right.push(tablemap[STBL]![r]!);
          else if (cmd === CMD_SETPULSEPTR) right.push(tablemap[PTBL]![r]!);
          else if (cmd === CMD_SETFILTERPTR) right.push(tablemap[FTBL]![r]!);
          else right.push(r);
        } else right.push(r ^ 0x80);
      } else if (c === PTBL && simplepulse) {
        if (l >= 0x80) right.push((l & 0x0f) | (r & 0xf0));
        else {
          let speed = r >> 4;
          if (r & 0x80) {
            speed |= 0xf0;
            speed--;
          }
          speed &= 0xff;
          right.push(((speed & 0x0f) << 4) | ((speed & 0xf0) >> 4));
        }
      } else right.push(r);
    }
    bytes(right);
  }

  for (let c = 0; c < songs; c++) {
    for (let d = 0; d < 3; d++) {
      label(`mt_song${c * 3 + d}`);
      bytes(songData[c]![d]!);
    }
  }
  for (const [c, p] of packed.entries()) {
    label(`mt_patt${c}`);
    bytes(p);
  }
  out.push('');
  return { ok: true, source: out.join('\n'), songs, notes };
}

const rowList = (rows: readonly number[]): string =>
  rows.length === 1 ? `row ${rows[0]}` : `rows ${rows.slice(0, 5).join(', ')}${rows.length > 5 ? ', ...' : ''}`;

/**
 * Where GoatTracker's editor (and this app, which plays like it) and its C64
 * player (`player.s`, what the `.sid` runs) part on the song's tables,
 * measured with the corpus (plan-sid-authoring.md phase 4):
 *  - a pulse-table row with modulation time 0: the editor stays on it and
 *    changes nothing; the C64 player counts the time down from 256, so it
 *    sweeps the pulse for 256 frames and then goes on;
 *  - a pulse or filter jump onto another jump row: both read that row as a
 *    "set" row and go on with the row after it, but in the C64 player's copy
 *    of the table the rows are renumbered (so the value it sets, the pulse
 *    low byte or the filter's resonance and routing, is the new row number)
 *    and only the rows a pointer or jump reaches are kept (so the row after
 *    it may be another table's data).
 */
function tableDifferences(
  ltable: readonly (readonly number[])[],
  rtable: readonly (readonly number[])[],
  tableused: readonly (readonly boolean[])[],
): string[] {
  const notes: string[] = [];
  const timeZero: number[] = [];
  for (let c = 0; c < MAX_TABLELEN; c++) {
    if (tableused[PTBL]![c + 1] && ltable[PTBL]![c] === 0x00) timeZero.push(c + 1);
  }
  if (timeZero.length > 0) {
    notes.push(
      `pulse table ${rowList(timeZero)} ${timeZero.length === 1 ? 'has' : 'have'} a modulation time of 0: here the app (like GoatTracker's editor) holds the pulse, but the C64 player sweeps it for 256 frames`,
    );
  }
  for (const t of [PTBL, FTBL]) {
    const rows: number[] = [];
    for (let c = 0; c < MAX_TABLELEN; c++) {
      const target = rtable[t]![c]!;
      if (tableused[t]![c + 1] && ltable[t]![c] === 0xff && target && ltable[t]![target - 1] === 0xff) rows.push(c + 1);
    }
    if (rows.length > 0) {
      notes.push(
        `${t === PTBL ? 'pulse' : 'filter'} table ${rowList(rows)} ${rows.length === 1 ? 'jumps' : 'jump'} onto another jump row; the C64 player's copy of the table is renumbered and shortened, so what that row sets, and the row after it, can differ from the app`,
      );
    }
  }
  return notes;
}

/**
 * Notes past the top of GoatTracker's note table (index 96..127, after a
 * transpose or a wave-table step): the editor, and this app, play frequency
 * 0 there; the C64 player's table stops at the last note the song needs, so
 * it reads the file's next bytes as the frequency. Found by playing each
 * voice's orderlist once (and its loop), with the instrument each note is
 * played with, through the wave-table rows that instrument (or an 8xx
 * command) starts from.
 */
function noteRangeDifferences(doc: SidDoc): string[] {
  // Wave pointer -> the channel notes (0-based, transposed) it starts with.
  const starts = new Map<number, Set<number>>();
  const add = (ptr: number, note: number): void => {
    if (!ptr) return;
    let set = starts.get(ptr);
    if (set === undefined) starts.set(ptr, (set = new Set()));
    set.add(note);
  };
  for (const subsong of doc.subsongs) {
    for (const list of subsong.orderlists) {
      let instrument = 0;
      let note: number | null = null;
      const order = [...list.entries, ...list.entries.slice(list.restart)];
      for (const entry of order) {
        const pattern = doc.patterns[entry.pattern];
        if (pattern === undefined) continue;
        for (let rep = 0; rep < Math.min(entry.repeat, 2); rep++) {
          for (const row of pattern.rows) {
            if (row.instrument) instrument = row.instrument;
            if (row.note >= 1 && row.note <= 93) {
              note = row.note - 1 + entry.transpose;
              add(doc.instruments[instrument - 1]?.wavePtr ?? 0, note);
            }
            if (row.command === CMD_SETWAVEPTR && note !== null) add(row.param, note);
          }
        }
      }
    }
  }
  const wave = doc.tables.wave;
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const [start, notes] of starts) {
    const visited = new Set<number>();
    for (let ptr = start; ptr >= 1 && ptr <= wave.length && !visited.has(ptr); ) {
      visited.add(ptr);
      const row = wave[ptr - 1]!;
      if (row.left === 0xff) {
        ptr = row.right;
        continue;
      }
      if (row.left < WAVECMD && row.right !== 0x80) {
        for (const n of notes) {
          const index = (row.right < 0x80 ? row.right + n : row.right) & 0x7f;
          if (index >= MAX_NOTES && !seen.has(`${ptr}`)) {
            seen.add(`${ptr}`);
            hits.push(`${ptr}`);
          }
        }
      }
      ptr++;
    }
  }
  if (hits.length === 0) return [];
  const rows = hits.map(Number).sort((a, b) => a - b);
  return [
    `wave table ${rowList(rows)} ${rows.length === 1 ? 'takes' : 'take'} some notes past the top of GoatTracker's note table: there the app plays no pitch, but the C64 player reads other bytes of the file as the pitch`,
  ];
}

/** GT's `gettablepartlen`: rows from `pos` (0-based) up to and including the next jump. */
function tablePartLength(ltable: readonly number[], num: number, pos: number): number {
  if (pos < 0) return 0;
  if (num === STBL) return 1;
  let c = pos;
  for (; c < MAX_TABLELEN; c++) {
    if (ltable[c] === 0xff) {
      c++;
      break;
    }
  }
  return c - pos;
}

/**
 * GT's `findtableduplicates`: a speed-table row equal to an earlier one, and a
 * self-contained wave/pulse/filter part (used throughout, jumps only inside,
 * nothing jumps into it) equal to an earlier one, are left out and mapped onto
 * the first. The row-number bookkeeping is GT's exactly, including its bounds.
 */
function findTableDuplicates(
  num: number,
  ltables: readonly (readonly number[])[],
  rtables: readonly (readonly number[])[],
  tableused: boolean[][],
  tablemap: number[][],
): void {
  const lt = ltables[num]!;
  const rt = rtables[num]!;
  const used = tableused[num]!;
  const map = tablemap[num]!;
  if (num === STBL) {
    for (let c = 1; c <= MAX_TABLELEN; c++) {
      if (!used[c]) continue;
      for (let d = c + 1; d <= MAX_TABLELEN; d++) {
        if (used[d] && lt[d - 1] === lt[c - 1] && rt[d - 1] === rt[c - 1]) {
          used[d] = false;
          for (let e = d; e <= MAX_TABLELEN; e++) if (used[e]) map[e]!--;
          map[d] = map[c]!;
        }
      }
    }
    return;
  }
  const selfContained = (start: number): boolean => {
    const len = tablePartLength(lt, num, start - 1);
    const end = start + len - 1;
    if (len === 1) return false;
    for (let c = start; c <= end; c++) if (!used[c]) return false;
    if (rt[end - 1] !== 0 && (rt[end - 1]! < start || rt[end - 1]! > end)) return false;
    for (let c = 1; c <= MAX_TABLELEN; c++) {
      if (c >= start && c <= end) continue;
      if (used[c] && lt[c - 1] === 0xff && rt[c - 1]! >= start && rt[c - 1]! <= end) return false;
    }
    return true;
  };
  for (let c = 1; c <= MAX_TABLELEN; c++) {
    if (!selfContained(c)) continue;
    for (let d = c + tablePartLength(lt, num, c - 1); d <= MAX_TABLELEN; ) {
      const len = tablePartLength(lt, num, d - 1);
      if (selfContained(d)) {
        let e = 0;
        for (; e < len; e++) {
          if (e < len - 1) {
            if (lt[d + e - 1] !== lt[c + e - 1] || rt[d + e - 1] !== rt[c + e - 1]) break;
          } else {
            if (lt[d + e - 1] !== lt[c + e - 1]) break;
            if (rt[d + e - 1] === 0) {
              if (rt[c + e - 1] !== 0) break;
            } else if (rt[d + e - 1]! - d !== rt[c + e - 1]! - c) break;
          }
        }
        if (e === len) {
          for (e = 0; e < len; e++) used[d + e] = false;
          for (e = d; e < MAX_TABLELEN; e++) if (used[e]) map[e]! -= len;
          for (e = 0; e < len; e++) map[d + e] = map[c + e]!;
        }
      }
      d += len;
    }
  }
}

/**
 * GT's `packpattern`: `rows` 4-byte rows -> the player's pattern bytes, or
 * null past 256. An instrument equal to the previous one is dropped; table
 * parameters are renumbered; a tempo's parameter is one less (not funktempo);
 * a command is written (FX + cmd before a note, FXONLY + cmd on an empty row)
 * only when it changes; runs of 2-64 empty rows become one byte.
 */
function packPattern(
  src: readonly number[],
  rows: number,
  f: Record<Flag, number>,
  tablemap: readonly (readonly number[])[],
  instrmap: readonly number[],
): number[] | null {
  const t = src.slice(0, rows * 4);
  let instr = 0;
  for (let c = 0; c < rows; c++) {
    const ins = src[c * 4 + 1]!;
    if (c && ins && ins === instr) t[c * 4 + 1] = 0;
    else if (ins) instr = ins;
    const cmd = t[c * 4 + 2]!;
    const at = c * 4 + 3;
    switch (cmd) {
      case CMD_PORTAUP:
      case CMD_PORTADOWN:
        f.noportamento = 0;
        t[at] = tablemap[STBL]![t[at]!]!;
        break;
      case CMD_TONEPORTA:
        f.notoneporta = 0;
        t[at] = tablemap[STBL]![t[at]!]!;
        break;
      case CMD_VIBRATO:
        f.novib = 0;
        t[at] = tablemap[STBL]![t[at]!]!;
        break;
      case CMD_SETAD:
        f.nosetad = 0;
        break;
      case CMD_SETSR:
        f.nosetsr = 0;
        break;
      case CMD_SETWAVE:
        f.nosetwave = 0;
        break;
      case CMD_SETWAVEPTR:
        f.nosetwaveptr = 0;
        t[at] = tablemap[WTBL]![t[at]!]!;
        break;
      case CMD_SETPULSEPTR:
        f.nosetpulseptr = 0;
        f.nopulse = 0;
        t[at] = tablemap[PTBL]![t[at]!]!;
        break;
      case CMD_SETFILTERPTR:
        f.nosetfiltptr = 0;
        f.nofilter = 0;
        t[at] = tablemap[FTBL]![t[at]!]!;
        break;
      case CMD_SETFILTERCTRL:
        f.nosetfiltctrl = 0;
        f.nofilter = 0;
        break;
      case CMD_SETFILTERCUTOFF:
        f.nosetfiltcutoff = 0;
        f.nofilter = 0;
        break;
      case CMD_SETMASTERVOL:
        f.nosetmastervol = 0;
        // Without author info GT erases timing marks (a volume above $0F).
        if (t[at]! > 0x0f) {
          t[c * 4 + 2] = 0;
          t[at] = 0;
        }
        break;
      case CMD_FUNKTEMPO:
        f.nofunktempo = 0;
        t[at] = tablemap[STBL]![t[at]!]!;
        break;
      case CMD_SETTEMPO:
        if (t[at]! >= 0x80) f.nochanneltempo = 0;
        else f.noglobaltempo = 0;
        if ((t[at]! & 0x7f) >= 3) t[at] = t[at]! - 1;
        break;
    }
  }

  let command = -1;
  let databyte = -1;
  if (f.noeffects) {
    command = 0;
    databyte = 0;
  }
  const im: number[] = [];
  for (let c = 0; c < rows; c++) {
    const note = t[c * 4]!;
    const ins = t[c * 4 + 1]!;
    const cmd = t[c * 4 + 2]!;
    const param = t[c * 4 + 3]!;
    if (ins) im.push(instrmap[ins]!);
    const changed = cmd !== command || param !== databyte;
    if (note === REST) {
      if (changed) {
        command = cmd;
        databyte = param;
        im.push(FXONLY + command);
        if (command) im.push(databyte);
      } else im.push(REST);
    } else {
      if (changed) {
        command = cmd;
        databyte = param;
        im.push(FX + command);
        if (command) im.push(databyte);
      }
      im.push(note);
    }
  }

  // Runs of plain rests -> one packed-rest byte (never the first row).
  const dest: number[] = [];
  for (let c = 0; c < im.length; ) {
    let packok = c !== 0;
    if (im[c]! < FX) {
      dest.push(im[c++]!);
      packok = false;
    }
    if (im[c]! >= FXONLY && im[c]! < FIRSTNOTE) {
      const fx = im[c]! - FXONLY;
      dest.push(im[c++]!);
      if (fx) dest.push(im[c++]!);
      continue;
    }
    if (im[c]! < FXONLY) {
      const fx = im[c]! - FX;
      dest.push(im[c++]!);
      if (fx) dest.push(im[c++]!);
      packok = false;
    }
    if (im[c] !== REST) packok = false;
    if (!packok) dest.push(im[c++]!);
    else {
      let d = c;
      while (d < im.length && im[d] === REST) {
        d++;
        if (d - c === 64) break;
      }
      d -= c;
      if (d > 1) {
        dest.push((-d) & 0xff);
        c += d;
      } else dest.push(im[c++]!);
    }
  }
  if (dest.length > 256) return null;
  if (dest.length < 256) dest.push(0x00);
  return dest;
}
