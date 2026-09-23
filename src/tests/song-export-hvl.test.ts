import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { parseAhx, type AhxSong } from '@another-synth/tracker-playback';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { clone, fittingHvlModel, hvlBytesOf } from './helpers/fitting-hvl';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { ahxSourceInfoOf, setCurrentAhxSource, snapshotEditorSong } from 'src/audio/tracker/ahx-source';
import {
  ahxExporter,
  channelsWithData,
  convertHvlToAhx,
  describeSongExporter,
  HVL_MIX_NOTE,
  hvlExporter,
  serializeAhx,
  SongExportError,
} from 'src/audio/tracker/song-export';

const DEMOS = resolve(__dirname, '../../public/demos/ahx');
const demo = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(DEMOS, name)));
const HVL_FILES = readdirSync(DEMOS).filter((name) => name.endsWith('.hvl'));
const songOf = (name: string) => importAhxToTrackerSong(demo(name).slice().buffer);

/**
 * The highest track each demo `.hvl` reaches (the highest channel that holds a
 * non-blank track in any position, plus one), measured with the same scan the
 * exporter runs. Only ring_modulation_test_song fits in 4 (it is refused as
 * AHX for its second effect column instead); the smallest otherwise is 6.
 * `moderate_sellotaping` has 8 channels but never uses the last. It is not how
 * many tracks are in use: a channel below the highest may be blank.
 */
const CHANNELS_USED: Record<string, number> = {
  'a_little_cyberfunk.hvl': 8,
  'afterstorm.hvl': 12,
  'chiprolled.hvl': 6,
  'doobrey_gubbins.hvl': 11,
  'drainage_proble.hvl': 7,
  'drop_table.hvl': 12,
  'forsaken.hvl': 6,
  'galactic_emeralds.hvl': 10,
  'hexplosion.hvl': 16,
  'illuminated.hvl': 6,
  'incognito_crust.hvl': 6,
  'lanterns.hvl': 16,
  'meltwater_10ch.hvl': 10,
  'mijikai_tobikomi.hvl': 11,
  'moderate_sellotaping.hvl': 7,
  'ring_modulation_test_song.hvl': 3,
  'sliding_away.hvl': 6,
  'sunspots.hvl': 6,
  'sweeties.hvl': 10,
  'there_you_are.hvl': 6,
  'top_gun_anthem.hvl': 12,
  'unexpected_horse.hvl': 10,
  'yoake_no_myoujou.hvl': 16,
};

/**
 * meltwater_10ch.hvl's string table omits the final (empty) instrument name's
 * NUL terminator, so the writer canonically emits it: the export is the source
 * plus exactly one trailing NUL byte, and the parse is the same song
 * (measured 2026-09-23, curated HVL batch).
 */
const TRAILING_NAME_NUL = ['meltwater_10ch.hvl'];

