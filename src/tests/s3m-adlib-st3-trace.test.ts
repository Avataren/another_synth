/**
 * .ai/plan-opl.md O3 gate: S3M AdLib playback against Scream Tracker 3.
 *
 * The references are ST3's own register writes. `fixtures/opl/st3-traces/`
 * holds st3play's (a C port of ST3.21's replayer) AdLib output for the
 * corpus's tier-1 songs, one line per `outaw` with the tick it happened on
 * (see regen.sh there). This plays each song through the real importer, the
 * real engine and `S3mOplDriver`, and compares, tick by tick, the values
 * written to every register.
 *
 * Differences that are documented and inaudible are classified, not
 * failed: tick 0's idle key-on (`isIdleKeyOn`), writes on a channel still
 * holding the silent empty timbre, and pitch within 2 F-number steps.
 * Debug a song with OPL_TRACE_DEBUG=<name>: its first unexplained ticks.
 *
 * Times become ticks row by row: ST3's trace marks the tick each row starts
 * on, the engine reports the time it schedules each row at, and a write's
 * tick within its row is its offset over the tick length. So the two never
 * drift apart over a long song however their tempo rounding differs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import {
  PlaybackEngine,
  S3mOplDriver,
  buildPlaybackSong,
  parseS3m,
  s3mAdlibChannelForTrack,
} from '@another-synth/tracker-playback';
import type { OplInstrumentData, PlaybackClock, Song } from '@another-synth/tracker-playback';
import { importS3mToTrackerSong } from 'src/audio/tracker/s3m-import';
// Relative on purpose, as in opl-worklet-core.test.ts: the real wasm.
import { OplRenderer, initSync } from '../../public/wasm/audio_processor.js';
import { useTrackerStore } from 'src/stores/tracker-store';

const FIXTURES = path.resolve(__dirname, 'fixtures/opl');
const CLOCK_STEP_SECONDS = 0.05;

class ManualClock implements PlaybackClock {
  now = 0;
  private tick: ((deltaMs: number) => void) | null = null;
  start(tick: (deltaMs: number) => void) {
    this.tick = tick;
  }
  stop() {
    this.tick = null;
  }
  setVisible() {}
  get running() {
    return this.tick !== null;
  }
  advance(seconds: number) {
    const end = this.now + seconds;
    while (this.tick !== null && this.now < end) {
      this.now += CLOCK_STEP_SECONDS;
      this.tick(CLOCK_STEP_SECONDS * 1000);
    }
  }
}

/** Per tick, per register, the values written in order. */
type TickWrites = Map<number, Map<number, number[]>>;

interface St3Trace {
  writes: TickWrites;
  /** The tick each row starts on, in play order. */
  rowTicks: number[];
  /** BPM in effect on each row's first tick. */
  rowBpm: number[];
  ticks: number;
}

function addWrite(into: TickWrites, tick: number, reg: number, val: number) {
  let regs = into.get(tick);
  if (!regs) into.set(tick, (regs = new Map()));
  let vals = regs.get(reg);
  if (!vals) regs.set(reg, (vals = []));
  vals.push(val);
}

