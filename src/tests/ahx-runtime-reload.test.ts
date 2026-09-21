// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { AhxPlayer, initSync } from '../../public/wasm/audio_processor.js';
import { parseAhx } from '@another-synth/tracker-playback';
import {
  AhxProcessorCore,
  type AhxEvent,
  type AhxInstrumentBytes,
  type AhxSongInfo,
  type AhxWasmPlayerCtor,
} from 'src/audio/worklets/ahx-core';
import type { AhxPlayerClient, AhxPosition } from 'src/audio/tracker/ahx-player';
import { AhxTransport } from 'src/audio/tracker/ahx-transport';
import { recordAhxLoad, setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { ahxNotices, clearAhxNotices } from 'src/audio/tracker/ahx-notices';
import {
  buildAhxFile,
  createNewAhxDoc,
  deletePosition,
  docFromBytes,
  insertPosition,
  movePosition,
  setStep,
  setTrackLength,
  type AhxDoc,
  type AhxDocStep,
} from 'src/audio/tracker/ahx-doc';
import { defaultAhxInstrument } from 'src/audio/tracker/ahx-instrument-edit';
import { ahxCorpus, importTitleOf, slotsOf } from './helpers/ahx-doc-fixtures';

/**
 * A live reload of the song worklet over the real wasm (T6 of the AHX editing
 * plan): what the engine does with a second `load-song` on a core that is
 * playing, what a `seek` afterwards says, what a refused load leaves behind,
 * and that `AhxTransport.reloadInPlace` puts the last accepted version back.
 */

const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 44100;
const QUANTUM = 128;
let nextId = 0;

const fixture = (name: string) => new Uint8Array(readFileSync(resolve(ROOT, 'public/demos/ahx', name)));
const GARBAGE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const step = (note: number, instrument = 1, fx = 0, fxParam = 0): AhxDocStep => ({ note, instrument, fx, fxParam, fxb: 0, fxbParam: 0 });
const ok = (r: { ok: true; doc: AhxDoc } | { ok: false; reason: string }): AhxDoc => {
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};

function newCore() {
  const events: AhxEvent[] = [];
  const core = new AhxProcessorCore(AhxPlayer as unknown as AhxWasmPlayerCtor, SAMPLE_RATE, (e) => events.push(e));
  return { core, events };
}

function render(core: AhxProcessorCore, frames: number) {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let at = 0; at < frames; at += QUANTUM) {
    const n = Math.min(QUANTUM, frames - at);
    core.process(l.subarray(at, at + n), r.subarray(at, at + n));
  }
  return { l, r };
}

const same = (a: { l: Float32Array; r: Float32Array }, b: { l: Float32Array; r: Float32Array }): boolean =>
  Buffer.from(a.l.buffer).equals(Buffer.from(b.l.buffer)) && Buffer.from(a.r.buffer).equals(Buffer.from(b.r.buffer));
const peakOf = (out: { l: Float32Array; r: Float32Array }): number =>
  out.l.reduce((m, v, i) => Math.max(m, Math.abs(v), Math.abs(out.r[i] ?? 0)), 0);
const positions = (events: readonly AhxEvent[]) =>
  events.filter((e): e is Extract<AhxEvent, { type: 'position' }> => e.type === 'position');

/** karma with a step written into the track position 1 plays on channel 0: an edited song of a real file. */
function editedKarma(): { original: Uint8Array; edited: Uint8Array } {
  const original = fixture('karma.ahx');
  const song = parseAhx(original);
  const doc = docFromBytes(original);
  const track = doc.positions[1]!.track[0]!;
  const edited = ok(setStep(doc, track, 0, step(45, 1)));
  return {
    original,
    edited: buildAhxFile({ doc: edited, slots: slotsOf(song), title: importTitleOf(song) }).bytes,
  };
}

/**
 * A song of one note on row 0 over a 16-row position; optionally with a position
 * jump on row 1, above row 2. The default instrument rings for about 0.35 s and a
 * row is 0.12 s, so the note is still sounding on row 2 and gone by row 4.
 */
