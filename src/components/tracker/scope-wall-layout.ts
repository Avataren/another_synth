/**
 * A scope wants width: the cell shape the grid tries to approach. High on
 * purpose -- a raised target favours wide cells, so four channels make a 2x2
 * on all but a very short area, instead of a row of tall slivers on a wide
 * screen (a lower target does the opposite).
 */
export const SCOPE_WALL_TARGET_ASPECT = 3.5;

export interface ScopeWallGrid {
  columns: number;
  rows: number;
}

/**
 * The grid that gives `count` scopes the most room in a `width` x `height` box.
 *
 * Each candidate column count is scored by the largest cell of the target
 * aspect that fits in its (stretched) cells, so a wide box gets wide rows of
 * scopes and a tall one stacks them, and 18 channels do not become a 1x18
 * sliver. Ties go to fewer columns. Before the box has been measured (0 x 0)
 * the count is laid out as near-square.
 */
export function scopeWallGrid(
  count: number,
  width: number,
  height: number,
  aspect: number = SCOPE_WALL_TARGET_ASPECT,
): ScopeWallGrid {
  if (count <= 0) return { columns: 1, rows: 1 };
  if (!(width > 0) || !(height > 0)) {
    const columns = Math.ceil(Math.sqrt(count));
    return { columns, rows: Math.ceil(count / columns) };
  }

  let best: ScopeWallGrid = { columns: 1, rows: count };
  let bestScale = -1;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const scale = Math.min(width / columns / aspect, height / rows);
    if (scale > bestScale + 1e-9) {
      bestScale = scale;
      best = { columns, rows };
    }
  }
  return best;
}
