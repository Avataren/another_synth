// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { AhxPlayer, initSync } from '../../public/wasm/audio_processor.js';
import {
  parseAhx,
  serializeAhxInstrument,
  type AhxInstrument,
} from '@another-synth/tracker-playback';
import {
  AhxProcessorCore,
  type AhxEvent,
  type AhxWasmPlayerCtor,
} from 'src/audio/worklets/ahx-core';
import {
  addAhxPListEntry,
  setAhxEnvelope,
  setAhxNumber,
  setAhxStartWaveform,
} from 'src/audio/tracker/ahx-instrument-edit';

const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 44100;
const QUANTUM = 128;
let nextId = 0;
let nextReplaceId = 0;

const karmaBytes = new Uint8Array(readFileSync(resolve(ROOT, 'public/demos/ahx/karma.ahx')));
const karma = parseAhx(karmaBytes);
const instrument = (idx: number): AhxInstrument =>
  JSON.parse(JSON.stringify(karma.instruments[idx]));
const wire = (ins: AhxInstrument): Uint8Array => serializeAhxInstrument(ins, 'ahx');

/** A plain tone on `waveform` (1 triangle, 2 saw, 3 square, 4 noise) decaying to `level`. */
function tone(waveform: number, level: number): AhxInstrument {
  let ins = setAhxNumber(instrument(1), 'volume', 64);
  ins = setAhxNumber(ins, 'waveLength', 5);
  ins = setAhxNumber(ins, 'vibratoDepth', 0);
  ins = { ...ins, plist: { speed: 1, entries: [] }, hardCutRelease: false };
  ins = setAhxStartWaveform(addAhxPListEntry(ins), waveform);
  for (const [field, value] of Object.entries({
    aFrames: 1,
    aVolume: 64,
    dFrames: 20,
    dVolume: level,
    sFrames: 255,
    rFrames: 8,
    rVolume: 0,
  })) {
    ins = setAhxEnvelope(ins, field as keyof AhxInstrument['envelope'], value);
  }
  return ins;
}

function newCore(preview = false) {
  const events: AhxEvent[] = [];
  const core = new AhxProcessorCore(
    AhxPlayer as unknown as AhxWasmPlayerCtor,
    SAMPLE_RATE,
    (e) => events.push(e),
  );
  if (preview) core.handle({ type: 'set-preview', enabled: true });
  core.handle({ type: 'set-hifi', enabled: true });
  return { core, events };
}

function render(core: AhxProcessorCore, seconds: number): Float32Array {
  const frames = Math.round(seconds * SAMPLE_RATE);
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let at = 0; at < frames; at += QUANTUM) {
    const n = Math.min(QUANTUM, frames - at);
    core.process(l.subarray(at, at + n), r.subarray(at, at + n));
  }
  return l;
}

const rms = (x: Float32Array): number =>
  Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / Math.max(1, x.length));
const crossings = (x: Float32Array): number => {
  let n = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1]! < 0 !== x[i]! < 0) n++;
  return n;
};

function replace(core: AhxProcessorCore, events: AhxEvent[], index: number, bytes: Uint8Array) {
  const id = nextReplaceId++;
  core.handle({ type: 'replace-instrument', id, instrument: index, bytes });
  const answer = events.find((e) => e.type === 'instrument-replaced' && e.id === id);
  if (!answer || answer.type !== 'instrument-replaced') throw new Error('no answer');
  return answer;
}

/** Holds `note` on instrument `idx` and returns the rendered window [skip, skip + seconds). */
function hold(core: AhxProcessorCore, idx: number, skip: number, seconds: number): Float32Array {
  core.handle({ type: 'preview-note-on', instrument: idx, note: 30, velocity: 127 });
  const all = render(core, skip + seconds);
  core.handle({ type: 'preview-note-off' });
  render(core, 0.5);
  return all.subarray(Math.round(skip * SAMPLE_RATE));
}

beforeAll(() => {
  initSync({
    module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))),
  });
});

