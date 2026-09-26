import { describe, expect, it } from 'vitest';
import {
  BLANK_SID_ROW,
  compileSidFlatSong,
  makeSidDoc,
  SID_CHANNELS,
  SID_DEFAULT_TEMPO,
  SID_FILE_VERSION,
  SID_NOTE_FIRST,
  type SidDoc,
  type SidDocRow,
  type SidInstrument,
} from 'src/audio/tracker/sid-doc';
import { exportSid } from 'src/audio/tracker/sid-export';
import { captureSid, parsePsid } from 'src/audio/tracker/psid';
import { foldInstruments } from 'src/audio/tracker/psid/transcribe/fold';
import { flatSubsong, type SubsongRows } from 'src/audio/tracker/psid/transcribe/song';

/**
 * A transcription's instruments that differ from another in one thing only
 * fold into it as a row command (`fold.ts`): a sound's accents are commands
 * on one instrument, not an instrument each.
 */

const base: SidInstrument = {
  name: 'pulse',
  attack: 0,
  decay: 9,
  sustain: 10,
  release: 8,
  firstWave: 0x09,
  gateTimer: 2,
  hardRestart: true,
  noGateOff: false,
  vibratoDelay: 0,
  wavePtr: 1,
  pulsePtr: 1,
  filterPtr: 0,
  speedPtr: 0,
};

const INSTRUMENTS: readonly SidInstrument[] = [
  base,
  // An accent: a harder attack (5xx).
  { ...base, name: 'accent', attack: 2, decay: 10 },
  // Another start of the pulse (9xx).
  { ...base, name: 'wide', pulsePtr: 3 },
  // Another wave program (8xx).
  { ...base, name: 'octave', wavePtr: 3 },
  // Two things differ: its own instrument still.
  { ...base, name: 'soft', attack: 5, sustain: 4 },
  // The same sound (a wave program cut to fit can make two so).
  { ...base, name: 'twin' },
];

const note = (n: number, instrument: number, command = 0, param = 0): SidDocRow => ({ note: SID_NOTE_FIRST + n, instrument, command, param });

/** One voice of notes every 4 rows through `instruments` (1-based), 48 rows. */
function rowsOf(instruments: readonly number[], commands: ReadonlyMap<number, readonly [number, number]> = new Map()): SubsongRows {
  const voice = Array.from({ length: 48 }, (_, r): SidDocRow => {
    if (r % 4 !== 0) return BLANK_SID_ROW;
    const k = r / 4;
    const [command, param] = commands.get(r) ?? [0, 0];
    return note(24 + (k % 5), instruments[k % instruments.length]!, command, param);
  });
  return { voices: [voice, voice.map(() => BLANK_SID_ROW), voice.map(() => BLANK_SID_ROW)], length: 48, loopRow: 0, loop: 'exact' };
}

function docOf(instruments: readonly SidInstrument[], rows: SubsongRows): SidDoc {
  const empty = makeSidDoc({
    format: 'sid',
    version: SID_FILE_VERSION,
    songName: 'fold',
    author: '',
    copyright: '',
    chipModel: '6581',
    channels: SID_CHANNELS,
    speedMultiplier: 1,
    tempo: SID_DEFAULT_TEMPO,
    subsongs: [{ orderlists: [0, 1, 2].map(() => ({ entries: [{ pattern: 0, transpose: 0, repeat: 1 }], restart: 0 })) }],
    patterns: [{ rows: [{ note: 0, instrument: 0, command: 0, param: 0 }] }],
    instruments: instruments.slice(),
    tables: {
      wave: [
        { left: 0x41, right: 0x00 },
        { left: 0xff, right: 0x00 },
        { left: 0x41, right: 0x0c },
        { left: 0xff, right: 0x00 },
      ],
      pulse: [
        { left: 0x84, right: 0x00 },
        { left: 0xff, right: 0x00 },
        { left: 0x8c, right: 0x00 },
        { left: 0xff, right: 0x00 },
      ],
      filter: [],
      speed: [],
    },
  });
  const compiled = compileSidFlatSong(empty, [flatSubsong(rows, 48, 's0')]);
  if (!compiled.ok) throw new Error(compiled.reason);
  return compiled.doc;
}

/** The SID registers after every frame of `doc` played by GoatTracker's player, as exported. */
function registersOf(doc: SidDoc): Uint8Array {
  const exported = exportSid(doc);
  if (!exported.ok) throw new Error(exported.reason);
  const parsed = parsePsid(exported.bytes);
  if (!parsed.ok) throw new Error(parsed.reason);
  const c = captureSid(parsed.file, { subsong: 0, maxSeconds: 8 });
  if (!c.ok) throw new Error(c.reason);
  return c.trace.regs;
}

describe('foldInstruments', () => {
  it('folds an instrument that differs in one thing into a command, and merges twins; one that differs in two stays', () => {
    const f = foldInstruments(INSTRUMENTS, [rowsOf([1, 2, 3, 4, 5, 6])]);
    expect(f.instruments.map((i) => i.name)).toEqual(['pulse', 'soft']);
    const played = f.songs[0]!.voices[0]!.filter((r) => r.instrument !== 0).slice(0, 6);
    expect(played.map((r) => [r.instrument, r.command, r.param])).toEqual([
      [1, 0, 0],
      [1, 0x5, 0x2a],
      [1, 0x9, 3],
      [1, 0x8, 3],
      [2, 0, 0],
      [1, 0, 0],
    ]);
  });

  it('plays exactly as before: the same registers every frame through GoatTracker\'s player', () => {
    const rows = rowsOf([1, 2, 3, 4, 5, 6]);
    const f = foldInstruments(INSTRUMENTS, [rows]);
    const before = registersOf(docOf(INSTRUMENTS, rows));
    const after = registersOf(docOf(f.instruments, f.songs[0]!));
    // (Each capture stops where the machine repeats itself, which RAM the player keeps can move: the song's whole pass, 288 frames, is in both.)
    const n = Math.min(before.length, after.length);
    expect(n).toBeGreaterThanOrEqual(48 * SID_DEFAULT_TEMPO * 25);
    expect(Buffer.from(after.subarray(0, n)).equals(Buffer.from(before.subarray(0, n)))).toBe(true);
  }, 60_000);

  it('leaves an instrument whose rows already hold a command (a portamento) as it is, but still merges a twin', () => {
    // The accent's first note (row 4) and the twin's second (row 20) carry a portamento.
    const commands = new Map<number, readonly [number, number]>([
      [4, [0x1, 0x01]],
      [20, [0x1, 0x01]],
    ]);
    const f = foldInstruments(INSTRUMENTS.slice(0, 2).concat(INSTRUMENTS[5]!), [rowsOf([1, 2, 3], commands)]);
    expect(f.instruments.map((i) => i.name)).toEqual(['pulse', 'accent']);
    const twin = f.songs[0]!.voices[0]![20]!;
    expect([twin.instrument, twin.command, twin.param]).toEqual([1, 0x1, 0x01]);
  });

  it('never folds a zero pointer into a command (GoatTracker keeps the running program there)', () => {
    const f = foldInstruments([base, { ...base, name: 'no pulse', pulsePtr: 0 }], [rowsOf([1, 2])]);
    expect(f.instruments).toHaveLength(2);
  });
});
