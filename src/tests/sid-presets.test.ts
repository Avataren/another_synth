import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Relative on purpose: the alias is mocked for other tests; this one renders on the real bytes.
import { SidPlayer, initSync } from '../../public/wasm/audio_processor.js';
import {
  SID_MAX_INSTRUMENT_NAME_LENGTH,
  createNewSidDoc,
  importGtSong,
  serializeSidFile,
  setSidRow,
  type SidDoc,
} from 'src/audio/tracker/sid-doc';
import { exportGtSong } from 'src/audio/tracker/sid-doc/gt-sng-write';
import { exportSid } from 'src/audio/tracker/sid-export';
import { SID_PRESETS, SID_PRESET_CATEGORIES, addSidPreset, applySidPreset, sidPresetOptions, sidPresetUsesFilter } from 'src/audio/tracker/sid-presets';
import { sidInstrumentTableRows, sidRowSetsSize, sidUnusedTableRows } from 'src/audio/tracker/sid-table-rows';

/**
 * The SID preset library (`sid-presets.ts`): every preset goes into a song,
 * its rows land where its pointers and jumps say, the same preset twice
 * shares its rows, the filter is routed to the voice asked for, GoatTracker's
 * packer takes every one, and every one SOUNDS on the real player.
 */

const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 44100;

beforeAll(() => {
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
});

const ok = (result: ReturnType<typeof addSidPreset>): SidDoc => {
  if (!result.ok) throw new Error(result.reason);
  return result.doc;
};

/** What instrument `n` plays: its settings and the contents of every row it reaches, in order (row numbers aside). */
function programOf(doc: SidDoc, n: number) {
  const { wavePtr, pulsePtr, filterPtr, speedPtr, ...settings } = doc.instruments[n - 1]!;
  const reached = sidInstrumentTableRows(doc, n);
  const rows = (t: 'wave' | 'pulse' | 'filter' | 'speed') => [...reached[t]].sort((a, b) => a - b).map((r) => doc.tables[t][r - 1]!);
  return { settings, starts: [wavePtr, pulsePtr, filterPtr, speedPtr].map((p) => p > 0), wave: rows('wave').map((r) => (r.left === 0xff ? r.left : r)), pulse: rows('pulse').map((r) => (r.left === 0xff ? r.left : r)), filter: rows('filter'), speed: rows('speed') };
}

/** A new song holding every preset, instrument 2 onwards, in library order. */
function everyPreset(): SidDoc {
  let doc = createNewSidDoc({});
  for (const preset of SID_PRESETS) doc = ok(addSidPreset(doc, preset.id));
  return doc;
}