describe('the HVL exporter on the demo .hvl files', () => {
  it('finds all twenty-three demos', () => {
    expect([...HVL_FILES].sort()).toEqual(Object.keys(CHANNELS_USED).sort());
  });

  it.each(HVL_FILES)('%s: an unedited song exports as the file it came from, byte for byte', (name) => {
    const song = songOf(name);
    expect(describeSongExporter(hvlExporter, song)).toEqual({ state: 'enabled' });
    const out = hvlExporter.serialize(song);
    if (TRAILING_NAME_NUL.includes(name)) {
      const bytes = demo(name);
      expect(out.length).toBe(bytes.length + 1);
      expect(out.subarray(0, bytes.length)).toEqual(bytes);
      expect(out[out.length - 1]).toBe(0);
    } else {
      expect(out).toEqual(demo(name));
    }
    expect(hvlExporter.warnings!(song)).toEqual([]);
  });

  it.each(HVL_FILES)('%s: the AHX row is unavailable, and says why', (name) => {
    const song = songOf(name);
    // ring_modulation_test_song fits 4 tracks; its refusal is the second
    // effect column. The rest reach past track 4.
    const reason = CHANNELS_USED[name]! > 4
      ? `AHX files have 4 tracks; this song reaches track ${CHANNELS_USED[name]}. Export it as HVL instead.`
      : "This song uses a second effect column, which AHX files don't have. Export it as HVL instead.";
    expect(describeSongExporter(ahxExporter, song)).toEqual({ state: 'unavailable', reason });
    expect(() => ahxExporter.serialize(song)).toThrow(SongExportError);
    expect(() => ahxExporter.serialize(song)).toThrow(reason);
    const used = channelsWithData(parseAhx(demo(name)));
    expect((used[used.length - 1] ?? -1) + 1).toBe(CHANNELS_USED[name]);
  });

  it('an edited title becomes the song name in the file and nothing else in the model changes', () => {
    const song = songOf('sliding_away.hvl');
    song.data.currentSong.title = 'My Remix';
    const out = hvlExporter.serialize(song);
    const before = parseAhx(demo('sliding_away.hvl'));
    const after = parseAhx(out);
    expect(after.name).toBe('My Remix');
    expect(after).toEqual({ ...before, name: 'My Remix' });
    expect(out[0]).toBe(0x48); // still an HVL file
  });

  it('a title with characters the format cannot hold is written with `?` and the row says so', () => {
    const song = songOf('sliding_away.hvl');
    expect(hvlExporter.warnings!(song)).toEqual([]);
    song.data.currentSong.title = 'Café €';
    expect(hvlExporter.warnings!(song)).toEqual(["Some characters in the title can't be saved and are replaced or removed."]);
    expect(parseAhx(hvlExporter.serialize(song)).name).toBe('Café ?');
  });

  it('says author and BPM are not saved only when one was changed, and writes neither', () => {
    const song = songOf('sunspots.hvl');
    song.data.currentSong.bpm = 90;
    expect(hvlExporter.warnings!(song)).toEqual(["Author and BPM changes aren't saved."]);
    expect(hvlExporter.serialize(song)).toEqual(demo('sunspots.hvl'));
  });

  it('an exported file loads again as the same song', () => {
    const song = songOf('illuminated.hvl');
    song.data.currentSong.title = 'Round Trip';
    const back = importAhxToTrackerSong(hvlExporter.serialize(song).slice().buffer);
    expect(back.data.currentSong.title).toBe('Round Trip');
    const rows = (s: typeof back) => s.data.patterns.map(({ id: _id, ...rest }) => rest);
    expect(rows(back)).toEqual(rows(songOf('illuminated.hvl')));
  });

  it('refuses an AHX song, a song without its source and a song made from scratch, with one plain line', () => {
    const ahx = importAhxToTrackerSong(demo('karma.ahx').slice().buffer);
    expect(hvlExporter.check(ahx)).toEqual({ ok: false, reason: "AHX songs can't be saved as HVL." });
    expect(() => hvlExporter.serialize(ahx)).toThrow("AHX songs can't be saved as HVL.");

    const hvl = songOf('sliding_away.hvl');
    const noSource = { ...hvl, data: { ...hvl.data } };
    expect(hvlExporter.check(noSource)).toEqual({ ok: false, reason: 'This song has no original file to export from.' });
    const scratch = { ...noSource, data: { ...hvl.data, moduleFormat: 'native' as const } };
    expect(hvlExporter.check(scratch)).toEqual({ ok: false, reason: "Songs made from scratch can't be exported yet." });
  });
});

describe('HVL songs and the editor store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setCurrentAhxSource(null);
  });

  it('an HVL song has no instrument slots, so no instrument edit can exist to be exported or lost', () => {
    const bytes = demo('chiprolled.hvl');
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(bytes.slice().buffer));
    setCurrentAhxSource(bytes.slice(), ahxSourceInfoOf(bytes));
    expect(store.instrumentSlots.filter((slot) => slot.ahxData !== undefined)).toEqual([]);
    const instrument = parseAhx(bytes).instruments[1]!;
    expect(store.updateAhxInstrument(1, { ...instrument, volume: 5 })).toBe('rejected');

    const out = hvlExporter.serialize(snapshotEditorSong(store));
    expect(out).toEqual(bytes);
  });

  it('an HVL song read back from the store keeps author and BPM at their import values, so no warning shows', () => {
    const bytes = demo('chiprolled.hvl');
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(bytes.slice().buffer));
    setCurrentAhxSource(bytes.slice(), ahxSourceInfoOf(bytes));
    expect(hvlExporter.warnings!(snapshotEditorSong(store))).toEqual([]);
  });
});

/**
 * The demo `.hvl` files all use more than 4 channels and a second effect
 * column, so none of them can be converted. The conversion rules are tested
 * on models derived in memory from a real parsed file (never written out as a
 * fixture): the model is edited as data until it fits, then each rule is broken
 * on its own.
 */
