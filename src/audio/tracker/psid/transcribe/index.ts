import {
  compileSidFlatSong,
  makeSidDoc,
  type SidFlatSubsong,
  SID_CHANNELS,
  SID_DEFAULT_TEMPO,
  SID_FILE_VERSION,
  SID_MAX_INSTRUMENTS,
  SID_MAX_SPEED_MULTIPLIER,
  SID_MAX_SUBSONGS,
  type SidDoc,
} from 'src/audio/tracker/sid-doc';
import { gtPackedPatternSize } from 'src/audio/tracker/sid-export';
import { captureSid, type SidTrace } from '../sid-capture';
import type { PsidFile } from '../psid-file';
import { estimateTuning, traceFrames, type TraceFrames } from './frames';
import { detectGrid, rowLength, rowOfFrame, tempoChanges, type RowGrid } from './grid';
import { buildInstruments, groupNotes, TableBuilder, type InstrumentPlan } from './instruments';
import { filterDriver, noteBase, notePrograms, onsetsOf, placeNotes, type NoteProgram } from './notes';
import { planPitch, type PitchRow } from './pitch';
import { findLoop, flatSubsong, subsongRows, type PatternPitch, type SongLoop, type SubsongRows } from './song';

/**
 * A `.sid` of any player, transcribed into a GoatTracker song
 * (plan-psid-import.md §3, phase 2): every subsong is run on the emulated
 * C64, its register trace cut into rows and notes, the notes grouped into
 * instruments, and the rows compiled through the flat song model, the one
 * the editor edits. Subsongs share the instruments and tables; the start
 * song comes first, and a subsong that no longer fits GoatTracker's limits
 * (63 instruments, 255 rows a table, 208 patterns, 32 subsongs) or runs at
 * another speed is left out with a note.
 */

export interface TranscribeOptions {
  /** PSID subsongs to import (0-based), in order. Default: the start song, then the others. */
  readonly subsongs?: readonly number[];
  /** Capture length cap per subsong, seconds (default 600). */
  readonly maxSeconds?: number;
}

export interface SubsongReport {
  /** The PSID subsong (0-based). */
  readonly subsong: number;
  /** The GoatTracker subsong it became, or null when it was left out. */
  readonly gtSubsong: number | null;
  readonly reason?: string;
  readonly frames?: number;
  readonly grid?: RowGrid;
  readonly notes?: number;
  readonly folded?: number;
  readonly loop?: SubsongRows['loop'];
  readonly rows?: number;
  /** The capture (for measuring the result against). */
  readonly trace?: SidTrace;
  /** It did not loop and was cut to this many rows to fit GoatTracker. */
  readonly cutRows?: number;
}

export type PsidTranscription =
  | { readonly ok: true; readonly doc: SidDoc; readonly reports: readonly SubsongReport[]; readonly notes: readonly string[] }
  | { readonly ok: false; readonly reason: string; readonly reports: readonly SubsongReport[] };

/** GoatTracker's 1x frame rate (PAL, `player.rs` `frame_cycles`). */
const PAL_FRAME_HZ = 985248 / 19656;

const WAVE_NAMES: Readonly<Record<number, string>> = { 0x10: 'tri', 0x20: 'saw', 0x40: 'pulse', 0x80: 'noise' };

function instrumentName(plan: InstrumentPlan, n: number): string {
  const waves = new Set(plan.group.rep.frames.map((f) => f.ctrl & 0xf0).filter((w) => w !== 0));
  const parts = [...waves].map((w) => WAVE_NAMES[w] ?? `$${w.toString(16)}`).slice(0, 2);
  return `${parts.join('+') || 'silent'}${plan.vibrato ? ' vib' : ''} ${n}`.slice(0, 16);
}

interface Prepared {
  readonly subsong: number;
  /** The voice whose notes drive the filter, or null. */
  readonly driver: number | null;
  readonly trace: SidTrace;
  readonly frames: TraceFrames;
  readonly grid: RowGrid;
  readonly loop: SongLoop;
  /** The notes of one pass of the song (up to its loop's end). */
  readonly programs: NoteProgram[];
  /** Per voice, the pitch effects' pattern cells (`pitch.ts`). */
  readonly pitch: readonly (readonly PitchRow[])[];
  /** Pitch is played by pattern effects (else by the instruments alone, to take less room). */
  readonly effects: boolean;
  readonly folded: number;
}