describe('replace-instrument in the worklet, over the real wasm', () => {
  it('answers ok, and refuses with a reason when there is no song, a bad length or a missing instrument', () => {
    const { core, events } = newCore();
    expect(replace(core, events, 1, wire(instrument(1)))).toMatchObject({
      ok: false,
      message: 'no song is loaded',
    });
    core.handle({ type: 'load-song', id: nextId++, bytes: karmaBytes });
    expect(replace(core, events, 1, wire(instrument(1)))).toMatchObject({ ok: true });
    const bad = replace(core, events, 1, wire(instrument(1)).slice(0, 30));
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/instrument is 30 bytes/);
    expect(replace(core, events, 0, wire(instrument(1))).ok).toBe(false);
    expect(replace(core, events, 999, wire(instrument(1))).message).toMatch(/no instrument 999/);
  });

  it('changes what the SONG plays, keeps it playing from where it was, and restoring it restores the render', () => {
    const song = (edit?: (core: AhxProcessorCore, events: AhxEvent[]) => void) => {
      const { core, events } = newCore();
      core.handle({ type: 'load-song', id: nextId++, bytes: karmaBytes });
      core.handle({ type: 'play' });
      render(core, 1);
      edit?.(core, events);
      return { core, out: render(core, 6), events };
    };
    const plain = song();
    const quieter = song((core, events) => {
      // Instrument 16 is one the song plays within its first seconds.
      replace(core, events, 16, wire(setAhxNumber(instrument(16), 'volume', 4)));
    });
    expect(Array.from(quieter.out)).not.toEqual(Array.from(plain.out));
    expect(rms(quieter.out)).toBeLessThan(rms(plain.out));

    const restored = song((core, events) => {
      replace(core, events, 16, wire(setAhxNumber(instrument(16), 'volume', 4)));
      replace(core, events, 16, wire(instrument(16)));
    });
    expect(Array.from(restored.out)).toEqual(Array.from(plain.out));

    // The transport was not touched: same position reports as the untouched song.
    const positions = (e: AhxEvent[]) => e.filter((x) => x.type === 'position').length;
    expect(positions(quieter.events)).toBe(positions(plain.events));
  });

  it('is what a load applies before hi-fi prewarms: the edited song starts edited and needs no re-prewarm', () => {
    const edits = [{ instrument: 16, bytes: wire(setAhxNumber(instrument(16), 'volume', 4)) }];
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: karmaBytes, instruments: edits });
    const loaded = events.find((e) => e.type === 'song-loaded');
    expect(loaded).toBeDefined();
    expect(loaded && loaded.type === 'song-loaded' ? loaded.info.rejectedInstruments : 'x').toBeUndefined();
    core.handle({ type: 'play' });
    const viaLoad = render(core, 5);

    const live = newCore();
    live.core.handle({ type: 'load-song', id: nextId++, bytes: karmaBytes });
    replace(live.core, live.events, 16, edits[0]!.bytes);
    live.core.handle({ type: 'play' });
    expect(Array.from(viaLoad)).toEqual(Array.from(render(live.core, 5)));
  });

  it('skips a load-time edit the engine refuses, names it, and still loads the song', () => {
    const { core, events } = newCore();
    core.handle({
      type: 'load-song',
      id: nextId++,
      bytes: karmaBytes,
      instruments: [
        { instrument: 3, bytes: new Uint8Array(5) },
        { instrument: 999, bytes: wire(instrument(1)) },
        { instrument: 16, bytes: wire(instrument(16)) },
      ],
    });
    const loaded = events.find((e) => e.type === 'song-loaded');
    expect(loaded?.type === 'song-loaded' && loaded.info.rejectedInstruments).toEqual([3, 999]);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('reaches the keyboard preview: an envelope edit changes the decay and a waveform edit the timbre', () => {
    const { core, events } = newCore(true);
    core.handle({ type: 'load-song', id: nextId++, bytes: karmaBytes });
    expect(replace(core, events, 1, wire(tone(3, 64))).ok).toBe(true);
    const loud = rms(hold(core, 1, 0.6, 0.5));
    expect(loud).toBeGreaterThan(0.02);

    // Envelope: the same tone decaying to a quarter of the level.
    replace(core, events, 1, wire(tone(3, 16)));
    const quiet = rms(hold(core, 1, 0.6, 0.5));
    expect(quiet).toBeLessThan(loud * 0.5);
    expect(quiet).toBeGreaterThan(loud * 0.1);

    // Waveform: square -> noise, everything else the same.
    replace(core, events, 1, wire(tone(3, 64)));
    const square = hold(core, 1, 0.3, 0.5);
    replace(core, events, 1, wire(tone(4, 64)));
    const noise = hold(core, 1, 0.3, 0.5);
    expect(crossings(noise)).toBeGreaterThan(crossings(square) * 3);
  });

  it('keeps the render path from ever building or missing a table after an edit', () => {
    const { core, events } = newCore(true);
    core.handle({ type: 'load-song', id: nextId++, bytes: karmaBytes });
    replace(core, events, 1, wire(tone(2, 64)));
    hold(core, 1, 0.3, 1.5);
    core.handle({ type: 'get-hifi-stats' });
    const stats = events.find((e) => e.type === 'hifi-stats');
    expect(stats).toMatchObject({ enabled: true, locked: true, misses: 0 });
  });

  it('reports the prewarm hold, bounded for an instrument that cannot produce more', () => {
    const { core, events } = newCore(true);
    core.handle({ type: 'load-song', id: nextId++, bytes: karmaBytes });
    replace(core, events, 1, wire(tone(3, 64)));
    core.handle({ type: 'get-warm-hold', instrument: 1 });
    core.handle({ type: 'get-warm-hold', instrument: 500 });
    const holds = events.filter((e) => e.type === 'warm-hold');
    expect(holds).toHaveLength(2);
    expect(holds[0]?.type === 'warm-hold' && holds[0].ticks).toBeGreaterThanOrEqual(16);
    expect(holds[0]?.type === 'warm-hold' && holds[0].ticks).toBeLessThan(100);
    expect(holds[1]?.type === 'warm-hold' && holds[1].ticks).toBe(0);
  });
});

