// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isReactive, reactive, toRaw } from 'vue';
import { parseAhx, type AhxInstrument } from '@another-synth/tracker-playback';
import {
  AHX_SIZE_LIMIT,
  BLANK_STEP,
  ahxInstrumentBytes,
  ahxSizeBudget,
  ahxUsedBytes,
  allocTrack,
  assignTrack,
  blankTrack,
  buildAhxFile,
  createNewAhxDoc,
  deletePosition,
  docFromBytes,
  docFromSong,
  insertPosition,
  isBlankTrack,
  makeAhxDoc,
  makeUnique,
  movePosition,
  projectAhxPatterns,
  setRestart,
  setSongName,
  setSpeedMultiplier,
  setStep,
  setTrack,
  setTrackLength,
  setTranspose,
  trackUsage,
  tracksEqual,
  type AhxDoc,
  type AhxOpContext,
  type AhxOpResult,
} from 'src/audio/tracker/ahx-doc';
import { defaultAhxInstrument, emptyPListEntry } from 'src/audio/tracker/ahx-instrument-edit';
import { AhxEncodeError } from 'src/audio/tracker/song-export';
import { ahxCorpus, importTitleOf, instrumentsOf, plainDoc, slotsOf } from './helpers/ahx-doc-fixtures';

const corpus = ahxCorpus();
const file = (name: string) => corpus.find((f) => f.name === name)!;
const step = (note: number, instrument = 0, fx = 0, fxParam = 0) => ({ note, instrument, fx, fxParam, fxb: 0, fxbParam: 0 });
const NUL = String.fromCharCode(0);

/** Unwraps an op that must succeed. */
function ok<T extends object>(result: AhxOpResult<T>): { doc: AhxDoc } & T {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result as unknown as { doc: AhxDoc } & T;
}
const doc = (r: AhxOpResult<object>): AhxDoc => ok(r).doc;
const refusal = (r: AhxOpResult<object>): string => {
  expect(r.ok).toBe(false);
  return (r as { reason: string }).reason;
};

/** A doc built directly, for boundary cases no corpus file has. */
function synthetic(fields: Partial<AhxDoc> & Pick<AhxDoc, 'tracks' | 'positions'>): AhxDoc {
  return makeAhxDoc({
    format: 'ahx',
    version: 1,
    songName: 'x',
    speedMultiplier: 1,
    restart: 0,
    trackLength: fields.tracks[0]?.length ?? 8,
    subsongs: [],
    ...fields,
  });
}
const pos = (...track: number[]) => ({ track, transpose: [0, 0, 0, 0] });

describe('the doc', () => {
  it('is raw and frozen: a reactive wrapper hands back the same object', () => {
    const d = docFromBytes(file('karma.ahx').bytes);
    const state = reactive({ d });
    expect(state.d).toBe(d);
    expect(isReactive(state.d)).toBe(false);
    expect(toRaw(d)).toBe(d);
    expect(Object.isFrozen(d)).toBe(true);
    expect(() => {
      (d as { restart: number }).restart = 3;
    }).toThrow();
  });

  it('keeps the parse as the file has it: shared tracks stay shared, unreferenced tracks stay', () => {
    const d = docFromBytes(file('outcast.ahx').bytes);
    const usage = trackUsage(d);
    expect(d.tracks.length).toBe(256);
    expect(usage.filter((n) => n === 0).length).toBeGreaterThan(200);
    expect(usage.some((n) => n > 1)).toBe(true);
    expect(d.base).toBe(file('outcast.ahx').bytes);
  });

  it('refuses an HVL song', () => {
    const dir = resolve(__dirname, '../../public/demos/ahx');
    const hvl = readdirSync(dir).find((n) => n.endsWith('.hvl'))!;
    expect(() => docFromBytes(new Uint8Array(readFileSync(resolve(dir, hvl))))).toThrow(/HVL/);
  });
});

