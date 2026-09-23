// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAhx, type AhxInstrument } from '@another-synth/tracker-playback';
import { serializeAhx } from 'src/audio/tracker/song-export';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import {
  ahxInstrumentBytes,
  ahxSizeBudget,
  ahxUsedBytes,
  buildAhxFile,
  docChannels,
  docFromBytes,
  docFromSong,
  docToSong,
  fileInstruments,
  makeUnique,
  projectAhxPatterns,
  projectDisplayPatterns,
  projectTracks,
  setStep,
  setTranspose,
  type AhxDoc,
  type AhxDocStep,
  type HvlDoc,
} from 'src/audio/tracker/ahx-doc';

/**
 * HVL docs over the whole HVL corpus (plan-hvl-editing.md P1): the doc model
 * holds everything the parse does, and doc -> serialize -> parse is the parse
 * again. The `base` path is byte-exact, as in `ahx-writer-corpus.test.ts`,
 * with the same one exception (`meltwater_10ch.hvl`: the source omits its last
 * empty instrument name's NUL, so the output is the source plus that byte).
 */
const DEMOS = resolve(__dirname, '../../public/demos/ahx');
const corpus = readdirSync(DEMOS)
  .filter((name) => name.endsWith('.hvl'))
  .sort()
  .map((name) => ({ name, bytes: new Uint8Array(readFileSync(resolve(DEMOS, name))) }));

/** See `ahx-writer-corpus.test.ts`'s `TRAILING_NAME_NUL`. */
const TRAILING_NAME_NUL = ['meltwater_10ch.hvl'];

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const nameOffsetOf = (bytes: Uint8Array): number => ((bytes[4] ?? 0) << 8) | (bytes[5] ?? 0);
const hvlDoc = (bytes: Uint8Array): HvlDoc => {
  const doc = docFromBytes(bytes);
  if (doc.format !== 'hvl') throw new Error('not an HVL doc');
  return doc;
};
/** The written file is the source (or, for the pinned file, the source plus one NUL). */
function expectSource(name: string, out: Uint8Array, bytes: Uint8Array): void {
  if (TRAILING_NAME_NUL.includes(name)) {
    expect(out.length, `${name}: source + one trailing NUL`).toBe(bytes.length + 1);
    expect(sameBytes(out.subarray(0, bytes.length), bytes), name).toBe(true);
    expect(out[out.length - 1], `${name}: trailing NUL`).toBe(0);
  } else {
    expect(sameBytes(out, bytes), name).toBe(true);
  }
}
/** The doc as if made without its source bytes (the writer then guesses the blank-first-track flag). */
const withoutBase = (doc: HvlDoc): HvlDoc => docFromSong(docToSong(doc, [])) as HvlDoc;
/** A pattern without its id (the import's are random, the projection's stable). */
const withoutId = <T extends { id: string }>({ id: _id, ...rest }: T): Omit<T, 'id'> => rest;

