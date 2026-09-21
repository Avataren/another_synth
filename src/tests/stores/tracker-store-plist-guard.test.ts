import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { AhxInstrument } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { AHX_SIZE_LIMIT, ahxInstrumentBytes, ahxUsedBytes, buildAhxFile } from 'src/audio/tracker/ahx-doc';
import { ahxEditNotice, clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { addAhxPListEntry, removeAhxPListEntry, setAhxNumber } from 'src/audio/tracker/ahx-instrument-edit';
import {
  commitPListEdit,
  createPListGesture,
  deletePListRow,
  insertPListRowBefore,
  modifyPListEntry,
  writePListNibble,
  type PListEditHost,
} from 'src/audio/tracker/plist-edit';
import { corpusBytes, nearFullSong } from '../helpers/ahx-near-full';

type Store = ReturnType<typeof useTrackerStore>;
const AHX = { format: 'ahx', version: 1 } as const;
const toBuffer = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Karma as an editable song (a doc), with its slots and doc grown to within `slack` bytes of the limit. */
function nearFullStore(slack: number): Store {
  const store = useTrackerStore();
  store.loadSongFile(importAhxToTrackerSong(toBuffer(corpusBytes('karma.ahx'))));
  const bytes = store.currentAhxBytes();
  expect(bytes).not.toBeNull();
  setCurrentAhxSource(bytes, { format: 'ahx', version: store.ahxDoc!.version, edits: [] });
  expect(store.isAhxEditable).toBe(true);
  const { doc, slots } = nearFullSong('karma.ahx', slack);
  const template = clone(store.instrumentSlots[0]!);
  slots.forEach((slot, i) => {
    const target = store.instrumentSlots[i]!;
    if (target.ahxData === undefined) Object.assign(target, clone(template), { slot: i + 1 });
    target.ahxData = clone(slot.ahxData);
  });
  store.ahxDoc = doc;
  return store;
}

const instrumentBytes = (store: Store): number =>
  ahxInstrumentBytes(store.instrumentSlots.flatMap((s) => (s.ahxData ? [s.ahxData] : [])));
const remaining = (store: Store): number => AHX_SIZE_LIMIT - ahxUsedBytes(store.ahxDoc!, instrumentBytes(store));

function hostOf(store: Store): PListEditHost {
  return {
    canUndo: () => store.isAhxEditable,
    pushHistory: () => store.pushHistory(),
    ahxInstrumentRefusal: (slot, next) => store.ahxInstrumentRefusal(slot, next),
    updateAhxInstrument: (slot, next) => store.updateAhxInstrument(slot, next),
  };
}

describe('the size guard in trackerStore.updateAhxInstrument', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setCurrentAhxSource(null);
    clearAhxEditNotice();
  });
  afterEach(() => clearAhxEditNotice());

  it('refuses growth past the limit (the table’s Add row included) with the reason, and changes nothing', () => {
    const store = nearFullStore(0);
    expect(remaining(store)).toBeLessThan(4);
    const before = clone(store.instrumentSlots[0]!.ahxData!);
    const used = ahxUsedBytes(store.ahxDoc!, instrumentBytes(store));
    const message = `Song is ${used.toLocaleString('en-US')} of 65,535 bytes; a PList row needs 4.`;

    // The table's own primitive: what its Add row button runs.
    const grown = addAhxPListEntry(before, 0);
    expect(store.ahxInstrumentRefusal(1, grown)).toBe(message);
    expect(store.updateAhxInstrument(1, grown)).toBe('rejected');
    expect(ahxEditNotice.value?.message).toBe(message);
    expect(store.instrumentSlots[0]!.ahxData).toEqual(before);
    expect(store.currentAhxBytes()).not.toBeNull(); // the file still serializes
  });

  it('accepts an edit that does not grow the file, on a full song', () => {
    const store = nearFullStore(0);
    const before = clone(store.instrumentSlots[0]!.ahxData!);
    expect(store.ahxInstrumentRefusal(1, setAhxNumber(before, 'volume', 33))).toBeNull();
    expect(['applied', 'kept']).toContain(store.updateAhxInstrument(1, setAhxNumber(before, 'volume', 33)));
    expect(store.instrumentSlots[0]!.ahxData!.volume).toBe(33);
    expect(ahxEditNotice.value).toBeNull();
    const plistEdit = modifyPListEntry(store.instrumentSlots[0]!.ahxData!, 0, { field: 'note', value: 12 }, AHX);
    expect(plistEdit.ok && plistEdit.changed).toBe(true);
    if (plistEdit.ok) expect(['applied', 'kept']).toContain(store.updateAhxInstrument(1, plistEdit.instrument));
  });

  it('accepts a shrink, and then the row fits again, exactly to the limit', () => {
    const store = nearFullStore(0);
    const original = clone(store.instrumentSlots[0]!.ahxData!);
    const shrunk = removeAhxPListEntry(original, 0);
    expect(['applied', 'kept']).toContain(store.updateAhxInstrument(1, shrunk));
    expect(remaining(store)).toBeGreaterThanOrEqual(4);
    expect(['applied', 'kept']).toContain(store.updateAhxInstrument(1, original));
    expect(remaining(store)).toBeGreaterThanOrEqual(0);
    expect(remaining(store)).toBeLessThan(4);
    expect(store.currentAhxBytes()).not.toBeNull();
  });

  it('a song with no doc has no budget here (it cannot be exported from the editor)', () => {
    const store = nearFullStore(0);
    store.ahxDoc = null;
    const grown = addAhxPListEntry(clone(store.instrumentSlots[0]!.ahxData!), 0);
    expect(store.ahxInstrumentRefusal(1, grown)).toBeNull();
    expect(['applied', 'kept']).toContain(store.updateAhxInstrument(1, grown));
  });

  it('the other refusals keep saying rejected, with a reason from ahxInstrumentRefusal and no notice', () => {
    const store = nearFullStore(0);
    const ins = clone(store.instrumentSlots[0]!.ahxData!);
    expect(store.ahxInstrumentRefusal(999, ins)).toBe('Slot 999 holds no AHX instrument.');
    expect(store.updateAhxInstrument(999, ins)).toBe('rejected');
    expect(store.ahxInstrumentRefusal(1, { ...ins, waveLength: 9 })).toBe('That is not a valid instrument for this song.');
    expect(ahxEditNotice.value).toBeNull();
  });

  describe('the undo hook', () => {
    it('one undo step per gesture, none for a refusal, and undo brings the PList back', () => {
      const store = nearFullStore(40);
      const host = hostOf(store);
      const gesture = createPListGesture();
      const original = clone(store.instrumentSlots[0]!.ahxData!);
      const steps = (): number => store.undoStack.length;
      const start = steps();

      // Three nibble strokes into one cell: one step.
      let cur = store.instrumentSlots[0]!.ahxData!;
      for (const [nibble, digit] of [[0, 5], [1, 1], [2, 0xa]] as const) {
        const r = writePListNibble(cur, 0, 0, nibble, digit, AHX);
        expect(commitPListEdit(host, gesture, 1, r, { continues: true }).ok).toBe(true);
        cur = store.instrumentSlots[0]!.ahxData!;
      }
      expect(steps()).toBe(start + 1);
      expect(cur.plist.entries[0]!.fx[0]).toBe(5);
      expect(cur.plist.entries[0]!.fxParam[0]).toBe(0x1a);

      // A refused key (a command AHX lacks) leaves no step and says why.
      gesture.close();
      const refused = commitPListEdit(host, gesture, 1, writePListNibble(cur, 0, 1, 0, 9, AHX), { continues: true });
      expect(refused).toEqual({ ok: false, reason: 'Command 9 is not available in an AHX PList.' });
      expect(steps()).toBe(start + 1);

      // A menu pick: its own step.
      gesture.close();
      expect(commitPListEdit(host, gesture, 1, deletePListRow(cur, 0, AHX)).ok).toBe(true);
      expect(steps()).toBe(start + 2);

      store.undo();
      store.undo();
      expect(store.instrumentSlots[0]!.ahxData!.plist).toEqual(original.plist);
    });

    it('a refused growth leaves no undo step, and the song still serializes', () => {
      const store = nearFullStore(0);
      const host = hostOf(store);
      const start = store.undoStack.length;
      const r = commitPListEdit(host, createPListGesture(), 1, insertPListRowBefore(store.instrumentSlots[0]!.ahxData!, 0, AHX));
      expect(r.ok).toBe(false);
      expect(r.ok ? '' : r.reason).toMatch(/^Song is [\d,]+ of 65,535 bytes; a PList row needs 4\.$/);
      expect(store.undoStack.length).toBe(start);
      expect(store.currentAhxBytes()).not.toBeNull();
    });

    it('records nothing on a song without undo (no doc), and still writes', () => {
      const store = nearFullStore(40);
      store.ahxDoc = null;
      expect(store.isAhxEditable).toBe(false);
      const start = store.undoStack.length;
      const r = commitPListEdit(hostOf(store), createPListGesture(), 1, modifyPListEntry(store.instrumentSlots[0]!.ahxData!, 0, { field: 'note', value: 20 }, AHX));
      expect(r.ok).toBe(true);
      expect(store.undoStack.length).toBe(start);
      expect(store.instrumentSlots[0]!.ahxData!.plist.entries[0]!.note).toBe(20);
    });
  });

  it('property (store path): random PList edits through the store keep the file serializable', () => {
    let refused = 0;
    let accepted = 0;
    for (let s = 0; s < 12; s++) {
      setActivePinia(createPinia());
      setCurrentAhxSource(null);
      const store = nearFullStore(s % 3 === 0 ? 0 : 20);
      const host = hostOf(store);
      const gesture = createPListGesture();
      let seed = 900 + s;
      const rnd = (): number => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return (seed >>> 8) / 16777216;
      };
      for (let i = 0; i < 25; i++) {
        const slotNo = 1 + Math.floor(rnd() * store.instrumentSlots.filter((x) => x.ahxData).length);
        const ins: AhxInstrument = store.instrumentSlots[slotNo - 1]!.ahxData!;
        const row = Math.floor(rnd() * Math.max(1, ins.plist.entries.length));
        const result =
          rnd() < 0.6
            ? insertPListRowBefore(ins, row, AHX)
            : rnd() < 0.5
              ? modifyPListEntry(ins, row, { field: 'note', value: Math.floor(rnd() * 64) }, AHX)
              : deletePListRow(ins, row, AHX);
        const out = commitPListEdit(host, gesture, slotNo, result);
        if (out.ok) accepted++;
        else refused++;
        expect(remaining(store)).toBeGreaterThanOrEqual(0);
        const built = buildAhxFile({ doc: store.ahxDoc!, slots: store.instrumentSlots, title: 'x' }).bytes;
        expect((built[4]! << 8) | built[5]!).toBe(ahxUsedBytes(store.ahxDoc!, instrumentBytes(store)));
      }
    }
    expect(accepted).toBeGreaterThan(50);
    expect(refused).toBeGreaterThan(5);
  }, 120_000);
});
