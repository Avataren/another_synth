// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { AhxPlayer, initSync } from '../../public/wasm/audio_processor.js';
import {
  AhxProcessorCore,
  type AhxEvent,
  type AhxWasmPlayerCtor,
} from 'src/audio/worklets/ahx-core';
import {
  parseAhx,
  serializeAhxInstrument,
  type AhxInstrument,
  type AhxSong,
} from '@another-synth/tracker-playback';

/**
 * The `plist-row` event over the real wasm: through `AhxProcessorCore`, in the
 * worklet's 128-frame quanta, the reported (instrument, row) sequence is
 * checked against an oracle that is not the engine. The oracle
 * (`PListOracle`) is a separate interpreter of the per-tick PList block,
 * written from `voice.rs` ("PList", the `perf_wait` / `perf_current` block),
 * `plist.rs` (commands 5 and 15) and `engine.rs` (`live_tick`, the note-on and
 * note-off handling and the release cut), run over the *parsed* instrument
 * data by the library's own parser and the tick clock `render_block` uses.
 * Nothing in it calls the wasm.
 */

const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 44100;
const QUANTUM = 128;
const NOTE = 30;
const DEMOS = resolve(ROOT, 'public/demos/ahx');

let nextId = 0;

const fixture = (name: string) => new Uint8Array(readFileSync(resolve(DEMOS, name)));

const CORPUS = readdirSync(DEMOS)
  .filter((f) => /\.(ahx|hvl)$/i.test(f))
  .sort();

interface Reported {
  instrument: number;
  row: number;
}
const NONE: Reported = { instrument: 0, row: -1 };

// --- the oracle ------------------------------------------------------------

type Script =
  | { at: number; kind: 'on'; instrument: number }
  | { at: number; kind: 'off' }
  | { at: number; kind: 'replace'; instrument: number; data: AhxInstrument };

const toI8 = (n: number): number => (n << 24) >> 24;

/**
 * One voice's PList, tick by tick. `at` in a script is the quantum a command is
 * issued before; the engine takes a command at the first tick boundary at or
 * after the frame it was issued on, and ticks start on multiples of the tick
 * length.
 */
class PListOracle {
  private readonly instruments: AhxInstrument[];
  private readonly tickFrames: number;
  private pendingOn: number | null = null;
  private pendingOff = false;
  private instrument = 0;
  private cur = 0;
  private wait = 0;
  private speed = 0;
  private lastRow = -1;
  private held = false;
  private released = false;
  private releaseLeft = 0;
  private nextTick = 0;
  private cursor = 0;

  constructor(
    song: AhxSong,
    private readonly script: Script[],
  ) {
    this.instruments = song.instruments.slice();
    this.tickFrames = Math.floor(SAMPLE_RATE / 50 / Math.max(1, song.speedMultiplier));
  }

  /** What the worklet has reported once it has rendered `frames` frames in all. */
  reportedAfter(frames: number): Reported {
    for (;;) {
      const boundary = this.nextTick * this.tickFrames;
      if (boundary >= frames) break;
      this.takeCommands(boundary);
      this.tick();
      this.nextTick++;
    }
    return this.state();
  }

  private takeCommands(boundary: number): void {
    while (this.cursor < this.script.length && this.script[this.cursor]!.at * QUANTUM <= boundary) {
      const command = this.script[this.cursor++]!;
      if (command.kind === 'on') {
        this.pendingOn = command.instrument;
        this.pendingOff = false;
      } else if (command.kind === 'off') {
        this.pendingOff = true;
      } else {
        this.instruments[command.instrument] = command.data;
      }
    }
  }

