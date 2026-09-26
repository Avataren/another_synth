import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportGtSong, parseSidFile, serializeSidFile, type SidDoc } from 'src/audio/tracker/sid-doc';
import { assemble6502, exportPrg, exportSid } from 'src/audio/tracker/sid-export';
import { importPsid, parsePsid, type PsidImport } from 'src/audio/tracker/psid';
import { estimateTuning, GT_NOTE_REGS, nearestNote, pitchOf, type TraceFrames } from 'src/audio/tracker/psid/transcribe/frames';
import { detectGrid, rowLength, rowOfFrame, rowStart, tempoChanges } from 'src/audio/tracker/psid/transcribe/grid';
import { buildPsid } from './helpers/psid-builder';

/**
 * plan-psid-import.md phases 2-4: a `.sid` of any player transcribed into a
 * GoatTracker song, and how close it sounds (D6: exported with the app's own
 * `.sid` exporter, run on the same emulated C64, compared frame by frame).
 * The floors sit just under what the transcriber reaches today, per tune:
 * a change that makes one sound worse fails here.
 */

const FIXTURES = resolve(__dirname, 'fixtures/psid');
const bytesOf = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)));
const imported = (name: string, subsongs?: readonly number[]): PsidImport => {
  const r = importPsid(bytesOf(name), subsongs === undefined ? {} : { subsongs });
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const startOf = (name: string): number => {
  const p = parsePsid(bytesOf(name));
  if (!p.ok) throw new Error(p.reason);
  return p.file.startSong - 1;
};

/** A trace of frames for the grid and tuning helpers: voice 0 holds `freq`, gated. */
function framesOf(freqs: readonly number[]): TraceFrames {
  const n = freqs.length;
  const voice = () => ({ freq: new Uint16Array(n), pw: new Uint16Array(n), ctrl: new Uint8Array(n), ad: new Uint8Array(n), sr: new Uint8Array(n), events: new Uint8Array(n) });
  const voices = [voice(), voice(), voice()];
  freqs.forEach((f, i) => {
    voices[0]!.freq[i] = f;
    voices[0]!.ctrl[i] = 0x41;
  });
  return {
    frames: n,
    voices,
    cutoff: new Uint16Array(n),
    resonance: new Uint8Array(n),
    modeVolume: new Uint8Array(n).fill(0x0f),
    rateHz: 50,
    clockHz: 985248,
    decimation: 1,
    loopFrame: null,
  };
}

describe('pitch and tuning', () => {
  it("GoatTracker's own note table reads back as its notes", () => {
    for (let n = 12; n < 96; n++) expect(nearestNote(pitchOf(GT_NOTE_REGS[n]!, 985248))).toBe(n);
    expect(pitchOf(0, 985248)).toBe(-Infinity);
  });

  it("a tune tuned 26 cents flat of GoatTracker's table (Galway's) is found so", () => {
    const flat = (note: number): number => Math.round(GT_NOTE_REGS[note]! * 2 ** (-0.26 / 12));
    const freqs = [40, 44, 47, 52, 40, 45].flatMap((n) => Array.from({ length: 12 }, () => flat(n)));
    expect(estimateTuning(framesOf(freqs))).toBeCloseTo(-0.26, 1);
    expect(estimateTuning(framesOf([40, 45, 52].flatMap((n) => Array.from({ length: 12 }, () => GT_NOTE_REGS[n]!))))).toBeCloseTo(0, 1);
  });
});

describe('the row grid', () => {
  it('a steady tempo: one row length, per-voice delays, and one F command', () => {
    // Voice 0 on every 6th frame from 1, voice 1 every 12th, voice 2 two frames late.
    const onsets = [
      Array.from({ length: 100 }, (_, k) => 1 + 6 * k),
      Array.from({ length: 50 }, (_, k) => 1 + 12 * k),
      Array.from({ length: 100 }, (_, k) => 3 + 6 * k),
    ];
    const g = detectGrid(onsets, 610);
    expect(rowLength(g, 0)).toBe(6);
    expect(g.starts[0]).toBe(0);
    expect(g.delays).toEqual([0, 0, 2]);
    expect(g.coverage).toBe(1);
    expect(tempoChanges(g, 100)).toEqual([{ row: 0, length: 6 }]);
  });

  it("rows of 9, 9 and 10 frames (Knucklebusters') are laid note by note, an F wherever the length changes", () => {
    const lengths = Array.from({ length: 60 }, (_, k) => (k % 3 === 2 ? 10 : 9));
    const starts = lengths.reduce<number[]>((acc, l) => [...acc, acc[acc.length - 1]! + l], [0]);
    const onsets = [starts.slice(0, -1).map((s) => s + 1), [], []];
    const g = detectGrid(onsets, starts[starts.length - 1]!);
    for (let k = 0; k < 60; k++) expect(rowStart(g, k)).toBe(starts[k]);
    expect(g.coverage).toBe(1);
    const changes = tempoChanges(g, 60);
    expect(changes.slice(0, 3)).toEqual([
      { row: 0, length: 9 },
      { row: 2, length: 10 },
      { row: 3, length: 9 },
    ]);
  });

  it('rowOfFrame and rowStart agree, past the last row too', () => {
    const g = detectGrid([Array.from({ length: 20 }, (_, k) => 1 + 7 * k), [], []], 140);
    for (let f = 0; f < 400; f++) {
      const k = rowOfFrame(g, f);
      expect(rowStart(g, k)).toBeLessThanOrEqual(f);
      expect(rowStart(g, k + 1)).toBeGreaterThan(f);
    }
  });
});

/** Each fixture's start song, alone, and the score it must keep (today's, less two points). */
const FLOORS: readonly (readonly [string, number])[] = [
  ['hubbard_rob/commando.sid', 0.94],
  ['hubbard_rob/crazy_comets.sid', 0.90],
  ['hubbard_rob/knucklebusters.sid', 0.94],
  ['hubbard_rob/chimera.sid', 0.86],
  ['galway_martin/arkanoid.sid', 0.83],
  ['galway_martin/comic_bakery.sid', 0.92],
  ['galway_martin/commando_high_score.sid', 0.94],
  ['galway_martin/ocean_loader_1.sid', 0.96],
  ['galway_martin/ocean_loader_2.sid', 0.96],
  ['daglish_ben/krakout.sid', 0.95],
  ['daglish_ben/last_ninja.sid', 0.84],
  ['huelsbeck_chris/great_giana_sisters.sid', 0.97],
  ['huelsbeck_chris/r_type.sid', 0.94],
  ['joseph_richard/defender_of_the_crown.sid', 0.97],
  ['tel_jeroen/golden_axe.sid', 0.87],
  ['tel_jeroen/robocop_3.sid', 0.88],
  ['chiptunesak/vibratotest.sid', 0.92],
];

/** The formats the app exports a SID song to, each of which must take the transcription. */
function exportsEverywhere(doc: SidDoc): void {
  const sng = exportGtSong(doc);
  if (!sng.ok) throw new Error(`.sng: ${sng.reason}`);
  const sid = exportSid(doc);
  if (!sid.ok) throw new Error(`.sid: ${sid.reason}`);
  const prg = exportPrg(doc);
  if (!prg.ok) throw new Error(`.prg: ${prg.reason}`);
  // And the app's own song file (the doc a .cmod carries) round-trips it.
  expect(parseSidFile(serializeSidFile(doc))).toEqual(doc);
}

describe('importPsid: the start song of every fixture', () => {
  it.each(FLOORS)('%s plays at least %f like the original, and exports to .sng, .sid and .prg', (name, floor) => {
    const r = imported(name, [startOf(name)]);
    expect(r.method).toBe('transcribed');
    expect(r.doc.subsongs.length).toBe(1);
    expect(r.fidelity).not.toBeNull();
    expect(r.fidelity!.score).toBeGreaterThanOrEqual(floor);
    // The comparison covered the song (or all of a short one), aligned within a few frames.
    expect(r.fidelity!.frames).toBeGreaterThan(Math.min(2900, r.reports[0]!.frames! - 100));
    exportsEverywhere(r.doc);
  }, 60_000);

  it("sounds every note: Commando's one-frame drum hits start their envelope (no ADSR delay bug)", () => {
    // Started with the gate off on tick 0, the note's slow release rate ran the envelope's
    // rate counter past the attack's for a frame, and the drums on voice 1 never sounded.
    const r = imported('hubbard_rob/commando.sid', [0]);
    expect(r.doc.instruments.some((i) => i.firstWave === 0x09)).toBe(true);
    expect(r.fidelity!.voices[0]!.level).toBeGreaterThanOrEqual(0.75);
  }, 60_000);

  it('carries the header into the song: name, author, released, chip model', () => {
    const r = imported('tel_jeroen/robocop_3.sid', [0]);
    expect([r.doc.songName, r.doc.author, r.doc.copyright]).toEqual(['RoboCop 3', 'Jeroen Tel', '1992 Ocean']);
    expect(r.doc.chipModel).toBe('8580');
    expect(imported('hubbard_rob/commando.sid', [0]).doc.chipModel).toBe('6581');
  }, 60_000);

  it("keeps a tune's speed: Defender of the Crown's 98.5 Hz player is a 2x song, and the note says how close", () => {
    const r = imported('joseph_richard/defender_of_the_crown.sid', [0]);
    expect(r.doc.speedMultiplier).toBe(2);
    expect(r.notes.some((n) => /98\.\d\d Hz; GoatTracker plays it at 100\.25 Hz \(2x\), 1\.\d% faster/.test(n))).toBe(true);
  }, 60_000);

  it('says what it left out: the samples a digi tune plays through $D418, and subsongs at another speed, as runs', () => {
    const r = imported('galway_martin/arkanoid.sid', [0, 2, 3, 4, 6]);
    expect(r.notes.some((n) => /samples through the volume register/.test(n))).toBe(true);
    expect(r.notes).toContain('Not imported: subsongs 3-5, 7 (2x speed; the song plays at 1x).');
  }, 60_000);
});

describe('importPsid: whole files', () => {
  it('Commando: all 19 subsongs, the start song first, sharing the instruments and tables', () => {
    const r = imported('hubbard_rob/commando.sid');
    expect(r.doc.subsongs.length).toBe(19);
    expect(r.reports.map((x) => x.gtSubsong)).toEqual(Array.from({ length: 19 }, (_, i) => i));
    expect(r.doc.instruments.length).toBeLessThanOrEqual(63);
    expect(r.fidelity!.score).toBeGreaterThanOrEqual(0.93);
    exportsEverywhere(r.doc);
  }, 120_000);

  it('Knucklebusters: its ten minutes of subsong 1 never repeat, and fit whole', () => {
    const r = imported('hubbard_rob/knucklebusters.sid');
    expect(r.doc.subsongs.length).toBe(11);
    const long = r.reports.find((x) => x.subsong === 0)!;
    expect(long.loop).toBe('none');
    expect(long.cutRows).toBeUndefined();
    expect(long.rows).toBeGreaterThan(7000);
    exportsEverywhere(r.doc);
  }, 120_000);

  it('The Last Ninja: the subsongs that do not fit are named, with the reason', () => {
    const r = imported('daglish_ben/last_ninja.sid');
    expect(r.doc.subsongs.length).toBeGreaterThanOrEqual(3);
    expect(r.reports[0]!.subsong).toBe(2);
    const left = r.reports.filter((x) => x.gtSubsong === null);
    expect(left.length).toBe(11 - r.doc.subsongs.length);
    expect(r.notes.some((n) => /^Not imported: subsongs? \d.*\.$/.test(n))).toBe(true);
    exportsEverywhere(r.doc);
  }, 120_000);
});

/**
 * A tune that never repeats: a 16-bit LFSR picks each voice's next note every
 * third frame for ten minutes, more than GoatTracker's 208 patterns hold.
 */
const NEVER_TWICE = `
lfsr = $f0
cnt = $f2
        .ORG ($1000)
init:   lda #$ac
        sta <lfsr
        lda #$e1
        sta <lfsr+1
        lda #$00
        sta <cnt
        lda #$0f
        sta $d418
        lda #$09
        sta $d405
        sta $d40c
        sta $d413
        lda #$a0
        sta $d406
        sta $d40d
        sta $d414
        rts
play:   ldx <cnt
        inx
        cpx #$03
        bne keep
        ldx #$00
keep:   stx <cnt
        txa
        bne off
voice:  jsr step
        lda <lfsr
        and #$1f
        clc
        adc #$08
        sta $d401,x
        lda #$41
        sta $d404,x
        txa
        clc
        adc #$07
        tax
        cpx #$15
        bne voice
        rts
off:    cmp #$01
        bne done
        lda #$40
        sta $d404
        sta $d40b
        sta $d412
done:   rts
step:   lsr <lfsr+1
        ror <lfsr
        bcc nox
        lda <lfsr+1
        eor #$b4
        sta <lfsr+1
nox:    rts
`;

describe('importPsid: a song longer than GoatTracker holds', () => {
  it('is cut to the rows that fit, and the note says so', () => {
    const asm = assemble6502(NEVER_TWICE);
    if (!asm.ok) throw new Error(`line ${asm.line}: ${asm.reason}`);
    const r = importPsid(buildPsid({ init: 0x1000, play: asm.symbols.get('play')!, name: 'Never Twice' }, Array.from(asm.bytes)));
    if (!r.ok) throw new Error(r.reason);
    const report = r.reports[0]!;
    expect(report.loop).toBe('none');
    expect(report.cutRows).toBeGreaterThan(1000);
    expect(report.rows).toBe(report.cutRows);
    expect(r.doc.patterns.length).toBeLessThanOrEqual(208);
    expect(r.notes).toContain(`Subsong 1 does not repeat within its first 600 s, and only its first ${report.cutRows} rows fit GoatTracker.`);
    // Every note on its row, whatever the pitch: one instrument, the notes the nearest GoatTracker has.
    expect(r.doc.instruments.length).toBe(1);
    expect(r.fidelity!.voices.every((v) => v.gate === 1 && v.onsets === 1)).toBe(true);
    exportsEverywhere(r.doc);
  }, 120_000);
});

describe('importPsid: refusals', () => {
  it('bytes that are no SID file, or a tune that plays nothing, are refused with the reason', () => {
    expect(importPsid(new TextEncoder().encode('GTS5...'))).toEqual({ ok: false, reason: 'it is not a SID file' });
    // A PSID whose play routine only returns: it runs, and plays no notes.
    const silent = new Uint8Array(readFileSync(resolve(FIXTURES, 'hubbard_rob/commando.sid')));
    const header = silent.slice(0, 0x7c);
    header[8] = 0x10;
    header[9] = 0x00;
    header[10] = 0x10;
    header[11] = 0x00;
    header[12] = 0x10;
    header[13] = 0x00;
    header[14] = 0;
    header[15] = 1;
    const r = importPsid(new Uint8Array([...header, 0x60]));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/plays no notes/);
  });
});
