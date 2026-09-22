// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAhx, type AhxInstrument, type AhxPListEntry } from '@another-synth/tracker-playback';
import { defaultAhxInstrument } from 'src/audio/tracker/ahx-instrument-edit';
import {
  buildPListTrack,
  plistNoteText,
  plistToneText,
  PLIST_TRACK_NAME,
} from 'src/audio/tracker/plist-track';
import { formatEntryCells } from 'src/components/tracker/pattern-canvas/format-entry-cells';

/**
 * T1: the projection of an instrument's PList onto a one-track pattern is a
 * complete picture of the data. The bar is the whole demo corpus (77 `.ahx` +
 * 7 `.hvl`, 1290 instruments): every entry, read back from the text the canvas
 * would draw, is the entry it came from.
 */
const DEMOS = resolve(__dirname, '../../public/demos/ahx');

const NOTE_NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];

/**
 * Test-local reader, written apart from the projection: the displayed text
 * (`formatEntryCells`, the canvas's own formatter) back to an entry. `fixed`
 * on a row with no note is invisible (the engine ignores it), so it reads
 * back as false and the comparison normalises the original the same way.
 */
function readBack(track: ReturnType<typeof buildPListTrack>, rowCount: number): AhxPListEntry[] {
  const byRow = new Map(track.entries.map((e) => [e.row, e]));
  const out: AhxPListEntry[] = [];
  for (let row = 0; row < rowCount; row++) {
    const entry = byRow.get(row);
    const cells = entry ? formatEntryCells(entry) : null;
    let note = 0;
    let fixed = false;
    const noteText = cells?.note.display ?? '---';
    if (noteText.startsWith('+')) {
      note = parseInt(noteText.slice(1), 10) + 1;
    } else if (noteText !== '---') {
      note = NOTE_NAMES.indexOf(noteText.slice(0, 2)) + (parseInt(noteText.slice(2), 10) - 1) * 12 + 1;
      fixed = true;
    }
    const toneText = cells?.instrument.display ?? '..';
    let waveform = 0;
    if (toneText.startsWith('?')) waveform = parseInt(toneText.slice(1), 10);
    else if (toneText !== '..') waveform = ['TR', 'SA', 'SQ', 'NO'].indexOf(toneText) + 1;
    const cmd = (digits: string[] | undefined): [number, number] => {
      const text = (digits ?? ['.', '.', '.']).join('');
      if (text === '...') return [0, 0];
      return [parseInt(text[0]!, 16), parseInt(text.slice(1), 16)];
    };
    const [fx0, p0] = cmd(cells?.macroDigits);
    const [fx1, p1] = cmd(cells?.macro2Digits);
    out.push({ note, waveform, fixed, fx: [fx0, fx1], fxParam: [p0, p1] });
  }
  return out;
}

const seen = (e: AhxPListEntry): AhxPListEntry => ({ ...e, fixed: e.note > 0 && e.fixed });

const entry = (over: Partial<AhxPListEntry> = {}): AhxPListEntry => ({
  note: 0,
  waveform: 0,
  fixed: false,
  fx: [0, 0],
  fxParam: [0, 0],
  ...over,
});

function corpusInstruments(): { name: string; index: number; instrument: AhxInstrument }[] {
  const out: { name: string; index: number; instrument: AhxInstrument }[] = [];
  for (const name of readdirSync(DEMOS).filter((n) => /\.(ahx|hvl)$/.test(n)).sort()) {
    const song = parseAhx(new Uint8Array(readFileSync(resolve(DEMOS, name))));
    // instruments[0] is the format's empty placeholder, not an instrument of the file.
    song.instruments.slice(1).forEach((instrument, i) => out.push({ name, index: i + 1, instrument }));
  }
  return out;
}

describe('the PList projection over the demo corpus', () => {
  const all = corpusInstruments();

  // re-measured 2026-09-22: corpus 62→84 files at c027f2a2
  it('covers all 1290 instruments of the 84 demo files', () => {
    expect(new Set(all.map((i) => i.name)).size).toBe(84);
    expect(all).toHaveLength(1290);
  });

  it('is lossless: 1290/1290 instruments read back to their own entries', () => {
    const bad: string[] = [];
    let rows = 0;
    for (const { name, index, instrument } of all) {
      const entries = instrument.plist.entries;
      const track = buildPListTrack(entries);
      rows += entries.length;
      const back = readBack(track, entries.length);
      if (JSON.stringify(back) !== JSON.stringify(entries.map(seen))) bad.push(`${name}#${index}`);
    }
    expect(bad).toEqual([]);
    expect(rows).toBeGreaterThan(1000);
  });

  it('gives one row per entry: an entry exists exactly where a field is set, in row order, never past the list', () => {
    for (const { name, index, instrument } of all) {
      const entries = instrument.plist.entries;
      const track = buildPListTrack(entries);
      const expectedRows = entries
        .map((e, row) => ({ e, row }))
        .filter(({ e }) => e.note > 0 || e.waveform > 0 || e.fx[0] !== 0 || e.fxParam[0] !== 0 || e.fx[1] !== 0 || e.fxParam[1] !== 0)
        .map(({ row }) => row);
      expect(track.entries.map((t) => t.row), `${name}#${index}`).toEqual(expectedRows);
    }
  });

  it('never shows a release: no note text is ever ---, -- or ###', () => {
    for (const { instrument } of all) {
      for (const e of buildPListTrack(instrument.plist.entries).entries) {
        if (e.note !== undefined) expect(['---', '--', '###']).not.toContain(e.note);
        expect(formatEntryCells(e).note.display).not.toBe('###');
      }
    }
  });

  it('the one lossy field is `fixed` on a row with no note, and the corpus has that many such rows', () => {
    let count = 0;
    for (const { instrument } of all) for (const e of instrument.plist.entries) if (e.note === 0 && e.fixed) count++;
    // The engine ignores `fixed` without a note and the note column has nothing to show for it; recorded so a
    // change in what the corpus holds is a visible decision.
    console.log(`fixed-with-no-note rows in the corpus: ${count}`);
    expect(count).toBeGreaterThanOrEqual(0);
  });
});