describe('steps and tracks', () => {
  const base = synthetic({ tracks: [blankTrack(8), blankTrack(8), blankTrack(8)], positions: [pos(1, 0, 0, 2), pos(0, 0, 0, 0)] });

  it('an edit makes one new track and shares the rest', () => {
    const next = doc(setStep(base, 1, 3, step(25, 1, 0xc, 0x20)));
    expect(next.tracks[1]![3]).toEqual(step(25, 1, 0xc, 0x20));
    expect(next.tracks[0]).toBe(base.tracks[0]);
    expect(next.tracks[2]).toBe(base.tracks[2]);
    expect(next.positions).toBe(base.positions);
    expect(base.tracks[1]![3]).toEqual(BLANK_STEP);
  });

  it('a step to the value it already has returns the very same doc', () => {
    expect(doc(setStep(base, 1, 3, step(0)))).toBe(base);
    const edited = doc(setStep(base, 1, 3, step(9)));
    expect(doc(setStep(edited, 1, 3, step(9)))).toBe(edited);
    expect(doc(setTrack(edited, 1, edited.tracks[1]!))).toBe(edited);
  });

  it('refuses what a step cannot hold, with a reason', () => {
    const bad: [string, number, number, ReturnType<typeof step>][] = [
      ['note 64', 1, 0, step(64)],
      ['note -1', 1, 0, step(-1)],
      ['instrument 64', 1, 0, step(1, 64)],
      ['effect 16', 1, 0, step(1, 1, 16)],
      ['param 256', 1, 0, step(1, 1, 1, 256)],
      ['second effect column', 1, 0, { ...step(1), fxb: 1 }],
      ['track 3', 3, 0, step(1)],
      ['row 8', 1, 8, step(1)],
      ['row -1', 1, -1, step(1)],
    ];
    for (const [what, track, row, s] of bad) expect(refusal(setStep(base, track, row, s)), what).toMatch(/\w/);
  });

  it('accepts notes 61..63 (the format holds them, the editor just never types them)', () => {
    expect(doc(setStep(base, 1, 0, step(63))).tracks[1]![0]!.note).toBe(63);
  });

  it('track 0 is copy-on-write while blank, and an ordinary track once it has content', () => {
    expect(refusal(setStep(base, 0, 0, step(5)))).toMatch(/Track 0/);
    expect(doc(setStep(base, 0, 0, step(0)))).toBe(base);
    const filled = synthetic({ tracks: [[step(5), ...blankTrack(7)], blankTrack(8)], positions: [pos(0, 0, 0, 0)] });
    const edited = doc(setStep(filled, 0, 1, step(6)));
    expect(edited.tracks[0]![1]!.note).toBe(6);
    expect(isBlankTrack(doc(setTrack(edited, 0, blankTrack(8))).tracks[0]!)).toBe(true);
  });

  it('setTrack takes exactly trackLength valid steps', () => {
    expect(refusal(setTrack(base, 1, blankTrack(7)))).toMatch(/8 steps/);
    expect(refusal(setTrack(base, 1, [...blankTrack(7), step(99)]))).toMatch(/Row 7/);
    expect(doc(setTrack(base, 2, [step(1), ...blankTrack(7)])).tracks[2]![0]!.note).toBe(1);
  });
});

