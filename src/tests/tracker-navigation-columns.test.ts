import { describe, it, expect } from 'vitest';
import { computed, ref } from 'vue';
import { useTrackerNavigation } from 'src/composables/useTrackerNavigation';
import { trackColumns, visibleColumnIndices } from 'src/components/tracker/track-metrics';
import type { TrackerPattern } from 'src/stores/tracker-store';

/**
 * Left/right through a row's cells walks the columns the song's rows have: an
 * AHX, HVL or SID row has no volume column, so the cursor goes from the
 * instrument straight to the effect and back, never onto two cells nothing is
 * drawn in.
 */
function setup(volume: boolean, extraEffect: boolean) {
  const activeRow = ref(0);
  const activeTrack = ref(0);
  const activeColumn = ref(0);
  const activeMacroNibble = ref(0);
  const pattern = { tracks: [{}, {}] } as unknown as TrackerPattern;
  const nav = useTrackerNavigation({
    activeRow,
    activeTrack,
    activeColumn,
    activeMacroNibble,
    rowsCount: ref(64),
    currentPattern: computed(() => pattern),
    visibleColumns: ref(visibleColumnIndices(trackColumns(volume, extraEffect))),
    clearSelection: () => {},
  });
  /** Where each step right lands, as `column` or `column.nibble`. */
  const walk = (delta: number, steps: number): string[] => {
    const stops: string[] = [];
    for (let i = 0; i < steps; i++) {
      nav.moveColumn(delta);
      const at = activeColumn.value >= 4 ? `${activeColumn.value}.${activeMacroNibble.value}` : `${activeColumn.value}`;
      stops.push(`${activeTrack.value}:${at}`);
    }
    return stops;
  };
  return { activeColumn, activeTrack, activeMacroNibble, walk };
}

describe('cursor movement across a row', () => {
  it('skips the volume column where the song has none', () => {
    const { walk } = setup(false, false);
    expect(walk(1, 6)).toEqual(['0:1', '0:4.0', '0:4.1', '0:4.2', '1:0', '1:1']);
  });

  it('wraps left onto the effect of the previous track, then its instrument', () => {
    const { walk } = setup(false, false);
    expect(walk(-1, 3)).toEqual(['1:4.0', '1:1', '1:0']);
  });

  it('keeps the volume column where the song has one', () => {
    const { walk } = setup(true, false);
    expect(walk(1, 4)).toEqual(['0:1', '0:2', '0:3', '0:4.0']);
  });

  it('reaches the second effect column of an HVL row', () => {
    const { walk } = setup(false, true);
    expect(walk(1, 6)).toEqual(['0:1', '0:4.0', '0:4.1', '0:4.2', '0:5.0', '0:5.1']);
  });

  it('steps off a column the layout no longer shows', () => {
    const { activeColumn, walk } = setup(false, false);
    activeColumn.value = 3;
    expect(walk(1, 1)).toEqual(['0:4.0']);
    activeColumn.value = 2;
    expect(walk(-1, 1)).toEqual(['0:1']);
  });
});