describe('replace-instruments (a batch) in the worklet, over the real wasm', () => {
  const song = () => {
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: karmaBytes });
    core.handle({ type: 'play' });
    render(core, 1);
    return { core, events };
  };
  const batch = (core: AhxProcessorCore, events: AhxEvent[], edits: Array<[number, Uint8Array]>) => {
    const wireEdits = edits.map(([instrument, bytes]) => ({ id: nextReplaceId++, instrument, bytes }));
    core.handle({ type: 'replace-instruments', edits: wireEdits });
    return wireEdits.map(({ id }) => {
      const answer = events.find((e) => e.type === 'instrument-replaced' && e.id === id);
      if (!answer || answer.type !== 'instrument-replaced') throw new Error('no answer');
      return answer;
    });
  };
  const stats = (core: AhxProcessorCore, events: AhxEvent[]) => {
    const before = events.length;
    core.handle({ type: 'get-hifi-stats' });
    const stat = events.slice(before).find((e) => e.type === 'hifi-stats');
    if (!stat || stat.type !== 'hifi-stats') throw new Error('no stats');
    return stat;
  };

  it('answers every edit of the batch, and plays what the same edits one by one play', () => {
    const edits: Array<[number, Uint8Array]> = [
      [16, wire(setAhxNumber(instrument(16), 'volume', 4))],
      [3, wire(setAhxNumber(instrument(3), 'waveLength', 4))],
      [5, wire(setAhxEnvelope(instrument(5), 'dVolume', 7))],
    ];
    const one = song();
    for (const [idx, bytes] of edits) replace(one.core, one.events, idx, bytes);
    const outOne = render(one.core, 5);

    const all = song();
    const answers = batch(all.core, all.events, edits);
    expect(answers.map((a) => [a.instrument, a.ok])).toEqual([[16, true], [3, true], [5, true]]);
    expect(Array.from(render(all.core, 5))).toEqual(Array.from(outOne));
    expect(stats(all.core, all.events).misses).toBe(0);
    expect(stats(all.core, all.events).locked).toBe(true);
  });

  it('a refused edit is answered as refused and does not stop the others of the batch', () => {
    const { core, events } = song();
    const answers = batch(core, events, [
      [1, wire(instrument(1)).slice(0, 30)],
      [999, wire(instrument(1))],
      [16, wire(setAhxNumber(instrument(16), 'volume', 4))],
    ]);
    expect(answers.map((a) => a.ok)).toEqual([false, false, true]);
    expect(answers[0]!.message).toBeTruthy();
    expect(answers[1]!.message).toMatch(/no instrument 999/);
  });

  it('with no song loaded, refuses each edit without throwing', () => {
    const { core, events } = newCore();
    const answers = batch(core, events, [[1, wire(instrument(1))], [2, wire(instrument(2))]]);
    expect(answers.map((a) => [a.ok, a.message])).toEqual([[false, 'no song is loaded'], [false, 'no song is loaded']]);
  });
});
