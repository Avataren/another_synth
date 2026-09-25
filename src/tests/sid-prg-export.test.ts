import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createNewSidDoc,
  gtSongHintsFromName,
  importGtSong,
  setSidRow,
  setSidSongTexts,
  type SidDoc,
  type SidOpResult,
} from 'src/audio/tracker/sid-doc';
import {
  basicSysStub,
  c64ScreenCodes,
  exportBin,
  exportPrg,
  exportSid,
  PRG_SHELL_ADDRESS,
  SID_EXPORT_DEFAULTS,
  type SidExport,
} from 'src/audio/tracker/sid-export';
import { PAL_FRAME_CYCLES, readSysLine, runPrg, screenText } from './helpers/c64-boot';
import { runPsid } from './helpers/cpu6502';

/**
 * plan-sid-authoring.md phase 5: the plain `.prg` (BASIC line, shell,
 * GoatTracker's player and the song) and the raw `.bin`. The `.prg` is RUN
 * on the test 6502 as a C64 (`helpers/c64-boot.ts`) and must write the SID
 * registers the `.sid` of the same song writes, play call for play call.
 * The corpus-wide gate is `.ai/sid-oracle/prg_play_gate.ts`.
 */

const SONGS = resolve(__dirname, 'fixtures/gt-songs');
const docOf = (name: string): SidDoc => {
  const r = importGtSong(new Uint8Array(readFileSync(resolve(SONGS, name))), gtSongHintsFromName(name));
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};
const ok = (r: SidOpResult): SidDoc => {
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};
const exported = (r: SidExport): Extract<SidExport, { ok: true }> => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const STREETS = 'aeuk/metal_warrior_4_streets.sng'; // 1x, 3 subsongs
const REMIX_2X = 'cadaver/mw_title_remix_2x_speed.sng';

describe('the .prg bytes', () => {
  it('starts with the load address $0801 and the BASIC line 10 SYS 2061', () => {
    expect(basicSysStub(2061)).toEqual([0x0b, 0x08, 0x0a, 0x00, 0x9e, 0x32, 0x30, 0x36, 0x31, 0x00, 0x00, 0x00]);
    expect(PRG_SHELL_ADDRESS).toBe(2061);
    const prg = exported(exportPrg(docOf(STREETS))).bytes;
    expect(Array.from(prg.subarray(0, 14))).toEqual([0x01, 0x08, ...basicSysStub(2061)]);
    const mem = new Uint8Array(0x10000);
    mem.set(prg.subarray(2), 0x0801);
    expect(readSysLine(mem)).toBe(2061);
  });

  it('opens the shell with interrupts off, BASIC banked out and CIA 1 interrupts off', () => {
    const prg = exported(exportPrg(docOf(STREETS))).bytes;
    const at = 2 + PRG_SHELL_ADDRESS - 0x0801;
    // sei / lda #$36 / sta $01 / lda #$7f / sta $dc0d / lda $dc0d
    expect(Array.from(prg.subarray(at, at + 14))).toEqual([
      0x78, 0xa9, 0x36, 0x85, 0x01, 0xa9, 0x7f, 0x8d, 0x0d, 0xdc, 0xad, 0x0d, 0xdc, 0xa9,
    ]);
  });

  it('holds at $1000 the same player and song as the .sid and the .bin, zeros before it', () => {
    for (const name of [STREETS, REMIX_2X]) {
      const doc = docOf(name);
      const prg = exported(exportPrg(doc));
      const bin = exported(exportBin(doc));
      const sid = exported(exportSid(doc));
      expect(prg.address).toBe(0x1000);
      expect(bin.address).toBe(0x1000);
      expect(prg.bytes.subarray(2 + 0x1000 - 0x0801)).toEqual(bin.bytes);
      // The .sid: header, load address, (at 2x) the 10-byte CIA stub, then the same bytes.
      expect(sid.bytes.subarray(sid.bytes.length - bin.bytes.length)).toEqual(bin.bytes);
      expect(prg.notes).toEqual(sid.notes);
      expect(bin.notes).toEqual(sid.notes);
      const shellEnd = prg.bytes.subarray(2, 2 + 0x1000 - 0x0801).findLastIndex((b) => b !== 0) + 0x0801;
      expect(shellEnd).toBeLessThan(0x0c00);
    }
  });

  it('writes the .bin with no header: GoatTracker jump table first', () => {
    const bin = exported(exportBin(docOf(STREETS))).bytes;
    expect(bin[0]).toBe(0x4c); // jmp mt_init
    expect(bin[3]).toBe(0x4c); // jmp mt_play
  });
});

