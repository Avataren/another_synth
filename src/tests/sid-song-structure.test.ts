import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ahxEditNotice, clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import {
  BLANK_SID_ROW,
  createNewSidDoc,
  decodeSidFile,
  encodeSidFile,
  makeSidDoc,
  type SidDoc,
  type SidDocRow,
} from 'src/audio/tracker/sid-doc';
import { useTrackerStore } from 'src/stores/tracker-store';
import { sidGridHarness as harness } from './helpers/sid-grid-harness';

/**
 * plan-sid-authoring.md phase 2 (the flat model): a SID song's patterns and
 * sequence are edited like any song's, through the store's own pattern and
 * sequence actions, and compile to GoatTracker's orderlists. What the voices
 * play is what the grid shows, position by position; each voice keeps its
 * loop point on its position through sequence edits; subsongs are shown and
 * edited one at a time; what GT cannot hold is refused and put back.
 */

const noticeText = () => ahxEditNotice.value?.message ?? null;

beforeEach(() => {
  setActivePinia(createPinia());
  clearAhxEditNotice();
});
afterEach(() => clearAhxEditNotice());

/** Voice `voice`'s rows as the doc plays them through subsong `subsong`'s first pass (transposed notes). */
function played(doc: SidDoc, subsong: number, voice: number): string[] {
  const out: string[] = [];
  for (const e of doc.subsongs[subsong]!.orderlists[voice]!.entries) {
    for (let k = 0; k < e.repeat; k++) {
      for (const r of doc.patterns[e.pattern]!.rows) out.push(r.note > 0 && r.note < 94 ? `${r.note + e.transpose}` : r.note === 0 ? '.' : String(r.note));
    }
  }
  return out;
}

describe('patterns and the sequence', () => {
  it('a pattern named twice in the sequence plays twice, and an edit of it shows in both places', () => {
    const h = harness();
    h.store.pushHistory();
    h.store.addPatternToSequence('sid-pos-0');
    expect(h.store.sequence).toEqual(['sid-pos-0', 'sid-pos-1', 'sid-pos-0']);
    h.at(0, 1, 2);
    h.editing.handleNoteEntry(60);
    const doc = h.sid();
    const v2 = played(doc, 0, 1);
    expect(v2).toHaveLength(48);
    // Position 0 and position 2 (the same pattern) both play the note at their row 2.
    expect(v2[2]).toBe(v2[32 + 2]);
    expect(v2[2]).toBe('49');
  });

  it('moving and removing positions keep each voice\'s loop point on its position', () => {
    // Voice 1 loops to position 1, voices 2 and 3 to position 2.
    const base = createNewSidDoc({ patternRows: 4 });
    const pattern = (n: number) => ({ rows: [{ ...BLANK_SID_ROW, note: n, instrument: 1 }, BLANK_SID_ROW, BLANK_SID_ROW, BLANK_SID_ROW] });
    const doc = makeSidDoc({
      ...base,
      patterns: [pattern(10), pattern(20), pattern(30), pattern(40)],
      subsongs: [
        {
          orderlists: [0, 1, 2].map((_, v) => ({
            entries: [0, 1, 2, 3].map((p) => ({ pattern: p, transpose: 0, repeat: 1 })),
            restart: v === 0 ? 1 : 2,
          })),
        },
      ],
    });
    const h = harness(doc);
    expect(h.store.sidFlat[0]!.restarts).toEqual([1, 2, 2]);
    h.store.moveSequenceItem(1, 3); // positions: 0 2 3 1
    expect(h.store.sidFlat[0]!.restarts).toEqual([3, 1, 1]);
    h.store.removePatternFromSequence(0); // 2 3 1
    expect(h.store.sidFlat[0]!.restarts).toEqual([2, 0, 0]);
    const compiled = h.sid();
    // Voice 1 loops back to the entry that plays note 20 (old position 1); voices 2 and 3 to note 30.
    const loopNote = (v: number) => {
      const list = compiled.subsongs[0]!.orderlists[v]!;
      return compiled.patterns[list.entries[list.restart]!.pattern]!.rows[0]!.note;
    };
    expect([0, 1, 2].map(loopNote)).toEqual([20, 30, 30]);
  });

  it('a new pattern takes the song\'s rows (at most 128) and its length can be set, up to GoatTracker\'s 128', () => {
    const h = harness();
    h.store.pushHistory();
    const id = h.store.createPattern();
    h.store.addPatternToSequence(id);
    h.store.setPatternRows(200, id);
    expect(h.store.patterns.find((p) => p.id === id)!.rows).toBe(128);
    const doc = h.sid();
    expect(played(doc, 0, 0)).toHaveLength(32 + 128);
  });

  it('what GoatTracker cannot hold is refused and put back, with the reason', () => {
    // 255 plain positions alternating two patterns: 255 orderlist bytes.
    const h = harness(createNewSidDoc({ patternRows: 1 }));
    h.store.pushHistory();
    const other = h.store.createPattern();
    h.at(0, 0, 0);
    h.editing.handleNoteEntry(60);
    let n = 1;
    while (n < 300 && noticeText() === null) {
      h.store.addPatternToSequence(n % 2 ? other : 'sid-pos-0');
      n++;
    }
    expect(noticeText()).toBe("Voice 1's GoatTracker orderlist would take 255 bytes; GoatTracker's holds 254. Use fewer or longer patterns.");
    expect(h.store.sequence).toHaveLength(254);
    expect(h.sid().subsongs[0]!.orderlists[0]!.entries).toHaveLength(254);
  });

  it('an undo of a sequence edit gives back the doc byte for byte, and the grid', () => {
    const h = harness();
    const before = encodeSidFile(h.sid());
    h.store.pushHistory();
    const id = h.store.createPattern();
    h.store.addPatternToSequence(id);
    h.store.pushHistory();
    h.store.moveSequenceItem(2, 0);
    expect(encodeSidFile(h.sid())).not.toBe(before);
    h.store.undo();
    h.store.undo();
    expect(encodeSidFile(h.sid())).toBe(before);
    expect(h.store.sequence).toEqual(['sid-pos-0', 'sid-pos-1']);
    h.store.redo();
    h.store.redo();
    expect(h.store.sequence).toEqual([id, 'sid-pos-0', 'sid-pos-1']);
  });

  it('an unedited song keeps its doc (it saves byte for byte); a save after an edit loads back as the grid it was', () => {
    const h = harness();
    const adopted = h.store.sidDoc;
    h.store.pushHistory();
    h.store.addPatternToSequence('sid-pos-1');
    h.at(2, 0, 4);
    h.editing.handleNoteEntry(64);
    const file = h.store.serializeSong();
    expect(adopted).not.toBe(h.store.sidDoc);
    const decoded = decodeSidFile(file.data.sidFile as string);
    expect(decoded.ok && decoded.doc).toEqual(h.sid());

    setActivePinia(createPinia());
    const other = useTrackerStore();
    other.loadSongFile(JSON.parse(JSON.stringify(file)));
    const cells = (patterns: typeof other.patterns, sequence: string[]) =>
      sequence.map((id) => patterns.find((p) => p.id === id)!.tracks.map((t) => t.entries));
    expect(cells(other.patterns, other.sequence)).toEqual(cells(h.store.patterns, h.store.sequence));
  });
});