describe('the SID preset library', () => {
  it('has every category, unique ids, names an instrument can hold and a description', () => {
    expect(new Set(SID_PRESETS.map((p) => p.category))).toEqual(new Set(SID_PRESET_CATEGORIES));
    expect(new Set(SID_PRESETS.map((p) => p.id)).size).toBe(SID_PRESETS.length);
    for (const p of SID_PRESETS) {
      expect(p.name.length, p.id).toBeLessThanOrEqual(SID_MAX_INSTRUMENT_NAME_LENGTH);
      expect(p.description.length, p.id).toBeGreaterThan(20);
    }
    expect(sidPresetOptions()).toHaveLength(SID_PRESETS.length);
  });

  it('all of them fit in one song', () => {
    const doc = everyPreset();
    expect(doc.instruments).toHaveLength(SID_PRESETS.length + 1);
    expect(doc.instruments.slice(1).map((i) => i.name)).toEqual(SID_PRESETS.map((p) => p.name));
  });

  it('points each instrument at its own rows, and its jumps stay inside them', () => {
    const doc = everyPreset();
    SID_PRESETS.forEach((preset, i) => {
      const ins = doc.instruments[i + 1]!;
      const wave = doc.tables.wave;
      expect(ins.wavePtr, preset.id).toBeGreaterThan(0);
      const rows = wave.slice(ins.wavePtr - 1, ins.wavePtr - 1 + preset.wave.length);
      rows.forEach((row, r) => {
        const own = preset.wave[r]!;
        if (own.left === 0xff && own.right !== 0) {
          expect(row.right - ins.wavePtr + 1, `${preset.id} wave row ${r + 1}`).toBe(own.right);
        } else if (own.left >= 0xf1 && own.left <= 0xf4) {
          expect(row.right, `${preset.id} speed row`).toBeGreaterThan(0);
          expect(doc.tables.speed[row.right - 1], preset.id).toEqual(preset.speed![own.right - 1]);
        } else {
          expect(row, `${preset.id} wave row ${r + 1}`).toEqual(own);
        }
      });
      if (preset.pulse) expect(doc.tables.pulse[ins.pulsePtr - 1]).toEqual(preset.pulse[0]);
      else expect(ins.pulsePtr).toBe(0);
      if (preset.vibrato) expect(doc.tables.speed[ins.speedPtr - 1]).toEqual(preset.speed![0]);
      else expect(ins.speedPtr).toBe(0);
    });
  });

  it('the same preset twice shares its rows: the tables do not grow', () => {
    const once = ok(addSidPreset(createNewSidDoc({}), 'lead-pwm'));
    const twice = ok(addSidPreset(once, 'lead-pwm'));
    expect(twice.tables).toEqual(once.tables);
    const [a, b] = [twice.instruments[1]!, twice.instruments[2]!];
    expect([b.wavePtr, b.pulsePtr, b.speedPtr]).toEqual([a.wavePtr, a.pulsePtr, a.speedPtr]);
  });

  it('routes the filter to the voice asked for (voice 1 by default), resonance kept', () => {
    expect(sidPresetUsesFilter('bass-acid')).toBe(true);
    expect(sidPresetUsesFilter('bass-pulse')).toBe(false);
    const v1 = ok(addSidPreset(createNewSidDoc({}), 'bass-acid'));
    const v3 = ok(addSidPreset(createNewSidDoc({}), 'bass-acid', { filterVoice: 3 }));
    const modeRow = (doc: SidDoc) => doc.tables.filter[doc.instruments[1]!.filterPtr - 1]!;
    expect(modeRow(v1).right).toBe(0xf1);
    expect(modeRow(v3).right).toBe(0xf4);
  });

  it('replaces an instrument in place; the others play the same rows (renumbered)', () => {
    const doc = ok(addSidPreset(createNewSidDoc({}), 'bass-pulse'));
    const replaced = ok(applySidPreset(doc, 1, 'drum-snare'));
    expect(replaced.instruments).toHaveLength(2);
    expect(replaced.instruments[0]!.name).toBe('Snare');
    expect(programOf(replaced, 2)).toEqual(programOf(doc, 2));
    expect(applySidPreset(doc, 5, 'drum-snare').ok).toBe(false);
    expect(addSidPreset(doc, 'no-such').ok).toBe(false);
  });

  it('frees the rows only the replaced instrument reached, so replacing again and again does not grow the tables', () => {
    let doc = ok(addSidPreset(createNewSidDoc({}), 'bass-pulse'));
    doc = ok(applySidPreset(doc, 1, 'lead-pwm'));
    const settled = doc.tables;
    for (const id of ['arp-major', 'drum-tom', 'bass-acid', 'lead-pwm']) doc = ok(applySidPreset(doc, 1, id));
    expect(doc.tables).toEqual(settled);
    expect(sidRowSetsSize(sidUnusedTableRows(doc))).toBe(0);
  });

  it('keeps rows another instrument or a pattern command still reaches', () => {
    let doc = ok(addSidPreset(createNewSidDoc({}), 'lead-pwm'));
    doc = ok(addSidPreset(doc, 'lead-pwm'));
    // Instruments 2 and 3 share their rows; a pattern starts instrument 2's pulse program by command 9.
    const pulse = doc.instruments[1]!.pulsePtr;
    doc = ok(setSidRow(doc, 0, 0, { note: 0, instrument: 0, command: 0x9, param: pulse }));
    const before3 = programOf(doc, 3);
    const replaced = ok(applySidPreset(doc, 2, 'drum-kick'));
    expect(programOf(replaced, 3)).toEqual(before3);
    const row = replaced.patterns[0]!.rows[0]!;
    expect(replaced.tables.pulse[row.param - 1]).toEqual(doc.tables.pulse[pulse - 1]);
  });

  it('leaves rows nothing reached before alone (a sequence being written)', () => {
    const base = createNewSidDoc({});
    const scratch = { ...base, tables: { ...base.tables, wave: [...base.tables.wave, { left: 0x21, right: 0x00 }, { left: 0xff, right: 0x00 }] } };
    const replaced = ok(applySidPreset(scratch, 1, 'bass-sub'));
    expect(replaced.tables.wave.slice(0, 2)).toEqual(scratch.tables.wave.slice(2));
  });

  it('scales the gate timer at multispeed, as a new instrument\'s is', () => {
    const doc = ok(addSidPreset(createNewSidDoc({ speedMultiplier: 2, tempo: 12 }), 'lead-saw'));
    expect(doc.instruments[1]!.gateTimer).toBe(4);
  });

  it('GoatTracker takes a song playing every one: .sng round trip and .sid export', () => {
    let doc = everyPreset();
    SID_PRESETS.forEach((_, i) => {
      doc = ok(setSidRow(doc, 0, i, { note: 49, instrument: i + 2, command: 0, param: 0 }));
    });
    const sng = exportGtSong(doc);
    if (!sng.ok) throw new Error(sng.reason);
    const back = importGtSong(sng.bytes);
    if (!back.ok) throw new Error(back.reason);
    expect(back.doc.instruments).toEqual(doc.instruments);
    expect(back.doc.tables).toEqual(doc.tables);
    const sid = exportSid(doc);
    if (!sid.ok) throw new Error(sid.reason);
    expect(sid.bytes.length).toBeGreaterThan(0x7c);
  });
});

