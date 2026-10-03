import { computed } from 'vue';
import type { useTrackerStore } from 'src/stores/tracker-store';

type TrackerStore = ReturnType<typeof useTrackerStore>;

/**
 * The subsongs of the song on screen, for the jukebox (the tracker page has
 * its own selectors): a C64 tune played as the file it is has the `.sid`'s
 * subsongs, a GoatTracker song its doc's. Any other song has none to pick.
 */
export function useSongSubsongs(store: TrackerStore) {
  /** How many subsongs there are to pick between (0: the song has no such notion). */
  const count = computed(() => {
    if (store.psidTune !== null) return store.psidTune.file.songs;
    if (store.isSidEditable) return store.sidFlat.length;
    return 0;
  });
  /** The one playing, 0-based. */
  const current = computed(() => (store.psidTune !== null ? store.psidTune.subsong : store.sidSubsong));

  function select(subsong: number): void {
    if (store.psidTune !== null) store.selectPsidSubsong(subsong);
    else store.selectSidSubsong(subsong);
  }

  /** Move to a random subsong other than the one playing; false when there is nothing to choose. */
  function selectRandom(): boolean {
    if (count.value < 2) return false;
    let next = Math.floor(Math.random() * (count.value - 1));
    if (next >= current.value) next += 1;
    select(next);
    return true;
  }

  return { count, current, select, selectRandom };
}