/** Per row, what each voice starts there: the note, its envelope and first frames. */
function noteKeys(rows: number, programs: readonly NoteProgram[]): string[] {
  const cells: string[][] = [0, 1, 2].map(() => Array.from({ length: rows }, () => '.'));
  for (const p of programs) {
    if (p.note.row >= rows) continue;
    const head = p.frames.slice(0, 4).map((x) => x.ctrl).join(',');
    cells[p.note.voice]![p.note.row] = `${p.base}/${p.ad}/${p.sr}/${head}`;
  }
  return Array.from({ length: rows }, (_, r) => `${cells[0]![r]}|${cells[1]![r]}|${cells[2]![r]}`);
}

function prepare(file: PsidFile, subsong: number, maxSeconds: number | undefined): Prepared | string {
  const capture = captureSid(file, maxSeconds === undefined ? { subsong } : { subsong, maxSeconds });
  if (!capture.ok) return capture.reason;
  return transcribed(subsong, capture.trace, true);
}

/**
 * The rows and notes of a captured subsong; `effects`: its pitch as pattern
 * effects (`pitch.ts`), or, when the song must be smaller to fit
 * GoatTracker, as the instruments' wave tables alone.
 */
function transcribed(subsong: number, trace: SidTrace, effects: boolean): Prepared | string {
  const frames = traceFrames(trace);
  const onsets = onsetsOf(frames);
  if (onsets.every((l) => l.length === 0)) return 'plays no notes';
  const grid = detectGrid(onsets, frames.frames);
  const tuning = estimateTuning(frames);
  const notes = placeNotes(frames, grid, onsets);
  const plans = effects ? notes.map((list) => planPitch(frames, grid, list, (n) => noteBase(frames, grid, n, tuning), tuning)) : [];
  const all = notes.flatMap((list, v) => notePrograms(frames, list, tuning, grid, plans[v]));
  const driver = filterDriver(frames, onsets);
  for (const p of all) if (p.note.voice === driver) p.filter = true;
  const rows = rowOfFrame(grid, frames.frames - 1) + 1;
  const loop = findLoop(frames, grid, noteKeys(rows, all));
  const programs = all.filter((p) => p.note.row < loop.length);
  const folded = notes.flat().reduce((n, x) => n + (x.row < loop.length ? x.folded : 0), 0);
  const pitch = plans.map((p) => p.rows.filter((x) => x.row < loop.length));
  return { subsong, driver, trace, frames, grid, loop, programs, pitch, effects, folded };
}

