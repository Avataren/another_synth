import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { parseAhx, type AhxSong } from '@another-synth/tracker-playback';
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
 * How many channels each demo `.hvl` uses (the highest channel that holds a
 * non-blank track in any position, plus one), measured with the same scan the
 * exporter runs. No demo `.hvl` fits in 4: the smallest is 6. `moderate_sellotaping`
 * has 8 channels but never uses the last.
 */
const CHANNELS_USED: Record<string, number> = {
  'chiprolled.hvl': 6,
  'doobrey_gubbins.hvl': 11,
  'drainage_proble.hvl': 7,
  'illuminated.hvl': 6,
  'moderate_sellotaping.hvl': 7,
  'sliding_away.hvl': 6,
  'sunspots.hvl': 6,
};

describe('the HVL exporter on the demo .hvl files', () => {
  it('finds all seven demos', () => {
    expect([...HVL_FILES].sort()).toEqual(Object.keys(CHANNELS_USED).sort());
  });

  it.each(HVL_FILES)('%s: an unedited song exports as the file it came from, byte for byte', (name) => {
    const song = songOf(name);
    expect(describeSongExporter(hvlExporter, song)).toEqual({ state: 'enabled' });
    expect(hvlExporter.serialize(song)).toEqual(demo(name));
    expect(hvlExporter.warnings!(song)).toEqual([]);
  });

  it.each(HVL_FILES)('%s: the AHX row is unavailable, and says how many tracks the song uses', (name) => {
    const song = songOf(name);
    const reason = `AHX files have 4 tracks; this song uses ${CHANNELS_USED[name]}. Export it as HVL instead.`;
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
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  /** A real HVL model cut down until it fits: channels 0..3 only, no second effect column. */
  function fitting(name = 'sliding_away.hvl'): AhxSong {
    const song = clone(parsed(name));
    const blank = song.tracks.findIndex((track) => track.every((s) => s.note === 0 && s.instrument === 0 && s.fx === 0 && s.fxParam === 0 && s.fxb === 0 && s.fxbParam === 0));
    expect(blank, 'the file has a blank track to point the dropped channels at').toBeGreaterThanOrEqual(0);
    for (const position of song.positions) {
      for (let ch = 4; ch < song.channels; ch++) position.track[ch] = blank;
    }
    for (const track of song.tracks) for (const step of track) Object.assign(step, { fxb: 0, fxbParam: 0 });
    return song;
  }

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

  it('data on a channel above the fourth refuses, and the count is the highest channel used', () => {
    const song = fitting();
    const busy = song.tracks.findIndex((track) => track.some((s) => s.note !== 0));
    song.positions[0]!.track[5] = busy;
    expect(convertHvlToAhx(song)).toEqual({
      ok: false,
      reason: 'AHX files have 4 tracks; this song uses 6. Export it as HVL instead.',
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

  it('an AHX song is not converted', () => {
    expect(convertHvlToAhx(parsed('karma.ahx'))).toEqual({ ok: false, reason: 'Only HVL songs can be converted.' });
  });

  it('says the HVL mix is not kept', () => {
    expect(HVL_MIX_NOTE).toBe("AHX files don't store this song's stereo and volume mix.");
  });
});