describe('the .prg RUN on a 6502', () => {
  it('plays a 1x song from a raster interrupt, once per frame, as the .sid plays it', () => {
    const doc = docOf(STREETS);
    const prg = exported(exportPrg(doc));
    const run = runPrg(prg.bytes, { plays: 500, player: prg.address });
    expect(run.sys).toBe(2061);
    expect([run.source, run.period]).toEqual(['raster', PAL_FRAME_CYCLES]);
    expect(run.inits).toEqual([{ subsong: 0, atPlay: 0 }]);
    expect(run.regs).toEqual(runPsid(exported(exportSid(doc)).bytes, 0, 500).regs);
    expect(run.maxHandlerCycles).toBeLessThan(run.period / 4);
    const mem = run.cpu.mem;
    expect(mem[0x01]).toBe(0x36);
    expect(mem[0xdc0d]).toBe(0x7f);
    expect(mem[0xd011]! & 0x80).toBe(0);
    expect(mem[0xd012]).toBe(0x80);
  });

  it('plays a 2x song from CIA 1 at the latch its .sid sets, every play call as the .sid', () => {
    const doc = docOf(REMIX_2X);
    const prg = exported(exportPrg(doc));
    const sid = exported(exportSid(doc)).bytes;
    const run = runPrg(prg.bytes, { plays: 600, player: prg.address });
    const { regs, ciaLatch } = runPsid(sid, 0, 600);
    expect(run.source).toBe('cia');
    expect(run.period).toBe(ciaLatch + 1);
    expect(ciaLatch).toBe(Math.trunc(0x4cc7 / 2));
    expect(run.cpu.mem[0xd01a]! & 1).toBe(0);
    expect(run.regs).toEqual(regs);
  });

  it('plays a new song at 16x within the interrupt period', () => {
    const C4 = 49;
    const doc = ok(setSidRow(createNewSidDoc({ speedMultiplier: 16 }), 0, 0, { note: C4, instrument: 1, command: 0, param: 0 }));
    const prg = exported(exportPrg(doc));
    const run = runPrg(prg.bytes, { plays: 400, player: prg.address });
    expect(run.period).toBe(Math.trunc(0x4cc7 / 16) + 1);
    expect(run.maxHandlerCycles).toBeLessThan(run.period);
    expect(run.regs).toEqual(runPsid(exported(exportSid(doc)).bytes, 0, 400).regs);
  });

  it('starts subsong 3 on the key 3 as the .sid starts it, however long subsong 1 played', () => {
    const doc = docOf(STREETS);
    const prg = exported(exportPrg(doc));
    const ref = runPsid(exported(exportSid(doc)).bytes, 2, 300).regs;
    for (const afterPlays of [0, 50]) {
      const run = runPrg(prg.bytes, { plays: 300, player: prg.address, keys: [{ key: 0x33, afterPlays }] });
      expect(run.inits.map((i) => i.subsong)).toEqual([0, 2]);
      expect(run.inits[1]!.atPlay).toBeGreaterThanOrEqual(afterPlays);
      // GoatTracker's init alone would leave voice 1's frequency of subsong 1 there; the
      // shell copies the player back as loaded first (c64-prg.ts).
      expect(run.regs).toEqual(ref);
      expect(screenText(run.cpu.mem)[10]).toContain('Playing subsong 3 of 3');
    }
  });

  it('keeps the loaded player in the page after the tune and copies it back on a subsong start', () => {
    const prg = exported(exportPrg(docOf(STREETS)));
    const bin = exported(exportBin(docOf(STREETS))).bytes;
    const backup = Math.ceil((0x1000 + bin.length) / 256) * 256;
    const run = runPrg(prg.bytes, { plays: 60, player: prg.address, keys: [{ key: 0x32, afterPlays: 30 }] });
    // The backup holds the loaded bytes, not the playing player's.
    expect(run.cpu.mem.subarray(backup, backup + 0x100)).toEqual(bin.subarray(0, 0x100));
    expect(run.cpu.mem.subarray(0x1000, 0x1100)).not.toEqual(bin.subarray(0, 0x100));
  });

  it('ignores keys past the last subsong, and other keys', () => {
    const prg = exported(exportPrg(docOf(STREETS)));
    const run = runPrg(prg.bytes, {
      plays: 100,
      player: prg.address,
      keys: [
        { key: 0x34, afterPlays: 5 },
        { key: 0x30, afterPlays: 6 },
        { key: 0x41, afterPlays: 7 },
      ],
    });
    expect(run.inits.map((i) => i.subsong)).toEqual([0]);
  });

  it('shows the texts, centred, in the lower/upper case set', () => {
    const doc = ok(setSidSongTexts(docOf(STREETS), { songName: 'Streets_Remix', author: 'Aeuk & Cadaver' }));
    const prg = exported(exportPrg(doc));
    expect(prg.textAltered).toBe(false);
    const run = runPrg(prg.bytes, { plays: 1, player: prg.address });
    const lines = screenText(run.cpu.mem);
    expect(lines[3]).toBe(`${' '.repeat(13)}Streets_Remix`);
    expect(lines[5]!.trim()).toBe('Aeuk & Cadaver');
    expect(lines[6]!.trim()).toBe(doc.copyright);
    expect(lines[10]!.trim()).toBe('Playing subsong 1 of 3');
    expect(lines[12]!.trim()).toBe('Press 1-3 for another subsong');
    expect(lines[22]!.trim()).toBe('made with another_synth');
    expect(run.cpu.mem[0xd018]).toBe(0x17);
  });

  it('has no subsong lines for a one-subsong song', () => {
    const prg = exported(exportPrg(docOf(REMIX_2X)));
    const lines = screenText(runPrg(prg.bytes, { plays: 1, player: prg.address }).cpu.mem);
    expect(lines[10]!.trim()).toBe('Playing');
    expect(lines[12]).toBe('');
  });
});

