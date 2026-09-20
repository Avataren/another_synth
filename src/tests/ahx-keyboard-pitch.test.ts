// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { AhxPlayer, initSync } from '../../public/wasm/audio_processor.js';
import { parseAhx } from '@another-synth/tracker-playback';
import { AhxProcessorCore, type AhxWasmPlayerCtor } from 'src/audio/worklets/ahx-core';
import { AhxPreview } from 'src/audio/tracker/ahx-preview';
import type { AhxPlayerClient } from 'src/audio/tracker/ahx-player';
import { TRACKER_NOTE_KEY_MAP } from 'src/composables/keyboard/note-key-map';

/**
 * The computer keyboard's pitch, end to end and by measurement (the KBD-MIDI
 * report: "u i 9 o 0 p all sound the same"): a key code -> its MIDI note ->
 * `AhxPreview.noteOn` (the production class, `ahxNoteIndexFromMidi` included)
 * -> the worklet's message handler -> the real wasm engine -> rendered audio.
 * Only the Web Audio port between `AhxPlayerClient` and the worklet is
 * replaced (by a direct call of `AhxProcessorCore.handle`, with the messages
 * `AhxPlayerClient` would post).
 */
const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 44100;
const QUANTUM = 128;
const WINDOW = 8192;

const fixtureBytes = (name: string) =>
  new Uint8Array(readFileSync(resolve(ROOT, 'public/demos/ahx', name)));

function renderInto(core: AhxProcessorCore, l: Float32Array): void {
  const r = new Float32Array(l.length);
  for (let at = 0; at < l.length; at += QUANTUM) {
    const n = Math.min(QUANTUM, l.length - at);
    core.process(l.subarray(at, at + n), r.subarray(at, at + n));
  }
}

/** The strongest spectral peak (Hz) of `samples`, Hann-windowed, scanned on a 4 Hz grid. */
function dominantFrequency(samples: Float32Array): number {
  let best = 0;
  let bestMagnitude = 0;
  for (let f = 100; f < 4000; f += 4) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < WINDOW; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW);
      const a = (2 * Math.PI * f * i) / SAMPLE_RATE;
      re += samples[i]! * w * Math.cos(a);
      im += samples[i]! * w * Math.sin(a);
    }
    const magnitude = Math.hypot(re, im);
    if (magnitude > bestMagnitude) {
      bestMagnitude = magnitude;
      best = f;
    }
  }
  return best;
}

/** A song loaded through the real `AhxPreview` into a real preview engine; keys are struck with `strike`. */
function keyboard(songName: string) {
  const core = new AhxProcessorCore(AhxPlayer as unknown as AhxWasmPlayerCtor, SAMPLE_RATE, () => {});
  const noteIndexes: number[] = [];
  let loadId = 0;
  const client = {
    audioContext: {},
    output: { connect: () => undefined },
    setPreview: (enabled: boolean) => core.handle({ type: 'set-preview', enabled }),
    setHifi: (enabled: boolean) => core.handle({ type: 'set-hifi', enabled }),
    loadSong: async (bytes: Uint8Array) => {
      core.handle({ type: 'load-song', id: loadId++, bytes: bytes.slice() });
      return {};
    },
    previewNoteOn: (instrument: number, note: number, velocity: number) => {
      noteIndexes.push(note);
      core.handle({ type: 'preview-note-on', instrument, note, velocity });
    },
    previewNoteOff: () => core.handle({ type: 'preview-note-off' }),
    dispose: () => undefined,
  } as unknown as AhxPlayerClient;
  const bytes = fixtureBytes(songName);
  const host = { audioContext: client.audioContext as AudioContext, output: {} as AudioNode };
  const preview = new AhxPreview(host, async () => client);

  return {
    noteIndexes,
    /** Press `code` as the tracker page does (default base octave), hold it, measure, release. */
    async strike(code: string, instrument: number): Promise<number> {
      const midi = TRACKER_NOTE_KEY_MAP[code]!;
      await preview.noteOn(bytes, instrument, midi, 100);
      renderInto(core, new Float32Array(SAMPLE_RATE / 4));
      const heard = new Float32Array(WINDOW);
      renderInto(core, heard);
      preview.noteOff(midi);
      renderInto(core, new Float32Array(SAMPLE_RATE * 3)); // let the release finish
      return dominantFrequency(heard);
    },
  };
}