describe('HVL docs over the corpus', () => {
  it('reads the 22 HVL files', () => {
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 22 .hvl files, 2026-09-23)
    expect(corpus.length).toBe(22);
  });

  it('every file gets an HVL doc with its header fields: format, channels, mix gain, default stereo', () => {
    for (const { name, bytes } of corpus) {
      const song = parseAhx(bytes);
      const doc = hvlDoc(bytes);
      expect(doc.format, name).toBe('hvl');
      expect(doc.channels, name).toBe(song.channels);
      expect(docChannels(doc), name).toBe((bytes[8]! >> 2) + 4);
      expect(doc.mixgainRaw, name).toBe(bytes[14]);
      expect(doc.defstereo, name).toBe(bytes[15]);
      expect(doc.base, name).toBe(bytes);
      for (const [i, position] of doc.positions.entries()) {
        expect(position.track.length, `${name} position ${i}`).toBe(doc.channels);
        expect(position.transpose.length, `${name} position ${i}`).toBe(doc.channels);
      }
    }
  });

  it('is lossless at model level: docToSong(docFromSong(parse)) is the parse, all 22', () => {
    for (const { name, bytes } of corpus) {
      const song = parseAhx(bytes);
      expect(docToSong(docFromSong(song, bytes), song.instruments), name).toEqual(song);
    }
  });

  it('an HVL doc carries its own instruments (P2, Option 1): docToSong(docFromSong(parse)) is the parse with no instrument list given, all 22', () => {
    for (const { name, bytes } of corpus) {
      const song = parseAhx(bytes);
      const doc = hvlDoc(bytes);
      expect(doc.instruments, name).toEqual(song.instruments.slice(1));
      expect(doc.instruments.length, name).toBe(song.instrumentNr);
      // Copies: the doc shares no object with the parse.
      doc.instruments.forEach((ins, i) => {
        expect(ins, `${name} instrument ${i + 1}`).not.toBe(song.instruments[i + 1]);
        expect(ins.plist.entries, `${name} instrument ${i + 1}`).not.toBe(song.instruments[i + 1]!.plist.entries);
      });
      expect(docToSong(docFromSong(song, bytes)), name).toEqual(song);
    }
  });

  it('buildAhxFile with the store\'s HVL slots (none) writes the doc\'s instruments: the source bytes, all 22', () => {
    for (const { name, bytes } of corpus) {
      const song = parseAhx(bytes);
      const doc = docFromSong(song, bytes);
      const built = buildAhxFile({ doc, slots: [], title: song.name.trim() || 'Imported HVL' });
      expect(built.instrumentNamesAltered, name).toBe(false);
      expectSource(name, built.bytes, bytes);
      // Stray slots never override an HVL doc's instruments.
      const stray = [{ ahxData: song.instruments[1] }];
      expectSource(name, buildAhxFile({ doc, slots: stray, title: song.name.trim() || 'Imported HVL' }).bytes, bytes);
      // What the size limit counts is the doc's instruments too.
      expect(ahxUsedBytes(doc, ahxInstrumentBytes(fileInstruments(doc, []), 'hvl')), name).toBe(nameOffsetOf(bytes));
    }
  });

  it('doc -> serialize with base writes the source bytes (meltwater pinned), all 22', () => {
    let checked = 0;
    for (const { name, bytes } of corpus) {
      const song = parseAhx(bytes);
      const doc = docFromSong(song, bytes);
      expectSource(name, serializeAhx(docToSong(doc, song.instruments), { base: bytes }), bytes);
      checked++;
    }
    expect(checked).toBe(22);
  });

  it('doc -> buildAhxFile (the one writer the app shares) writes the source bytes, all 22', () => {
    for (const { name, bytes } of corpus) {
      const song = parseAhx(bytes);
      const slots = song.instruments.slice(1).map((ahxData) => ({ ahxData }));
      const title = song.name.trim() || 'Imported HVL';
      const built = buildAhxFile({ doc: docFromSong(song, bytes), slots, title });
      expect(built.titleAltered, name).toBe(false);
      expect(built.instrumentNamesAltered, name).toBe(false);
      expectSource(name, built.bytes, bytes);
    }
  });

  it('doc -> serialize -> parse is the parse, with and without base, all 22', () => {
    for (const { name, bytes } of corpus) {
      const song = parseAhx(bytes);
      const doc = docFromSong(song, bytes);
      expect(parseAhx(serializeAhx(docToSong(doc, song.instruments), { base: bytes })), `${name} base`).toEqual(song);
      expect(parseAhx(serializeAhx(docToSong(withoutBase(doc as HvlDoc), song.instruments))), `${name} no base`).toEqual(song);
      // And the doc of the written file is the doc (base aside).
      const again = docFromBytes(serializeAhx(docToSong(doc, song.instruments), { base: bytes }));
      expect({ ...again, base: undefined }, name).toEqual({ ...doc, base: undefined });
    }
  });

  it('the size budget is the file\'s nameOffset exactly (1 byte per blank step, 5 per other, 5-byte PList rows)', () => {
    for (const { name, bytes } of corpus) {
      const song = parseAhx(bytes);
      const doc = hvlDoc(bytes);
      const instruments = song.instruments.slice(1);
      expect(ahxUsedBytes(doc, ahxInstrumentBytes(instruments, 'hvl')), name).toBe(nameOffsetOf(bytes));
      expect(ahxSizeBudget(doc, instruments).used, name).toBe(nameOffsetOf(bytes));
      // Without base the flag is guessed from track 0, as the writer does it.
      const bare = withoutBase(doc);
      expect(bare.base).toBeUndefined();
      const written = serializeAhx(docToSong(bare, song.instruments));
      expect(ahxUsedBytes(bare, ahxInstrumentBytes(instruments, 'hvl')), `${name} no base`).toBe(nameOffsetOf(written));
    }
  });

  it('an HVL PList row is 5 bytes, an AHX one 4', () => {
    const one = [{ plist: { speed: 0, entries: [{}] } }] as unknown as Pick<AhxInstrument, 'plist'>[];
    expect(ahxInstrumentBytes(one)).toBe(26);
    expect(ahxInstrumentBytes(one, 'ahx')).toBe(26);
    expect(ahxInstrumentBytes(one, 'hvl')).toBe(27);
  });

  it('the display projection is the import\'s grid, with stable ids and each position\'s transpose, all 22', () => {
    for (const { name, bytes } of corpus) {
      const imported = importAhxToTrackerSong(bytes.slice().buffer).data.patterns;
      const projected = projectDisplayPatterns(hvlDoc(bytes));
      expect(projected.map(withoutId), name).toEqual(imported.map(withoutId));
      expect(projected.map((p) => p.id), name).toEqual(projected.map((_, i) => `ahx-pos-${i}`));
    }
  });

  it('projectTracks knows the doc\'s width: every track reads as it does in the editable projection', () => {
    for (const { name, bytes } of corpus) {
      const doc = hvlDoc(bytes);
      const patterns = projectAhxPatterns(doc);
      const used = [...new Set(doc.positions.flatMap((p) => p.track))];
      const rows = projectTracks(doc, used);
      expect(rows.size, name).toBe(used.length);
      doc.positions.forEach((position, p) => {
        position.track.forEach((track, c) => {
          expect(rows.get(track), `${name} position ${p} channel ${c}`).toEqual(patterns[p]!.tracks[c]!.entries);
        });
      });
    }
  });
});

