import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  isFilterActive,
  normalizeFilterQuery,
  songMatchesFilter,
  filterSongsIndexed,
} from '../composables/song-filter';
import { useJukeboxStore, type JukeboxEntry } from '../stores/jukebox-store';

interface FakeSong {
  title: string;
  file: string;
}

const songs: FakeSong[] = [
  { title: 'Ocean Runner', file: 'amiga/ocean-runner.mod' },
  { title: 'amiga medley', file: 'amiga/medley.mod' },
  { title: 'SID Stories', file: 'c64/sid-stories.sid' },
];

function entry(title: string, file: string): JukeboxEntry {
  return {
    file,
    url: `demos/${file}`,
    title,
    format: 'MOD',
    channels: 4,
    bytes: 1024,
  };
}

describe('song filter matching', () => {
  it('normalizes the query by trimming and lowercasing', () => {
    expect(normalizeFilterQuery('  OCEAN ')).toBe('ocean');
    expect(normalizeFilterQuery('   ')).toBe('');
  });

  it('reports whether a query is active', () => {
    expect(isFilterActive('')).toBe(false);
    expect(isFilterActive('   ')).toBe(false);
    expect(isFilterActive('ocean')).toBe(true);
  });

  it('matches case-insensitively against the title', () => {
    expect(songMatchesFilter('OCE', 'Ocean Runner', 'amiga/ocean-runner.mod')).toBe(true);
    expect(songMatchesFilter('runner', 'Ocean Runner', 'amiga/ocean-runner.mod')).toBe(true);
  });

  it('matches the filename too', () => {
    expect(songMatchesFilter('medley.mod', 'amiga medley', 'amiga/medley.mod')).toBe(true);
    expect(songMatchesFilter('c64/', 'SID Stories', 'c64/sid-stories.sid')).toBe(true);
  });

  it('rejects non-matching songs and empty needles never hide anything', () => {
    expect(songMatchesFilter('zzz', 'Ocean Runner', 'amiga/ocean-runner.mod')).toBe(false);
    expect(songMatchesFilter('', 'Ocean Runner', 'amiga/ocean-runner.mod')).toBe(true);
  });
});

describe('filterSongsIndexed', () => {
  it('returns every item with its position when the filter is inactive', () => {
    const result = filterSongsIndexed(
      songs,
      '   ',
      (s) => s.title,
      (s) => s.file,
    );
    expect(result.map(({ item, index }) => [index, item.title])).toEqual([
      [0, 'Ocean Runner'],
      [1, 'amiga medley'],
      [2, 'SID Stories'],
    ]);
  });

  it('keeps original indices when the filter narrows the list', () => {
    const result = filterSongsIndexed(
      songs,
      'SID',
      (s) => s.title,
      (s) => s.file,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.index).toBe(2);
    expect(result[0]!.item.title).toBe('SID Stories');
  });
});

describe('jukebox store filter', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function fill(store: ReturnType<typeof useJukeboxStore>) {
    store.setEntries([
      entry('Ocean Runner', 'amiga/ocean-runner.mod'),
      entry('SID Stories', 'c64/sid-stories.sid'),
      entry('Night Drive', 'amiga/night-drive.mod'),
    ]);
    store.setCurrentIndex(1);
  }

  it('starts unfiltered and exposes the full playlist', () => {
    const store = useJukeboxStore();
    fill(store);
    expect(store.filter).toBe('');
    expect(store.filteredEntries.map(({ index }) => index)).toEqual([0, 1, 2]);
  });

  it('narrows the view by title or filename without touching the queue', () => {
    const store = useJukeboxStore();
    fill(store);

    store.setFilter('drive');
    expect(store.filteredEntries.map(({ index, entry }) => [index, entry.title])).toEqual([
      [2, 'Night Drive'],
    ]);
    // The real playlist, its order and the current song are untouched.
    expect(store.entries).toHaveLength(3);
    expect(store.currentIndex).toBe(1);
    expect(store.current?.title).toBe('SID Stories');

    store.setFilter('c64/');
    expect(store.filteredEntries.map(({ index }) => index)).toEqual([1]);

    store.setFilter('   ');
    expect(store.filteredEntries).toHaveLength(3);
  });

  it('an empty filtered view never stops or reorders playback', () => {
    const store = useJukeboxStore();
    fill(store);

    store.setFilter('zzz-nothing');
    expect(store.filteredEntries).toHaveLength(0);
    expect(store.entries).toHaveLength(3);
    expect(store.currentIndex).toBe(1);
    expect(store.current?.file).toBe('c64/sid-stories.sid');
  });
});
