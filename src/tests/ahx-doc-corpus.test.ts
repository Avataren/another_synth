// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseAhx, type AhxSong } from '@another-synth/tracker-playback';
import {
  allocTrack,
  ahxInstrumentBytes,
  ahxUsedBytes,
  assignTrack,
  buildAhxFile,
  cellsUsingTrack,
  deletePosition,
  docFromBytes,
  entriesToTrack,
  insertPosition,
  isBlankTrack,
  makeUnique,
  projectAhxPatterns,
  setStep,
  setTranspose,
  tracksEqual,
  trackUsage,
  type AhxDoc,
  type AhxFileSlot,
  type AhxOpContext,
  type AhxOpResult,
} from 'src/audio/tracker/ahx-doc';
import { defaultAhxInstrument } from 'src/audio/tracker/ahx-instrument-edit';
import {
  ahxCorpus,
  dormantReferences,
  importTitleOf,
  instrumentsOf,
  resolvedPlayback,
  slotsOf,
  type CorpusFile,
} from './helpers/ahx-doc-fixtures';
import { RENDER_SAMPLE_RATE, firstDifference, initAhxWasm, peak, renderAhx } from './helpers/ahx-render';

/**
 * The acceptance bar for the AHX doc (Song Edit B1): every one of the 77 `.ahx`
 * demos, parsed into a doc and written back with no edit, is the source file
 * byte for byte; and the edits the ops offer do to the file exactly what they
 * say. Three oracles, each written apart from the ops: bytes (the source), the
 * resolved playback (every position/channel/row's step + transpose, read from
 * the parse of the output) and the audio (the real engine over real wasm, hi-fi
 * off, the first 8 seconds).
 */
const corpus = ahxCorpus();
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const PCM_SECONDS = 8;

// Measured on this corpus: songs in which the engine reaches no step with a note
// and a pitched instrument in the first 8 s (A1/A2 skip these). A broken picker
// would skip far more than these.
// corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
const EXPECTED_PICK_SKIPS = ['bill_buys_a_hoover.ahx', 'countdown_to_nil.ahx', 'dreams_odyssee.ahx', 'epic.ahx', 'get_to_the_chopper.ahx', 'kids.ahx', 'tattoo in the armpit.ahx'];

/** Twelve songs that between them cover v0/v1, speed x1/x2/x3, a subsong, restart, explicit blank track 0, shared and unreferenced tracks, and 256 tracks. */
const PCM_SUBSET = [
  'a_new_beginning.ahx',
  'get_to_the_chopper.ahx',
  'nyrmodian_cityscape.ahx',
  'cats_on_the_catwalk.ahx',
  'outcast.ahx',
  'winter_dreams.ahx',
  'karma.ahx',
  'magneto_crack.ahx',
  'explodingfist.ahx',
  'melodious.ahx',
  'thats_the_wave_it_is.ahx',
  'lightforce_trainer.ahx',
];

interface Song {
  file: CorpusFile;
  parsed: AhxSong;
  doc: AhxDoc;
  slots: AhxFileSlot[];
  title: string;
  context: AhxOpContext;
}

const songs: Song[] = corpus.map((file) => {
  const parsed = parseAhx(file.bytes);
  const slots = slotsOf(parsed);
  return {
    file,
    parsed,
    doc: docFromBytes(file.bytes),
    slots,
    title: importTitleOf(parsed),
    context: { instrumentBytes: ahxInstrumentBytes(instrumentsOf(slots)) },
  };
});

const build = (song: Song, doc: AhxDoc, slots: AhxFileSlot[] = song.slots): Uint8Array => buildAhxFile({ doc, slots, title: song.title }).bytes;
const okDoc = (r: AhxOpResult<object>): AhxDoc => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return (r as unknown as { doc: AhxDoc }).doc;
};
const firstReferenced = (doc: AhxDoc): number => doc.positions[0]!.track.find((t) => t !== 0) ?? doc.positions.flatMap((p) => p.track).find((t) => t !== 0) ?? 0;