describe('tracks: allocation, sharing, the 256 limit', () => {
  it('reuses the first unreferenced blank track from 1, then appends', () => {
    const d = synthetic({
      tracks: [blankTrack(4), [step(1), ...blankTrack(3)], blankTrack(4), blankTrack(4), blankTrack(4)],
      positions: [pos(1, 3, 0, 0)],
    });
    // Track 1 is used and non-blank, 2 is unreferenced and blank: reused, the file does not grow.
    const first = ok(allocTrack(d));
    expect(first.track).toBe(2);
    expect(first.doc).toBe(d);
    // 3 is referenced, so with 2 taken the next free one is 4.
    const taken = doc(assignTrack(d, 0, 2, 2));
    expect(ok(allocTrack(taken)).track).toBe(4);
    const full = doc(assignTrack(taken, 0, 3, 4));
    const appended = ok(allocTrack(full));
    expect(appended.track).toBe(5);
    expect(appended.doc.tracks.length).toBe(6);
    expect(ok(allocTrack(d, { append: true })).track).toBe(5);
  });

  it('copyOf copies the steps into a reused or an appended track', () => {
    const d = synthetic({ tracks: [blankTrack(4), [step(7), ...blankTrack(3)], blankTrack(4)], positions: [pos(1, 0, 0, 0)] });
    const reused = ok(allocTrack(d, { copyOf: 1 }));
    expect(reused.track).toBe(2);
    expect(reused.doc.tracks[2]).toEqual(d.tracks[1]);
    expect(ok(allocTrack(d, { copyOf: 1, append: true })).track).toBe(3);
    expect(refusal(allocTrack(d, { copyOf: 9 }))).toMatch(/track 9/);
  });

  it('refuses at 256 tracks and allows the 256th', () => {
    const tracks = Array.from({ length: 255 }, (_, t) => (t === 0 ? blankTrack(2) : [step(1 + (t % 60)), BLANK_STEP]));
    const positions = Array.from({ length: 255 }, (_, p) => pos(p, 0, 0, 0));
    const last = ok(allocTrack(synthetic({ tracks, positions })));
    expect(last.track).toBe(255);
    expect(last.doc.tracks.length).toBe(256);
    expect(refusal(allocTrack(last.doc, { append: true }))).toMatch(/256 tracks/);
    // At 256 with no unreferenced blank track, a plain alloc refuses too.
    expect(refusal(allocTrack(doc(assignTrack(last.doc, 0, 1, 255))))).toMatch(/256 tracks/);
    // The same on a real song that has 256.
    expect(refusal(allocTrack(docFromBytes(file('outcast.ahx').bytes), { append: true }))).toMatch(/256 tracks/);
  });

  it('makeUnique copies a shared track for one cell and leaves a lone track alone', () => {
    const d = synthetic({ tracks: [blankTrack(4), [step(3), ...blankTrack(3)]], positions: [pos(1, 1, 0, 0), pos(1, 0, 0, 0)] });
    const alone = ok(makeUnique(d, 0, 1));
    expect(alone.track).toBe(2);
    expect(alone.doc.positions[0]!.track).toEqual([1, 2, 0, 0]);
    expect(alone.doc.tracks[2]).toEqual(alone.doc.tracks[1]);
    expect(trackUsage(alone.doc)[1]).toBe(2);
    const again = ok(makeUnique(alone.doc, 0, 1));
    expect(again.track).toBe(2);
    expect(again.doc).toBe(alone.doc);
    expect(refusal(makeUnique(d, 5, 0))).toMatch(/position 5/);
    expect(refusal(makeUnique(d, 0, 4))).toMatch(/channels/);
  });

  it('makeUnique never hands the blank track 0 back to a cell, even the last one using it', () => {
    // A new song: [1,0,0,0]. Making channels 2 and 3 unique leaves channel 4 as the only
    // cell on track 0; it used to be told "already alone" and keep it (unwritable).
    let d = createNewAhxDoc();
    expect(d.positions[0]!.track).toEqual([1, 0, 0, 0]);
    for (const ch of [1, 2, 3]) {
      const r = ok(makeUnique(d, 0, ch));
      expect(r.track).not.toBe(0);
      d = r.doc;
    }
    const tracks = d.positions[0]!.track;
    expect(tracks[0]).toBe(1);
    expect(tracks.slice(1).every((t) => t !== 0)).toBe(true);
    expect(new Set(tracks).size).toBe(4);
    expect(trackUsage(d)[0]).toBe(0);
    expect(isBlankTrack(d.tracks[0]!)).toBe(true);
    // A non-blank track 0 (legal in a loaded file) is an ordinary track: alone stays alone.
    const loud = synthetic({ tracks: [[step(3), ...blankTrack(3)], blankTrack(4)], positions: [pos(0, 1, 1, 1)] });
    const alone = ok(makeUnique(loud, 0, 0));
    expect(alone.track).toBe(0);
    expect(alone.doc).toBe(loud);
  });

  it('assignTrack and setTranspose validate and are no-ops on the same value', () => {
    const d = synthetic({ tracks: [blankTrack(4), blankTrack(4)], positions: [pos(1, 0, 0, 0)] });
    expect(doc(assignTrack(d, 0, 0, 1))).toBe(d);
    expect(refusal(assignTrack(d, 0, 0, 2))).toMatch(/track 2/);
    expect(refusal(assignTrack(d, 1, 0, 0))).toMatch(/position 1/);
    expect(doc(setTranspose(d, 0, 0, 0))).toBe(d);
    for (const v of [-128, 127, 0, -1]) expect(doc(setTranspose(d, 0, 2, v)).positions[0]!.transpose[2]).toBe(v);
    for (const v of [-129, 128, 1.5, NaN]) expect(refusal(setTranspose(d, 0, 2, v))).toMatch(/-128 to 127/);
  });
});