function heldNoteSong(jump: boolean): Uint8Array {
  let doc = createNewAhxDoc({ trackLength: 16 });
  doc = ok(setStep(doc, 1, 0, step(37, 1)));
  if (jump) doc = ok(setStep(doc, 1, 1, step(0, 0, 0xb, 0)));
  return buildAhxFile({ doc, slots: [{ ahxData: defaultAhxInstrument() }], title: 'held' }).bytes;
}

beforeAll(() => {
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
});

describe('a second load-song on a playing core', () => {
  it('plays the edited song from the seek, on what the core already had set (gain, mute, loop-position)', () => {
    const { original, edited } = editedKarma();
    const configure = (core: AhxProcessorCore) => {
      core.handle({ type: 'set-gain', gain: 0.5 });
      core.handle({ type: 'set-mute-solo', mute: 0b0100, solo: 0 });
      core.handle({ type: 'set-loop-position', enabled: true });
    };

    // The reload: A is playing, then load A', seek, play, in one go.
    const live = newCore();
    configure(live.core);
    live.core.handle({ type: 'load-song', id: nextId++, bytes: original });
    live.core.handle({ type: 'seek', position: 1, row: 0 });
    live.core.handle({ type: 'play' });
    render(live.core, SAMPLE_RATE / 2);
    const before = live.events.length;
    live.core.handle({ type: 'load-song', id: nextId++, bytes: edited });
    live.core.handle({ type: 'seek', position: 1, row: 0 });
    live.core.handle({ type: 'play' });
    const afterReload = render(live.core, SAMPLE_RATE * 2);

    // The reference: the same settings, A' loaded straight away.
    const fresh = newCore();
    configure(fresh.core);
    fresh.core.handle({ type: 'load-song', id: nextId++, bytes: edited });
    fresh.core.handle({ type: 'seek', position: 1, row: 0 });
    fresh.core.handle({ type: 'play' });
    expect(same(afterReload, render(fresh.core, SAMPLE_RATE * 2))).toBe(true);

    // It is A' that plays, not A: the unedited song sounds different from there.
    const plain = newCore();
    configure(plain.core);
    plain.core.handle({ type: 'load-song', id: nextId++, bytes: original });
    plain.core.handle({ type: 'seek', position: 1, row: 0 });
    plain.core.handle({ type: 'play' });
    expect(same(afterReload, render(plain.core, SAMPLE_RATE * 2))).toBe(false);

    // The settings were kept: unmuted and at full gain it is another sound.
    const bare = newCore();
    bare.core.handle({ type: 'load-song', id: nextId++, bytes: edited });
    bare.core.handle({ type: 'seek', position: 1, row: 0 });
    bare.core.handle({ type: 'play' });
    const unset = render(bare.core, SAMPLE_RATE * 2);
    expect(peakOf(unset)).toBeGreaterThan(peakOf(afterReload));
    // loop-position: the reloaded song stays on position 1.
    const reported = positions(live.events.slice(before));
    expect(reported.length).toBeGreaterThan(5);
    expect(new Set(reported.map((p) => p.position))).toEqual(new Set([1]));
  });

  it('answers a seek with its kind on the position event, and only then', () => {
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: heldNoteSong(false) });
    core.handle({ type: 'play' });
    render(core, SAMPLE_RATE);
    core.handle({ type: 'seek', position: 0, row: 8 });
    const answered = positions(events).filter((p) => p.seekKind !== undefined);
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ position: 0, row: 8, seekKind: 1 });
    // The periodic reports carry none.
    render(core, SAMPLE_RATE);
    expect(positions(events).filter((p) => p.seekKind === undefined).length).toBeGreaterThan(1);
    // Out of range: nothing changed, nothing answered.
    const count = events.length;
    core.handle({ type: 'seek', position: 9, row: 0 });
    expect(events.length).toBe(count);
  });

  it('kind 1: an edit that keeps the flow lets the held note carry on through the seek', () => {
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: heldNoteSong(false) });
    core.handle({ type: 'seek', position: 0, row: 2 });
    expect(positions(events).at(-1)).toMatchObject({ seekKind: 1 });
    core.handle({ type: 'play' });
    // Row 2 of a note struck on row 0: it is still sounding at the first quantum.
    expect(peakOf(render(core, QUANTUM * 8))).toBeGreaterThan(0.1);
  });

  it('kind 2: an edit that makes the row unreachable (a jump above it) starts it cold, and says so', () => {
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: heldNoteSong(true) });
    core.handle({ type: 'seek', position: 0, row: 2 });
    expect(positions(events).at(-1)).toMatchObject({ position: 0, row: 2, seekKind: 2 });
    core.handle({ type: 'play' });
    // No note was struck on the way to row 2: silence until something triggers.
    expect(peakOf(render(core, QUANTUM * 8))).toBe(0);
  });

  it('a load the engine refuses leaves the core with no player: it renders silence and ignores play', () => {
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
    core.handle({ type: 'play' });
    expect(peakOf(render(core, SAMPLE_RATE / 2))).toBeGreaterThan(0);
    const id = nextId++;
    core.handle({ type: 'load-song', id, bytes: GARBAGE });
    expect(events.at(-1)).toMatchObject({ type: 'error', id });
    // `dropPlayer()` ran first: this documents that, it is not "usable".
    expect(peakOf(render(core, SAMPLE_RATE / 2))).toBe(0);
    core.handle({ type: 'play' });
    expect(peakOf(render(core, SAMPLE_RATE / 2))).toBe(0);
    core.handle({ type: 'seek', position: 1, row: 0 });
    expect(positions(events).filter((p) => p.seekKind !== undefined)).toHaveLength(0);
  });
});