function readTrace(name: string): St3Trace {
  const writes: TickWrites = new Map();
  const rowTicks: number[] = [];
  /** [tick, bpm] from each T line: the tempo from that tick on. */
  const tempos: Array<[number, number]> = [];
  let last: { ord: number; row: number; tick: number } | null = null;
  let beforeLast: { ord: number; row: number } | null = null;
  let ticks = 0;
  for (const line of fs.readFileSync(path.join(FIXTURES, 'st3-traces', `${name}.trace`), 'utf8').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'T') {
      const [tick, , bpm, ord, row] = parts.slice(1).map(Number) as [number, number, number, number, number];
      // ST3 advances its next-row pointer on a row's last tick, so the row
      // that pointer names starts on the tick after (row 0 on tick 0).
      if (!last) rowTicks.push(0);
      else if (last.ord !== ord || last.row !== row) {
        // A pattern-delay repeat: `dorow` steps np_row back on the tick
        // after the row's last, so the pointer flicks back for one tick.
        // That tick starts a repeat, not the next row; the engine does not
        // report repeats as rows either.
        if (beforeLast && beforeLast.ord === ord && beforeLast.row === row && tick === last.tick + 1) {
          rowTicks.pop();
        } else {
          rowTicks.push(tick + 1);
        }
        beforeLast = { ord: last.ord, row: last.row };
      }
      if (!last || last.ord !== ord || last.row !== row) last = { ord, row, tick };
      tempos.push([tick, bpm]);
      ticks = tick + 1;
    } else if (parts.length === 3) {
      const tick = Number(parts[0]);
      if (tick < 0) continue; // initadlib: S3mOplDriver.reset, pinned in opl-driver.spec.ts
      addWrite(writes, tick, parseInt(parts[1]!, 16), parseInt(parts[2]!, 16));
      ticks = Math.max(ticks, tick + 1);
    }
  }
  // A Txx takes effect on the tick that reads it: each row's tempo is the
  // latest one set at or before its first tick.
  const rowBpm = rowTicks.map((start) => {
    let bpm = tempos[0]?.[1] ?? 125;
    for (const [tick, value] of tempos) {
      if (tick > start) break;
      bpm = value;
    }
    return bpm;
  });
  return { writes, rowTicks, rowBpm, ticks };
}

function loadSong(file: string): { song: Song; bytes: Uint8Array; instruments: Map<string, OplInstrumentData> } {
  const buf = fs.readFileSync(path.join(FIXTURES, 's3m-adlib', file));
  const bytes = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const tracker = importS3mToTrackerSong(bytes.slice().buffer as ArrayBuffer);
  setActivePinia(createPinia());
  const store = useTrackerStore();
  store.loadSongFile(tracker);
  const song = buildPlaybackSong(
    {
      currentSong: { ...store.currentSong },
      moduleFormat: store.moduleFormat,
      initialSpeed: store.initialSpeed,
      linearFrequency: store.linearFrequency,
      amigaLimits: store.amigaLimits,
      fastVolumeSlides: store.fastVolumeSlides,
      initialGlobalVolume: store.initialGlobalVolume,
      vblankTiming: store.vblankTiming,
      patterns: store.patterns,
      sequence: store.sequence,
      currentPatternId: store.currentPatternId,
      currentPattern: store.currentPattern,
      defaultPatternRows: store.defaultPatternRows,
      normalizeInstrumentId: (id) => (id ? id : undefined),
    },
    'song',
  );
  const instruments = new Map<string, OplInstrumentData>();
  for (const slot of tracker.data.instrumentSlots) {
    if (slot.oplData) instruments.set(String(slot.slot).padStart(2, '0'), slot.oplData as OplInstrumentData);
  }
  return { song, bytes, instruments };
}