describe('size budget', () => {
  it('used equals the serialized nameOffset, for real songs and a new one', () => {
    const cases: [AhxDoc, ReturnType<typeof slotsOf>][] = [];
    for (const name of ['karma.ahx', 'outcast.ahx', 'aces_high.ahx', 'winter_dreams.ahx', 'depressed.ahx']) {
      cases.push([docFromBytes(file(name).bytes), slotsOf(parseAhx(file(name).bytes))]);
    }
    cases.push([createNewAhxDoc(), [{ ahxData: defaultAhxInstrument() }]]);
    for (const [d, slots] of cases) {
      const { bytes } = buildAhxFile({ doc: d, slots, title: d.songName || 'x' });
      const nameOffset = (bytes[4]! << 8) | bytes[5]!;
      const budget = ahxSizeBudget(d, instrumentsOf(slots));
      expect(budget.used).toBe(nameOffset);
      expect(budget.max).toBe(65535);
      expect(budget.remaining).toBe(65535 - nameOffset);
    }
  });

  it('counts an explicit blank track 0 (a version-0 file may store one) and not an omitted one', () => {
    const explicit = docFromBytes(file('winter_dreams.ahx').bytes);
    expect((explicit.base![6]! & 0x80) === 0).toBe(true);
    expect(ahxUsedBytes(explicit)).toBe(14 + 2 * explicit.subsongs.length + 8 * explicit.positions.length + 3 * explicit.trackLength * explicit.tracks.length);
    const omitted = docFromBytes(corpus.find((f) => (f.bytes[6]! & 0x80) !== 0)!.bytes);
    expect(ahxUsedBytes(omitted)).toBe(14 + 2 * omitted.subsongs.length + 8 * omitted.positions.length + 3 * omitted.trackLength * (omitted.tracks.length - 1));
  });

  it('refuses growth exactly at the limit and says by how much; never refuses a change that does not grow', () => {
    const d = synthetic({ tracks: [blankTrack(64), blankTrack(64)], positions: [pos(1, 0, 0, 0)] });
    const fixed = ahxUsedBytes(d, 0);
    // One more track costs 192: with exactly 192 free it fits (the file ends at 65,535), with 191 it does not.
    expect(allocTrack(d, { append: true }, { instrumentBytes: AHX_SIZE_LIMIT - fixed - 192 }).ok).toBe(true);
    expect(refusal(allocTrack(d, { append: true }, { instrumentBytes: AHX_SIZE_LIMIT - fixed - 191 }))).toBe(
      'Song is 65,344 of 65,535 bytes; a new track needs 192.',
    );
    const over: AhxOpContext = { instrumentBytes: AHX_SIZE_LIMIT };
    expect(setStep(d, 1, 0, step(1)).ok).toBe(true);
    expect(setTranspose(d, 0, 0, 5).ok).toBe(true);
    expect(setTrackLength(d, 32, over).ok).toBe(true);
    expect(refusal(insertPosition(d, 0, { kind: 'blank' }, over))).toMatch(/a new position needs 8/);
    expect(refusal(setTrackLength(synthetic({ tracks: [blankTrack(8), blankTrack(8)], positions: [pos(1, 0, 0, 0)] }), 64, over))).toMatch(
      /64 rows per track needs 168/,
    );
  });

  it('a doc reached through ops at the limit still serializes; one track more does not', () => {
    const bulk: AhxInstrument[] = [];
    for (let i = 0; i < 20; i++) {
      const big = defaultAhxInstrument();
      big.plist.entries = Array.from({ length: 255 }, () => emptyPListEntry());
      bulk.push(big);
    }
    const slots = bulk.map((ahxData) => ({ ahxData }));
    const context: AhxOpContext = { instrumentBytes: ahxInstrumentBytes(bulk) };
    let d = createNewAhxDoc();
    let refused = '';
    for (let i = 0; i < 300 && refused === ''; i++) {
      const r = allocTrack(d, { append: true }, context);
      if (r.ok) d = r.doc;
      else refused = r.reason;
    }
    expect(refused).toMatch(/^Song is [\d,]+ of 65,535 bytes; a new track needs 192\.$/);
    expect(ahxSizeBudget(d, bulk).remaining).toBeLessThan(192);
    expect(buildAhxFile({ doc: d, slots, title: d.songName }).bytes.length).toBeGreaterThan(60000);
    const forced = makeAhxDoc({ ...d, tracks: [...d.tracks, blankTrack(d.trackLength)] });
    expect(() => buildAhxFile({ doc: forced, slots, title: d.songName })).toThrow(AhxEncodeError);
  });
});

/** Positions labelled by their first channel's track number, to follow them through an op. */
function labelled(n: number, restart: number, subsongs: number[]): AhxDoc {
  return synthetic({
    tracks: Array.from({ length: n + 1 }, () => blankTrack(4)),
    positions: Array.from({ length: n }, (_, i) => pos(i + 1, 0, 0, 0)),
    restart,
    subsongs,
  });
}
const labelAt = (d: AhxDoc, i: number): number => d.positions[i]!.track[0]!;
const indexOfLabel = (d: AhxDoc, label: number): number => d.positions.findIndex((p) => p.track[0] === label);

