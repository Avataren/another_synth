import { computed, reactive, ref, watch, type ComputedRef, type Ref } from 'vue';
import type { AhxInstrument, AhxSongFormat } from '@another-synth/tracker-playback';
import {
  commitPListEdit,
  createPListGesture,
  type PListEditHost,
  type PListNibble,
} from 'src/audio/tracker/plist-edit';
import {
  PLIST_MENU_ACTIONS,
  runPListIntent,
  type PListColumn,
  type PListCursor,
  type PListIntent,
  type PListMenuAction,
} from 'src/audio/tracker/plist-edit-input';
import type { useTrackerStore } from 'src/stores/tracker-store';

export interface UseAhxPListEditingOptions {
  instrument: ComputedRef<AhxInstrument | null>;
  slotNumber: ComputedRef<number | null>;
  songFormat: ComputedRef<AhxSongFormat>;
  sourceVersion: ComputedRef<number>;
  trackerStore: ReturnType<typeof useTrackerStore>;
  selectedRow: Ref<number | null>;
  selectRow: (row: number) => void;
  releaseKeyboard: () => void;
}

/**
 * The PList editing state machine: mode, cursor, undo-gesture grouping, the
 * row ops and the menu's per-row refusals. Extracted verbatim from
 * `AhxInstrumentPage.vue` (plan `.ai/plan-ahx-inst-redesign.md` §3 B3) — same
 * behavior, only the location moves.
 */
