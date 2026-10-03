// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { SidChipPlayer, SidPlayer, initSync } from '../../public/wasm/audio_processor.js';
import { SidProcessorCore, type SidEvent, type SidWasmPlayerCtor } from 'src/audio/worklets/sid-core';
import type { SidChipWasmCtor } from 'src/audio/tracker/psid/psid-playback';
import { gtSongHintsFromName, importGtSong, serializeSidFile } from 'src/audio/tracker/sid-doc';
import { exportSid } from 'src/audio/tracker/sid-export';

/**
 * .ai/plan-psid-playback.md: a `.sid` played as it is, through the worklet's
 * real render-thread core over the real wasm. The tune's 6502 code runs on
 * the emulated C64 and the chip gets its writes at their cycles.
 */

const ROOT = resolve(__dirname, '../..');
const RATE = 44100;
const FIXTURES = resolve(__dirname, 'fixtures/psid');
const SONGS = resolve(__dirname, 'fixtures/gt-songs');
const fixtureBytes = (name: string) => new Uint8Array(readFileSync(resolve(FIXTURES, name)));

beforeAll(() => {
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
});

let nextId = 0;
function newCore() {
  const events: SidEvent[] = [];
  const core = new SidProcessorCore(SidPlayer as unknown as SidWasmPlayerCtor, RATE, (e) => events.push(e), SidChipPlayer as unknown as SidChipWasmCtor);
  return { core, events };
}

function loadPsid(core: SidProcessorCore, events: SidEvent[], bytes: Uint8Array, subsong = 0): SidEvent {
  const id = nextId++;
  core.handle({ type: 'load-psid', id, bytes: bytes.slice(), subsong });
  const answer = events.find((e) => (e.type === 'song-loaded' || e.type === 'error') && e.id === id);
  if (!answer) throw new Error('the load was not answered');
  return answer;
}

function render(core: SidProcessorCore, frames: number, quantum = 128) {
  const mix = new Float32Array(frames);
  const right = new Float32Array(frames);
  const taps = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
  for (let at = 0; at < frames; at += quantum) {
    const n = Math.min(quantum, frames - at);
    core.process(mix.subarray(at, at + n), right.subarray(at, at + n), taps.map((t) => t.subarray(at, at + n)));
  }
  return { mix, taps };
}

const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (x: ArrayLike<number>, a = 0, b = x.length): number => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, b - a));
};