/** An `AhxPlayerClient` over an `AhxProcessorCore`: the worklet without the browser, so the transport runs against the real engine. */
function loopbackClient() {
  const positionListeners = new Set<(p: AhxPosition) => void>();
  let pending: { id: number; resolve: (info: AhxSongInfo) => void; reject: (e: Error) => void } | null = null;
  const log: string[] = [];
  const engine = new AhxProcessorCore(AhxPlayer as unknown as AhxWasmPlayerCtor, SAMPLE_RATE, (event) => {
    if (event.type === 'song-loaded' && event.id === pending?.id) {
      pending.resolve(event.info);
      pending = null;
    } else if (event.type === 'error' && event.id !== undefined && event.id === pending?.id) {
      pending.reject(new Error(event.message));
      pending = null;
    } else if (event.type === 'position') {
      for (const listener of positionListeners) {
        listener({
          position: event.position,
          row: event.row,
          tempo: event.tempo,
          ticks: event.ticks,
          ...(event.seekKind !== undefined ? { seekKind: event.seekKind } : {}),
        });
      }
    }
  });
  const audioContext = {} as AudioContext;
  const client = {
    audioContext,
    output: { connect: () => undefined },
    loadSong(bytes: Uint8Array, stereoMode = 2, instruments: ReadonlyArray<{ instrument: number; bytes: Uint8Array }> = []) {
      const id = nextId++;
      log.push('load');
      return new Promise<AhxSongInfo>((resolve, reject) => {
        pending = { id, resolve, reject };
        const wire: AhxInstrumentBytes[] = instruments.map((e) => ({ instrument: e.instrument, bytes: e.bytes.slice() }));
        engine.handle({ type: 'load-song', id, bytes: bytes.slice(), stereoMode, instruments: wire });
      });
    },
    seek: (position: number, row: number) => {
      log.push(`seek:${position}:${row}`);
      engine.handle({ type: 'seek', position, row });
    },
    play: () => {
      log.push('play');
      engine.handle({ type: 'play' });
    },
    pause: () => {
      log.push('pause');
      engine.handle({ type: 'pause' });
    },
    restart: (subsong = 0) => engine.handle({ type: 'restart', subsong }),
    setHifi: (enabled: boolean) => engine.handle({ type: 'set-hifi', enabled }),
    setStopAtEnd: () => undefined,
    setLoopPosition: (enabled: boolean) => engine.handle({ type: 'set-loop-position', enabled }),
    setCapture: () => undefined,
    setMuteSolo: () => undefined,
    onPosition: (listener: (p: AhxPosition) => void) => {
      positionListeners.add(listener);
      return () => positionListeners.delete(listener);
    },
    onSongEnd: () => () => undefined,
    onWaveforms: () => () => undefined,
    dispose: () => undefined,
  };
  return { engine, client, audioContext, log };
}

