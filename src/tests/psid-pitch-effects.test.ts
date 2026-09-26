import { describe, expect, it } from 'vitest';
import { sidDocForSubsong, SID_NOTE_KEY_OFF, type SidDoc } from 'src/audio/tracker/sid-doc';
import { assemble6502, exportSid } from 'src/audio/tracker/sid-export';
import { captureSid, importPsid, parsePsid, type PsidImport } from 'src/audio/tracker/psid';
import { unrolled } from 'src/audio/tracker/psid/fidelity';
import { GT_NOTE_REGS, pitchOf, traceFrames, type TraceFrames } from 'src/audio/tracker/psid/transcribe/frames';
import { buildPsid } from './helpers/psid-builder';

/**
 * plan-psid-import.md §3, pitch effects and the pulse table: what the
 * original does to a sounding note after it starts, played by GoatTracker's
 * pattern commands (a glide by tone portamento, a legato line by ties) and
 * its pulse table (a sweep, a looping one), measured on the exported `.sid`.
 *
 * The tunes are tables of register values, one entry a frame, played in a
 * loop by a small player; voice 2 ticks every 6 frames so the rows are 6
 * frames long.
 */

const PAL = 985248;
const C4 = GT_NOTE_REGS[48]!;
const E4 = GT_NOTE_REGS[52]!;
const G4 = GT_NOTE_REGS[55]!;
const TICK = GT_NOTE_REGS[72]!;

interface VoiceFrame {
  readonly freq: number;
  readonly ctrl: number;
  readonly pw?: number;
}

/** A tune of `frames` frames, looping: per voice, the registers each frame (voice 3 silent). */
function tableTune(name: string, voice1: readonly VoiceFrame[]): Uint8Array {
  const n = voice1.length;
  const voice2: VoiceFrame[] = Array.from({ length: n }, (_, i) => ({ freq: TICK, ctrl: i % 6 < 2 ? 0x11 : 0x10 }));
  const bytes = (values: readonly number[]): string => values.map((v) => `.BYTE (${v & 0xff})`).join('\n');
  const tables = [voice1, voice2].flatMap((vs, v) => [
    `f${v}lo:\n${bytes(vs.map((x) => x.freq))}`,
    `f${v}hi:\n${bytes(vs.map((x) => x.freq >> 8))}`,
    `p${v}lo:\n${bytes(vs.map((x) => x.pw ?? 0x800))}`,
    `p${v}hi:\n${bytes(vs.map((x) => (x.pw ?? 0x800) >> 8))}`,
    `c${v}:\n${bytes(vs.map((x) => x.ctrl))}`,
  ]);
  const writes = [0, 1]
    .flatMap((v) => [
      [`f${v}lo`, 0],
      [`f${v}hi`, 1],
      [`p${v}lo`, 2],
      [`p${v}hi`, 3],
      [`c${v}`, 4],
    ])
    .map(([t, r]) => `        lda ${t},x\n        sta $d4${(Number(r) + (String(t).includes('1') ? 7 : 0)).toString(16).padStart(2, '0')}`)
    .join('\n');
  const src = `
cnt = $f0
        .ORG ($1000)
init:   lda #$00
        sta <cnt
        lda #$0f
        sta $d418
        lda #$09
        sta $d405
        sta $d40c
        lda #$a0
        sta $d406
        sta $d40d
        rts
play:   ldx <cnt
${writes}
        inx
        cpx #${n}
        bne keep
        ldx #$00
keep:   stx <cnt
        rts
${tables.join('\n')}
`;
  const asm = assemble6502(src);
  if (!asm.ok) throw new Error(`line ${asm.line}: ${asm.reason}`);
  return buildPsid({ init: 0x1000, play: asm.symbols.get('play')!, name }, Array.from(asm.bytes));
}

