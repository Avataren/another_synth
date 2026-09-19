/**
 * Clear the tracker selection when the user presses the primary pointer on a
 * dead area of the tracker page -- blank toolbar space, a track header
 * gutter, the padding around a panel -- anywhere that is neither a control
 * nor the pattern grid.
 *
 * The pattern grid (canvas renderer or the DOM fallback) is exempt: it owns
 * its own selection gestures, and a press there starts a drag-select. The
 * clear must not run for it too, or the drag's first cell would be wiped
 * as the drag begins.
 */

/** Elements that act on a press themselves, so a press on them is not "empty space". */
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="slider"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="tab"]',
  '[draggable="true"]',
  '.q-btn',
  '.q-field',
  '.q-slider',
  '.q-checkbox',
  '.q-toggle',
  '.q-item',
  '.q-menu',
  '.q-dialog',
].join(',');

/** The pattern grid, plus its scroll proxy: a press there is a scroll, not "empty". */
const SELECTION_SURFACE_SELECTOR = '[data-selection-surface]';

export interface OutsidePressOptions {
  /** Extra elements (beyond `[data-selection-surface]`) that own selection gestures. */
  isExempt?: (target: Element) => boolean;
}

/**
 * True when this pointerdown should clear the selection: the primary button,
 * no modifier held (a modified press is the multi-select gesture), and the
 * target is neither a control nor a selection surface.
 */
export function shouldClearSelectionOnPress(
  event: Pick<PointerEvent, 'button' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target'>,
  options: OutsidePressOptions = {}
): boolean {
  if (event.button !== 0) return false;
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest(SELECTION_SURFACE_SELECTOR)) return false;
  if (target.closest(INTERACTIVE_SELECTOR)) return false;
  if (options.isExempt?.(target)) return false;
  return true;
}

/**
 * Build the pointerdown handler for the tracker container. `hasSelection`
 * keeps a press on a dead area from reaching into state when there is
 * nothing to clear.
 */
export function createClearSelectionOnPress(
  clearSelection: () => void,
  hasSelection: () => boolean,
  options: OutsidePressOptions = {}
): (event: PointerEvent) => void {
  return (event) => {
    if (!hasSelection()) return;
    if (!shouldClearSelectionOnPress(event, options)) return;
    clearSelection();
  };
}