describe('every preset sounds (the Rust player, the preview voice, C-4)', () => {
  const doc = everyPreset();
  const bytes = serializeSidFile(doc);
  const frame = 882;

  /** RMS per 100 ms, with the note held for `heldMs` then released. */
  function render(instrument: number, heldMs: number, totalMs: number): number[] {
    const player = new SidPlayer(bytes, SAMPLE_RATE);
    player.enable_preview();
    expect(player.preview_note_on(instrument, 48)).toBe(true);
    const window = SAMPLE_RATE / 10;
    const out = new Float32Array(frame);
    const taps = [new Float32Array(frame), new Float32Array(frame), new Float32Array(frame)];
    const levels: number[] = [];
    let sum = 0;
    let count = 0;
    for (let done = 0; done < (totalMs / 1000) * SAMPLE_RATE; done += frame) {
      if (done >= (heldMs / 1000) * SAMPLE_RATE && done - frame < (heldMs / 1000) * SAMPLE_RATE) player.preview_note_off();
      player.render(out, taps[0]!, taps[1]!, taps[2]!);
      for (const s of out) {
        sum += s * s;
        count += 1;
        if (count === window) {
          levels.push(Math.sqrt(sum / count));
          sum = 0;
          count = 0;
        }
      }
    }
    player.free();
    return levels;
  }

  it.each(SID_PRESETS.map((p, i) => [p.id, i + 2] as const))('%s is heard, and is silent once released', (id, instrument) => {
    const levels = render(instrument, 500, 4000);
    expect(Math.max(...levels.slice(0, 5)), id).toBeGreaterThan(0.005);
    expect(levels.every(Number.isFinite)).toBe(true);
    // Every preset has died away within 3.5 s of its release.
    expect(levels[levels.length - 1]!, id).toBeLessThan(0.002);
  });
});