/** Plays `file` through engine + driver for `seconds`; writes by time, row start times. */
async function playThroughDriver(file: string, seconds: number) {
  const { song, bytes, instruments } = loadSong(file);
  const s3m = parseS3m(bytes);
  const channelMap = s3mAdlibChannelForTrack(s3m);
  const writes: Array<[number, number, number]> = [];
  const driver = new S3mOplDriver({
    target: { write: (t, r, v) => writes.push([t, r, v]) },
    instrument: (id) => instruments.get(id),
    channelForTrack: (t) => channelMap[t],
    amigaLimits: s3m.amigaLimits,
  });
  driver.reset(0);
  writes.length = 0;

  const clock = new ManualClock();
  const engine = new PlaybackEngine({
    audioContext: {
      get currentTime() {
        return clock.now;
      },
    } as unknown as AudioContext,
    playbackClock: clock,
    steppedTickAutomation: (id) => driver.handles(id),
    scheduledNoteHandler: (e) => {
      if (e.type === 'noteOn') {
        if (!driver.handles(e.instrumentId) || e.midi === undefined) return;
        const hz = e.frequency ?? 440 * 2 ** ((e.midi - 69) / 12);
        driver.noteOn(e.instrumentId, e.velocity ?? 127, e.time, e.trackIndex, hz);
      } else {
        driver.noteOff(e.time, e.trackIndex);
      }
    },
    scheduledPitchHandler: (_id, _voice, frequency, time, trackIndex, _ramp, source) =>
      driver.setPitch(time, trackIndex, frequency, source),
    scheduledVolumeHandler: (_id, _voice, volume, time, trackIndex) => driver.setVolume(time, trackIndex, volume),
    scheduledRetriggerHandler: (id, midi, velocity, time, trackIndex, frequency) => {
      if (driver.handles(id)) driver.noteOn(id, velocity, time, trackIndex, frequency ?? 440 * 2 ** ((midi - 69) / 12));
    },
    scheduledAllNotesOffHandler: (time) => driver.allNotesOff(time),
  });
  const rowTimes: number[] = [];
  const internals = engine as unknown as {
    scheduleRow: (row: number, time: number) => void;
    patternDelayRepeating: boolean;
  };
  const scheduleRow = internals.scheduleRow.bind(engine);
  // A pattern-delay repeat is not a new row in ST3's trace either.
  internals.scheduleRow = (row, time) => {
    if (!internals.patternDelayRepeating) rowTimes.push(time);
    scheduleRow(row, time);
  };
  engine.loadSong(song, 0);
  engine.setLoopSong(false);
  await engine.play();
  clock.advance(seconds);
  engine.stop();
  return { writes, rowTimes };
}

interface Comparison {
  ticks: number;
  /** Ticks differing in a way no known, documented difference explains. */
  other: number[];
  /** Ticks where only a pitch differs, by at most 2 F-number steps. */
  pitch: number[];
  first?: string;
  st3Writes: number;
  ourWrites: number;
}

/**
 * Tick 0's idle key-on: `updateadlib` sees every channel's zeroed rate as
 * changed and keys it on at F-number 0 (or at the 436 Hz a c2spd-less note
 * computes), with the empty, TL-63 timbre loaded: silent, and the next real
 * note re-keys it anyway. The driver has no tick boundary to do it on.
 */
function isIdleKeyOn(tick: number, reg: number, st3: number[], ours: number[]): boolean {
  if (tick !== 0 || ours.length) return false;
  if (reg >= 0xb0 && reg <= 0xb8) return st3.length === 1 && (st3[0]! & 0xfc) === 0x20;
  if (reg >= 0xa0 && reg <= 0xa8) return st3.length === 1;
  return false;
}

/** ST3's AdLib channel operator offsets (`adlibiadd`). */
const OPERATOR_OFFSET = [0, 1, 2, 8, 9, 10, 16, 17, 18];

/** The OPL channel (0..8) a channel-scoped register belongs to, if any. */
function channelOfRegister(reg: number): number | undefined {
  if ((reg >= 0xa0 && reg <= 0xa8) || (reg >= 0xb0 && reg <= 0xb8) || (reg >= 0xc0 && reg <= 0xc8)) return reg & 0x0f;
  const offset = reg & 0x1f;
  const base = reg & 0xe0;
  if (![0x20, 0x40, 0x60, 0x80, 0xe0].includes(base)) return undefined;
  const ch = OPERATOR_OFFSET.findIndex((o) => o === offset || o + 3 === offset);
  return ch < 0 ? undefined : ch;
}

/** Same block and key bit, F-numbers within `steps`. */
function isNearPitch(reg: number, st3: number[], ours: number[], steps: number, a: Map<number, number[]>, b: Map<number, number[]>): boolean {
  if (!((reg >= 0xa0 && reg <= 0xa8) || (reg >= 0xb0 && reg <= 0xb8))) return false;
  const ch = reg & 0x0f;
  const lastOf = (m: Map<number, number[]>, r: number, fallback: number) => {
    const v = m.get(r);
    return v && v.length ? v[v.length - 1]! : fallback;
  };
  const fnum = (m: Map<number, number[]>) => ((lastOf(m, 0xb0 + ch, 0) & 3) << 8) | lastOf(m, 0xa0 + ch, 0);
  const high = (m: Map<number, number[]>) => lastOf(m, 0xb0 + ch, 0) & 0xfc;
  if (reg >= 0xb0 && st3.length !== ours.length) return false;
  return high(a) === high(b) && Math.abs(fnum(a) - fnum(b)) <= steps;
}

