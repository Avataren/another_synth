import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gtSongHintsFromName, importGtSong, type SidDoc } from 'src/audio/tracker/sid-doc';
import {
  assemble6502,
  exportSid,
  GT_PACK_DEFAULTS,
  GT_PLAYER_SOURCE,
  gtPackSource,
  parseAsmTree,
  psidBytes,
  SID_EXPORT_DEFAULTS,
  type GtPackOptions,
} from 'src/audio/tracker/sid-export';
import { importPsid, parsePsid, unpackGtSid, type PsidFile } from 'src/audio/tracker/psid';
import { matchPlayer } from 'src/audio/tracker/psid/gt-unpack/player-match';
import { importPsidToTrackerSong } from 'src/audio/tracker/psid-import';

/**
 * plan-psid-import.md phase 4: a `.sid` GoatTracker made is unpacked into the
 * song it was packed from. The player's build is read off its code
 * (`player-match.ts`) and must be the build the assembler made; the song
 * then unpacked must pack to the file's bytes again, for every song of the
 * GoatTracker corpus in both builds the export dialog makes, and for files
 * GoatTracker 2.77 wrote itself; and it must play the same notes, with the
 * same instruments, as the song that was packed.
 */

const SONGS = resolve(__dirname, 'fixtures/gt-songs');
const SIDS = resolve(__dirname, 'fixtures/gt-sids');
const corpus: readonly string[] = readdirSync(SONGS)
  .filter((d) => !d.includes('.'))
  .flatMap((d) => readdirSync(join(SONGS, d)).filter((f) => f.endsWith('.sng')).map((f) => `${d}/${f}`));
const songDoc = (name: string): SidDoc => {
  const r = importGtSong(new Uint8Array(readFileSync(join(SONGS, name))), gtSongHintsFromName(name));
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};
const psidOf = (bytes: Uint8Array): PsidFile => {
  const r = parsePsid(bytes);
  if (!r.ok) throw new Error(r.reason);
  return r.file;
};
const exported = (doc: SidDoc, options: GtPackOptions): Uint8Array => {
  const e = exportSid(doc, options);
  if (!e.ok) throw new Error(e.reason);
  return e.bytes;
};
const BUILDS: readonly (readonly [string, GtPackOptions])[] = [
  ['optimized', GT_PACK_DEFAULTS],
  ['every feature', SID_EXPORT_DEFAULTS],
];

/**
 * What a song plays, voice by voice, in the order its orderlists play it (the
 * first pass): per row the note (transposed), the instrument's sound (its
 * envelope, first wave, gate timer and group) and the command. Table
 * pointers are left out (the packer renumbers the tables), F02 reads as F03
 * (both are 3 ticks a row) and a D command's timing mark (above $0F, which
 * the packer erases) as no command.
 */
function played(doc: SidDoc): string[] {
  const out: string[] = [];
  for (const subsong of doc.subsongs) {
    for (const list of subsong.orderlists) {
      let instrument = 0;
      const voice: string[] = [];
      for (const entry of list.entries) {
        const pattern = doc.patterns[entry.pattern]!;
        for (let rep = 0; rep < entry.repeat; rep++) {
          for (const row of pattern.rows) {
            if (row.instrument) instrument = row.instrument;
            const ins = doc.instruments[instrument - 1];
            const sound = ins === undefined ? '-' : `${ins.attack}${ins.decay}${ins.sustain}${ins.release}/${ins.firstWave}/${ins.gateTimer}/${ins.hardRestart}/${ins.noGateOff}`;
            const note = row.note >= 1 && row.note <= 93 ? row.note + entry.transpose : row.note;
            let command = row.command;
            let param = row.param;
            if ([0x1, 0x2, 0x3, 0x4, 0x8, 0x9, 0xa, 0xe].includes(command)) param = -1;
            if (command === 0xf && (param & 0x7f) === 2) param += 1;
            if (command === 0xd && param > 0x0f) [command, param] = [0, 0];
            voice.push(`${note}:${row.note >= 1 && row.note <= 93 ? sound : ''}:${command}:${param}`);
          }
        }
      }
      out.push(voice.join(' '));
    }
  }
  return out;
}