describe('position ops and mapPosition (exhaustive on small songs)', () => {
  it('insert: every old position lands where the map says; restart and subsongs follow their content', () => {
    for (let n = 1; n <= 5; n++) {
      for (let restart = 0; restart < n; restart++) {
        for (let at = 0; at <= n; at++) {
          const subsongs = [0, n - 1];
          const before = labelled(n, restart, subsongs);
          const r = ok(insertPosition(before, at, { kind: 'blank' }));
          expect(r.doc.positions.length).toBe(n + 1);
          for (let old = 0; old < n; old++) {
            expect(labelAt(r.doc, r.mapPosition(old)!), `n${n} at${at} old${old}`).toBe(labelAt(before, old));
          }
          expect(r.doc.restart).toBe(r.mapPosition(restart));
          expect(r.doc.subsongs).toEqual(subsongs.map((s) => r.mapPosition(s)));
          expect(r.doc.positions[at]!.track).toEqual([0, 0, 0, 0]);
        }
      }
    }
  });

  it('delete: survivors land where the map says, the deleted one maps to null, restart/subsongs never dangle', () => {
    for (let n = 2; n <= 5; n++) {
      for (let restart = 0; restart < n; restart++) {
        for (let at = 0; at < n; at++) {
          const before = labelled(n, restart, [restart, at, n - 1]);
          const r = ok(deletePosition(before, at));
          expect(r.doc.positions.length).toBe(n - 1);
          for (let old = 0; old < n; old++) {
            const to = r.mapPosition(old);
            if (old === at) expect(to).toBeNull();
            else expect(labelAt(r.doc, to!), `n${n} at${at} old${old}`).toBe(labelAt(before, old));
          }
          expect(r.doc.restart).toBe(restart === at ? Math.min(at, n - 2) : indexOfLabel(r.doc, labelAt(before, restart)));
          for (const s of r.doc.subsongs) expect(s).toBeLessThan(n - 1);
        }
      }
    }
  });

  it('move: a bijection that follows the content, restart and subsongs included', () => {
    for (let n = 1; n <= 5; n++) {
      for (let restart = 0; restart < n; restart++) {
        for (let from = 0; from < n; from++) {
          for (let to = 0; to < n; to++) {
            const before = labelled(n, restart, [n - 1]);
            const r = ok(movePosition(before, from, to));
            const seen = new Set<number>();
            for (let old = 0; old < n; old++) {
              const at = r.mapPosition(old)!;
              seen.add(at);
              expect(labelAt(r.doc, at), `n${n} ${from}->${to} old${old}`).toBe(labelAt(before, old));
            }
            expect(seen.size).toBe(n);
            expect(labelAt(r.doc, to)).toBe(labelAt(before, from));
            expect(r.doc.restart).toBe(r.mapPosition(restart));
            expect(r.doc.subsongs).toEqual([r.mapPosition(n - 1)]);
            if (from === to) expect(r.doc).toBe(before);
          }
        }
      }
    }
  });

  it('the last position cannot be deleted, 1000 positions is the most', () => {
    expect(refusal(deletePosition(labelled(1, 0, []), 0))).toMatch(/at least one position/);
    const positions = (n: number) => Array.from({ length: n }, () => pos(1, 0, 0, 0));
    const tracks = [blankTrack(2), blankTrack(2)];
    expect(refusal(insertPosition(synthetic({ tracks, positions: positions(1000) }), 0))).toMatch(/1000 positions/);
    expect(ok(insertPosition(synthetic({ tracks, positions: positions(999) }), 999)).doc.positions.length).toBe(1000);
    expect(refusal(insertPosition(labelled(2, 0, []), 3))).toMatch(/inserted at 3/);
    expect(refusal(deletePosition(labelled(2, 0, []), 2))).toMatch(/position 2/);
  });

  it('duplicate shares the tracks, duplicateUnique gives each channel its own copy (blank track 0 stays shared)', () => {
    const d = synthetic({
      tracks: [blankTrack(4), [step(1), ...blankTrack(3)], [step(2), ...blankTrack(3)]],
      positions: [{ track: [1, 1, 2, 0], transpose: [3, -4, 5, 6] }],
    });
    const dup = ok(insertPosition(d, 1, { kind: 'duplicate', of: 0 }));
    expect(dup.doc.positions[1]).toEqual(d.positions[0]);
    expect(dup.doc.tracks).toBe(d.tracks);
    const uniq = ok(insertPosition(d, 1, { kind: 'duplicateUnique', of: 0 }));
    const copy = uniq.doc.positions[1]!;
    expect(copy.transpose).toEqual([3, -4, 5, 6]);
    expect(copy.track[3]).toBe(0);
    const own = copy.track.slice(0, 3);
    expect(new Set(own).size).toBe(3);
    own.forEach((t, ch) => {
      expect(tracksEqual(uniq.doc.tracks[t]!, d.tracks[d.positions[0]!.track[ch]!]!)).toBe(true);
      expect(trackUsage(uniq.doc)[t]).toBe(1);
    });
    expect(refusal(insertPosition(d, 0, { kind: 'duplicate', of: 4 }))).toMatch(/position 4/);
  });

  it('a blank position points at track 0, or at fresh blank tracks when track 0 holds content', () => {
    const filled = synthetic({ tracks: [[step(5), ...blankTrack(3)], blankTrack(4), blankTrack(4)], positions: [pos(0, 0, 0, 0)] });
    const tracks = ok(insertPosition(filled, 1)).doc.positions[1]!.track;
    expect(new Set(tracks).size).toBe(4);
    const after = ok(insertPosition(filled, 1)).doc;
    for (const t of tracks) expect(isBlankTrack(after.tracks[t]!)).toBe(true);
    expect(tracks.includes(0)).toBe(false);
  });
});

