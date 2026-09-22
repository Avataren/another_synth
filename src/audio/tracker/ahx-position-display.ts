/**
 * Display wording for the AHX per-position, per-channel transpose byte
 * (plan-pos-transpose.md). One module so the panel, the grid badge and the
 * tests all assert the same strings: `T-1`, `T0`, `T+3` — a zero renders
 * `T0`, not a blank, so "no badge" keeps meaning "not an AHX song".
 */
export function ahxTransposeLabel(value: number): string {
  return `T${value > 0 ? '+' : ''}${value}`;
}

/**
 * The badge/input tooltip: what the byte does, where it edits. True for every
 * editable AHX position; not rendered anywhere else.
 */
export function ahxTransposeTitle(position: number, channel: number, value: number): string {
  return `Position ${position + 1}, channel ${channel + 1}: notes shift by ${ahxTransposeLabel(value)} semitones when the song plays; edit it in the position panel below the song list.`;
}