describe('matchPlayer: the build a player is, from its code', () => {
  const tree = parseAsmTree(GT_PLAYER_SOURCE);
  if (!tree.ok) throw new Error(tree.reason);

  it.each(corpus.slice(0, 24))('%s: every define and song-data address the code shows is the assembler\'s', (name) => {
    const doc = songDoc(name);
    for (const [, options] of BUILDS) {
      const source = gtPackSource(doc, GT_PLAYER_SOURCE, options);
      if (!source.ok) throw new Error(source.reason);
      const asm = assemble6502(source.source);
      if (!asm.ok) throw new Error(asm.reason);
      const defines = new Map(
        source.source
          .split('\n')
          .map((l) => /^([A-Za-z][A-Za-z0-9]*) *= (\d+)$/.exec(l))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => [m[1]!, Number(m[2])] as const),
      );
      const mem = (a: number): number | undefined => (a >= asm.origin && a < asm.origin + asm.bytes.length ? asm.bytes[a - asm.origin] : undefined);
      const m = matchPlayer(tree.stmts, mem, new Map([['base', asm.origin]]), 'mt_freqtbllo');
      expect(m).not.toBeNull();
      expect(m!.end).toBe(asm.symbols.get('mt_freqtbllo'));
      for (const [k, v] of m!.symbols) {
        if (defines.has(k)) expect([k, v]).toEqual([k, defines.get(k)]);
        else if (asm.symbols.has(k)) expect([k, v]).toEqual([k, asm.symbols.get(k)]);
      }
      // The ones the unpacker reads, always shown.
      for (const k of ['FIRSTNOTE', 'mt_freqtblhi', 'mt_songtbllo', 'mt_patttbllo', 'mt_insad', 'mt_inssr', 'mt_wavetbl', 'mt_notetbl']) {
        expect(m!.symbols.get(k), k).toBe(defines.get(k) ?? asm.symbols.get(k));
      }
    }
  });

  it("does not take another player's code: Commando's is Rob Hubbard's", () => {
    const file = psidOf(new Uint8Array(readFileSync(resolve(__dirname, 'fixtures/psid/hubbard_rob/commando.sid'))));
    const mem = (a: number): number | undefined => file.data[a - file.loadAddress];
    expect(matchPlayer(tree.stmts, mem, new Map([['base', 0x5000]]), 'mt_freqtbllo')).toBeNull();
    expect(unpackGtSid(file)).toMatchObject({ ok: false });
  });
});

describe('unpackGtSid: the GoatTracker corpus, exported and unpacked', () => {
  it(`all ${corpus.length} songs, in both builds, pack again to the same bytes and play the same notes`, () => {
    const misses: string[] = [];
    for (const name of corpus) {
      const doc = songDoc(name);
      for (const [build, options] of BUILDS) {
        const bytes = exported(doc, options);
        const u = unpackGtSid(psidOf(bytes));
        if (!u.ok) {
          misses.push(`${name} (${build}): ${u.reason}`);
          continue;
        }
        if (!u.exact) misses.push(`${name} (${build}): not the same bytes`);
        if (JSON.stringify(played(u.doc)) !== JSON.stringify(played(doc))) misses.push(`${name} (${build}): plays other notes`);
        expect([u.doc.chipModel, u.doc.speedMultiplier, u.doc.songName]).toEqual([doc.chipModel, doc.speedMultiplier, doc.songName.slice(0, 32)]);
      }
    }
    expect(misses).toEqual([]);
  }, 120_000);
});

/** `doc` packed as GoatTracker's relocator does with options this app's export has not (buffered SID writes, sound effects, volume, author info). */
function variantBuild(doc: SidDoc, defines: Readonly<Record<string, number>>, options: GtPackOptions): Uint8Array {
  const source = gtPackSource(doc, GT_PLAYER_SOURCE, options);
  if (!source.ok) throw new Error(source.reason);
  let text = source.source;
  for (const [k, v] of Object.entries(defines)) text = text.replace(new RegExp(`^${k} *= \\d+$`, 'm'), `${k.padEnd(16)} = ${v}`);
  const asm = assemble6502(text);
  if (!asm.ok) throw new Error(asm.reason);
  const code = asm.bytes.slice();
  // The relocator writes the author info into the assembled player.
  const author = asm.symbols.get('mt_author');
  if (author !== undefined) code.set([...'An author info text, 32 bytes...'].map((c) => c.charCodeAt(0)), author - asm.origin);
  return psidBytes({ name: doc.songName, author: doc.author, released: '', songs: source.songs, chipModel: doc.chipModel, speedMultiplier: doc.speedMultiplier, address: asm.origin, code });
}

