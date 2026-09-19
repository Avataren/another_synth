import type { RouteLocationRaw } from 'vue-router';
import { useTrackerStore } from 'src/stores/tracker-store';
import { canEditSlot, isAhxSlot } from 'src/audio/tracker/instrument-types';

/**
 * Where the legacy synth-editor paths (`?editSongPatch=N`, `#/patch/instrument/N`)
 * must go for slot `slotNumber`: an AHX slot has no patch, so the synth patch
 * editor cannot open it (it would write a patch into the slot); it goes to the
 * AHX instrument editor, or back to the tracker when the slot has no instrument
 * to edit. Any other slot: `null`, the caller's own route stands.
 */
export function ahxSlotRedirect(slotNumber: number): RouteLocationRaw | null {
  const slot = useTrackerStore().instrumentSlots.find((s) => s.slot === slotNumber);
  if (!slot || !isAhxSlot(slot)) return null;
  return canEditSlot(slot)
    ? { name: 'ahx-instrument-display', params: { slot: slotNumber } }
    : { path: '/tracker' };
}

export const slotOf = (value: unknown): number | null => {
  const parsed = parseInt(String(Array.isArray(value) ? value[0] : value), 10);
  return Number.isNaN(parsed) ? null : parsed;
};

