import { readonly, ref, type Ref } from 'vue';

/**
 * When the tracker and jukebox switch to their phone layout.
 *
 * Two conditions, either of which is enough:
 *
 * - a viewport under 900px, which no three-panel layout fits on;
 * - a coarse pointer on anything under a small-laptop width, which catches
 *   phones and small tablets held in landscape -- 780px tall in landscape is
 *   as starved for vertical space as a portrait phone, and the panels have to
 *   collapse there too.
 *
 * A wide desktop window narrowed by hand therefore gets the phone layout,
 * which is the honest answer: the layout follows the space available, not a
 * guess at the device.
 */
export const MOBILE_LAYOUT_QUERY =
  '(max-width: 900px), (pointer: coarse) and (max-width: 1180px)';

/**
 * Shared across every caller: this drives structural `v-if`s, and two
 * components disagreeing about which layout is on screen would render a
 * mobile toolbar over a desktop grid. One MediaQueryList, one ref.
 */
let shared: Ref<boolean> | null = null;

function createSignal(): Ref<boolean> {
  const isMobile = ref(false);
  // jsdom and SSR have no matchMedia; the desktop layout is the safe default
  // there, and tests drive `setMobileLayoutForTest` instead.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return isMobile;
  }
  const mql = window.matchMedia(MOBILE_LAYOUT_QUERY);
  isMobile.value = mql.matches;
  const onChange = (event: MediaQueryListEvent | MediaQueryList) => {
    isMobile.value = event.matches;
  };
  // Safari below 14 has no addEventListener on MediaQueryList.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
  } else if (typeof mql.addListener === 'function') {
    mql.addListener(onChange);
  }
  return isMobile;
}

/**
 * Whether the phone layout is on screen.
 *
 * Never unsubscribed: the signal outlives every component that reads it (it
 * is one listener for the life of the tab), and tearing it down when the
 * last reader unmounts would leave the next mount reading a stale value.
 */
export function useMobileLayout(): Readonly<Ref<boolean>> {
  shared ??= createSignal();
  return readonly(shared);
}

/** Test seam: drive the layout without a real MediaQueryList. */
export function setMobileLayoutForTest(value: boolean): void {
  shared ??= ref(false);
  shared.value = value;
}