/**
 * Listening aid, not a gate: with OPL_WAV_DIR set, each song's driver output
 * is rendered through the real wasm chip to <dir>/<name>.wav (44.1 kHz).
 */
function renderWav(name: string, writes: Array<[number, number, number]>, seconds: number): void {
  const dir = process.env.OPL_WAV_DIR;
  if (!dir) return;
  initSync({ module: new Uint8Array(fs.readFileSync(path.resolve(__dirname, '../../public/wasm/audio_processor_bg.wasm'))) });
  const rate = 44100;
  const renderer = new OplRenderer(rate);
  for (const [t, reg, val] of writes) renderer.write_at(t * rate, reg, val);
  const frames = Math.ceil(seconds * rate);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let at = 0; at < frames; at += 128) {
    const n = Math.min(128, frames - at);
    renderer.render(left.subarray(at, at + n), right.subarray(at, at + n));
  }
  renderer.free();
  const pcm = Buffer.alloc(44 + frames * 4);
  pcm.write('RIFF', 0);
  pcm.writeUInt32LE(36 + frames * 4, 4);
  pcm.write('WAVEfmt ', 8);
  pcm.writeUInt32LE(16, 16);
  pcm.writeUInt16LE(1, 20);
  pcm.writeUInt16LE(2, 22);
  pcm.writeUInt32LE(rate, 24);
  pcm.writeUInt32LE(rate * 4, 28);
  pcm.writeUInt16LE(4, 32);
  pcm.writeUInt16LE(16, 34);
  pcm.write('data', 36);
  pcm.writeUInt32LE(frames * 4, 40);
  const clamp = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < frames; i++) {
    pcm.writeInt16LE(clamp(left[i]!), 44 + i * 4);
    pcm.writeInt16LE(clamp(right[i]!), 46 + i * 4);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.wav`), pcm);
}

async function compare(name: string, file: string): Promise<Comparison> {
  const trace = readTrace(name);
  // Enough play for every traced row (at the slowest tempo seen, speed 31).
  const seconds = (trace.ticks / 50) * 2 + 2;
  const { writes, rowTimes } = await playThroughDriver(file, seconds);
  renderWav(name, writes, Math.min(seconds, 60));

  const ours: TickWrites = new Map();
  const rows = Math.min(rowTimes.length, trace.rowTicks.length);
  let r = 0;
  for (const [t, reg, val] of writes.sort((a, b) => a[0] - b[0])) {
    while (r + 1 < rows && rowTimes[r + 1]! <= t + 1e-6) r++;
    if (r >= rows || t + 1e-6 < rowTimes[r]!) continue;
    const tickLength = 2.5 / trace.rowBpm[r]!;
    const tick = trace.rowTicks[r]! + Math.floor((t - rowTimes[r]!) / tickLength + 1e-6);
    addWrite(ours, tick, reg, val);
  }

  // Compare every tick both sides cover: up to the last row both reached.
  const lastTick = rows < trace.rowTicks.length ? trace.rowTicks[rows]! : trace.ticks;
  const other: number[] = [];
  const pitch: number[] = [];
  let first: string | undefined;
  let st3Writes = 0;
  let ourWrites = 0;
  // A channel holding initadlib's empty timbre (attack rate 0: its envelope
  // never rises) is silent whatever else is written to it, so differences
  // there are not compared until ST3 loads a real instrument: its C0 write.
  const armed = new Set<number>();
  for (let tick = 0; tick < lastTick; tick++) {
    const a = trace.writes.get(tick) ?? new Map<number, number[]>();
    const b = ours.get(tick) ?? new Map<number, number[]>();
    for (const v of a.values()) st3Writes += v.length;
    for (const v of b.values()) ourWrites += v.length;
    const loading = new Set([...a.keys()].filter((reg) => reg >= 0xc0 && reg <= 0xc8).map((reg) => reg & 0x0f));
    const regs = new Set([...a.keys(), ...b.keys()]);
    const bad = [...regs].filter((reg) => {
      const x = a.get(reg) ?? [];
      const y = b.get(reg) ?? [];
      if (JSON.stringify(x) === JSON.stringify(y) || isIdleKeyOn(tick, reg, x, y)) return false;
      const ch = channelOfRegister(reg);
      return ch === undefined || armed.has(ch) || loading.has(ch);
    });
    for (const ch of loading) armed.add(ch);
    if (!bad.length) continue;
    if (bad.every((reg) => isNearPitch(reg, a.get(reg) ?? [], b.get(reg) ?? [], 2, a, b))) {
      pitch.push(tick);
      continue;
    }
    other.push(tick);
    const fmt = (m: Map<number, number[]>, reg: number) => (m.get(reg) ?? []).map((v) => v.toString(16)).join(',');
    const detail = bad.map((reg) => `${reg.toString(16)} st3=[${fmt(a, reg)}] ours=[${fmt(b, reg)}]`).join('; ');
    if (!first) first = `tick ${tick}: ${detail}`;
    // eslint-disable-next-line no-console
    if (process.env.OPL_TRACE_DEBUG === name && other.length <= 14) console.log(`  ${tick}: ${detail}`);
  }
  return { ticks: lastTick, other, pitch, ...(first ? { first } : {}), st3Writes, ourWrites };
}

/**
 * Per song: its file, and how many ticks may still differ in ways no
 * documented difference explains (0 = exact). The non-zero ones are the
 * ENGINE's S3M channel state disagreeing with ST3's before the driver sees
 * it -- the same deviations play on PCM channels -- so they are pinned here
 * as regression baselines and tracked as their own batch (.ai/plan-opl.md,
 * O3 landing record). Lower a number when the engine gets closer.
 */
const SONGS: Array<[string, string, number, string]> = [
  ['starport2', 'Skaven/starport bbs introtune 2 v2.s3m', 0, 'exact'],
  ['mystic', 'Mayaman/mystic reflections.s3m', 0, 'exact'],
  ['a-vision', 'Basehead/a vision.s3m', 0, 'exact'],
  ['starport', 'Purple Motion/starport bbs introtune.s3m', 38, 'engine: S3M vibrato timing'],
  ['redemptions', 'Omega/redemptions.s3m', 38, 'two file channels on A9 (ST3 merges them into one state)'],
  ['first-adlib-attempt', 'Skaven/first adlib attempt.as3m', 56, 'engine: volume on a key-off row; vibrato'],
  ['rotagilla', 'Manwe/rotagilla.s3m', 350, 'engine: J00 arpeggio memory'],
  ['koakuma', 'Viraxor/koakuma.s3m', 407, 'engine: J00 memory; note-delay volume on tick 0'],
  ['church', 'Bisqwit/some kind of church theme.s3m', 0, 'exact'],
  ['rance-bird', '- unknown/(opl2) rance 4.1 - bird.s3m', 1249, 'engine: vibrato; two file channels on A6'],
];

describe('S3M AdLib register writes against ST3 (st3play traces)', () => {
  for (const [name, file, baseline, why] of SONGS) {
    it(`${name}: ${baseline === 0 ? 'every tick writes what ST3 writes' : `no worse than ${baseline} unexplained ticks (${why})`}`, async () => {
      const result = await compare(name, file);
      // eslint-disable-next-line no-console
      console.log(
        `${name}: ${result.ticks} ticks, ${result.other.length} other, ${result.pitch.length} pitch-only; ` +
          `writes st3=${result.st3Writes} ours=${result.ourWrites}${result.first ? `; first ${result.first}` : ''}`,
      );
      expect(result.ticks).toBeGreaterThan(500);
      expect(result.st3Writes).toBeGreaterThan(0);
      if (baseline === 0) expect(result.other).toEqual([]);
      else expect(result.other.length).toBeLessThanOrEqual(baseline);
    }, 60_000);
  }
});
