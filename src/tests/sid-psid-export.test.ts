import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sidTableFreqReg } from '@another-synth/tracker-playback';
import {
  createNewSidDoc,
  gtSongHintsFromName,
  importGtSong,
  setSidChipModel,
  setSidRow,
  type SidDoc,
  type SidOpResult,
} from 'src/audio/tracker/sid-doc';
import {
  exportSid,
  GT_PACK_DEFAULTS,
  PSID_HEADER_LENGTH,
  psidBytes,
  SID_EXPORT_DEFAULTS,
  type SidExport,
} from 'src/audio/tracker/sid-export';
import { readPsidHeader, runPsid } from './helpers/cpu6502';

/**
 * plan-sid-authoring.md phase 4: `.sid` export. The bytes are GoatTracker
 * 2.77's own (`gt2reloc`, fixtures/gt-sids/README.md); the file plays on a
 * 6502; the refusals are GoatTracker's packer's; the warnings name where
 * GoatTracker's C64 player and its editor (this app) part. The corpus-wide
 * gates are `.ai/sid-oracle/psid_gate.ts` and `psid_play_gate.ts`.
 */

const SONGS = resolve(__dirname, 'fixtures/gt-songs');
const SIDS = resolve(__dirname, 'fixtures/gt-sids');
const docOf = (name: string): SidDoc => {
  const r = importGtSong(new Uint8Array(readFileSync(resolve(SONGS, name))), gtSongHintsFromName(name));
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};
const gtSid = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(SIDS, name)));
const ok = (r: SidOpResult): SidDoc => {
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};
const exported = (r: SidExport): Extract<SidExport, { ok: true }> => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe('exportSid: the same bytes as GoatTracker', () => {
  it("writes GoatTracker's 'disable optimization' build by default, byte for byte", () => {
    expect(SID_EXPORT_DEFAULTS.optimize).toBe(false);
    expect(exported(exportSid(docOf('mch/alien_funk.sng'))).bytes).toEqual(gtSid('alien_funk.sid'));
  });

  it("writes GoatTracker's default (optimized) build byte for byte", () => {
    expect(exported(exportSid(docOf('mch/alien_funk.sng'), GT_PACK_DEFAULTS)).bytes).toEqual(gtSid('alien_funk.opt.sid'));
  });

  it('writes a 2x song with the CIA timer stub in front of the player', () => {
    const out = exported(exportSid(docOf('cadaver/mw_title_remix_2x_speed.sng')));
    expect(out.bytes).toEqual(gtSid('mw_title_remix_2x_speed.sid'));
    const h = readPsidHeader(out.bytes);
    // Load (from the data), init: 10 bytes before the player; play: its jmp mt_play.
    expect([h.load, h.init, h.play, h.speed]).toEqual([0x0ff6, 0x0ff6, 0x1003, 0xffffffff]);
  });

  it('writes the 8580 model flag', () => {
    const doc = ok(setSidChipModel(docOf('stinsen/sniff.sng'), '8580'));
    expect(exported(exportSid(doc)).bytes).toEqual(gtSid('sniff.8580.sid'));
  });
});

describe('psidBytes: the PSID v2 header', () => {
  it('lays out a 1x 6581 file as GoatTracker does', () => {
    const b = psidBytes({
      name: 'Tune',
      author: 'Me',
      released: '2026',
      songs: 3,
      chipModel: '6581',
      speedMultiplier: 1,
      address: 0x1000,
      code: Uint8Array.of(0x4c, 0x00, 0x10),
    });
    expect(b.length).toBe(PSID_HEADER_LENGTH + 2 + 3);
    expect(readPsidHeader(b)).toEqual({
      version: 2,
      dataOffset: 0x7c,
      load: 0x1000,
      init: 0x1000,
      play: 0x1003,
      songs: 3,
      startSong: 1,
      speed: 0,
      name: 'Tune',
      author: 'Me',
      released: '2026',
      flags: 0x0014,
    });
    // Load address 0 in the header: the data's first two bytes are the load address.
    expect(Array.from(b.subarray(8, 10))).toEqual([0, 0]);
    expect(Array.from(b.subarray(0x7c))).toEqual([0x00, 0x10, 0x4c, 0x00, 0x10]);
  });

  it('puts a CIA stub at 4x (latch $4CC7 / 4) and marks every song CIA-timed; 8580 flag', () => {
    const b = psidBytes({
      name: '',
      author: '',
      released: '',
      songs: 1,
      chipModel: '8580',
      speedMultiplier: 4,
      address: 0x1000,
      code: Uint8Array.of(0x60),
    });
    const h = readPsidHeader(b);
    expect([h.init, h.play, h.speed, h.flags]).toEqual([0x0ff6, 0x1003, 0xffffffff, 0x0024]);
    const latch = Math.trunc(0x4cc7 / 4);
    expect(Array.from(b.subarray(0x7c))).toEqual([
      0xf6, 0x0f, 0xa2, latch & 0xff, 0x8e, 0x04, 0xdc, 0xa2, latch >> 8, 0x8e, 0x05, 0xdc, 0x60,
    ]);
  });
});