/** Transcribe `file` into a GoatTracker song. Never throws for a tune's behaviour. */
export function transcribePsid(file: PsidFile, options: TranscribeOptions = {}): PsidTranscription {
  const order =
    options.subsongs ?? [file.startSong - 1, ...Array.from({ length: file.songs }, (_, i) => i).filter((i) => i !== file.startSong - 1)];
  const reports: SubsongReport[] = [];
  const notes: string[] = [];
  const preps: Prepared[] = [];
  let speedMultiplier: number | null = null;

  for (const s of order) {
    if (preps.length >= SID_MAX_SUBSONGS) {
      reports.push({ subsong: s, gtSubsong: null, reason: `GoatTracker holds ${SID_MAX_SUBSONGS} subsongs` });
      continue;
    }
    const prep = prepare(file, s, options.maxSeconds);
    if (typeof prep === 'string') {
      reports.push({ subsong: s, gtSubsong: null, reason: prep });
      continue;
    }
    const mult = Math.max(1, Math.min(SID_MAX_SPEED_MULTIPLIER, Math.round(prep.frames.rateHz / PAL_FRAME_HZ)));
    if (speedMultiplier === null) {
      speedMultiplier = mult;
      const gtHz = PAL_FRAME_HZ * mult;
      const off = prep.frames.rateHz / gtHz - 1;
      if (Math.abs(off) > 0.01) {
        notes.push(
          `The tune's player runs at ${prep.frames.rateHz.toFixed(2)} Hz; GoatTracker plays it at ${gtHz.toFixed(2)} Hz (${mult}x), ${Math.abs(off * 100).toFixed(1)}% ${off > 0 ? 'slower' : 'faster'}.`,
        );
      }
    } else if (mult !== speedMultiplier) {
      reports.push({ subsong: s, gtSubsong: null, reason: `${mult}x speed; the song plays at ${speedMultiplier}x` });
      continue;
    }
    preps.push(prep);
  }
  if (preps.length === 0 || speedMultiplier === null) {
    return { ok: false, reason: reports.map((r) => `subsong ${r.subsong + 1}: ${r.reason ?? '?'}`).join('; ') || 'the file has no subsongs', reports };
  }

  // All the subsongs that fit: while the song does not, a subsong that does not
  // loop is cut shorter first, then subsongs are left out from the last.
  let lastReason = '';
  let current = preps.slice();
  const cut = new Map<number, number>();
  for (;;) {
    const built = build(file, current, speedMultiplier);
    if (built.ok) {
      for (const prep of preps) {
        const at = current.findIndex((p) => p.subsong === prep.subsong);
        const r = built.rows[at];
        if (at < 0 || r === undefined) {
          reports.push({ subsong: prep.subsong, gtSubsong: null, reason: `no room left in GoatTracker's limits: ${lastReason}` });
          continue;
        }
        const cutRows = cut.get(prep.subsong);
        if (cutRows !== undefined) {
          notes.push(`Subsong ${prep.subsong + 1} does not repeat within its first ${Math.round(current[at]!.frames.frames / current[at]!.frames.rateHz)} s, and only its first ${cutRows} rows fit GoatTracker.`);
        }
        reports.push({
          subsong: prep.subsong,
          gtSubsong: at,
          frames: prep.frames.frames,
          grid: prep.grid,
          notes: current[at]!.programs.length,
          folded: prep.folded,
          loop: r.loop,
          rows: r.length,
          trace: prep.trace,
          ...(cutRows !== undefined ? { cutRows } : {}),
        });
      }
      return { ok: true, doc: built.doc, reports, notes };
    }
    lastReason = built.reason;
    const longest = current
      .map((p, i) => [p, i] as const)
      .filter(([p]) => p.loop.kind === 'none' && p.loop.length > 64)
      .sort((a, b) => b[0].loop.length - a[0].loop.length)[0];
    if (longest !== undefined) {
      const [p, i] = longest;
      // First the same rows with its pitch in the instruments alone: fewer distinct patterns.
      const plain = p.effects ? transcribed(p.subsong, p.trace, false) : null;
      if (plain !== null && typeof plain !== 'string' && plain.loop.kind === 'none') {
        current = current.slice();
        current[i] = plain;
        continue;
      }
      const length = Math.floor(p.loop.length / 2);
      current = current.slice();
      current[i] = { ...p, loop: { loopRow: 0, length, kind: 'none' }, programs: p.programs.filter((x) => x.note.row < length) };
      cut.set(p.subsong, length);
      continue;
    }
    if (current.length > 1) {
      // The most subsongs (from the first) that fit: a binary search, since a build is costly.
      let lo = 1;
      let hi = current.length - 1;
      let fitting: Prepared[] | null = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const attempt = build(file, current.slice(0, mid), speedMultiplier);
        if (attempt.ok) {
          fitting = current.slice(0, mid);
          lo = mid + 1;
        } else {
          lastReason = attempt.reason;
          hi = mid - 1;
        }
      }
      if (fitting !== null) {
        current = fitting;
        continue;
      }
      current = current.slice(0, 1);
      continue;
    }
    return { ok: false, reason: lastReason, reports };
  }
}

/**
 * A filter no voice's notes drive but the song uses (some voice routed through
 * it in a tenth of the frames): set once on row 0 (`A`, a filter program of
 * its most common mode, resonance and routing and its median cutoff).
 */
function staticFilter(prep: Prepared, tables: TableBuilder): { row: number; command: number; param: number }[] {
  if (prep.driver !== null) return [];
  const f = prep.frames;
  const routed: number[] = [];
  for (let i = 0; i < f.frames; i++) if (f.resonance[i]! & 7) routed.push(i);
  if (routed.length < f.frames / 10) return [];
  const common = (values: readonly number[]): number => {
    const counts = new Map<number, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  };
  const cutoffs = routed.map((i) => f.cutoff[i]! >> 3).sort((a, b) => a - b);
  const program = {
    rows: [
      { left: 0x80 | (common(routed.map((i) => (f.modeVolume[i]! >> 4) & 7)) << 4), right: common(routed.map((i) => f.resonance[i]!)) },
      { left: 0x00, right: cutoffs[cutoffs.length >> 1]! },
      { left: 0xff, right: 0 },
    ],
  };
  return [{ row: 0, command: 0xa, param: tables.place('filter', program) }];
}

type Built = { readonly ok: true; readonly doc: SidDoc; readonly rows: readonly SubsongRows[] } | { readonly ok: false; readonly reason: string };

