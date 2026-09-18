import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useTrackerSelection } from 'src/composables/useTrackerSelection';
import type { TrackerSelectionContext } from 'src/composables/useTrackerSelection';
import type { TrackerPattern } from 'src/stores/tracker-store';

function setup(readOnly: boolean | undefined) {
  const pattern = {
    id: 'p1',
    name: 'P',
    rows: 4,
    tracks: [
      { id: 'T01', name: 'T', color: '#fff', entries: [{ note: 'C-4' }, { note: 'D-4' }] },
    ],
  } as unknown as TrackerPattern;
  const pushHistory = vi.fn();
  const isEditMode = ref(false);
  const context: TrackerSelectionContext = {
    activeRow: ref(0),
    activeTrack: ref(0),
    isEditMode,
    ...(readOnly === undefined ? {} : { isReadOnly: ref(readOnly) }),
    rowsCount: ref(4),
    currentPattern: computed(() => pattern),
    pushHistory,
    parseTrackerNoteSymbol: (note) => ({ isNoteOff: false, midi: note === 'C-4' ? 60 : 62 }),
    midiToTrackerNote: (midi) => `n${midi}`,
  };
  return { sel: useTrackerSelection(context), pattern, pushHistory, isEditMode };
}

describe('track and pattern operations on a read-only song', () => {
  it.each([
    ['cutTrack', (s: ReturnType<typeof setup>) => s.sel.cutTrack()],
    ['transposeTrack', (s: ReturnType<typeof setup>) => s.sel.transposeTrack(1)],
    ['cutPattern', (s: ReturnType<typeof setup>) => s.sel.cutPattern()],
    ['transposePattern', (s: ReturnType<typeof setup>) => s.sel.transposePattern(1)],
    [
      'pasteTrack',
      (s: ReturnType<typeof setup>) => {
        s.sel.copyTrack();
        s.sel.pasteTrack();
      },
    ],
    [
      'pastePattern',
      (s: ReturnType<typeof setup>) => {
        s.sel.copyPattern();
        s.sel.pastePattern();
      },
    ],
  ])('%s changes nothing, records no history and does not switch edit mode on', (_name, run) => {
    const s = setup(true);
    const before = JSON.stringify(s.pattern);
    run(s);
    expect(JSON.stringify(s.pattern)).toBe(before);
    expect(s.pushHistory).not.toHaveBeenCalled();
    expect(s.isEditMode.value).toBe(false);
  });

  it('the same operations still work when the song is editable', () => {
    const s = setup(false);
    s.sel.transposeTrack(1);
    expect(s.pattern.tracks[0]!.entries.map((e) => e.note)).toEqual(['n61', 'n63']);
    expect(s.pushHistory).toHaveBeenCalledOnce();
    expect(s.isEditMode.value).toBe(true);
  });

  it('and when the host does not say (older callers)', () => {
    const s = setup(undefined);
    s.sel.cutTrack();
    expect(s.pattern.tracks[0]!.entries).toEqual([]);
  });
});