describe('converting an HVL song to AHX', () => {
  const parsed = (name: string): AhxSong => parseAhx(demo(name));
  const fitting = fittingHvlModel;

  it('the derived model fits: it is a real HVL song with data on 4 channels', () => {
    const song = fitting();
    expect(song.format).toBe('hvl');
    expect(song.channels).toBeGreaterThan(4);
    expect(channelsWithData(song).every((ch) => ch < 4)).toBe(true);
  });

  it('a fitting model becomes an AHX song the writer accepts and the parser reads back the same', () => {
    const song = fitting();
    const result = convertHvlToAhx(song);
    if (!result.ok) throw new Error(result.reason);
    expect(result.song.format).toBe('ahx');
    expect(result.song.channels).toBe(4);
    expect('mixgainRaw' in result.song).toBe(false);
    expect('defstereo' in result.song).toBe(false);

    const bytes = serializeAhx(result.song);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0x54, 0x48, 0x58]);
    const back = parseAhx(bytes);
    expect(back.format).toBe('ahx');
    expect(back.channels).toBe(4);
    expect(back.name).toBe(song.name);
    expect(back.positions).toEqual(song.positions.map((p) => ({ track: p.track.slice(0, 4), transpose: p.transpose.slice(0, 4) })));
    expect(back.tracks).toEqual(song.tracks);
    expect(back.instruments.slice(1).map((i) => i.name)).toEqual(song.instruments.slice(1).map((i) => i.name));
    expect(back.speedMultiplier).toBe(song.speedMultiplier);
    expect(back.restart).toBe(song.restart);
    expect(serializeAhx(back)).toEqual(bytes);
  });

  it('does not change the model it was given', () => {
    const song = fitting();
    const copy = clone(song);
    convertHvlToAhx(song);
    expect(song).toEqual(copy);
  });

  it('data on a channel above the fourth refuses, and the number is the highest track reached (channels 4 and below it may be blank)', () => {
    const song = fitting();
    const busy = song.tracks.findIndex((track) => track.some((s) => s.note !== 0));
    song.positions[0]!.track[5] = busy;
    expect(convertHvlToAhx(song)).toEqual({
      ok: false,
      reason: 'AHX files have 4 tracks; this song reaches track 6. Export it as HVL instead.',
    });
  });

  it('a second effect column on a kept channel refuses', () => {
    const song = fitting();
    const used = song.positions[0]!.track[0]!;
    song.tracks[used]![0]!.fxb = 3;
    expect(convertHvlToAhx(song)).toEqual({
      ok: false,
      reason: "This song uses a second effect column, which AHX files don't have. Export it as HVL instead.",
    });
  });

  it('a note or instrument number above 63 refuses', () => {
    for (const field of ['note', 'instrument'] as const) {
      const song = fitting();
      const used = song.positions[0]!.track[0]!;
      song.tracks[used]![0]![field] = 64;
      expect(convertHvlToAhx(song), field).toEqual({
        ok: false,
        reason: "This song has notes or instruments AHX files can't hold. Export it as HVL instead.",
      });
    }
  });

  it('EF1 refuses in a version-1 HVL song only (the engine ignores it in version 0)', () => {
    const song = fitting();
    const used = song.positions[0]!.track[0]!;
    Object.assign(song.tracks[used]![0]!, { fx: 0xe, fxParam: 0xf1 });
    song.version = 0;
    expect(convertHvlToAhx(song).ok).toBe(true);
    song.version = 1;
    expect(convertHvlToAhx(song)).toEqual({
      ok: false,
      reason: 'This song uses an effect (EF1) that only HVL plays. Export it as HVL instead.',
    });
  });

  it('an instrument with a PList command AHX cannot hold refuses, naming the instrument', () => {
    const song = fitting();
    const entries = song.instruments[2]!.plist.entries;
    // AHX's PList codes commands 0..5, 12 and 15; HVL's has all 16 (7 is one of the others).
    entries.push({ note: 1, waveform: 1, fixed: false, fx: [7, 0], fxParam: [0, 0] });
    expect(convertHvlToAhx(song)).toEqual({
      ok: false,
      reason: "Instrument 2 uses settings AHX files don't have. Export it as HVL instead.",
    });
  });

  /** A track no kept channel plays: only channels 4 and up (which the conversion drops) pointed at it. */
  function unplayedTrack(song: AhxSong): number {
    const kept = new Set(song.positions.flatMap((position) => position.track.slice(0, 4)));
    const index = song.tracks.findIndex((_, i) => !kept.has(i));
    expect(index, 'the cut-down song has a track only the dropped channels played').toBeGreaterThanOrEqual(0);
    return index;
  }

  it('a track no kept channel plays is written too, so a second effect column in it refuses (the check runs the writer)', () => {
    const song = fitting();
    const index = unplayedTrack(song);
    song.tracks[index]![0]!.fxb = 3;
    expect(convertHvlToAhx(song)).toEqual({
      ok: false,
      reason: `AHX files can't hold this song: track ${index} row 0 has a second effect column, which AHX has no room for. Export it as HVL instead.`,
    });
  });

  it('a note above 63 in a track no kept channel plays refuses the same way', () => {
    const song = fitting();
    const index = unplayedTrack(song);
    song.tracks[index]![0]!.note = 64;
    const result = convertHvlToAhx(song);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(new RegExp(`^AHX files can't hold this song: track ${index} row 0 note .*\\. Export it as HVL instead\\.$`));
  });

  it('an AHX song is not converted', () => {
    expect(convertHvlToAhx(parsed('karma.ahx'))).toEqual({ ok: false, reason: 'Only HVL songs can be converted.' });
  });

  it('says the HVL mix is not kept', () => {
    expect(HVL_MIX_NOTE).toBe("AHX files don't store this song's stereo and volume mix.");
  });
});

