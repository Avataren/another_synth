// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { AhxPlayer, initSync } from '../../public/wasm/audio_processor.js';
import { ahxNoteIndexFromMidi } from '@another-synth/tracker-playback';
import {
  AhxProcessorCore,
  type AhxEvent,
  type AhxWasmPlayerCtor,
} from 'src/audio/worklets/ahx-core';
import { AhxPreview } from 'src/audio/tracker/ahx-preview';
import type { AhxPlayerClient } from 'src/audio/tracker/ahx-player';

const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 44100;
const QUANTUM = 128;
let nextId = 0;

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(ROOT, 'public/demos/ahx', name)));

function render(core: AhxProcessorCore, seconds: number) {
  const frames = Math.round(seconds * SAMPLE_RATE);
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let at = 0; at < frames; at += QUANTUM) {
    const n = Math.min(QUANTUM, frames - at);
    core.process(l.subarray(at, at + n), r.subarray(at, at + n));
  }
  let peak = 0;
  for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(l[i]!), Math.abs(r[i]!));
  return { l, r, peak };
}

describe('ahxNoteIndexFromMidi', () => {
  it('puts C-1 (MIDI 24) on note 1 and B-5 (MIDI 83) on note 60, as the row model names them', () => {
    expect(ahxNoteIndexFromMidi(24)).toBe(1);
    expect(ahxNoteIndexFromMidi(36)).toBe(13);
    expect(ahxNoteIndexFromMidi(83)).toBe(60);
  });

  it('clamps to the format’s five octaves and refuses a non-finite note', () => {
    expect(ahxNoteIndexFromMidi(0)).toBe(1);
    expect(ahxNoteIndexFromMidi(127)).toBe(60);
    expect(ahxNoteIndexFromMidi(Number.NaN)).toBeUndefined();
  });
});

describe('AhxProcessorCore in preview mode over the real wasm', () => {
  beforeAll(() => {
    initSync({
      module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))),
    });
  });

  function previewCore() {
    const events: AhxEvent[] = [];
    const core = new AhxProcessorCore(
      AhxPlayer as unknown as AhxWasmPlayerCtor,
      SAMPLE_RATE,
      (e) => events.push(e),
    );
    core.handle({ type: 'set-preview', enabled: true });
    core.handle({ type: 'set-hifi', enabled: true });
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
    return { core, events };
  }

  it('is silent, and reports no song position, until a note is played', () => {
    const { core, events } = previewCore();
    expect(render(core, 0.5).peak).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['song-loaded']);
  });

  it('sounds a note while the key is down and falls silent after the release', () => {
    const { core } = previewCore();
    let played = 0;
    for (let instrument = 1; instrument <= 8; instrument++) {
      core.handle({ type: 'preview-note-on', instrument, note: 30, velocity: 127 });
      if (render(core, 0.3).peak === 0) {
        core.handle({ type: 'preview-note-off' });
        render(core, 6);
        continue;
      }
      played++;
      render(core, 2);
      expect(render(core, 0.2).peak).toBeGreaterThan(0);
      core.handle({ type: 'preview-note-off' });
      render(core, 6);
      expect(render(core, 0.2).peak).toBe(0);
    }
    expect(played).toBeGreaterThan(0);
  });

  it('builds its hi-fi tables lazily: no song walk, so the load stays cheap', () => {
    const { core, events } = previewCore();
    core.handle({ type: 'get-hifi-stats' });
    const stats = events.find((e) => e.type === 'hifi-stats');
    expect(stats).toMatchObject({ enabled: true, locked: false, tables: 0 });
  });

  it('ignores note commands with no preview song loaded', () => {
    const events: AhxEvent[] = [];
    const core = new AhxProcessorCore(
      AhxPlayer as unknown as AhxWasmPlayerCtor,
      SAMPLE_RATE,
      (e) => events.push(e),
    );
    core.handle({ type: 'preview-note-on', instrument: 1, note: 30, velocity: 127 });
    core.handle({ type: 'preview-note-off' });
    expect(render(core, 0.1).peak).toBe(0);
    expect(events).toEqual([]);
  });

  it('does not touch a song player beside it: a plain worklet still plays the song', () => {
    const { core: preview } = previewCore();
    preview.handle({ type: 'preview-note-on', instrument: 1, note: 30, velocity: 127 });
    const song = new AhxProcessorCore(
      AhxPlayer as unknown as AhxWasmPlayerCtor,
      SAMPLE_RATE,
      () => {},
    );
    song.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
    song.handle({ type: 'play' });
    const alone = render(song, 1).l;

    const song2 = new AhxProcessorCore(
      AhxPlayer as unknown as AhxWasmPlayerCtor,
      SAMPLE_RATE,
      () => {},
    );
    song2.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
    song2.handle({ type: 'play' });
    // Interleave a preview render between every song quantum.
    const beside = new Float32Array(SAMPLE_RATE);
    const scratchL = new Float32Array(QUANTUM);
    const scratchR = new Float32Array(QUANTUM);
    for (let at = 0; at < SAMPLE_RATE; at += QUANTUM) {
      const n = Math.min(QUANTUM, SAMPLE_RATE - at);
      preview.process(scratchL.subarray(0, n), scratchR.subarray(0, n));
      song2.process(beside.subarray(at, at + n), new Float32Array(n));
    }
    expect(Array.from(beside)).toEqual(Array.from(alone));
  });
});