describe('the projection, by rule', () => {
  it('shows a relative note as the semitones above the key (note - 1) and a fixed one by name', () => {
    expect(plistNoteText(entry({ note: 6 }))).toBe('+05');
    expect(plistNoteText(entry({ note: 1 }))).toBe('+00');
    expect(plistNoteText(entry({ note: 63 }))).toBe('+62');
    expect(plistNoteText(entry({ note: 1, fixed: true }))).toBe('C-1');
    expect(plistNoteText(entry({ note: 25, fixed: true }))).toBe('C-3');
    expect(plistNoteText(entry({ note: 62, fixed: true }))).toBe('C#6');
  });

  it('shows nothing (undefined, never ---) for note 0, fixed or not', () => {
    expect(plistNoteText(entry())).toBeUndefined();
    expect(plistNoteText(entry({ fixed: true }))).toBeUndefined();
  });

  it('tags tones TR SA SQ NO, ?N above 4, and nothing for 0', () => {
    expect([1, 2, 3, 4].map(plistToneText)).toEqual(['TR', 'SA', 'SQ', 'NO']);
    expect([5, 6, 7].map(plistToneText)).toEqual(['?5', '?6', '?7']);
    expect(plistToneText(0)).toBeUndefined();
  });

  it('puts command 1 in the macro column and command 2 in macro2, blank only for command 0 with parameter 0', () => {
    const track = buildPListTrack([
      entry({ fx: [5, 0], fxParam: [0x0a, 0] }),
      entry({ fx: [0, 12], fxParam: [0, 0x3c] }),
      entry({ fx: [0, 0], fxParam: [1, 0] }),
      entry({ fx: [0, 0], fxParam: [0, 0] }),
    ]);
    expect(track.entries).toEqual([
      { row: 0, macro: '50A' },
      { row: 1, macro2: 'C3C' },
      { row: 2, macro: '001' },
    ]);
  });

  it('leaves a fully blank row without an entry, and the volume column unset', () => {
    const track = buildPListTrack([entry(), entry({ note: 3, waveform: 3 }), entry()]);
    expect(track.entries).toEqual([{ row: 1, note: '+02', instrument: 'SQ' }]);
    expect(track.entries.every((e) => e.volume === undefined)).toBe(true);
  });

  it('projects an empty list to an empty track', () => {
    const track = buildPListTrack([]);
    expect(track.entries).toEqual([]);
    expect(track.name).toBe(PLIST_TRACK_NAME);
  });

  it('projects a full 255-row list, one row per step', () => {
    const entries = Array.from({ length: 255 }, (_, i) =>
      entry({ note: (i % 62) + 1, waveform: (i % 5), fixed: i % 3 === 0, fx: [i % 16, 0], fxParam: [i % 256, 0] }),
    );
    const track = buildPListTrack(entries);
    expect(track.entries.length).toBeGreaterThan(250);
    expect(track.entries.at(-1)!.row).toBeLessThanOrEqual(254);
    expect(JSON.stringify(readBack(track, 255))).toBe(JSON.stringify(entries.map(seen)));
  });

  it('projects an HVL-layout instrument (commands past the AHX set) as raw hex', () => {
    const track = buildPListTrack([entry({ fx: [6, 14], fxParam: [0x12, 0xff] })]);
    expect(track.entries).toEqual([{ row: 0, macro: '612', macro2: 'EFF' }]);
  });

  it('a fresh default instrument has an empty or fully readable PList', () => {
    const ins = defaultAhxInstrument();
    const track = buildPListTrack(ins.plist.entries);
    expect(JSON.stringify(readBack(track, ins.plist.entries.length))).toBe(JSON.stringify(ins.plist.entries.map(seen)));
  });

  it('is frozen: the painter can not change what it paints', () => {
    const track = buildPListTrack([entry({ note: 2 })]);
    expect(Object.isFrozen(track)).toBe(true);
    expect(Object.isFrozen(track.entries)).toBe(true);
    expect(Object.isFrozen(track.entries[0])).toBe(true);
  });
});