/**
 * `ahxExporter` on an HVL `TrackerSongFile`, the way the dialog reaches it: a
 * fitting HVL song (`fittingHvlModel`, written out as a real `.hvl` file) is
 * imported by the store's own import path, so the export runs on the song the
 * app would hold, source bytes attached.
 */
describe('the AHX exporter on an HVL song that fits', () => {
  const importFitting = (edit?: (model: AhxSong) => void): { model: AhxSong; song: TrackerSongFile } => {
    const model = fittingHvlModel();
    edit?.(model);
    return { model, song: importAhxToTrackerSong(hvlBytesOf(model)) };
  };

  it('is enabled, and the file is an AHX file holding the same song', () => {
    const { model, song } = importFitting();
    expect(model.name.trim(), 'a named song, so the name check below is not the fallback').not.toBe('');
    expect(describeSongExporter(ahxExporter, song)).toEqual({ state: 'enabled' });

    const out = ahxExporter.serialize(song);
    expect([out[0], out[1], out[2]]).toEqual([0x54, 0x48, 0x58]); // THX
    const back = parseAhx(out);
    expect(back.format).toBe('ahx');
    expect(back.channels).toBe(4);
    expect(back.name).toBe(model.name);
    expect(back.positions).toEqual(model.positions.map((p) => ({ track: p.track.slice(0, 4), transpose: p.transpose.slice(0, 4) })));
    expect(back.tracks).toEqual(model.tracks);
    expect(back.instruments).toEqual(model.instruments);
    expect('mixgainRaw' in back).toBe(false);
  });

  it('is written from the converted model alone: it needs no instrument slots, and a base would be refused as an HVL file', () => {
    const { model, song } = importFitting();
    expect(song.data.instrumentSlots).toEqual([]);
    expect(() => ahxExporter.serialize(song)).not.toThrow();
    const converted = convertHvlToAhx(model);
    if (!converted.ok) throw new Error(converted.reason);
    const base = new Uint8Array(hvlBytesOf(model));
    expect(() => serializeAhx(converted.song, { base })).toThrow(/base is an HVL file but the song is AHX/);
    expect(serializeAhx(converted.song)).toEqual(ahxExporter.serialize(song));
  });

  it('warns that the HVL mix is not kept, and nothing else for an unedited song', () => {
    const { song } = importFitting();
    expect(ahxExporter.warnings!(song)).toEqual([HVL_MIX_NOTE]);
  });

  it('keeps the warnings in order: title characters, author and BPM, then the mix', () => {
    const { song } = importFitting();
    song.data.currentSong.title = 'Café €';
    song.data.currentSong.bpm = 90;
    expect(ahxExporter.warnings!(song)).toEqual([
      "Some characters in the title can't be saved and are replaced or removed.",
      "Author and BPM changes aren't saved.",
      HVL_MIX_NOTE,
    ]);
    expect(parseAhx(ahxExporter.serialize(song)).name).toBe('Café ?');
  });

  it('an edited title becomes the name in the AHX file', () => {
    const { song } = importFitting();
    song.data.currentSong.title = 'My Remix';
    expect(parseAhx(ahxExporter.serialize(song)).name).toBe('My Remix');
  });

  it('an unedited song with no name in the file writes no name, not the "Imported HVL" the import shows', () => {
    const { song } = importFitting((model) => {
      model.name = '';
    });
    expect(song.data.currentSong.title).toBe('Imported HVL');
    expect(parseAhx(ahxExporter.serialize(song)).name).toBe('');
    expect(ahxExporter.warnings!(song)).toEqual([HVL_MIX_NOTE]);
    // The same song exported as HVL agrees.
    expect(parseAhx(hvlExporter.serialize(song)).name).toBe('');
  });

  it('a name the user typed that happens to be "Imported AHX" is a real edit and is written', () => {
    const { song } = importFitting((model) => {
      model.name = '';
    });
    song.data.currentSong.title = 'Imported AHX';
    expect(parseAhx(ahxExporter.serialize(song)).name).toBe('Imported AHX');
  });

  it('goes through the editor store the same way', () => {
    setActivePinia(createPinia());
    setCurrentAhxSource(null);
    const bytes = new Uint8Array(hvlBytesOf(fittingHvlModel()));
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(bytes.slice().buffer));
    setCurrentAhxSource(bytes.slice(), ahxSourceInfoOf(bytes));
    const snapshot = snapshotEditorSong(store);
    expect(describeSongExporter(ahxExporter, snapshot)).toEqual({ state: 'enabled' });
    expect(parseAhx(ahxExporter.serialize(snapshot)).tracks).toEqual(parseAhx(bytes).tracks);
    expect(ahxExporter.warnings!(snapshot)).toEqual([HVL_MIX_NOTE]);
  });

  it('a track no playing channel uses does not slip past the check: the row is unavailable with the writer\'s reason, and serialize says the same', () => {
    const { song } = importFitting((model) => {
      const kept = new Set(model.positions.flatMap((position) => position.track.slice(0, 4)));
      const index = model.tracks.findIndex((_, i) => !kept.has(i));
      model.tracks[index]![0]!.fxb = 3;
    });
    const verdict = describeSongExporter(ahxExporter, song);
    expect(verdict.state).toBe('unavailable');
    const reason = (verdict as { reason: string }).reason;
    expect(reason).toMatch(/^AHX files can't hold this song: track \d+ row 0 has a second effect column, which AHX has no room for\. Export it as HVL instead\.$/);
    expect(() => ahxExporter.serialize(song)).toThrow(reason);
    expect(hvlExporter.check(song)).toEqual({ ok: true });
  });
});