  private tick(): void {
    if (this.pendingOn !== null) {
      this.instrument = this.pendingOn;
      this.pendingOn = null;
      this.wait = 0;
      this.cur = 0;
      this.lastRow = -1;
      this.speed = this.instruments[this.instrument]!.plist.speed;
      this.held = true;
      this.released = false;
    }
    const ins = this.instruments[this.instrument]!;
    if (this.pendingOff) {
      this.pendingOff = false;
      if (this.held && !this.released && this.instrument !== 0) {
        this.held = false;
        this.released = true;
        this.releaseLeft =
          ins.hardCutRelease && ins.hardCutReleaseFrames > 0
            ? ins.hardCutReleaseFrames
            : ins.envelope.rFrames > 0
              ? ins.envelope.rFrames
              : 2;
      }
    }
    if (this.instrument !== 0) {
      const entries = ins.plist.entries;
      if (this.cur < entries.length) {
        const overflow = this.wait === 128;
        this.wait -= 1;
        if (overflow || toI8(this.wait) <= 0) {
          const row = this.cur;
          this.lastRow = row;
          this.cur += 1;
          this.wait = this.speed;
          const entry = entries[row]!;
          for (let k = 0; k < 2; k++) {
            if (entry.fx[k] === 5) this.cur = entry.fxParam[k]!;
            if (entry.fx[k] === 15) {
              this.speed = entry.fxParam[k]!;
              this.wait = entry.fxParam[k]!;
            }
          }
        }
      } else if (this.wait !== 0) {
        this.wait -= 1;
      }
    }
    if (this.released) this.releaseLeft -= 1;
  }

  private state(): Reported {
    if (this.instrument === 0 || this.lastRow < 0) return NONE;
    if (this.released && this.releaseLeft <= 0) return NONE;
    return { instrument: this.instrument, row: this.lastRow };
  }
}

// --- the driver ------------------------------------------------------------

interface Run {
  /** Every `plist-row` event, in order, with the quantum it came out of. */
  posts: Array<{ quantum: number; instrument: number; row: number }>;
  /** What the last event said, after each quantum. */
  observed: Reported[];
  events: AhxEvent[];
}

function newPreviewCore(bytes: Uint8Array, instruments: Array<{ instrument: number; bytes: Uint8Array }> = []) {
  const events: AhxEvent[] = [];
  const core = new AhxProcessorCore(AhxPlayer as unknown as AhxWasmPlayerCtor, SAMPLE_RATE, (e) => events.push(e));
  core.handle({ type: 'set-preview', enabled: true });
  core.handle({ type: 'load-song', id: nextId++, bytes: bytes.slice(), instruments });
  events.length = 0;
  return { core, events };
}

/** Plays `script` for `quanta` quanta on a fresh preview core. */
function play(bytes: Uint8Array, script: Script[], quanta: number): Run {
  const { core, events } = newPreviewCore(bytes);
  const run: Run = { posts: [], observed: [], events };
  const left = new Float32Array(QUANTUM);
  const right = new Float32Array(QUANTUM);
  let seen = 0;
  let last: Reported = NONE;
  let cursor = 0;
  for (let q = 0; q < quanta; q++) {
    while (cursor < script.length && script[cursor]!.at === q) {
      const command = script[cursor++]!;
      if (command.kind === 'on') {
        core.handle({ type: 'preview-note-on', instrument: command.instrument, note: NOTE, velocity: 127 });
      } else if (command.kind === 'off') {
        core.handle({ type: 'preview-note-off' });
      } else {
        core.handle({
          type: 'replace-instrument',
          id: nextId++,
          instrument: command.instrument,
          bytes: serializeAhxInstrument(command.data),
        });
      }
    }
    core.process(left, right);
    for (; seen < events.length; seen++) {
      const e = events[seen]!;
      if (e.type !== 'plist-row') continue;
      run.posts.push({ quantum: q, instrument: e.instrument, row: e.row });
      last = { instrument: e.instrument, row: e.row };
    }
    run.observed.push(last);
  }
  return run;
}