describe('T1(A): an unedited doc is the source file', () => {
  it('reads the whole corpus', () => {
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
    expect(songs.length).toBe(77);
  });

  it('buildAhxFile(docFromBytes(x)) == x, 77/77', () => {
    let checked = 0;
    for (const song of songs) {
      expect(same(build(song, song.doc), song.file.bytes), song.file.name).toBe(true);
      checked++;
    }
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
    expect(checked).toBe(77);
  });

  it('is a fixed point: writing what it wrote gives the same bytes', () => {
    let checked = 0;
    for (const song of songs) {
      const once = build(song, song.doc);
      const again = docFromBytes(once);
      expect(same(build(song, again), once), song.file.name).toBe(true);
      checked++;
    }
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
    expect(checked).toBe(77);
  });

  it('holds the file untouched in the doc: shared tracks stay shared, unreferenced ones stay, transposes are kept', () => {
    let shared = 0;
    let unreferenced = 0;
    let transposed = 0;
    for (const { doc, parsed } of songs) {
      expect(doc.tracks.length).toBe(parsed.tracks.length);
      expect(doc.positions.length).toBe(parsed.positions.length);
      const usage = trackUsage(doc);
      if (usage.some((n) => n > 1)) shared++;
      if (usage.some((n) => n === 0)) unreferenced++;
      if (doc.positions.some((p) => p.transpose.some((v) => v !== 0))) transposed++;
    }
    // The measurements of plan section 1.1.
    // corpus-size constants — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
    expect(shared).toBe(76);
    expect(unreferenced).toBe(36);
    expect(transposed).toBe(53);
  });
});

