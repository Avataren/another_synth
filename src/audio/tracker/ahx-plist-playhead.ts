import { shallowRef, type ShallowRef } from 'vue';
import type { AhxPListRow } from 'src/audio/tracker/ahx-player';

/** The PList row the sounding preview note is on, and the instrument (1-based) it belongs to. */
export interface AhxPListPlayhead {
  instrument: number;
  row: number;
}

/**
 * Where the engine's preview note is in its instrument's PList, or `null` when
 * nothing sounds. Reactive for the instrument page's canvas; written only by
 * the playback store, from the preview's `onPListRow`.
 *
 * A `shallowRef`, not a `ref`: it is replaced on every report and never
 * mutated, so no Proxy ever wraps the value (the same choice as
 * `ahxSourceInfo`).
 */
export const ahxPListPlayhead: ShallowRef<AhxPListPlayhead | null> = shallowRef(null);

/** Takes a worklet report: a row sets the playhead, `row < 0` (nothing sounds) clears it. */
export function setAhxPListPlayhead(report: AhxPListRow): void {
  if (report.row < 0 || report.instrument <= 0) {
    clearAhxPListPlayhead();
    return;
  }
  const now = ahxPListPlayhead.value;
  if (now?.instrument === report.instrument && now.row === report.row) return;
  ahxPListPlayhead.value = { instrument: report.instrument, row: report.row };
}

/** A different song, or no preview worklet any more: whatever row was shown is a lie. */
export function clearAhxPListPlayhead(): void {
  if (ahxPListPlayhead.value !== null) ahxPListPlayhead.value = null;
}