/** Runs `script` and asserts every quantum's reported state is the oracle's, and that only changes were posted. */
function expectOracle(name: string, bytes: Uint8Array, song: AhxSong, script: Script[], quanta: number): Run {
  const run = play(bytes, script, quanta);
  const oracle = new PListOracle(song, script);
  let previous: Reported = NONE;
  let changes = 0;
  for (let q = 0; q < quanta; q++) {
    const want = oracle.reportedAfter((q + 1) * QUANTUM);
    if (want.instrument !== previous.instrument || want.row !== previous.row) changes++;
    previous = want;
    const got = run.observed[q]!;
    if (got.instrument !== want.instrument || got.row !== want.row) {
      throw new Error(
        `${name}: after quantum ${q} the worklet reported ${JSON.stringify(got)}, the oracle says ${JSON.stringify(want)}`,
      );
    }
  }
  // Only on change: no post repeats the state before it, and there is one per change.
  let before: Reported = NONE;
  for (const post of run.posts) {
    expect(post, `${name}: a post that changed nothing`).not.toEqual({ ...before, quantum: post.quantum });
    before = { instrument: post.instrument, row: post.row };
  }
  expect(run.posts.length, `${name}: posts vs the oracle's changes`).toBe(changes);
  return run;
}

const seconds = (s: number): number => Math.ceil((s * SAMPLE_RATE) / QUANTUM);

// --- what to play ----------------------------------------------------------

interface Candidate {
  file: string;
  bytes: Uint8Array;
  song: AhxSong;
}

let songs: Map<string, Candidate>;

const candidate = (file: string): Candidate => {
  const found = songs.get(file);
  if (!found) throw new Error(`no ${file} in the corpus`);
  return found;
};

beforeAll(() => {
  initSync({
    module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))),
  });
  songs = new Map(
    CORPUS.map((file) => {
      const bytes = fixture(file);
      return [file, { file, bytes, song: parseAhx(bytes) }];
    }),
  );
});

/** Every (song, instrument) with a PList, in corpus order. */
function withPLists(): Array<{ c: Candidate; instrument: number }> {
  const out: Array<{ c: Candidate; instrument: number }> = [];
  for (const c of songs.values()) {
    for (let i = 1; i <= c.song.instrumentNr; i++) {
      if (c.song.instruments[i]!.plist.entries.length > 0) out.push({ c, instrument: i });
    }
  }
  return out;
}