const KEYS_U_TO_P = ['KeyU', 'KeyI', 'Digit9', 'KeyO', 'Digit0', 'KeyP'];
const LOWER_ROW = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM'];
const UPPER_ROW = ['KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7'];

describe('AHX keyboard pitch, keys to sound (real wasm)', () => {
  beforeAll(() => {
    initSync({
      module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))),
    });
  });

  it('hands the engine one AHX note index per key, MIDI 71..76 -> 48..53, converted exactly once', async () => {
    const play = keyboard('karma.ahx');
    for (const code of KEYS_U_TO_P) await play.strike(code, 1);
    expect(KEYS_U_TO_P.map((code) => TRACKER_NOTE_KEY_MAP[code])).toEqual([71, 72, 73, 74, 75, 76]);
    expect(play.noteIndexes).toEqual([48, 49, 50, 51, 52, 53]);
  });

  it('u i 9 o 0 p sound six different, rising pitches on an instrument that plays notes as written', async () => {
    const play = keyboard('karma.ahx');
    const pitches: number[] = [];
    for (const code of KEYS_U_TO_P) pitches.push(await play.strike(code, 1));
    expect(new Set(pitches).size).toBe(6);
    for (let i = 1; i < pitches.length; i++) expect(pitches[i]!).toBeGreaterThan(pitches[i - 1]!);
  }, 60_000);

  it('the two lower rows rise key by key too', async () => {
    const play = keyboard('karma.ahx');
    for (const row of [LOWER_ROW, UPPER_ROW]) {
      const pitches: number[] = [];
      for (const code of row) pitches.push(await play.strike(code, 1));
      for (let i = 1; i < pitches.length; i++) {
        expect(pitches[i]!, `${row[i]} after ${row[i - 1]}`).toBeGreaterThan(pitches[i - 1]!);
      }
    }
  }, 120_000);

  // The collapse the report describes is real, and it is the format's, not a
  // bug in the keyboard chain: an AHX instrument's PList can carry a note
  // that is added to whatever is played (`instr_period + transpose +
  // track_period - 1`, voice.rs `calc_period`), and the sum is clamped to
  // the five-octave period table (index 60). An instrument whose PList opens
  // on note 13 sounds an octave up, and reaches the top of the table at note
  // 48 (MIDI 71, the U key): from there every key is the same pitch, exactly
  // as when a pattern holds those notes. 224 of the 932 instruments in the
  // bundled demos open on a note >= 13.
  describe('an instrument whose PList opens an octave up (aces_high #11)', () => {
    it('is such an instrument', () => {
      const song = parseAhx(fixtureBytes('aces_high.ahx'));
      const entry = song.instruments[11]!.plist.entries.find((e) => e.note !== 0)!;
      expect(entry.note).toBe(13);
      expect(entry.fixed).toBe(false);
    });

    it('reaches the top of the AHX pitch table at u, so u i 9 o 0 p are one pitch by the format’s own rule', async () => {
      const play = keyboard('aces_high.ahx');
      const pitches: number[] = [];
      for (const code of KEYS_U_TO_P) pitches.push(await play.strike(code, 11));
      expect(new Set(pitches).size).toBe(1);
      // ...while the keys below it still differ.
      const below = [await play.strike('KeyR', 11), await play.strike('KeyT', 11)];
      expect(new Set([...below, pitches[0]]).size).toBe(3);
    }, 60_000);
  });
});
