import { watch, type Ref, type WatchStopHandle } from 'vue';
import type { RouteLocationRaw, Router } from 'vue-router';
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
  // A SID slot has no patch either: its instrument is the song doc's (S4).
  if (slot?.instrumentFormat === 'sid') return { name: 'sid-instrument-editor', params: { slot: slotNumber } };
  if (!slot || !isAhxSlot(slot)) return null;
  return canEditSlot(slot)
    ? { name: 'ahx-instrument-display', params: { slot: slotNumber } }
    : { path: '/tracker' };
}

export const slotOf = (value: unknown): number | null => {
  const parsed = parseInt(String(Array.isArray(value) ? value[0] : value), 10);
  return Number.isNaN(parsed) ? null : parsed;
};


/**
 * Keeps the synth editor's route off AHX slots for as long as `slot` is the
 * route's slot -- including when the song only arrives afterwards. A fresh tab
 * on `#/patch/instrument/N` opens the route before its song has loaded: the
 * slot is not an AHX slot yet, the route guard lets it through, and the route
 * (so `slot`) never changes when the song lands. This watches where the slot
 * would be sent, which does change then (and when another song replaces it).
 */
export function watchAhxSlotRedirect(slot: Ref<number | null>, router: Router): WatchStopHandle {
  return watch(
    () => {
      const redirect = slot.value === null ? null : ahxSlotRedirect(slot.value);
      return redirect === null ? null : JSON.stringify(redirect);
    },
    (redirect) => {
      if (redirect !== null) void router.replace(JSON.parse(redirect) as RouteLocationRaw);
    },
  );
}