function transportOver(loop: ReturnType<typeof loopbackClient>) {
  const host = { audioContext: loop.audioContext, output: {} as AudioNode };
  return new AhxTransport(host, () => Promise.resolve(loop.client as unknown as AhxPlayerClient), () => []);
}

describe('AhxTransport.reloadInPlace over the real engine', () => {
  beforeEach(() => {
    clearAhxNotices();
    // A different song is what forgets the last accepted version (`null` alone is not a change when none is current).
    setCurrentAhxSource(new Uint8Array([1]));
    setCurrentAhxSource(null);
  });

  it('sends one load, one seek, one play, in that order, and the new song plays from the place', async () => {
    const { original, edited } = editedKarma();
    const loop = loopbackClient();
    const transport = transportOver(loop);
    await transport.load(original);
    loop.log.length = 0;
    const outcome = await transport.reloadInPlace(edited, { position: 1, row: 0 }, true);
    expect(outcome.outcome).toBe('loaded');
    expect(loop.log).toEqual(['load', 'seek:1:0', 'play']);
    expect(transport.isLoaded(edited)).toBe(true);
    expect(transport.isLoaded(original)).toBe(false);
    expect(transport.lastSeekKind).toBe(1);

    const reference = newCore();
    reference.core.handle({ type: 'set-hifi', enabled: true });
    reference.core.handle({ type: 'load-song', id: nextId++, bytes: edited });
    reference.core.handle({ type: 'seek', position: 1, row: 0 });
    reference.core.handle({ type: 'play' });
    expect(same(render(loop.engine, SAMPLE_RATE), render(reference.core, SAMPLE_RATE))).toBe(true);
  });

  it('reports the kind of the seek: 1 for an edit that keeps the flow, 2 for one that cuts it off', async () => {
    const loop = loopbackClient();
    const transport = transportOver(loop);
    await transport.load(heldNoteSong(false));
    const kinds: number[] = [];
    transport.onSeekKind((kind) => kinds.push(kind));
    await transport.reloadInPlace(heldNoteSong(false), { position: 0, row: 2 }, true);
    await transport.reloadInPlace(heldNoteSong(true), { position: 0, row: 2 }, true);
    expect(kinds).toEqual([1, 2]);
    expect(transport.lastSeekKind).toBe(2);
  });

  it('a refused reload puts the last accepted version back, at the old place, and says so until a reload is accepted', async () => {
    const { original } = editedKarma();
    const loop = loopbackClient();
    const transport = transportOver(loop);
    await transport.load(original);
    transport.seek(1, 0);
    transport.play();
    const before = render(loop.engine, SAMPLE_RATE * 2);

    loop.log.length = 0;
    const outcome = await transport.reloadInPlace(GARBAGE, { position: 1, row: 0 }, true);
    expect(outcome.outcome).toBe('recovered');
    // The failing load, its seek and play, then the recovery: load, seek, play.
    expect(loop.log).toEqual(['load', 'seek:1:0', 'play', 'load', 'seek:1:0', 'play']);
    expect(transport.isLoaded(original)).toBe(true);
    expect(ahxNotices.value.filter((n) => /could not be loaded by the engine/.test(n))).toHaveLength(1);

    // The audio is back and is the pre-edit song from the same place.
    const after = render(loop.engine, SAMPLE_RATE * 2);
    expect(peakOf(after)).toBeGreaterThan(0);
    expect(same(after, before)).toBe(true);
  });

  it('a second refusal stops and reports: no third load, the core holds nothing, playback paused', async () => {
    const { original } = editedKarma();
    const loop = loopbackClient();
    const transport = transportOver(loop);
    await transport.load(original);
    // The "last good" is bad too (it cannot happen by construction; this is the belt).
    recordAhxLoad(new Uint8Array([9, 9, 9, 9]), []);
    loop.log.length = 0;
    const outcome = await transport.reloadInPlace(GARBAGE, { position: 0, row: 0 }, true);
    expect(outcome.outcome).toBe('failed');
    expect(loop.log.filter((entry) => entry === 'load')).toHaveLength(2);
    expect(loop.log.at(-1)).toBe('pause');
    expect(transport.isLoaded(original)).toBe(false);
    expect(peakOf(render(loop.engine, SAMPLE_RATE / 2))).toBe(0);
    expect(ahxNotices.value.some((n) => /playback stopped/.test(n))).toBe(true);
  });

  it('with no last accepted version there is nothing to put back: it stops at once', async () => {
    const loop = loopbackClient();
    const transport = transportOver(loop);
    const outcome = await transport.reloadInPlace(GARBAGE, { position: 0, row: 0 }, true);
    expect(outcome.outcome).toBe('failed');
    expect(loop.log.filter((entry) => entry === 'load')).toHaveLength(1);
  });
});