/** One song of `preps`: instruments grouped across all of them, tables fitted, rows compiled. */
function build(file: PsidFile, preps: readonly Prepared[], speedMultiplier: number): Built {
  const tables = new TableBuilder();
  // A gate timer must stay below every row's length (GoatTracker reads the next row
  // when its counter meets the gate timer).
  let rowFrames = 127;
  for (const prep of preps) for (let k = 0; k < prep.loop.length; k++) rowFrames = Math.min(rowFrames, rowLength(prep.grid, k));
  const plans = groupNotes(preps.flatMap((p) => p.programs), SID_MAX_INSTRUMENTS);
  const instruments = buildInstruments(plans, tables, rowFrames, instrumentName);
  if (!tables.fits) return { ok: false, reason: "GoatTracker's tables are full" };
  const instrumentOf = new Map<NoteProgram, number>();
  plans.forEach((plan, i) => {
    for (const m of plan.members) instrumentOf.set(m, i + 1);
  });

  const rowsList = preps.map((prep) => {
    // Tempo: where the row length changes, and again at the loop row (the song comes
    // back there from its end); row 0 at 1x may rely on GoatTracker's start tempo 6.
    const tempo = tempoChanges(prep.grid, prep.loop.length).filter(
      (t) => !(t.row === 0 && t.length === SID_DEFAULT_TEMPO && speedMultiplier === 1),
    );
    const loopRow = prep.loop.loopRow;
    if (loopRow > 0 && !tempo.some((t) => t.row === loopRow)) tempo.push({ row: loopRow, length: rowLength(prep.grid, loopRow) });
    const pitch: PatternPitch[] = prep.pitch.flatMap((list, voice) =>
      list.map((x) => ({
        voice,
        row: x.row,
        note: x.note,
        command: x.command,
        // A speed-table row holds the 16-bit speed (below $8000: the register step itself).
        param: x.speed === 0 ? 0 : tables.speedRow(Math.min(0x7f, x.speed >> 8), x.speed >= 0x8000 ? 0xff : x.speed & 0xff),
        continued: x.continued,
      })),
    );
    return subsongRows(prep.loop, prep.grid, prep.programs, instrumentOf, (n) => instruments[n - 1]?.gateTimer ?? 2, tempo, staticFilter(prep, tables), pitch);
  });

  const base = makeSidDoc({
    format: 'sid',
    version: SID_FILE_VERSION,
    songName: file.name.slice(0, 32),
    author: file.author.slice(0, 32),
    copyright: file.released.slice(0, 32),
    chipModel: file.sidModel === '8580' ? '8580' : '6581',
    channels: SID_CHANNELS,
    speedMultiplier,
    tempo: SID_DEFAULT_TEMPO,
    subsongs: [{ orderlists: [0, 1, 2].map(() => ({ entries: [{ pattern: 0, transpose: 0, repeat: 1 }], restart: 0 })) }],
    patterns: [{ rows: [{ note: 0, instrument: 0, command: 0, param: 0 }] }],
    instruments,
    tables: { wave: tables.wave, pulse: tables.pulse, filter: tables.filter, speed: tables.speed },
  });

  // Per subsong, the longest patterns that pack for GoatTracker's player (256
  // bytes) and keep its orderlists within 254 bytes; then all compiled together.
  const flats: SidFlatSubsong[] = [];
  for (const [i, rows] of rowsList.entries()) {
    let chosen: SidFlatSubsong | null = null;
    let why = 'no pattern length fits';
    for (const size of [128, 96, 64, 48, 32, 24, 16, 8]) {
      const flat = flatSubsong(rows, size, `s${i}`);
      if (Object.values(flat.patterns).some((p) => p.cells.some((c) => gtPackedPatternSize(c.rows) > 256))) {
        why = `patterns of ${size} rows pack to more than GoatTracker's player reads`;
        continue;
      }
      const alone = compileSidFlatSong(base, [flat]);
      if (!alone.ok) {
        why = alone.reason;
        continue;
      }
      chosen = flat;
      break;
    }
    if (chosen === null) return { ok: false, reason: `subsong ${preps[i]!.subsong + 1}: ${why}` };
    flats.push(chosen);
  }
  if (!tables.fits) return { ok: false, reason: "GoatTracker's tables are full" };
  const compiled = compileSidFlatSong(base, flats);
  if (!compiled.ok) return { ok: false, reason: compiled.reason };
  return { ok: true, doc: compiled.doc, rows: rowsList };
}