describe('header ops', () => {
  const d = createNewAhxDoc({ trackLength: 8 });

  it('speed multiplier 1..4, restart within the positions', () => {
    for (const v of [1, 2, 3, 4]) expect(doc(setSpeedMultiplier(d, v)).speedMultiplier).toBe(v);
    for (const v of [0, 5, 1.5]) expect(refusal(setSpeedMultiplier(d, v))).toMatch(/1 to 4/);
    expect(doc(setSpeedMultiplier(d, 1))).toBe(d);
    expect(refusal(setRestart(d, 1))).toMatch(/0 to 0/);
    expect(doc(setRestart(d, 0))).toBe(d);
    expect(doc(setRestart(ok(insertPosition(d, 1)).doc, 1)).restart).toBe(1);
  });

  it('track length grows with blank rows and shrinks by truncating every track', () => {
    const withStep = doc(setStep(d, 1, 7, step(10)));
    const longer = doc(setTrackLength(withStep, 16));
    expect(longer.trackLength).toBe(16);
    for (const t of longer.tracks) expect(t.length).toBe(16);
    expect(longer.tracks[1]![7]!.note).toBe(10);
    expect(longer.tracks[1]!.slice(8).every((s) => s.note === 0)).toBe(true);
    const shorter = doc(setTrackLength(longer, 4));
    for (const t of shorter.tracks) expect(t.length).toBe(4);
    expect(doc(setTrackLength(d, 8))).toBe(d);
    for (const v of [0, 65, 2.5]) expect(refusal(setTrackLength(d, v))).toMatch(/1 to 64/);
    expect(buildAhxFile({ doc: shorter, slots: [{ ahxData: defaultAhxInstrument() }], title: shorter.songName }).bytes[10]).toBe(4);
  });

  it('song name is stored as the file can hold it', () => {
    const named = ok(setSongName(d, `Café ☃ x${NUL}y`));
    expect(named.doc.songName).toBe('Café ? xy');
    expect(named.altered).toBe(true);
    const same = ok(setSongName(named.doc, 'Café ? xy'));
    expect(same.doc).toBe(named.doc);
    expect(same.altered).toBe(false);
  });
});

describe('a no-op edit is invisible', () => {
  it('through the ops, an unedited corpus song still builds the source bytes', () => {
    for (const name of ['karma.ahx', 'outcast.ahx', 'winter_dreams.ahx']) {
      const { bytes } = file(name);
      const song = parseAhx(bytes);
      let d = docFromBytes(bytes);
      const before = d;
      d = doc(setStep(d, 1, 0, d.tracks[1]![0]!));
      d = doc(setTranspose(d, 0, 0, d.positions[0]!.transpose[0]!));
      d = doc(assignTrack(d, 0, 0, d.positions[0]!.track[0]!));
      d = doc(setRestart(d, d.restart));
      d = doc(setSpeedMultiplier(d, d.speedMultiplier));
      d = doc(setTrackLength(d, d.trackLength));
      d = doc(movePosition(d, 0, 0));
      d = doc(setSongName(d, d.songName));
      expect(d).toBe(before);
      const built = buildAhxFile({ doc: d, slots: slotsOf(song), title: importTitleOf(song) }).bytes;
      expect(Array.from(built), name).toEqual(Array.from(bytes));
    }
  });
});