/** A small deterministic generator, so a failure names its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the engine accepts every song the ops can reach (the refusal is unreachable by construction)', () => {
  it('serialized docs from random op runs on corpus songs all load in AhxPlayer', () => {
    const corpus = ahxCorpus().filter((file) => file.bytes.length < 20000).slice(0, 8);
    expect(corpus.length).toBe(8);
    let songs = 0;
    for (const [n, file] of corpus.entries()) {
      const song = parseAhx(file.bytes);
      const slots = slotsOf(song);
      const title = importTitleOf(song);
      const rnd = mulberry32(1000 + n);
      let doc = docFromBytes(file.bytes);
      for (let i = 0; i < 25; i++) {
        const pick = Math.floor(rnd() * 6);
        const at = Math.floor(rnd() * doc.positions.length);
        let result:
          | { ok: true; doc: AhxDoc }
          | { ok: false; reason: string };
        if (pick === 0) result = insertPosition(doc, at, { kind: 'blank' });
        else if (pick === 1) result = deletePosition(doc, at);
        else if (pick === 2) result = movePosition(doc, at, Math.floor(rnd() * doc.positions.length));
        else if (pick === 3) result = setTrackLength(doc, [8, 16, 32, 64][Math.floor(rnd() * 4)]!);
        else {
          const track = doc.positions[at]!.track[Math.floor(rnd() * 4)]!;
          result = setStep(doc, track, Math.floor(rnd() * doc.trackLength), step(1 + Math.floor(rnd() * 60), 1 + Math.floor(rnd() * song.instrumentNr)));
        }
        if (!result.ok) continue;
        doc = result.doc;
        const bytes = buildAhxFile({ doc, slots, title }).bytes;
        const player = new AhxPlayer(bytes, SAMPLE_RATE, 2);
        expect(player.position_count(), `${file.name} #${i}`).toBe(doc.positions.length);
        player.free();
        songs++;
      }
    }
    expect(songs).toBeGreaterThan(50);
  });
});

describe('what one reload costs (Node wasm, logged, not asserted tightly)', () => {
  it('records wall-clock per stage on a few corpus songs', () => {
    const rows: string[] = [];
    for (const name of ['karma.ahx', 'aces_high.ahx', 'get_to_the_chopper.ahx']) {
      let bytes: Uint8Array;
      try {
        bytes = fixture(name);
      } catch {
        continue;
      }
      const song = parseAhx(bytes);
      const doc = docFromBytes(bytes);
      const t0 = performance.now();
      const built = buildAhxFile({ doc, slots: slotsOf(song), title: importTitleOf(song) }).bytes;
      const t1 = performance.now();
      const { core } = newCore();
      core.handle({ type: 'set-hifi', enabled: true });
      core.handle({ type: 'load-song', id: nextId++, bytes });
      core.handle({ type: 'play' });
      render(core, SAMPLE_RATE / 4);
      const t2 = performance.now();
      core.handle({ type: 'load-song', id: nextId++, bytes: built });
      const t3 = performance.now();
      core.handle({ type: 'seek', position: Math.min(3, song.positions.length - 1), row: 0 });
      const t4 = performance.now();
      rows.push(
        `${name}: serialize ${(t1 - t0).toFixed(1)} ms, load-song ${(t3 - t2).toFixed(1)} ms (hi-fi prewarm included), seek ${(t4 - t3).toFixed(1)} ms`,
      );
      expect(t3 - t2).toBeLessThan(5000);
    }
    expect(rows.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.info(`[T6 stage costs]\n${rows.join('\n')}`);
  });
});