describe('plist-row over the real wasm, against a separate PList interpreter', () => {
  // re-measured 2026-09-23: corpus 84→100 files (curated HVL batch, corpus commit 2344594e),
  // then 100→99 (chiprolled.hvl removed — byte-identical dupe, user decision)
  it('the corpus is what the plan says it is', () => {
    expect(CORPUS).toHaveLength(99);
  });

  it('nyrmodian_cityscape instrument 7: 96 rows with a Jump', () => {
    const { bytes, song } = candidate('nyrmodian_cityscape.ahx');
    const ins = song.instruments[7]!;
    expect(ins.plist.entries.length).toBe(96);
    expect(ins.plist.entries.some((e) => e.fx.includes(5))).toBe(true);
    const run = expectOracle('nyrmodian 7', bytes, song, [{ at: 0, kind: 'on', instrument: 7 }], seconds(8));
    // It ran through the list and came back round: a Jump was taken.
    const rows = run.posts.map((p) => p.row);
    expect(Math.max(...rows)).toBeGreaterThan(20);
    expect(rows.some((r, i) => i > 0 && r < rows[i - 1]!)).toBe(true);
  });

  it('dreams_odyssee instrument 11: 67 rows with a Jump and an F speed command', () => {
    const { bytes, song } = candidate('dreams_odyssee.ahx');
    const ins = song.instruments[11]!;
    expect(ins.plist.entries.length).toBe(67);
    expect(ins.plist.entries.some((e) => e.fx.includes(5))).toBe(true);
    expect(ins.plist.entries.some((e) => e.fx.includes(15))).toBe(true);
    expectOracle('dreams_odyssee 11', bytes, song, [{ at: 0, kind: 'on', instrument: 11 }], seconds(10));
  });

  it('a speed-1 and a speed-3 instrument, at every tick multiplier the corpus has', () => {
    const chosen = new Set<string>();
    const cases: Array<{ c: Candidate; instrument: number; why: string }> = [];
    for (const { c, instrument } of withPLists()) {
      const ins = c.song.instruments[instrument]!;
      for (const [speed, len] of [
        [1, 8],
        [3, 8],
      ] as const) {
        const key = `${speed}x${c.song.speedMultiplier}`;
        if (ins.plist.speed === speed && ins.plist.entries.length >= len && !chosen.has(key)) {
          chosen.add(key);
          cases.push({ c, instrument, why: `speed ${speed}, x${c.song.speedMultiplier} (${c.file} ${instrument})` });
        }
      }
    }
    expect(chosen.has('1x1')).toBe(true);
    expect(chosen.has('3x1')).toBe(true);
    expect([...chosen].some((k) => k.startsWith('1x') && k !== '1x1')).toBe(true);
    for (const { c, instrument, why } of cases) {
      expectOracle(why, c.bytes, c.song, [{ at: 0, kind: 'on', instrument }], seconds(3));
    }
  });

  it('a 60-instrument sample across the corpus, 300 ticks each, struck on and off a tick boundary, released mid-list', () => {
    const all = withPLists();
    const sample = Array.from({ length: 60 }, (_, i) => all[Math.floor((i * all.length) / 60)]!);
    expect(new Set(sample.map((s) => s.c.file)).size).toBeGreaterThan(20);
    let compared = 0;
    let posted = 0;
    let jumps = 0;
    for (const [n, { c, instrument }] of sample.entries()) {
      const tickQuanta = (SAMPLE_RATE / 50 / c.song.speedMultiplier) / QUANTUM;
      const total = Math.ceil(300 * tickQuanta);
      // Even ones start at quantum 0, odd ones after some idle quanta (a tick phase that is not 0).
      const at = n % 2 === 0 ? 0 : 3 + (n % 5);
      const script: Script[] = [{ at, kind: 'on', instrument }];
      // Every third one is released a third of the way through: the release, then silence.
      if (n % 3 === 0) script.push({ at: at + Math.ceil(total / 3), kind: 'off' });
      const run = expectOracle(`${c.file} ${instrument} (case ${n})`, c.bytes, c.song, script, total);
      posted += run.posts.length;
      jumps += run.posts.some((p, i) => i > 0 && p.row >= 0 && p.row < run.posts[i - 1]!.row) ? 1 : 0;
      compared++;
    }
    expect(compared).toBe(60);
    // Not a vacuous pass: a good many rows were reported, and some lists looped back.
    expect(posted).toBeGreaterThan(1000);
    expect(jumps).toBeGreaterThan(3);
  });

  it('note-off keeps the rows going until the release is over, then posts exactly one row -1', () => {
    const c = candidate('karma.ahx');
    const instrument = withPLists().find((p) => p.c === c && p.c.song.instruments[p.instrument]!.plist.entries.length >= 3)!
      .instrument;
    const script: Script[] = [
      { at: 0, kind: 'on', instrument },
      { at: seconds(0.5), kind: 'off' },
    ];
    const run = expectOracle('karma note-off', c.bytes, c.song, script, seconds(8));
    const clears = run.posts.filter((p) => p.row === -1);
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({ instrument: 0, row: -1 });
    expect(run.posts.at(-1)).toBe(clears[0]);
    expect(clears[0]!.quantum).toBeGreaterThan(seconds(0.5));
  });

  it('a retrigger with another instrument stamps it, and the same instrument starts over at row 0', () => {
    const c = candidate('nyrmodian_cityscape.ahx');
    const script: Script[] = [
      { at: 0, kind: 'on', instrument: 7 },
      { at: seconds(1), kind: 'on', instrument: 8 },
      { at: seconds(2), kind: 'on', instrument: 8 },
    ];
    const run = expectOracle('nyrmodian retrigger', c.bytes, c.song, script, seconds(3));
    const instruments = run.posts.map((p) => p.instrument);
    expect(instruments[0]).toBe(7);
    expect(instruments).toContain(8);
    // The instrument stamp changes between two posts with no clear in between.
    const at = run.posts.findIndex((p) => p.instrument === 8);
    expect(run.posts[at]).toMatchObject({ instrument: 8, row: 0 });
    expect(run.posts[at - 1]!.instrument).toBe(7);
    // Struck again, instrument 8 goes back to row 0.
    const again = run.posts.filter((p) => p.instrument === 8 && p.row === 0);
    expect(again.length).toBeGreaterThanOrEqual(2);
  });

  it('another instrument on the same row is a change too (the stamp is part of the report)', () => {
    const c = candidate('karma.ahx');
    const oneRow = (n: number): { instrument: number; bytes: Uint8Array } => {
      const ins = structuredClone(c.song.instruments[n]!);
      ins.plist = { speed: 1, entries: [{ note: 0, waveform: 0, fixed: false, fx: [0, 0], fxParam: [0, 0] }] };
      return { instrument: n, bytes: serializeAhxInstrument(ins) };
    };
    const { core, events } = newPreviewCore(c.bytes, [oneRow(1), oneRow(2)]);
    const left = new Float32Array(QUANTUM);
    const right = new Float32Array(QUANTUM);
    core.handle({ type: 'preview-note-on', instrument: 1, note: NOTE, velocity: 127 });
    for (let q = 0; q < seconds(0.2); q++) core.process(left, right);
    core.handle({ type: 'preview-note-on', instrument: 2, note: NOTE, velocity: 127 });
    for (let q = 0; q < seconds(0.2); q++) core.process(left, right);
    expect(events.filter((e) => e.type === 'plist-row')).toEqual([
      { type: 'plist-row', instrument: 1, row: 0 },
      { type: 'plist-row', instrument: 2, row: 0 },
    ]);
  });

  it('a shorter list under the sounding note (replace-instrument) is what the engine says, row and all', () => {
    const c = candidate('nyrmodian_cityscape.ahx');
    const shorter: AhxInstrument = structuredClone(c.song.instruments[7]!);
    shorter.plist.entries = shorter.plist.entries.slice(0, 2);
    const grown = structuredClone(c.song.instruments[7]!);
    const script: Script[] = [
      { at: 0, kind: 'on', instrument: 7 },
      { at: seconds(0.6), kind: 'replace', instrument: 7, data: shorter },
      { at: seconds(1.2), kind: 'replace', instrument: 7, data: grown },
    ];
    const run = expectOracle('nyrmodian replace', c.bytes, c.song, script, seconds(3));
    expect(run.posts.length).toBeGreaterThan(5);
  });

  it('a core with no preview mode (the song player) posts none, playing or not', () => {
    const events: AhxEvent[] = [];
    const core = new AhxProcessorCore(AhxPlayer as unknown as AhxWasmPlayerCtor, SAMPLE_RATE, (e) => events.push(e));
    core.handle({ type: 'load-song', id: nextId++, bytes: candidate('karma.ahx').bytes.slice() });
    core.handle({ type: 'play' });
    // Even a note-on, which a song player ignores, must not make it report.
    core.handle({ type: 'preview-note-on', instrument: 1, note: NOTE, velocity: 127 });
    const left = new Float32Array(QUANTUM);
    const right = new Float32Array(QUANTUM);
    for (let q = 0; q < seconds(3); q++) core.process(left, right);
    expect(events.some((e) => e.type === 'position')).toBe(true);
    expect(events.filter((e) => e.type === 'plist-row')).toEqual([]);
  });

  it('a song player never reads the getters; a preview reads two scalars a quantum and nothing else', () => {
    let reads = 0;
    class Counting extends AhxPlayer {
      override preview_plist_row(): number {
        reads++;
        return super.preview_plist_row();
      }
      override preview_plist_instrument(): number {
        reads++;
        return super.preview_plist_instrument();
      }
    }
    const drive = (preview: boolean): number => {
      reads = 0;
      const core = new AhxProcessorCore(Counting as unknown as AhxWasmPlayerCtor, SAMPLE_RATE, () => {});
      if (preview) core.handle({ type: 'set-preview', enabled: true });
      core.handle({ type: 'load-song', id: nextId++, bytes: candidate('karma.ahx').bytes.slice() });
      if (!preview) core.handle({ type: 'play' });
      const left = new Float32Array(QUANTUM);
      const right = new Float32Array(QUANTUM);
      for (let q = 0; q < 100; q++) core.process(left, right);
      return reads;
    };
    expect(drive(false)).toBe(0);
    expect(drive(true)).toBe(200);
  });

  it('a preview worklet with nothing played posts nothing', () => {
    const { core, events } = newPreviewCore(candidate('karma.ahx').bytes);
    const left = new Float32Array(QUANTUM);
    const right = new Float32Array(QUANTUM);
    for (let q = 0; q < seconds(2); q++) core.process(left, right);
    expect(events).toEqual([]);
  });

  it('loading another song over a sounding note clears the row once, and disposing does not throw', () => {
    const { core, events } = newPreviewCore(candidate('nyrmodian_cityscape.ahx').bytes);
    core.handle({ type: 'preview-note-on', instrument: 7, note: NOTE, velocity: 127 });
    const left = new Float32Array(QUANTUM);
    const right = new Float32Array(QUANTUM);
    for (let q = 0; q < seconds(0.3); q++) core.process(left, right);
    const rows = () => events.filter((e) => e.type === 'plist-row');
    expect(rows().length).toBeGreaterThan(1);
    expect(rows().at(-1)).not.toMatchObject({ row: -1 });
    core.handle({ type: 'load-song', id: nextId++, bytes: candidate('karma.ahx').bytes.slice() });
    expect(rows().at(-1)).toEqual({ type: 'plist-row', instrument: 0, row: -1 });
    const count = rows().length;
    for (let q = 0; q < seconds(1); q++) core.process(left, right);
    expect(rows()).toHaveLength(count);
    core.handle({ type: 'dispose' });
    expect(() => core.process(left, right)).not.toThrow();
  });
});

