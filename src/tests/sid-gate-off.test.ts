// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { SidPlayer, initSync } from '../../public/wasm/audio_processor.js';
import { importGtSong, serializeSidFile } from 'src/audio/tracker/sid-doc';
import { simulateSidInstrument } from 'src/audio/tracker/sid-instrument-visuals';
import { SidProcessorCore, type SidWasmPlayerCtor } from 'src/audio/worklets/sid-core';

/**
 * S5.9 (`.ai/sid-gateoff-verdict.md`): the wave-table gate bit. GoatTracker
 * keeps a wave-table row's whole byte, gate bit included (gplay.c:525, 527),
 * and writes `wave & gate` to $D404 (gplay.c:945), so a drum row such as
 * `$80` (noise, gate bit clear) releases the note.
 *
 * `rust-wasm/tests/fixtures/sid/s59-drum-example.asid` is Cadaver's
 * "GoatTracker drum example" (`fixtures/gt-songs/cadaver/goattracker_drum_example.sng`)
 * through the real importer and the real song-file codec, the bytes the app
 * hands the SID worklet; `rust-wasm/tests/sid_gate_off.rs` plays it on the
 * real player. This test fails unless the fixture is that import, byte for
 * byte. Regenerate with
 * `UPDATE_SID_GATEOFF_FIXTURE=1 npx vitest run src/tests/sid-gate-off.test.ts`.
 */

const ROOT = resolve(__dirname, '../..');
const SONG = resolve(__dirname, 'fixtures/gt-songs/cadaver/goattracker_drum_example.sng');
const FIXTURE = resolve(ROOT, 'rust-wasm/tests/fixtures/sid/s59-drum-example.asid');
const SAMPLE_RATE = 44100;
const QUANTUM = 128;
const FRAME = 882;

const importSong = (path: string) => {
  const imported = importGtSong(new Uint8Array(readFileSync(path)));
  if (!imported.ok) throw new Error(imported.reason);
  return imported.doc;
};

beforeAll(() => {
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
});

/** Renders `frames` samples through the core in worklet quanta; returns the three voice taps. */
function render(core: SidProcessorCore, frames: number): Float32Array[] {
  const mix = new Float32Array(frames);
  const right = new Float32Array(frames);
  const taps = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
  for (let at = 0; at < frames; at += QUANTUM) {
    const n = Math.min(QUANTUM, frames - at);
    core.process(mix.subarray(at, at + n), right.subarray(at, at + n), taps.map((t) => t.subarray(at, at + n)));
  }
  return taps;
}

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

describe('S5.9 wave-table gate bit', () => {
  it('the Rust fixture is the drum example through the real import chain', () => {
    const imported = importGtSong(new Uint8Array(readFileSync(SONG)));
    if (!imported.ok) throw new Error(imported.reason);
    const bytes = serializeSidFile(imported.doc);
    if (process.env.UPDATE_SID_GATEOFF_FIXTURE === '1') writeFileSync(FIXTURE, bytes);
    expect(new Uint8Array(readFileSync(FIXTURE))).toEqual(bytes);
    // The song's drum programs, as the importer passes them through: the
    // bass drum ends on `$40` rows, the snare and hi-hat on `$80` rows, all
    // with the gate bit clear.
    const wave = imported.doc.tables.wave.map((r) => r.left);
    expect(wave).toEqual([0x81, 0x41, 0x40, 0x40, 0xff, 0x81, 0x41, 0x41, 0x80, 0x80, 0xff, 0x81, 0x80, 0xff]);
    expect(imported.doc.instruments.map((i) => [i.name, i.wavePtr, i.firstWave])).toEqual([
      ['Bassdrum', 1, 0x09],
      ['Snaredrum', 6, 0x09],
      ['Hihat', 12, 0x09],
    ]);
  });

  it('the instrument page draws what the player plays: the hi-hat releases on its $80 row', () => {
    // `simulateSidInstrument` ports the player's trigger and frame steps
    // (the S4 visuals); it follows the player's control byte. The hi-hat
    // (instrument 3, table 0C 81 CA, 0D 80 C4, 0E FF 00): the first-frame
    // $09, then $81, then $80 — gate off — held once the table stops.
    const doc = importSong(SONG);
    const controls = simulateSidInstrument(doc, 3, 48, 5).map((f) => f[2]);
    expect(controls).toEqual([0x09, 0x81, 0x80, 0x80, 0x80]);
  });

  it('SidProcessorCore over the real wasm: a crash cymbal on a $80 loop releases instead of hissing for a minute', () => {
    // Stinsen's "Forced Entry" through the real importer and codec, played
    // by the worklet's render core over the rebuilt wasm. Voice 2 strikes
    // instrument 16 "Crash-nofilt" (SR $CB; wave table 4C 71 DF, 4D 80 DF,
    // 4E FF 4D: a loop on noise with the gate bit clear) at frame 1056 and
    // plays nothing else until frame 2072 (S5.18: the song's funktempo rows
    // are 10 and 6 frames, as GT plays them; at a flat 6 the strike was at
    // frame 3170). GoatTracker releases it on the
    // $80 row (release $B, 2.4 s to zero on the chip's rates); the player
    // before S5.9 held the gate, and the noise stood at sustain $C for 61 s.
    const doc = importSong(resolve(__dirname, 'fixtures/gt-songs/stinsen/forced_entry.sng'));
    const core = new SidProcessorCore(SidPlayer as unknown as SidWasmPlayerCtor, SAMPLE_RATE, () => {});
    core.handle({ type: 'load-song', id: 1, bytes: serializeSidFile(doc) });
    core.handle({ type: 'play' });
    render(core, 1054 * FRAME);
    // The strike: noise on voice 2, loud.
    const strike = render(core, 50 * FRAME)[1]!;
    expect(peak(strike)).toBeGreaterThan(0.05);
    // 5.6 s later (frame 1336 on) the release has run out: voice 2 is
    // silent for the next two seconds, where it used to hiss at sustain.
    render(core, (1336 - 1104) * FRAME);
    const tail = render(core, 100 * FRAME)[1]!;
    expect(peak(tail)).toBeLessThan(1e-3);
  }, 60000);
});