describe('unpackGtSid: builds with the relocator options this app does not use', () => {
  const variants: readonly (readonly [string, Readonly<Record<string, number>>])[] = [
    ['buffered SID writes', { BUFFEREDWRITES: 1 }],
    ['sound effect support', { BUFFEREDWRITES: 1, SOUNDSUPPORT: 1 }],
    ['volume support', { VOLSUPPORT: 1 }],
    ['author info', { NOAUTHORINFO: 0 }],
  ];
  it.each(['mch/alien_funk.sng', 'cadaver/dojo.sng', 'stinsen/double_rainbow_2x.sng'])('%s: each unpacks to the notes packed', (name) => {
    const doc = songDoc(name);
    for (const [label, defines] of variants) {
      for (const [, options] of BUILDS) {
        const u = unpackGtSid(psidOf(variantBuild(doc, defines, options)));
        if (!u.ok) throw new Error(`${label}: ${u.reason}`);
        // Not our export's bytes (it has none of these options), but the same song.
        expect(u.exact, label).toBe(false);
        expect(played(u.doc), label).toEqual(played(doc));
      }
    }
  });

  it('importPsid keeps such an unpack when it plays like the file', () => {
    const r = importPsid(variantBuild(songDoc('cadaver/dojo.sng'), { BUFFEREDWRITES: 1 }, GT_PACK_DEFAULTS));
    if (!r.ok) throw new Error(r.reason);
    expect(r.method).toBe('unpacked');
    expect(r.exact).toBe(false);
    expect(r.fidelity!.score).toBeGreaterThanOrEqual(0.98);
  }, 60_000);
});

describe("unpackGtSid: files GoatTracker 2.77's relocator wrote", () => {
  it.each([
    ['alien_funk.sid', 'mch/alien_funk.sng'],
    ['alien_funk.opt.sid', 'mch/alien_funk.sng'],
    ['mw_title_remix_2x_speed.sid', 'cadaver/mw_title_remix_2x_speed.sng'],
    ['sniff.8580.sid', 'stinsen/sniff.sng'],
  ])('%s: exact, and the notes of %s', (sid, sng) => {
    const u = unpackGtSid(psidOf(new Uint8Array(readFileSync(join(SIDS, sid)))));
    if (!u.ok) throw new Error(u.reason);
    expect(u.exact).toBe(true);
    const original = songDoc(sng);
    // The file holds the subsongs the relocator packed (those with every voice playing).
    expect(played(u.doc)).toEqual(played({ ...original, subsongs: original.subsongs.slice(0, u.doc.subsongs.length) }));
  });
});

describe('importPsid: a GoatTracker file is unpacked, any other transcribed', () => {
  it('a GoatTracker export imports as its song, exactly, and the app says so', () => {
    const bytes = exported(songDoc('cadaver/dojo.sng'), GT_PACK_DEFAULTS);
    const r = importPsid(bytes);
    if (!r.ok) throw new Error(r.reason);
    expect(r.method).toBe('unpacked');
    expect(r.exact).toBe(true);
    expect(r.reports).toEqual([]);
    const song = importPsidToTrackerSong(bytes.slice().buffer, 'dojo.sid');
    expect(song.summary).toMatch(/^Dojo by Cadaver: a GoatTracker song, unpacked from the file exactly \(4 of 4 subsongs\)\.$/);
  });

  it("a GoatTracker file of another player version (ChiptuneSAK's vibratotest.sid) is transcribed", () => {
    const r = importPsid(new Uint8Array(readFileSync(resolve(__dirname, 'fixtures/psid/chiptunesak/vibratotest.sid'))));
    if (!r.ok) throw new Error(r.reason);
    expect(r.method).toBe('transcribed');
  }, 60_000);
});