export function useAhxPListEditing(options: UseAhxPListEditingOptions) {
  const { instrument, slotNumber, songFormat, sourceVersion, trackerStore, selectedRow, selectRow, releaseKeyboard } =
    options;

  /** Off on every load and slot change, never saved: a saved mode would turn the keyboard piano off on the next visit. */
  const plistEdit = reactive<{ mode: boolean; column: PListColumn; nibble: PListNibble }>({
    mode: false,
    column: 0,
    nibble: 0,
  });
  /**
   * A minimal, exact contract instead of `InstanceType<typeof PListCanvas>`:
   * the generic `*.vue` shim (`declare module '*.vue' { const component:
   * DefineComponent; }`, no prop/expose generics) only resolves precisely
   * under `vue-tsc`; plain `tsc` — the checker for this `.ts` file — sees
   * `focus` as possibly `undefined` through it. `PListCanvas.vue`'s real
   * `defineExpose({ focus })` satisfies this structurally either way.
   */
  const plistCanvasRef = ref<{ focus: () => void } | null>(null);

  /**
   * Canvas editing is offered where an edit has an undo: an editable AHX song.
   * An HVL song's doc has an undo too since plan-hvl-editing.md P2, but HVL
   * instrument editing is its own later pass (plan §6 risk 6): its canvas
   * stays as it was, and it is edited in the table.
   */
  const canEditPList = computed(() => trackerStore.isAhxEditable && trackerStore.ahxDoc?.format === 'ahx');

  const plistCursor = computed(() => ({ column: plistEdit.column, nibble: plistEdit.nibble }));
  const plistContext = computed(() => ({ format: songFormat.value, version: sourceVersion.value }));

  const EDIT_TOGGLE_TITLE =
    'Type into the step under the canvas cursor. While this is on the computer keyboard no longer plays notes (the on-screen keys and MIDI still do). F2 or Esc turns it off.';
  const EDIT_UNAVAILABLE_TITLE =
    'The canvas edits songs that can be undone: an AHX song opened here with its source. An HVL song, or an AHX song saved without its file, is edited in the table.';

  const plistGesture = createPListGesture();
  const plistHost: PListEditHost = {
    canUndo: () => canEditPList.value,
    pushHistory: () => trackerStore.pushHistory(),
    // Only reached if the store refuses a write it had just said yes to; the redo steps `pushHistory` cleared are not brought back.
    discardHistory: () => void trackerStore.undoStack.pop(),
    ahxInstrumentRefusal: (slotNo, next) => trackerStore.ahxInstrumentRefusal(slotNo, next),
    updateAhxInstrument: (slotNo, next) => trackerStore.updateAhxInstrument(slotNo, next),
  };

  /**
   * One edit: the op for `intent`, committed once (undo step per gesture, the size
   * guard, the notice); if it worked the cursor goes where `cursorAfter` says.
   */
  function runPListEdit(intent: PListIntent, cursorAfter: PListCursor | null, continues: boolean): void {
    const current = instrument.value;
    const slotNo = slotNumber.value;
    if (!current || slotNo === null) return;
    const outcome = commitPListEdit(plistHost, plistGesture, slotNo, runPListIntent(current, intent, plistContext.value), {
      continues,
    });
    if (!outcome.ok || cursorAfter === null) return;
    plistEdit.column = cursorAfter.column;
    plistEdit.nibble = cursorAfter.nibble;
    selectRow(cursorAfter.row);
  }

  /** The table's `+` and `×`, and Add row: the same ops as the canvas, each click its own step. */
  function runTableRowOp(intent: PListIntent): void {
    plistGesture.close();
    runPListEdit(intent, null, false);
  }
  const addRow = (after?: number) =>
    runTableRowOp({ kind: 'insert-below', row: after ?? (instrument.value?.plist.entries.length ?? 0) - 1 });
  const removeRow = (row: number) => runTableRowOp({ kind: 'delete', row });

  function setPListEditMode(on: boolean): void {
    if (on === plistEdit.mode) return;
    if (on && (!canEditPList.value || (instrument.value?.plist.entries.length ?? 0) === 0)) return;
    plistEdit.mode = on;
    plistGesture.close();
    if (!on) return;
    if (selectedRow.value === null) selectRow(0);
    // A note the keyboard holds when the mode begins is let go of; its key-up finds nothing more to do.
    releaseKeyboard();
    plistCanvasRef.value?.focus();
  }

  /** A cursor move (a key, a click in Edit mode) ends the run of strokes that was one undo step. */
  function onPListCursor(cursor: PListCursor): void {
    plistGesture.close();
    plistEdit.column = cursor.column;
    plistEdit.nibble = cursor.nibble;
    selectRow(cursor.row);
  }
  function onPListSelect(row: number): void {
    plistGesture.close();
    selectRow(row);
  }
  const onPListEdit = (request: { intent: PListIntent; cursorAfter: PListCursor | null; continues: boolean }) =>
    runPListEdit(request.intent, request.cursorAfter, request.continues);

  /** Undo and redo are the song's (an editable AHX song's snapshots); the song reloads, so the gesture starts over. */
  function onPListUndo(): void {
    plistGesture.close();
    trackerStore.undo();
  }
  function onPListRedo(): void {
    plistGesture.close();
    trackerStore.redo();
  }

  /** Why each row-menu item cannot be done on `row` right now: the op's own refusal, then the store's (the file's size). */
  function plistMenuReasons(row: number): Partial<Record<PListMenuAction, string>> {
    const current = instrument.value;
    const slotNo = slotNumber.value;
    if (!current || slotNo === null) return {};
    const reasons: Partial<Record<PListMenuAction, string>> = {};
    for (const action of PLIST_MENU_ACTIONS) {
      const result = runPListIntent(current, { kind: action, row }, plistContext.value);
      const reason = !result.ok ? result.reason : result.changed ? trackerStore.ahxInstrumentRefusal(slotNo, result.instrument) : null;
      if (reason !== null) reasons[action] = reason;
    }
    return reasons;
  }

  // The mode ends with what it needs: another instrument, a song that cannot be edited, no rows left.
  watch(slotNumber, () => setPListEditMode(false));
  watch(canEditPList, (can) => {
    if (!can) setPListEditMode(false);
  });
  watch(
    () => instrument.value?.plist.entries.length ?? 0,
    (count) => {
      if (count === 0) setPListEditMode(false);
    },
  );

  return {
    plistEdit,
    plistCanvasRef,
    canEditPList,
    plistCursor,
    EDIT_TOGGLE_TITLE,
    EDIT_UNAVAILABLE_TITLE,
    setPListEditMode,
    onPListCursor,
    onPListSelect,
    onPListEdit,
    onPListUndo,
    onPListRedo,
    plistMenuReasons,
    addRow,
    removeRow,
  };
}