describe('plist-row message rate', () => {
  /** A speed-1 list that loops on itself: one row per engine tick for as long as the note is down. */
  function loopingInstrument(base: AhxInstrument): AhxInstrument {
    const ins = structuredClone(base);
    ins.plist.speed = 1;
    const step = { note: 0, waveform: 0, fixed: false, fx: [0, 0] as [number, number], fxParam: [0, 0] as [number, number] };
    ins.plist.entries = Array.from({ length: 8 }, () => structuredClone(step));
    ins.plist.entries[7]!.fx = [5, 0];
    return ins;
  }

  it('the worst case, a speed-1 loop, posts one message per engine tick: 50, 100, 150 and 200 a second at x1..x4', () => {
    const seen: Record<number, number> = {};
    for (const c of songs.values()) {
      const mult = c.song.speedMultiplier;
      if (mult in seen) continue;
      const ins = loopingInstrument(c.song.instruments[1]!);
      const { core, events } = newPreviewCore(c.bytes, [{ instrument: 1, bytes: serializeAhxInstrument(ins, c.song.format) }]);
      core.handle({ type: 'preview-note-on', instrument: 1, note: NOTE, velocity: 127 });
      const left = new Float32Array(QUANTUM);
      const right = new Float32Array(QUANTUM);
      const quanta = seconds(10);
      const perSecond = new Array<number>(10).fill(0);
      let seenEvents = 0;
      for (let q = 0; q < quanta; q++) {
        core.process(left, right);
        for (; seenEvents < events.length; seenEvents++) {
          if (events[seenEvents]!.type === 'plist-row') {
            perSecond[Math.min(9, Math.floor((q * QUANTUM) / SAMPLE_RATE))]!++;
          }
        }
      }
      const total = perSecond.reduce((a, b) => a + b, 0);
      const perSec = total / 10;
      const ticksPerSecond = SAMPLE_RATE / Math.floor(SAMPLE_RATE / 50 / mult);
      // One message per tick, none more: the ceiling is the tick rate.
      expect(Math.max(...perSecond)).toBeLessThanOrEqual(Math.ceil(ticksPerSecond) + 1);
      expect(perSec).toBeGreaterThan(ticksPerSecond * 0.95);
      seen[mult] = perSec;
      // eslint-disable-next-line no-console
      console.log(`plist-row rate, x${mult} (${c.file}): ${perSec.toFixed(1)} messages/s (max second ${Math.max(...perSecond)}), tick rate ${ticksPerSecond.toFixed(1)}/s`);
    }
    expect(Object.keys(seen).length).toBeGreaterThanOrEqual(3);
    for (const rate of Object.values(seen)) expect(rate).toBeLessThanOrEqual(205);
  });
});