// ---------------------------------------------------------------------------
// Property test
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A cheap structural hash of everything the doc holds (not `base`), to prove an op did not touch its input. */
function fingerprint(d: AhxDoc): number {
  let h = 2166136261;
  const mix = (n: number) => {
    h = Math.imul(h ^ (n & 0xffff), 16777619) >>> 0;
  };
  [d.version, d.speedMultiplier, d.restart, d.trackLength, d.subsongs.length, d.positions.length, d.tracks.length].forEach(mix);
  for (const c of d.songName) mix(c.charCodeAt(0));
  d.subsongs.forEach(mix);
  for (const p of d.positions) for (let ch = 0; ch < 4; ch++) (mix(p.track[ch]!), mix(p.transpose[ch]!));
  for (const t of d.tracks) for (const x of t) [x.note, x.instrument, x.fx, x.fxParam, x.fxb, x.fxbParam].forEach(mix);
  return h;
}

type Slots = { ahxData: AhxInstrument }[];
const bytesOf = (slots: Slots): number => ahxInstrumentBytes(instrumentsOf(slots));

/** Adds instruments with long PLists until `slots` take `target` bytes (never more), so the size limit comes into reach. */
function padSlots(slots: Slots, target: number): void {
  while (slots.length < 63) {
    const room = target - bytesOf(slots);
    if (room < 26) return;
    const big = defaultAhxInstrument();
    big.plist.entries = Array.from({ length: Math.min(255, Math.floor((room - 22) / 4)) }, () => emptyPListEntry());
    slots.push({ ahxData: big });
  }
}

/**
 * `start` grown through the ops (full-length rows, then tracks) and `slots`
 * padded until the file is within `slack` bytes of the limit, so random growth
 * runs into it.
 */
function nearLimit(start: AhxDoc, slots: Slots, slack: number): AhxDoc {
  const context = (): AhxOpContext => ({ instrumentBytes: bytesOf(slots) });
  let d = start;
  const longer = setTrackLength(d, 64, context());
  if (longer.ok) d = longer.doc;
  for (let i = 0; i < 256; i++) {
    const r = allocTrack(d, { append: true }, context());
    if (!r.ok) break;
    d = r.doc;
  }
  padSlots(slots, bytesOf(slots) + Math.max(0, AHX_SIZE_LIMIT - ahxUsedBytes(d, bytesOf(slots)) - slack));
  return d;
}

const slotsWithData = (bytes: Uint8Array): Slots => slotsOf(parseAhx(bytes)).filter((s): s is { ahxData: AhxInstrument } => s.ahxData !== undefined);