/**
 * The HVL row's `base`: the source bytes carry two things the model does not
 * (the inert bytes 9..11 and the top two bits of byte 19 of an instrument),
 * and the writer copies them back. No demo `.hvl` has any set, so this sets
 * them by hand in a demo's bytes and checks they survive.
 */
describe('the HVL exporter keeps what only the source bytes hold', () => {
  /** Offset of instrument `n`'s 22-byte core, counted back from the string table, independent of the writer. */
  function instrumentCore(bytes: Uint8Array, n: number): number {
    const song = parseAhx(bytes);
    let at = (bytes[4]! << 8) | bytes[5]!;
    for (let i = song.instrumentNr; i >= n; i--) at -= 22 + song.instruments[i]!.plist.entries.length * 5;
    return at;
  }

  it('inert instrument bits set in the file are written back, though the model cannot see them', () => {
    const original = demo('sliding_away.hvl');
    const poked = original.slice();
    const core = instrumentCore(poked, 1);
    poked[core + 9] = 0xa5;
    poked[core + 19] = poked[core + 19]! | 0xc0;

    // The control has power: these bits are not part of the model, and a writer without `base` drops them.
    expect(parseAhx(poked)).toEqual(parseAhx(original));
    expect(serializeAhx(parseAhx(poked))).not.toEqual(poked);
    expect(serializeAhx(parseAhx(poked))).toEqual(serializeAhx(parseAhx(original)));

    const song = importAhxToTrackerSong(poked.slice().buffer);
    const out = hvlExporter.serialize(song);
    expect(out).toEqual(poked);
    expect(out[core + 9]).toBe(0xa5);
    expect(out[core + 19]! & 0xc0).toBe(0xc0);
  });
});