describe('the projection is invertible on the whole corpus', () => {
  it('every cell of every position, projected and written back, is its track', () => {
    let cells = 0;
    for (const { doc, file } of songs) {
      const patterns = projectAhxPatterns(doc);
      expect(patterns.length).toBe(doc.positions.length);
      patterns.forEach((pattern, p) => {
        expect(pattern.id).toBe(`ahx-pos-${p}`);
        expect(pattern.rows).toBe(doc.trackLength);
        pattern.tracks.forEach((track, ch) => {
          const back = entriesToTrack(track.entries, doc.trackLength);
          expect('error' in back, `${file.name} ${p}.${ch}`).toBe(false);
          expect(tracksEqual(back as never, doc.tracks[doc.positions[p]!.track[ch]!]!), `${file.name} position ${p} channel ${ch}`).toBe(true);
          cells++;
        });
      });
    }
    expect(cells).toBe(songs.reduce((n, s) => n + s.doc.positions.length * 4, 0));
  });

  it('shows an instrument only where the step has one (no latch)', () => {
    const { doc } = songs.find((s) => s.file.name === 'karma.ahx')!;
    const patterns = projectAhxPatterns(doc);
    patterns.forEach((pattern, p) =>
      pattern.tracks.forEach((track, ch) => {
        const steps = doc.tracks[doc.positions[p]!.track[ch]!]!;
        for (const entry of track.entries) {
          const step = steps[entry.row]!;
          expect(entry.instrument !== undefined).toBe(step.instrument > 0);
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// T1(B): the edit matrix
// ---------------------------------------------------------------------------

describe('T1(B): the edit matrix', () => {
  it('N1: a step set to its current value is the source file', () => {
    let applied = 0;
    for (const song of songs) {
      const t = firstReferenced(song.doc);
      const next = okDoc(setStep(song.doc, t, 0, song.doc.tracks[t]![0]!));
      expect(next).toBe(song.doc);
      expect(same(build(song, next), song.file.bytes), song.file.name).toBe(true);
      applied++;
    }
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
    expect(applied).toBe(77);
  });

  it('N2: a track cloned and every cell repointed plays the same (the 2 songs at 256 tracks refuse)', () => {
    const refused: string[] = [];
    let applied = 0;
    for (const song of songs) {
      const t = firstReferenced(song.doc);
      const copy = allocTrack(song.doc, { copyOf: t, append: true }, song.context);
      if (!copy.ok) {
        expect(copy.reason).toMatch(/256 tracks/);
        refused.push(song.file.name);
        continue;
      }
      let doc = copy.doc;
      for (const [p, ch] of cellsUsingTrack(song.doc, t)) doc = okDoc(assignTrack(doc, p, ch, copy.track));
      expect(cellsUsingTrack(doc, t).length).toBe(0);
      const out = build(song, doc);
      expect(resolvedPlayback(parseAhx(out)), song.file.name).toBe(resolvedPlayback(song.parsed));
      expect(out.length - song.file.bytes.length).toBe(3 * song.doc.trackLength);
      applied++;
    }
    expect(refused).toEqual(songs.filter((s) => s.doc.tracks.length === 256).map((s) => s.file.name));
    expect(refused.length).toBe(2);
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
    expect(applied).toBe(75);
  });

  it('N3: ten unreferenced blank tracks change nothing but the size (256 tracks and the 65,535 limit refuse)', () => {
    const refused: string[] = [];
    let applied = 0;
    for (const song of songs) {
      let doc = song.doc;
      let failure = '';
      for (let i = 0; i < 10 && failure === ''; i++) {
        const r = allocTrack(doc, { append: true }, song.context);
        if (r.ok) doc = r.doc;
        else failure = r.reason;
      }
      // The oracle for "should refuse" is arithmetic, not the op.
      const tooMany = song.doc.tracks.length + 10 > 256;
      const tooBig = ahxUsedBytes(song.doc, song.context.instrumentBytes) + 10 * song.doc.trackLength * 3 > 65535;
      expect(failure !== '', song.file.name).toBe(tooMany || tooBig);
      if (failure !== '') {
        refused.push(song.file.name);
        continue;
      }
      const out = build(song, doc);
      expect(out.length - song.file.bytes.length, song.file.name).toBe(10 * song.doc.trackLength * 3);
      expect(resolvedPlayback(parseAhx(out))).toBe(resolvedPlayback(song.parsed));
      applied++;
    }
    expect(refused.length).toBeGreaterThanOrEqual(2);
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
    expect(applied + refused.length).toBe(77);
  });

  it('N4: a blank position inserted and deleted again leaves the song as it was', () => {
    let identical = 0;
    for (const song of songs) {
      // A blank position points at the blank track 0. A song whose track 0 holds content
      // (36 of the 62: it is an ordinary track there) needs four blank tracks of its own,
      // which deleting the position leaves behind, unreferenced.
      const track0Blank = isBlankTrack(song.doc.tracks[0]!);
      for (const at of [0, song.doc.positions.length]) {
        const inserted = insertPosition(song.doc, at, { kind: 'blank' }, song.context);
        expect(inserted.ok, song.file.name).toBe(true);
        const r = inserted as unknown as { doc: AhxDoc };
        expect(r.doc.positions.length).toBe(song.doc.positions.length + 1);
        const back = okDoc(deletePosition(r.doc, at));
        expect(back.positions, `${song.file.name} at ${at}`).toEqual(song.doc.positions);
        expect(back.restart).toBe(song.doc.restart);
        expect(back.subsongs).toEqual(song.doc.subsongs);
        const out = build(song, back);
        expect(resolvedPlayback(parseAhx(out)), song.file.name).toBe(resolvedPlayback(song.parsed));
        if (track0Blank) {
          expect(same(out, song.file.bytes), `${song.file.name} at ${at}`).toBe(true);
          identical++;
        } else {
          expect(back.tracks.length).toBeGreaterThanOrEqual(song.doc.tracks.length);
        }
      }
    }
    expect(identical).toBe(2 * songs.filter((s) => isBlankTrack(s.doc.tracks[0]!)).length);
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
    expect(identical).toBe(2 * 35);
  });

  it('N5: every shared cell made unique and pointed back plays the same', () => {
    let made = 0;
    for (const song of songs) {
      let doc = song.doc;
      const undo: [number, number, number][] = [];
      for (let p = 0; p < song.doc.positions.length; p++) {
        for (let ch = 0; ch < 4; ch++) {
          const t = song.doc.positions[p]!.track[ch]!;
          if (t === 0 || (trackUsage(song.doc)[t] ?? 0) < 2) continue;
          const r = makeUnique(doc, p, ch, song.context);
          if (!r.ok) continue; // 256 tracks or the size limit: the op refuses, nothing changes
          doc = r.doc;
          undo.push([p, ch, t]);
          made++;
        }
      }
      // Made unique: no cell of a shared track shares any more.
      for (const [p, ch] of undo) expect((trackUsage(doc)[doc.positions[p]!.track[ch]!] ?? 0), song.file.name).toBe(1);
      const unique = build(song, doc);
      expect(resolvedPlayback(parseAhx(unique)), `${song.file.name} unique`).toBe(resolvedPlayback(song.parsed));
      for (const [p, ch, t] of undo) doc = okDoc(assignTrack(doc, p, ch, t));
      expect(doc.positions).toEqual(song.doc.positions);
      expect(resolvedPlayback(parseAhx(build(song, doc))), `${song.file.name} back`).toBe(resolvedPlayback(song.parsed));
    }
    expect(made).toBeGreaterThan(1000);
  });

  it('N6: renaming an instrument changes only the string table', () => {
    for (const song of songs) {
      const slots = song.slots.map((s) => ({ ahxData: s.ahxData && { ...s.ahxData } }));
      slots[0]!.ahxData!.name = 'Renamed instrument';
      const out = build(song, song.doc, slots);
      const nameOffset = (song.file.bytes[4]! << 8) | song.file.bytes[5]!;
      expect(out.subarray(0, nameOffset), song.file.name).toEqual(song.file.bytes.subarray(0, nameOffset));
      const parsed = parseAhx(out);
      expect(parsed.instruments[1]!.name).toBe('Renamed instrument');
      expect({ ...parsed, instruments: parsed.instruments.slice(2) }).toEqual({ ...song.parsed, instruments: song.parsed.instruments.slice(2), name: song.parsed.name, });
    }
  });

  const withNewInstrument = (song: Song): AhxFileSlot[] => {
    const slots = [...song.slots];
    slots[song.parsed.instrumentNr] = { ahxData: defaultAhxInstrument() };
    return slots;
  };

  it('N7: an added instrument nothing names changes nothing (songs with dormant references are A3)', () => {
    const skipped: string[] = [];
    let applied = 0;
    for (const song of songs) {
      if (dormantReferences(song.parsed, song.parsed.instrumentNr + 1) > 0) {
        skipped.push(song.file.name);
        continue;
      }
      const out = build(song, song.doc, withNewInstrument(song));
      const parsed = parseAhx(out);
      expect(parsed.instrumentNr).toBe(song.parsed.instrumentNr + 1);
      expect(parsed.instruments[parsed.instrumentNr]!.name).toBe('New instrument');
      expect(resolvedPlayback(parsed), song.file.name).toBe(resolvedPlayback(song.parsed));
      applied++;
    }
    expect(skipped).toEqual(['outcast.ahx']);
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
    expect(applied).toBe(76);
  });

  // The audible edits (A1, A2), and A3: structural tier on all 62.

  /** The (position, row) places the engine reports in the first 8 s, in the order it reaches them. */
  const reached = new Map<string, [number, number][]>();
  function reachedBy(song: Song): [number, number][] {
    let places = reached.get(song.file.name);
    if (!places) {
      const seen = new Set<string>();
      places = [];
      for (const e of renderAhx(song.file.bytes, PCM_SECONDS).events) {
        if (e.type !== 'position' || seen.has(`${e.position}.${e.row}`)) continue;
        seen.add(`${e.position}.${e.row}`);
        places.push([e.position, e.row]);
      }
      reached.set(song.file.name, places);
    }
    return places;
  }

  /** An instrument that exists and follows the note it is given (a PList row with a fixed note would not, nor does noise, waveform 4, have a pitch). */
  const pitched = (song: Song, n: number): boolean => {
    const ins = song.parsed.instruments[n];
    return n > 0 && n <= song.parsed.instrumentNr && ins !== undefined && !ins.plist.entries.some((e) => e.fixed || e.waveform === 4);
  };

  interface Pick {
    position: number;
    channel: number;
    track: number;
    row: number;
  }

  /**
   * The first step the song plays, in playing order (position, row, channel), that
   * has a note below 60 and a pitched instrument of its own, among the places the
   * engine reports inside the 8 s window (so an edit there can be heard in the
   * compared span). Deterministic; `undefined` when the window holds none.
   */
  function pickPlayedNote(song: Song): Pick | undefined {
    for (const [position, row] of reachedBy(song)) {
      for (let channel = 0; channel < 4; channel++) {
        const track = song.doc.positions[position]!.track[channel]!;
        const s = song.doc.tracks[track]![row]!;
        if (s.note >= 1 && s.note < 60 && pitched(song, s.instrument)) return { position, channel, track, row };
      }
    }
    return undefined;
  }

  /** A row lasts at least one tick, so row `r` of position 0 begins no earlier than tick `r`; later positions get no bound. */
  const earliestFrame = (song: Song, pick: Pick): number =>
    pick.position === 0 ? Math.floor((pick.row * RENDER_SAMPLE_RATE) / (50 * song.doc.speedMultiplier)) : 0;

  const skipped: string[] = [];

  it('A1: one note moved up a semitone is exactly that one step, in every song', () => {
    let applied = 0;
    for (const song of songs) {
      const pick = pickPlayedNote(song);
      if (!pick) {
        skipped.push(song.file.name);
        continue;
      }
      const step = song.doc.tracks[pick.track]![pick.row]!;
      const next = okDoc(setStep(song.doc, pick.track, pick.row, { ...step, note: step.note + 1 }));
      const expected = structuredClone(song.parsed);
      expected.tracks[pick.track]![pick.row]!.note += 1;
      expect(parseAhx(build(song, next)), song.file.name).toEqual(expected);
      applied++;
    }
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
    expect(applied + skipped.length).toBe(77);
    // A broken picker must not silently skip everything: these are the songs measured to have no candidate.
    expect(skipped).toEqual(EXPECTED_PICK_SKIPS);
  });

  it('A2: a transpose set on one position and channel is exactly that, in every song', () => {
    let applied = 0;
    for (const song of songs) {
      const pick = pickPlayedNote(song);
      if (!pick) continue;
      const old = song.doc.positions[pick.position]!.transpose[pick.channel]!;
      const value = old + 5 > 127 ? old - 5 : old + 5;
      const expected = structuredClone(song.parsed);
      expected.positions[pick.position]!.transpose[pick.channel] = value;
      expect(parseAhx(build(song, okDoc(setTranspose(song.doc, pick.position, pick.channel, value)))), song.file.name).toEqual(expected);
      applied++;
    }
    // corpus-size constant — re-measure when public/demos/ahx grows (last updated at 77 files, 2026-09-22)
    expect(applied).toBe(77 - EXPECTED_PICK_SKIPS.length);
  });

  // The audio tier, on the twelve-song subset.
  describe('the audio tier (real engine over real wasm, hi-fi off, 8 s)', () => {
    initAhxWasm();
    const subset = PCM_SUBSET.map((name) => songs.find((s) => s.file.name === name)!);

    it('the subset exists and the baseline renders sound', () => {
      expect(subset.every((s) => s !== undefined)).toBe(true);
      for (const song of subset) {
        const r = renderAhx(song.file.bytes, PCM_SECONDS);
        expect(r.events.find((e) => e.type === 'error'), song.file.name).toBeUndefined();
        expect(peak(r), song.file.name).toBeGreaterThan(0);
      }
    });

    it('the unedited doc plays exactly like the source file', () => {
      for (const song of subset) {
        expect(firstDifference(renderAhx(build(song, song.doc), PCM_SECONDS), renderAhx(song.file.bytes, PCM_SECONDS)), song.file.name).toBe(-1);
      }
    });

    it('N2, N3, N5, N6, N7 (neutral edits) sound the same', () => {
      for (const song of subset) {
        const reference = renderAhx(song.file.bytes, PCM_SECONDS);
        const t = firstReferenced(song.doc);

        // N2: clone + repoint
        const copy = allocTrack(song.doc, { copyOf: t, append: true }, song.context);
        if (copy.ok) {
          let doc = copy.doc;
          for (const [p, ch] of cellsUsingTrack(song.doc, t)) doc = okDoc(assignTrack(doc, p, ch, copy.track));
          expect(firstDifference(renderAhx(build(song, doc), PCM_SECONDS), reference), `${song.file.name} N2`).toBe(-1);
        }

        // N3: ten blank tracks
        let padded = song.doc;
        for (let i = 0; i < 10; i++) {
          const r = allocTrack(padded, { append: true }, song.context);
          if (r.ok) padded = r.doc;
        }
        expect(firstDifference(renderAhx(build(song, padded), PCM_SECONDS), reference), `${song.file.name} N3`).toBe(-1);

        // N5: every shared cell made unique
        let unique = song.doc;
        for (let p = 0; p < song.doc.positions.length; p++) {
          for (let ch = 0; ch < 4; ch++) {
            const r = makeUnique(unique, p, ch, song.context);
            if (r.ok) unique = r.doc;
          }
        }
        expect(firstDifference(renderAhx(build(song, unique), PCM_SECONDS), reference), `${song.file.name} N5`).toBe(-1);

        // N6: rename
        const renamed = song.slots.map((s) => ({ ahxData: s.ahxData && { ...s.ahxData } }));
        renamed[0]!.ahxData!.name = 'Something else entirely';
        expect(firstDifference(renderAhx(build(song, song.doc, renamed), PCM_SECONDS), reference), `${song.file.name} N6`).toBe(-1);

        // N7: an instrument nothing names
        if (dormantReferences(song.parsed, song.parsed.instrumentNr + 1) === 0) {
          expect(firstDifference(renderAhx(build(song, song.doc, withNewInstrument(song)), PCM_SECONDS), reference), `${song.file.name} N7`).toBe(-1);
        }
      }
    });

    it('A1 and A2 (audible edits) change the sound, and not before the edited row', () => {
      let picked = 0;
      for (const song of subset) {
        const reference = renderAhx(song.file.bytes, PCM_SECONDS);
        const pick = pickPlayedNote(song);
        if (!pick) continue;
        picked++;

        const step = song.doc.tracks[pick.track]![pick.row]!;
        const a1 = okDoc(setStep(song.doc, pick.track, pick.row, { ...step, note: step.note + 1 }));
        const d1 = firstDifference(renderAhx(build(song, a1), PCM_SECONDS), reference);
        expect(d1, `${song.file.name} A1 must be audible`).toBeGreaterThanOrEqual(0);
        expect(d1, `${song.file.name} A1 not before its row`).toBeGreaterThanOrEqual(earliestFrame(song, pick));

        const old = song.doc.positions[pick.position]!.transpose[pick.channel]!;
        const a2 = okDoc(setTranspose(song.doc, pick.position, pick.channel, old + 5 > 127 ? old - 5 : old + 5));
        const d2 = firstDifference(renderAhx(build(song, a2), PCM_SECONDS), reference);
        expect(d2, `${song.file.name} A2 must be audible`).toBeGreaterThanOrEqual(0);
        expect(d2, `${song.file.name} A2 not before its row`).toBeGreaterThanOrEqual(earliestFrame(song, pick));
      }
      expect(picked).toBe(subset.filter((song) => !EXPECTED_PICK_SKIPS.includes(song.file.name)).length);
      expect(picked).toBe(11);
    });

    it('A3: adding the instrument outcast already names in a step makes those steps sound', () => {
      const song = songs.find((s) => s.file.name === 'outcast.ahx')!;
      expect(dormantReferences(song.parsed, song.parsed.instrumentNr + 1)).toBe(1);
      // The step that names instrument 9 is row 0 of position 20, the song's last: start there.
      const seek = { position: 20, row: 0 };
      expect(song.doc.tracks[song.doc.positions[20]!.track[0]!]![0]!.instrument).toBe(9);
      const before = renderAhx(song.file.bytes, 4, { seek });
      const after = renderAhx(build(song, song.doc, withNewInstrument(song)), 4, { seek });
      expect(after.events.find((e) => e.type === 'error')).toBeUndefined();
      expect(firstDifference(after, before), 'the new instrument sounds where the dormant step is').toBeGreaterThanOrEqual(0);
      // And the same edit changes nothing audible in a song with no such reference.
      const karma = songs.find((s) => s.file.name === 'karma.ahx')!;
      const plain = renderAhx(karma.file.bytes, 4);
      expect(firstDifference(renderAhx(build(karma, karma.doc, withNewInstrument(karma)), 4), plain)).toBe(-1);
    });
  });
});