describe('property: whatever the ops accept serializes, parses back to the doc and projects the same', () => {
  const songs = ['karma.ahx', 'winter_dreams.ahx', 'depressed.ahx', 'outcast.ahx', 'aces_high.ahx', 'get_to_the_chopper.ahx', 'running.ahx', 'classic_cracktro.ahx'];

  function runSequence(seed: number, start: AhxDoc, slots: Slots, pressure: boolean): { refusals: number; accepted: number; sizeRefusals: number } {
    const rnd = mulberry32(seed);
    const int = (n: number) => Math.floor(rnd() * n);
    const context: AhxOpContext = { instrumentBytes: bytesOf(slots) };
    const track0WasBlank = isBlankTrack(start.tracks[0]!);
    let d = start;
    let refusals = 0;
    let accepted = 0;
    let sizeRefusals = 0;
    for (let i = 0; i < (pressure ? 30 : 14); i++) {
      const P = d.positions.length;
      const T = d.tracks.length;
      const L = d.trackLength;
      // Mostly valid arguments, now and then one just outside.
      const out = (n: number) => (rnd() < 0.08 ? n + int(3) : int(n));
      const growth: (() => AhxOpResult<object>)[] = [
        () => setStep(d, out(T), out(L), step(int(64), int(64), int(16), int(256))),
        () => setTrack(d, out(T), Array.from({ length: L }, () => (rnd() < 0.3 ? step(1 + int(60), int(10)) : BLANK_STEP))),
        () => allocTrack(d, rnd() < 0.5 ? { copyOf: out(T) } : { append: rnd() < 0.5 }, context),
        () => assignTrack(d, out(P), out(4), out(T)),
        () => makeUnique(d, out(P), out(4), context),
        () => insertPosition(d, out(P + 1), { kind: 'blank' }, context),
        () => insertPosition(d, out(P + 1), { kind: 'duplicate', of: out(P) }, context),
        () => insertPosition(d, out(P + 1), { kind: 'duplicateUnique', of: out(P) }, context),
        () => setTrackLength(d, 1 + int(66), context),
        () => allocTrack(d, { append: true }, context),
        () => allocTrack(d, { copyOf: out(T), append: true }, context),
      ];
      const others: (() => AhxOpResult<object>)[] = [
        () => setTranspose(d, out(P), out(4), int(260) - 130),
        () => deletePosition(d, out(P)),
        () => movePosition(d, out(P), out(P)),
        () => setSpeedMultiplier(d, int(6)),
        () => setRestart(d, out(P)),
        () => setSongName(d, ['', 'a b ', `x${NUL}☃`][int(3)]!),
      ];
      const ops = pressure ? growth : [...growth, ...others];
      const result = ops[int(ops.length)]!();

      const before = fingerprint(d);
      if (!result.ok) {
        refusals++;
        if (/of 65,535 bytes/.test(result.reason)) sizeRefusals++;
        expect(result.reason.length).toBeGreaterThan(0);
        expect(fingerprint(d)).toBe(before);
        continue;
      }
      accepted++;
      // Purity: the input doc is untouched by an accepted op too.
      expect(fingerprint(d)).toBe(before);
      d = (result as { doc: AhxDoc }).doc;

      // Invariants of every reachable doc.
      expect(d.positions.length).toBeGreaterThanOrEqual(1);
      expect(d.restart).toBeLessThan(d.positions.length);
      expect(d.subsongs.every((s) => s < d.positions.length)).toBe(true);
      expect(d.positions.every((p) => p.track.length === 4 && p.track.every((t) => t < d.tracks.length))).toBe(true);
      expect(d.tracks.every((t) => t.length === d.trackLength)).toBe(true);
      if (track0WasBlank) expect(isBlankTrack(d.tracks[0]!)).toBe(true);

      // It serializes, and the file is the doc.
      const built = buildAhxFile({ doc: d, slots, title: d.songName.trim() || 'Imported AHX' }).bytes;
      const parsed = parseAhx(built);
      const reread = docFromSong(parsed);
      expect(fingerprint(reread)).toBe(fingerprint(d));
      expect((built[4]! << 8) | built[5]!).toBe(ahxUsedBytes(d, context.instrumentBytes));
      // The full deep comparisons are the slow part: every third accepted op, and always the last.
      if (accepted % 3 === 0 || i === (pressure ? 29 : 13)) {
        expect(plainDoc(reread)).toEqual(plainDoc(d));
        expect(projectAhxPatterns(reread)).toEqual(projectAhxPatterns(d));
      }
    }
    return { refusals, accepted, sizeRefusals };
  }

  it('300 random op sequences on 8 corpus songs and a new song, with and without size pressure', () => {
    let refusals = 0;
    let accepted = 0;
    let sizeRefusals = 0;
    for (let s = 0; s < 300; s++) {
      const pressure = s % 5 === 4;
      const bytes = file(songs[s % songs.length]!).bytes;
      const useNew = s % 10 === 3;
      const slots: Slots = useNew ? [{ ahxData: defaultAhxInstrument() }] : slotsWithData(bytes);
      let start = useNew ? createNewAhxDoc({ trackLength: ([8, 16, 64] as const)[s % 3]! }) : docFromBytes(bytes);
      if (pressure) start = nearLimit(start, slots, 40);
      const r = runSequence(1000 + s, start, slots, pressure);
      refusals += r.refusals;
      accepted += r.accepted;
      sizeRefusals += r.sizeRefusals;
    }
    // The generator must reach both sides, or the test proves nothing.
    expect(accepted).toBeGreaterThan(1500);
    expect(refusals).toBeGreaterThan(300);
    expect(sizeRefusals).toBeGreaterThan(10);
  }, 280_000);

  it('the pressure runs really reach the size limit', () => {
    const bytes = file('karma.ahx').bytes;
    const slots = slotsWithData(bytes);
    const d = nearLimit(docFromBytes(bytes), slots, 40);
    expect(ahxSizeBudget(d, instrumentsOf(slots)).remaining).toBeLessThan(300);
    const refused = insertPosition(d, 0, { kind: 'blank' }, { instrumentBytes: bytesOf(slots) });
    let last = d;
    let reason = '';
    for (let i = 0; i < 40 && reason === ''; i++) {
      const r = insertPosition(last, 0, { kind: 'blank' }, { instrumentBytes: bytesOf(slots) });
      if (r.ok) last = r.doc;
      else reason = r.reason;
    }
    expect(refused.ok || reason !== '').toBe(true);
    expect(reason).toMatch(/^Song is [\d,]+ of 65,535 bytes; a new position needs 8\.$/);
    expect(buildAhxFile({ doc: last, slots, title: 'x' }).bytes.length).toBeGreaterThan(60000);
  });
});
