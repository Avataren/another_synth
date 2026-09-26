import { computed, watch, type ComputedRef } from 'vue';
import {
  brandIdForSong,
  formatBrand,
  modVariantLabel,
  type FormatBrand,
  type FormatBrandId,
} from 'src/branding/format-brands';
import { applyFormatBrand } from 'src/branding/format-theme';
import { useTrackerStore } from 'src/stores/tracker-store';

export interface ActiveFormatBrand {
  id: FormatBrandId;
  brand: FormatBrand;
  /** The MOD sub-label ('ProTracker · M.K.'), else null. */
  variant: string | null;
}

/**
 * The brand of the song in the tracker store, which is also the song the
 * jukebox plays. An AHX song's variant is its doc's format when it has a doc
 * (the doc is rebuilt on every edit), else its source header's, the same
 * authority order the HVL exporter uses.
 */
export function useActiveFormatBrand(): ComputedRef<ActiveFormatBrand> {
  const store = useTrackerStore();
  return computed(() => {
    const variant = store.ahxSongFormat;
    const id = brandIdForSong(store.moduleFormat, variant);
    return {
      id,
      brand: formatBrand(id),
      variant: id === 'mod' ? modVariantLabel(store.modOrigin) : null,
    };
  });
}

/**
 * Keeps the root's format variables on the active song's brand. Installed
 * once, by the layout: every page reads the variables, and a song switch
 * (load, jukebox handover, new song) repaints with no reload.
 */
export function useFormatBrandTheme(): ComputedRef<ActiveFormatBrand> {
  const active = useActiveFormatBrand();
  watch(() => active.value.id, (id) => applyFormatBrand(id), { immediate: true });
  return active;
}