function imported(bytes: Uint8Array): PsidImport {
  const r = importPsid(bytes);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

/** `doc`'s start song exported and run on the emulated C64: its frames, and the original's. */
function played(r: PsidImport, seconds = 12): { a: TraceFrames; b: TraceFrames; offset: number } {
  const exported = exportSid(sidDocForSubsong(r.doc, 0));
  if (!exported.ok) throw new Error(exported.reason);
  const parsed = parsePsid(exported.bytes);
  if (!parsed.ok) throw new Error(parsed.reason);
  const b = captureSid(parsed.file, { subsong: 0, maxSeconds: seconds });
  if (!b.ok) throw new Error(b.reason);
  const a = r.reports[0]!.trace!;
  // Both played on through their loops (a capture stops where the music repeats).
  return { a: unrolled(traceFrames(a), 1000), b: unrolled(traceFrames(b.trace), 1100), offset: r.fidelity!.offset };
}

/** Voice 1's pattern cells of the start song, in play order. */
function cells(doc: SidDoc): { note: number; instrument: number; command: number; param: number }[] {
  const out: { note: number; instrument: number; command: number; param: number }[] = [];
  for (const e of doc.subsongs[0]!.orderlists[0]!.entries) {
    for (let k = 0; k < e.repeat; k++) out.push(...doc.patterns[e.pattern]!.rows);
  }
  return out;
}

/** Cents between the original's voice 1 and the export's, at original frame `i`. */
const centsAt = (p: { a: TraceFrames; b: TraceFrames; offset: number }, i: number): number =>
  Math.abs(pitchOf(p.a.voices[0]!.freq[i]!, PAL) - pitchOf(p.b.voices[0]!.freq[i + p.offset]!, PAL)) * 100;

describe('pitch effects', () => {
  // 48 frames: C-4 held 12 frames, a straight glide (equal register steps) to E-4 over
  // 12, E-4 held, the gate off for the last 12.
  const glide: VoiceFrame[] = Array.from({ length: 48 }, (_, i) => {
    const freq = i < 12 ? C4 : i < 24 ? Math.round(C4 + ((E4 - C4) * (i - 11)) / 12) : E4;
    return { freq, ctrl: i < 36 ? 0x21 : 0x20 };
  });

  it('a glide between two notes is one note and a tone portamento, not a run of notes', () => {
    const r = imported(tableTune('Glide', glide));
    const rows = cells(r.doc);
    const notes = rows.filter((x) => x.instrument > 0);
    const portas = rows.filter((x) => x.command === 3 && x.param > 0);
    // One note (with an instrument) per 48 frames, and a tone portamento to E-4 in each.
    expect(portas.length).toBeGreaterThan(0);
    expect(notes.length).toBe(portas.filter((x) => x.note !== 0).length);
    expect(portas.every((x) => x.note === 0 || x.note === 53)).toBe(true);
    const speed = r.doc.tables.speed[portas[0]!.param - 1]!;
    expect((speed.left << 8) | speed.right).toBeGreaterThan(0);
    // Played: close through the glide, and exact once it lands.
    const p = played(r);
    const during: number[] = [];
    for (let cycle = 1; cycle < 4; cycle++) for (let i = 12; i < 24; i++) during.push(centsAt(p, cycle * 48 + i));
    const mean = during.reduce((s, x) => s + x, 0) / during.length;
    expect(mean).toBeLessThan(25);
    expect(Math.max(...during)).toBeLessThan(60);
    for (let cycle = 1; cycle < 4; cycle++) for (let i = 26; i < 34; i++) expect(centsAt(p, cycle * 48 + i)).toBeLessThan(5);
  });

  it('a pitch that moves to another note with no glide and no new gate is a tie (3 00), on the note it moves to', () => {
    // 48 frames: C-4 for 23 frames, then G-4 under the same gate, released for the last 12.
    const legato: VoiceFrame[] = Array.from({ length: 48 }, (_, i) => ({ freq: i < 23 ? C4 : G4, ctrl: i < 36 ? 0x41 : 0x40, pw: 0x800 }));
    const r = imported(tableTune('Legato', legato));
    const rows = cells(r.doc);
    const ties = rows.filter((x) => x.command === 3 && x.param === 0 && x.note !== 0);
    expect(ties.length).toBeGreaterThan(0);
    expect(ties.every((x) => x.note === 56 && x.instrument === 0)).toBe(true);
    // One instrument plays voice 1's notes: the tie is no note of its own.
    expect(new Set(rows.filter((x) => x.instrument > 0).map((x) => x.instrument)).size).toBe(1);
    const p = played(r);
    for (let cycle = 1; cycle < 4; cycle++) {
      for (let i = 2; i < 22; i++) expect(centsAt(p, cycle * 48 + i)).toBeLessThan(5);
      for (let i = 25; i < 36; i++) expect(centsAt(p, cycle * 48 + i)).toBeLessThan(5);
    }
  });

  it('a note let go after the frames an instrument describes still gets its key-off', () => {
    // 120 frames: C-4 held 80 frames (past the 48 the instrument's tables play), then released.
    const long: VoiceFrame[] = Array.from({ length: 120 }, (_, i) => ({ freq: C4, ctrl: i < 80 ? 0x21 : 0x20 }));
    const r = imported(tableTune('Long note', long));
    expect(cells(r.doc).some((x) => x.note === SID_NOTE_KEY_OFF)).toBe(true);
    const p = played(r);
    const off = (f: TraceFrames, from: number): number => {
      for (let i = from; i < f.frames; i++) if (!(f.voices[0]!.ctrl[i]! & 1)) return i;
      return -1;
    };
    // The export lets go within two frames of the original.
    expect(Math.abs(off(p.b, 120 + 5 + p.offset) - p.offset - off(p.a, 120 + 5))).toBeLessThanOrEqual(2);
  });
});

describe('the pulse table', () => {
  it('a width that sweeps up and down for as long as the note sounds loops in the table and follows the original', () => {
    // 144 frames: one long pulse note whose width climbs $40 a frame for 16 frames and falls back for 16, over and over.
    const tri = (i: number): number => {
      const t = i % 32;
      return 0x400 + 0x40 * (t < 16 ? t : 32 - t);
    };
    const sweep: VoiceFrame[] = Array.from({ length: 144 }, (_, i) => ({ freq: C4, ctrl: i < 132 ? 0x41 : 0x40, pw: tri(i) }));
    const r = imported(tableTune('Pulse sweep', sweep));
    const pulse = r.doc.tables.pulse;
    // A jump back into the program (a loop), not a stop.
    expect(pulse.some((row) => row.left === 0xff && row.right !== 0)).toBe(true);
    // GoatTracker holds the width on one frame of every row (the gate timer's), so the export
    // runs up to a step behind inside a row: within $60 of the original.
    const p = played(r);
    let near = 0;
    let n = 0;
    for (let i = 144 + 4; i < 144 + 128; i++) {
      n++;
      if (Math.abs((p.a.voices[0]!.pw[i]! & 0xfff) - (p.b.voices[0]!.pw[i + p.offset]! & 0xfff)) <= 0x60) near++;
    }
    expect(near / n).toBeGreaterThan(0.85);
  });
});