/** A stand-in for the worklet client that records what it is told. */
function fakeClient(ctx: object) {
  const calls: string[] = [];
  const client = {
    audioContext: ctx,
    output: { connect: vi.fn() },
    setPreview: (on: boolean) => calls.push(`preview:${on}`),
    setHifi: (on: boolean) => calls.push(`hifi:${on}`),
    loadSong: vi.fn(async () => {
      calls.push('load');
      return {};
    }),
    previewNoteOn: (i: number, n: number, v: number) => calls.push(`on:${i}:${n}:${v}`),
    previewNoteOff: () => calls.push('off'),
    dispose: vi.fn(() => calls.push('dispose')),
  };
  return { client: client as unknown as AhxPlayerClient, calls, raw: client };
}

describe('AhxPreview', () => {
  const ctx = {};
  const bytes = new Uint8Array([1, 2, 3]);
  const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets preview and hi-fi before it loads, connects to the mix bus, then plays the note', async () => {
    const { client, calls, raw } = fakeClient(ctx);
    const preview = new AhxPreview(host, async () => client);
    await preview.noteOn(bytes, 3, 48, 100);
    expect(calls).toEqual(['preview:true', 'hifi:true', 'load', 'on:3:25:100']);
    expect(raw.output.connect).toHaveBeenCalledWith(host.output);
  });

  it('creates its worklet once and loads a song once for many notes', async () => {
    const { client, raw } = fakeClient(ctx);
    const create = vi.fn(async () => client);
    const preview = new AhxPreview(host, create);
    await preview.noteOn(bytes, 1, 48);
    await preview.noteOn(bytes, 1, 50);
    expect(create).toHaveBeenCalledTimes(1);
    expect(raw.loadSong).toHaveBeenCalledTimes(1);
  });

  it('reloads when the song changes', async () => {
    const { client, raw } = fakeClient(ctx);
    const preview = new AhxPreview(host, async () => client);
    await preview.noteOn(bytes, 1, 48);
    await preview.noteOn(new Uint8Array([9]), 1, 48);
    expect(raw.loadSong).toHaveBeenCalledTimes(2);
  });

  it('releases on its own key’s note-off only', async () => {
    const { client, calls } = fakeClient(ctx);
    const preview = new AhxPreview(host, async () => client);
    await preview.noteOn(bytes, 1, 48);
    await preview.noteOn(bytes, 1, 50);
    preview.noteOff(48);
    expect(calls.filter((c) => c === 'off')).toHaveLength(0);
    preview.noteOff(50);
    expect(calls.filter((c) => c === 'off')).toHaveLength(1);
  });

  it('does not sound a note whose key was let go while the worklet started', async () => {
    const { client, calls } = fakeClient(ctx);
    const preview = new AhxPreview(host, async () => client);
    const pending = preview.noteOn(bytes, 1, 48);
    preview.noteOff(48);
    await pending;
    expect(calls.some((c) => c.startsWith('on:'))).toBe(false);
  });

  it('drops the worklet after it has been idle, and makes a new one for the next key', async () => {
    const first = fakeClient(ctx);
    const second = fakeClient(ctx);
    const clients = [first.client, second.client];
    const create = vi.fn(async () => clients.shift()!);
    const preview = new AhxPreview(host, create, 1000);
    await preview.noteOn(bytes, 1, 48);
    preview.noteOff(48);
    expect(preview.active).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(preview.active).toBe(false);
    expect(first.raw.dispose).toHaveBeenCalled();
    await preview.noteOn(bytes, 1, 48);
    expect(create).toHaveBeenCalledTimes(2);
    expect(second.calls).toContain('on:1:25:127');
  });

  it('a key held past the idle time is not cut from under the player', async () => {
    const { client, raw } = fakeClient(ctx);
    const preview = new AhxPreview(host, async () => client, 1000);
    await preview.noteOn(bytes, 1, 48);
    vi.advanceTimersByTime(5000);
    expect(raw.dispose).not.toHaveBeenCalled();
  });

  it('resumes a suspended context before starting the worklet', async () => {
    const { client } = fakeClient(ctx);
    const order: string[] = [];
    const create = vi.fn(async () => {
      order.push('create');
      return client;
    });
    const preview = new AhxPreview(
      {
        ...host,
        ensureAudioContextRunning: async () => {
          order.push('resume');
          return true;
        },
      },
      create,
    );
    await preview.noteOn(bytes, 1, 48);
    expect(order).toEqual(['resume', 'create']);
  });

  it('disposing releases the worklet and refuses later notes', async () => {
    const { client, raw, calls } = fakeClient(ctx);
    const preview = new AhxPreview(host, async () => client);
    await preview.noteOn(bytes, 1, 48);
    preview.dispose();
    expect(raw.dispose).toHaveBeenCalled();
    await preview.noteOn(bytes, 1, 48);
    expect(calls.filter((c) => c.startsWith('on:'))).toHaveLength(1);
  });
});