describe('an exported .sid on a 6502', () => {
  it('plays a new song: the note typed on row 0 reaches voice 1 with its table frequency', () => {
    const C4 = 49; // C-4: note index 48
    const doc = ok(setSidRow(createNewSidDoc(), 0, 0, { note: C4, instrument: 1, command: 0, param: 0 }));
    const { regs } = runPsid(exported(exportSid(doc)).bytes, 0, 20);
    const freq = regs.map((r) => r[0]! | (r[1]! << 8));
    expect(freq).toContain(sidTableFreqReg(C4 - 1));
    // The gate opens (the new instrument's wave table sets $41, pulse + gate).
    expect(regs.some((r) => r[4] === 0x41)).toBe(true);
  });

  it('sets the CIA latch a 2x song asks for in init', () => {
    const { ciaLatch } = runPsid(exported(exportSid(docOf('cadaver/mw_title_remix_2x_speed.sng'))).bytes, 0, 1);
    expect(ciaLatch).toBe(Math.trunc(0x4cc7 / 2));
  });
});

describe("exportSid: GoatTracker's packer's refusals", () => {
  const base = createNewSidDoc();
  const withTables = (tables: Partial<SidDoc['tables']>, instrument: Partial<SidDoc['instruments'][number]> = {}): SidDoc => ({
    ...base,
    tables: { ...base.tables, ...tables },
    instruments: [{ ...base.instruments[0]!, ...instrument }],
  });
  const refusal = (doc: SidDoc, options = SID_EXPORT_DEFAULTS): string => {
    const r = exportSid(doc, options);
    if (r.ok) throw new Error('exported');
    return r.reason;
  };

  it.each([0xf0, 0xf8, 0xfe])('refuses wave-table command $%s where the song reaches it', (left) => {
    const wave = [{ left, right: 0 }, ...base.tables.wave.slice(1)];
    expect(refusal(withTables({ wave }))).toBe(
      `wave table row 1 has command $${left.toString(16).toUpperCase()}, which GoatTracker's packer refuses in a wave table (only its editor plays it)`,
    );
  });

  it('refuses a table that runs past row 255', () => {
    expect(refusal(withTables({ pulse: [{ left: 0x88, right: 0x00 }] }))).toBe(
      "a table runs past its last row, 255, without a jump (instrument 1's pulse table); GoatTracker's packer refuses that",
    );
  });

  it('refuses a pointer that lands on a jump row', () => {
    const pulse = [{ left: 0xff, right: 0 }, ...base.tables.pulse];
    expect(refusal(withTables({ pulse }, { pulsePtr: 1 }))).toBe(
      "a table pointer lands on a jump row (instrument 1's pulse table); GoatTracker's packer refuses that",
    );
  });

  it('refuses a player that would run into the I/O area', () => {
    expect(refusal(base, { ...SID_EXPORT_DEFAULTS, playerAddress: 0xcf00 })).toMatch(
      /^the player and song take \d+ bytes from \$CF00 and run to \$D[0-9A-F]{3}, into the C64's I\/O area at \$D000$/,
    );
  });
});

describe('exportSid: where the C64 player and the app part', () => {
  it('says nothing for a song where they agree', () => {
    expect(exported(exportSid(docOf('mch/alien_funk.sng'))).notes).toEqual([]);
  });

  it('warns about a pulse row with modulation time 0', () => {
    expect(exported(exportSid(docOf('stinsen/sniff.sng'))).notes).toEqual([
      'pulse table row 58 has a modulation time of 0: here the app (like GoatTracker\'s editor) holds the pulse, but the C64 player sweeps it for 256 frames',
    ]);
  });

  it('warns about a pulse jump onto a jump row', () => {
    expect(exported(exportSid(docOf('cadaver/maximum_rastertime_test.sng'))).notes).toEqual([
      "pulse table row 2 jumps onto another jump row; the C64 player's copy of the table is renumbered and shortened, so what that row sets, and the row after it, can differ from the app",
    ]);
  });

  it('warns about notes past the top of the note table', () => {
    expect(exported(exportSid(docOf('stinsen/arpling.sng'))).notes).toEqual([
      "wave table row 8 takes some notes past the top of GoatTracker's note table: there the app plays no pitch, but the C64 player reads other bytes of the file as the pitch",
    ]);
  });
});