describe('c64ScreenCodes', () => {
  it('maps to the lower/upper case set, accents stripped, the rest to ?', () => {
    expect(c64ScreenCodes('aZ0 @[]_')).toEqual({ codes: [1, 0x5a, 0x30, 0x20, 0, 0x1b, 0x1d, 0x64], altered: false });
    expect(c64ScreenCodes('Ünï')).toEqual({ codes: [0x55, 14, 9], altered: true });
    expect(c64ScreenCodes('a{b')).toEqual({ codes: [1, 0x3f, 2], altered: true });
  });

  it('says when the screen shows the texts differently', () => {
    const doc = ok(setSidSongTexts(docOf(STREETS), { author: 'Björk' }));
    expect(exported(exportPrg(doc)).textAltered).toBe(true);
  });
});

describe('.prg and .bin refusals', () => {
  it('refuses a player address that the shell runs into, with the addresses', () => {
    const r = exportPrg(docOf(STREETS), { ...SID_EXPORT_DEFAULTS, playerAddress: 0x0900 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^the program's start-up code runs from \$0801 to \$0[9A-F][0-9A-F]{2}, past the player at \$0900$/);
  });

  it("refuses what the .sid refuses, with the .sid's reason", () => {
    const doc = docOf(STREETS);
    const at = { ...SID_EXPORT_DEFAULTS, playerAddress: 0xcf00 };
    const sid = exportSid(doc, at);
    expect(sid.ok).toBe(false);
    expect(exportPrg(doc, at)).toEqual(sid);
    expect(exportBin(doc, at)).toEqual(sid);
  });
});