/**
 * plan-hvl-editing.md P3: edited docs, over the whole corpus. Each file gets
 * real edits through the ops on its *last* channel (for most files one the
 * old four-channel code never reached): the position-0 cell gets a track of
 * its own (`makeUnique`), row 0 a note with instrument 1 and a second-column
 * effect (HVL only), and a transpose. The rebuilt file must hold exactly the
 * edited doc, keep every instrument, and re-save byte for byte.
 */
describe('mutated HVL docs round-trip byte-exact (P3)', () => {
  const STEP: AhxDocStep = { note: 13, instrument: 1, fx: 0, fxParam: 0, fxb: 0xc, fxbParam: 0x20 };
  const ok = <T extends { ok: boolean }>(result: T, what: string): Extract<T, { ok: true }> => {
    if (!result.ok) throw new Error(`${what}: ${(result as unknown as { reason: string }).reason}`);
    return result as Extract<T, { ok: true }>;
  };
  function edited(name: string, bytes: Uint8Array): { doc: HvlDoc; channel: number; track: number; transpose: number } {
    const doc = hvlDoc(bytes);
    const channel = docChannels(doc) - 1;
    const instrumentBytes = ahxInstrumentBytes(doc.instruments, 'hvl');
    const unique = ok(makeUnique(doc, 0, channel, { instrumentBytes }), `${name} makeUnique`);
    const stepped = ok(setStep(unique.doc, unique.track, 0, STEP), `${name} setStep`);
    const transpose = doc.positions[0]!.transpose[channel] === -5 ? 7 : -5;
    const moved = ok(setTranspose(stepped.doc, 0, channel, transpose), `${name} setTranspose`);
    return { doc: moved.doc as HvlDoc, channel, track: unique.track, transpose };
  }
  const titleOf = (doc: AhxDoc): string => doc.songName.trim() || 'Imported HVL';

  it('the edit lands and nothing else moves: the rebuilt file parses as the edited doc, instruments kept, all 22', () => {
    for (const { name, bytes } of corpus) {
      const source = parseAhx(bytes);
      expect(source.instrumentNr, `${name} has an instrument 1 to use`).toBeGreaterThanOrEqual(1);
      const { doc, channel, track, transpose } = edited(name, bytes);
      const out = buildAhxFile({ doc, slots: [], title: titleOf(doc) }).bytes;
      expect(sameBytes(out, bytes), `${name}: the edit changed the file`).toBe(false);
      const back = parseAhx(out);
      expect(back, name).toEqual(docToSong(doc));
      expect(back.positions[0]!.track[channel], name).toBe(track);
      expect(back.positions[0]!.transpose[channel], name).toBe(transpose);
      expect(back.tracks[track]![0], name).toEqual(STEP);
      expect(back.instrumentNr, name).toBe(source.instrumentNr);
      expect(back.instruments, name).toEqual(source.instruments);
      expect(back.channels, name).toBe(source.channels);
      expect([back.mixgainRaw, back.defstereo], name).toEqual([source.mixgainRaw, source.defstereo]);
      expect(nameOffsetOf(out), `${name}: size budget`).toBe(ahxUsedBytes(doc, ahxInstrumentBytes(fileInstruments(doc, []), 'hvl')));
    }
  });

  it('an edited file re-saves byte for byte: load it, rebuild it untouched, same bytes (with base and through buildAhxFile), all 22', () => {
    for (const { name, bytes } of corpus) {
      const { doc } = edited(name, bytes);
      const out = buildAhxFile({ doc, slots: [], title: titleOf(doc) }).bytes;
      const again = hvlDoc(out);
      expect(sameBytes(buildAhxFile({ doc: again, slots: [], title: titleOf(again) }).bytes, out), name).toBe(true);
      expect(sameBytes(serializeAhx(parseAhx(out), { base: out }), out), `${name} base`).toBe(true);
      // Without base too: the edited file's only base-held bit, the blank-first-track flag, is re-derived the same.
      expect(parseAhx(serializeAhx(parseAhx(out))), `${name} no base`).toEqual(parseAhx(out));
    }
  });

  it('meltwater_10ch.hvl (pinned): an edit on channel 10 keeps its 10 instruments, and the edited file is stable from then on', () => {
    const bytes = corpus.find((f) => f.name === 'meltwater_10ch.hvl')!.bytes;
    const { doc, channel } = edited('meltwater_10ch.hvl', bytes);
    expect(channel).toBe(9);
    const out = buildAhxFile({ doc, slots: [], title: titleOf(doc) }).bytes;
    const back = parseAhx(out);
    expect(back.instrumentNr).toBe(10);
    expect(back.instruments.slice(1).map((i) => i.name)).toEqual(parseAhx(bytes).instruments.slice(1).map((i) => i.name));
    // The rebuild writes the last (empty) name's NUL the source omits; once written it stays.
    expect(out[out.length - 1]).toBe(0);
    const twice = buildAhxFile({ doc: hvlDoc(out), slots: [], title: titleOf(doc) }).bytes;
    expect(sameBytes(twice, out)).toBe(true);
  });
});
