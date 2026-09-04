/**
 * Case-insensitive substring matching for the demo song browser and the
 * jukebox playlist filter.
 *
 * Pure on purpose: the logic is unit-tested without mounting any component.
 * Filtering is view-only everywhere it is used -- callers render the matches
 * but keep acting on the unfiltered list.
 */

/** Normalized query: trimmed and lowercased. Empty means "no filter". */
export function normalizeFilterQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** True when the query would actually hide something. */
export function isFilterActive(query: string): boolean {
  return normalizeFilterQuery(query).length > 0;
}

/**
 * Does one song match the filter?
 *
 * Matches the title, and also the filename: manifest titles are not always
 * distinct from the file they came from, and a filename fragment ("rugby",
 * "sid-mon") is often what the user has.
 */
export function songMatchesFilter(
  query: string,
  title: string,
  file: string,
): boolean {
  const needle = normalizeFilterQuery(query);
  if (!needle) return true;
  return (
    title.toLowerCase().includes(needle) || file.toLowerCase().includes(needle)
  );
}

/**
 * Filter a list of songs while keeping each item's original position.
 *
 * Returns `{ item, index }` pairs so callers can render only the matches but
 * still emit actions (play this index, is this the current one) against the
 * full, unfiltered list.
 */
export function filterSongsIndexed<T>(
  items: readonly T[],
  query: string,
  getTitle: (item: T) => string,
  getFile: (item: T) => string,
): { item: T; index: number }[] {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) =>
      songMatchesFilter(query, getTitle(item), getFile(item)),
    );
}
