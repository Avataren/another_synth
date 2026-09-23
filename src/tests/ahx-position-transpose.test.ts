import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { parseAhx } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { currentAhxSource, setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { ahxTransposeLabel } from 'src/audio/tracker/ahx-position-display';

// ---------------------------------------------------------------------------
// Fixtures (the `ahx-writeback.test.ts` harness: real store, real load path)
// ---------------------------------------------------------------------------

const toBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function loadBytes(bytes: Uint8Array): ReturnType<typeof useTrackerStore> {
  const store = useTrackerStore();
  const file = importAhxToTrackerSong(toBuffer(bytes));
  store.loadSongFile(file);
  setCurrentAhxSource(bytes, { format: 'ahx', version: 0, edits: [] });
  return store;
}

const demoPath = path.resolve(__dirname, '../../public/demos/ahx/i_love_holy_daze.ahx');
const holyDazeBytes = (): Uint8Array => new Uint8Array(fs.readFileSync(demoPath));

// ---------------------------------------------------------------------------
// The ground truth (MEASURED, `.ai/probe/holy-daze.mts`): the engine probe of
// the demo song, channel index 2 (0-based; Morten's ch3). Orders 46-49 have
// blank track 0 slots while track 41 sustains — the shift happens on
// positions that look silent in the grid, which is why the display sits on
// the track headers, not the rows.
// ---------------------------------------------------------------------------
const HOLY_DAZE_TRANSPOSES: readonly (readonly [order: number, value: number])[] = [
  [42, -1],
  [44, -2],
  [46, -3],
  [48, 0],
  [49, 0],
  [52, -1],
  [54, -3],
];

describe('the per-position per-channel transpose (plan-pos-transpose.md)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    setCurrentAhxSource(null);
  });

  it('parses the holy daze demo to the engine-probe table', () => {
    const song = parseAhx(holyDazeBytes());
    expect(song.positions.length).toBeGreaterThan(54);
    for (const [order, value] of HOLY_DAZE_TRANSPOSES) {
      expect(song.positions[order]?.transpose[2], `order ${order}`).toBe(value);
    }
  });

  it('the store doc holds the holy daze table after the real load path', () => {
    const store = loadBytes(holyDazeBytes());
    expect(store.isAhxEditable).toBe(true);
    const doc = store.ahxDoc;
    expect(doc).not.toBeNull();
    for (const [order, value] of HOLY_DAZE_TRANSPOSES) {
      expect(doc?.positions[order]?.transpose[2], `order ${order}`).toBe(value);
    }
  });

  it('the labels for the holy daze orders read T-1 / T-2 / T-3 / T0', () => {
    expect(HOLY_DAZE_TRANSPOSES.map(([, value]) => ahxTransposeLabel(value))).toEqual([
      'T-1', 'T-2', 'T-3', 'T0', 'T0', 'T-1', 'T-3',
    ]);
  });

  // plan-hvl-header-ux-0923.md BUG 1: an HVL never gets a doc (adoptAhxDoc
  // early-returns for its 'hvl' source record), so its read-only header chip
  // rides the pattern's own `positionTranspose` — which the real load path
  // must keep intact, not sanitize away with unknown fields.
  it('an HVL load keeps the per-pattern transpose the read-only chip reads', () => {
    const buf = fs.readFileSync(path.resolve(__dirname, '../../public/demos/ahx/doobrey_gubbins.hvl'));
    const raw = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const song = parseAhx(raw);
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    ));
    // No doc, read-only display: exactly the branch the HVL chip lives on.
    expect(store.isAhxEditable).toBe(false);
    expect(store.currentPattern?.positionTranspose).not.toBeUndefined();
    expect(store.currentPattern?.positionTranspose).toEqual(song.positions[0]!.transpose);
    // The current pattern's slot is its position, so the chip can title it.
    expect(store.sequence.indexOf(store.currentPatternId ?? '')).toBe(0);
  });

  describe('setAhxPositionTranspose', () => {
    it('writes the byte, republishes bytes the engine can parse, and keeps neighbours', () => {
      const store = loadBytes(holyDazeBytes());
      const before = store.ahxDoc?.positions[42]?.transpose.slice() as number[];
      expect(store.setAhxPositionTranspose(42, 2, 3)).toBe(true);
      expect(store.ahxDoc?.positions[42]?.transpose[2]).toBe(3);
      expect(store.ahxDoc?.positions[42]?.transpose[0]).toBe(before[0]);
      expect(store.ahxDoc?.positions[44]?.transpose[2]).toBe(-2);
      // The bytes the engine holds parse back to the edited song (B2a's rule:
      // the grid, the editor and Play never diverge).
      const bytes = currentAhxSource();
      expect(bytes).not.toBeNull();
      const song = parseAhx(bytes as Uint8Array);
      expect(song.positions[42]?.transpose[2]).toBe(3);
    });

    it('is a no-op on the same value: no history entry, no byte swap', () => {
      const store = loadBytes(holyDazeBytes());
      const revision = store.ahxRevision;
      const undoDepth = store.undoStack.length;
      expect(store.setAhxPositionTranspose(42, 2, -1)).toBe(false);
      expect(store.ahxRevision).toBe(revision);
      expect(store.undoStack.length).toBe(undoDepth);
    });

    it('undoes through the store snapshot (the doc is re-projected, the byte restored)', () => {
      const store = loadBytes(holyDazeBytes());
      expect(store.setAhxPositionTranspose(42, 2, 5)).toBe(true);
      store.undo();
      expect(store.ahxDoc?.positions[42]?.transpose[2]).toBe(-1);
      expect(store.undoStack.length).toBe(0);
    });

    it('refuses an out-of-range value with the op reason, before any history', () => {
      const store = loadBytes(holyDazeBytes());
      const undoDepth = store.undoStack.length;
      expect(store.setAhxPositionTranspose(42, 2, 128)).toBe(false);
      expect(store.ahxDoc?.positions[42]?.transpose[2]).toBe(-1);
      expect(store.undoStack.length).toBe(undoDepth);
    });

    it('refuses a position and a channel the song does not have', () => {
      const store = loadBytes(holyDazeBytes());
      expect(store.setAhxPositionTranspose(store.ahxDoc?.positions.length ?? 0, 0, 1)).toBe(false);
      expect(store.setAhxPositionTranspose(42, 4, 1)).toBe(false); // AHX has exactly 4 channels.
    });
  });
});