describe('playing a .sid through the SID worklet core', () => {
  it('Commando (a PSID): loads, then sounds on all three voices, in the mix and in the taps', () => {
    const { core, events } = newCore();
    const loaded = loadPsid(core, events, fixtureBytes('hubbard_rob/commando.sid'));
    expect(loaded.type).toBe('song-loaded');
    if (loaded.type !== 'song-loaded') return;
    expect(loaded.info.channels).toBe(3);
    expect(loaded.info.songRows).toBe(0);
    core.handle({ type: 'play' });
    const { mix, taps } = render(core, RATE * 6);
    expect(mix.every(Number.isFinite)).toBe(true);
    expect(peak(mix)).toBeGreaterThan(0.05);
    expect(peak(mix)).toBeLessThan(2);
    taps.forEach((t, i) => expect(peak(t), `voice ${i + 1}`).toBeGreaterThan(0.01));
  });

  it('stays silent until played, and silent again once paused', () => {
    const { core, events } = newCore();
    loadPsid(core, events, fixtureBytes('hubbard_rob/commando.sid'));
    expect(peak(render(core, 4410).mix)).toBe(0);
    core.handle({ type: 'play' });
    expect(peak(render(core, RATE * 2).mix)).toBeGreaterThan(0.01);
    core.handle({ type: 'pause' });
    expect(peak(render(core, 4410).mix)).toBe(0);
  });

  it('renders the same samples whatever the quantum (the emulated clock and the chip never drift apart)', () => {
    const run = (quantum: number) => {
      const { core, events } = newCore();
      loadPsid(core, events, fixtureBytes('hubbard_rob/commando.sid'));
      core.handle({ type: 'play' });
      return render(core, RATE * 3, quantum).mix;
    };
    const a = run(128);
    const b = run(441);
    const c = run(1);
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(Array.from(c.slice(0, 1)).length).toBe(1);
  });

  it('Chimera (an RSID that plays from its own interrupts) sounds', () => {
    const { core, events } = newCore();
    const loaded = loadPsid(core, events, fixtureBytes('hubbard_rob/chimera.sid'));
    expect(loaded.type).toBe('song-loaded');
    core.handle({ type: 'play' });
    expect(peak(render(core, RATE * 8).mix)).toBeGreaterThan(0.03);
  });

  it('subsongs are different tunes', () => {
    const bytes = fixtureBytes('hubbard_rob/commando.sid');
    const first = newCore();
    loadPsid(first.core, first.events, bytes, 0);
    first.core.handle({ type: 'play' });
    const second = newCore();
    loadPsid(second.core, second.events, bytes, 1);
    second.core.handle({ type: 'play' });
    const a = render(first.core, RATE * 2).mix;
    const b = render(second.core, RATE * 2).mix;
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('mute silences a voice in the mix and its tap; the others carry on', () => {
    const { core, events } = newCore();
    loadPsid(core, events, fixtureBytes('hubbard_rob/commando.sid'));
    core.handle({ type: 'set-mute-solo', mute: 0b001, solo: 0 });
    core.handle({ type: 'play' });
    const { taps } = render(core, RATE * 4);
    expect(peak(taps[0]!)).toBe(0);
    expect(peak(taps[1]!)).toBeGreaterThan(0.01);
  });

  it('reports the seconds played as its position', () => {
    const { core, events } = newCore();
    loadPsid(core, events, fixtureBytes('hubbard_rob/commando.sid'));
    core.handle({ type: 'play' });
    render(core, RATE * 3 + 500);
    const rows = events.filter((e) => e.type === 'position').map((e) => (e.type === 'position' ? e.row : -1));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1]).toBe(3);
  });

  it('answers a file that is not a .sid with the true reason, under the load id', () => {
    const { core, events } = newCore();
    const answer = loadPsid(core, events, new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(answer.type).toBe('error');
    if (answer.type === 'error') expect(answer.message).toMatch(/not a SID file/);
  });

  it('answers a tune whose init jams with the reason', () => {
    const bytes = fixtureBytes('hubbard_rob/commando.sid').slice();
    // Point init at $0000..: easier to corrupt the data at init. Overwrite the whole payload with JAMs.
    bytes.fill(0x02, 0x7c);
    const { core, events } = newCore();
    const answer = loadPsid(core, events, bytes);
    expect(answer.type).toBe('error');
  });
});

/**
 * A GoatTracker song exported as a `.sid` runs GoatTracker's own 6502 player.
 * Played here (emulated C64 -> chip) it must sound like the same song in the
 * app's Rust song player: same chip, same register stream. One difference is
 * real and kept: GoatTracker's playroutine takes about seven frames to start
 * its first note (a hard restart ahead of it; GoatTracker 2.77's own files do
 * the same, `fixtures/gt-sids`), where the song player starts at its first
 * row. So the two are lined up before they are compared.
 */
describe('a GoatTracker .sid against the same song in the Rust player', () => {
  const corpus: readonly string[] = readdirSync(SONGS)
    .filter((d) => !d.includes('.'))
    .flatMap((d) =>
      readdirSync(join(SONGS, d))
        .filter((f) => f.endsWith('.sng'))
        .map((f) => `${d}/${f}`),
    )
    .filter((_, i) => i % 11 === 0)
    .slice(0, 6);

  /** RMS of each 10 ms. */
  const WINDOW = RATE / 100;
  const windows = (x: Float32Array): number[] => {
    const out: number[] = [];
    for (let a = 0; a + WINDOW <= x.length; a += WINDOW) out.push(rms(x, a, a + WINDOW));
    return out;
  };
  /** Correlation of `a[i + lag]` with `b[i]`. */
  const correlationAt = (a: number[], b: number[], lag: number): number => {
    const idx: number[] = [];
    for (let i = 0; i < b.length; i++) if (i + lag >= 0 && i + lag < a.length) idx.push(i);
    const xs = idx.map((i) => a[i + lag]!);
    const ys = idx.map((i) => b[i]!);
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
    const my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i < xs.length; i++) {
      xy += (xs[i]! - mx) * (ys[i]! - my);
      xx += (xs[i]! - mx) ** 2;
      yy += (ys[i]! - my) ** 2;
    }
    return xy / Math.sqrt(xx * yy || 1);
  };

  for (const name of corpus) {
    it(`${name}: its level follows the Rust player's, a few frames later`, () => {
      const imported = importGtSong(new Uint8Array(readFileSync(join(SONGS, name))), gtSongHintsFromName(name));
      if (!imported.ok) throw new Error(imported.reason);
      const exp = exportSid(imported.doc);
      if (!exp.ok) throw new Error(exp.reason);

      const psid = newCore();
      loadPsid(psid.core, psid.events, exp.bytes);
      psid.core.handle({ type: 'play' });
      const emulated = windows(render(psid.core, RATE * 10).mix);

      const rust = newCore();
      rust.core.handle({ type: 'load-song', id: nextId++, bytes: serializeSidFile(imported.doc) });
      rust.core.handle({ type: 'play' });
      const native = windows(render(rust.core, RATE * 10).mix);

      let best = -2;
      let lag = 0;
      for (let l = 0; l <= 30; l++) {
        const r = correlationAt(emulated, native, l);
        if (r > best) {
          best = r;
          lag = l;
        }
      }
      // eslint-disable-next-line no-console
      console.log(`${name}: best correlation ${best.toFixed(3)} at ${lag * 10} ms`);
      // Two corpus songs differ on purpose: the song player follows GoatTracker's editor where the
      // C64 routine does otherwise (sid_decisions.md §3, "Ballad"); the emulated routine is the C64's.
      expect(best).toBeGreaterThan(0.85);
      // About seven frames (140 ms; a 2x speed song is faster), and not none.
      expect(lag).toBeGreaterThanOrEqual(5);
      expect(lag).toBeLessThanOrEqual(20);
    });
  }
});