describe('subsongs', () => {
  it('the grid shows the chosen subsong; an edit there changes that subsong only', () => {
    const h = harness();
    const before = h.sid();
    expect(h.store.sidFlat).toHaveLength(2);
    const revision = h.store.sidRevision;
    h.store.selectSidSubsong(1);
    expect(h.store.sidSubsong).toBe(1);
    // What plays changed (the transport plays the shown subsong).
    expect(h.store.sidRevision).toBe(revision + 1);
    // Subsong 1: voice 3 plays P0 up an octave; P0 row 0 is A-4, so A-5.
    expect(h.entryAt(0, 2, 0)?.note).toBe('A-5');
    h.store.pushHistory();
    h.at(0, 0, 1);
    h.editing.handleNoteEntry(62);
    const after = h.sid();
    expect(played(after, 0, 0)).toEqual(played(before, 0, 0));
    expect(played(after, 0, 2)).toEqual(played(before, 0, 2));
    expect(played(after, 1, 0)[1]).toBe(String(62 - 12 + 1));
    // Back to subsong 0: its grid, unchanged.
    h.store.selectSidSubsong(0);
    expect(h.entryAt(0, 0, 0)?.note).toBe('A-4');
    // Undo: the doc and the subsong it was made on.
    h.store.undo();
    expect(h.store.sidSubsong).toBe(1);
    expect(encodeSidFile(h.sid())).toBe(encodeSidFile(before));
  });
});

describe('a row the grid does not show survives a sequence edit around it', () => {
  it('a key-on in a cell stays through a move', () => {
    const base = createNewSidDoc({ patternRows: 4 });
    const on: SidDocRow = { note: 127, instrument: 0, command: 0, param: 0 };
    const doc = makeSidDoc({ ...base, patterns: [{ rows: [on, BLANK_SID_ROW, BLANK_SID_ROW, BLANK_SID_ROW] }, base.patterns[1]!, base.patterns[2]!] });
    const h = harness(doc);
    h.store.pushHistory();
    const id = h.store.createPattern();
    h.store.addPatternToSequence(id);
    h.store.moveSequenceItem(1, 0);
    const compiled = h.sid();
    const list = compiled.subsongs[0]!.orderlists[0]!;
    expect(compiled.patterns[list.entries[list.entries.length - 1]!.pattern]!.rows[0]).toEqual(on);
  });
});
