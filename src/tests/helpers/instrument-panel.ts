import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Vue from 'vue';
import { ref } from 'vue';
import { compile } from '@vue/compiler-dom';
import { mount } from '@vue/test-utils';
import { expect } from 'vitest';
import { formatInstrumentId } from '@another-synth/tracker-playback';
import { canEditSlot, instrumentBadgeLabel, isAhxSlot, listsSongInstrument } from 'src/audio/tracker/instrument-types';
import { useTrackerInstruments, type TrackerInstrumentsContext } from 'src/composables/useTrackerInstruments';
import { useMobileLayout } from 'src/composables/useMobileLayout';
import { TOTAL_PAGES, useTrackerStore } from 'src/stores/tracker-store';

/**
 * The tracker page's instruments panel on its own: the panel is cut out of
 * TrackerPage.vue and compiled, and it renders against the real store, the
 * real instruments composable and the real slot helpers. A full page mount
 * would drag in the audio host for no gain: the rows are the panel's alone.
 * `PatchPicker` is a stub whose root carries the props it was given (its
 * `placeholder` tells the pickers apart).
 */

const PAGE = readFileSync(resolve(__dirname, '../../pages/TrackerPage.vue'), 'utf8');

/** The `<div>` that opens at the instruments panel's `v-show`, to its matching close. */
function instrumentPanelMarkup(): string {
  const anchor = PAGE.indexOf("mobilePanel === 'instruments'\"");
  expect(anchor).toBeGreaterThan(0);
  const start = PAGE.lastIndexOf('<div', anchor);
  const tags = /<\/?div\b/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let m = tags.exec(PAGE); m; m = tags.exec(PAGE)) {
    depth += m[0] === '<div' ? 1 : -1;
    if (depth === 0) return PAGE.slice(start, PAGE.indexOf('>', m.index) + 1);
  }
  throw new Error('unbalanced instruments panel');
}

/** A runtime-compiled render function over the page's markup, as Vue's full build makes one. */
function compilePanel() {
  const { code } = compile(instrumentPanelMarkup(), { mode: 'function', hoistStatic: false });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const render = new Function('Vue', code)(Vue) as ((...args: unknown[]) => unknown) & { _rc?: boolean };
  render._rc = true;
  return render;
}

const stub = (name: string) => Vue.defineComponent({ name, render: () => Vue.h('span', { class: `stub-${name}` }) });

/**
 * Mounts the panel. `overrides` replaces the page's own bindings the harness
 * otherwise fakes (the preset pickers are off, `hasDocStructure` is the
 * store's).
 */
export function mountInstrumentPanel(mobilePanel: 'instruments' | 'song' | null, overrides: Record<string, unknown> = {}) {
  const render = compilePanel();
  return mount({
    render,
    components: {
      PatchPicker: stub('PatchPicker'),
      AudioKnobComponent: stub('AudioKnobComponent'),
      StereoLevelMeter: stub('StereoLevelMeter'),
      QIcon: stub('QIcon'),
    },
    setup() {
      const trackerStore = useTrackerStore();
      const instruments = useTrackerInstruments({ trackerStore, formatInstrumentId } as unknown as TrackerInstrumentsContext);
      const noop = () => {};
      return {
        // Layout (TrackerPage's own refs).
        isMobileLayout: useMobileLayout(),
        mobilePanel: ref(mobilePanel),
        // The store, as the page reads it.
        trackerStore,
        currentInstrumentPage: Vue.computed(() => trackerStore.currentInstrumentPage),
        currentPageSlots: Vue.computed(() => trackerStore.currentPageSlots),
        activeInstrumentId: Vue.computed(() => trackerStore.activeInstrumentId),
        visibleInstrumentPages: Vue.computed(() => [0, 1, 2, 3, 4]),
        TOTAL_PAGES,
        // The page's real display logic.
        formatInstrumentId,
        isAhxSlot,
        instrumentBadgeLabel,
        canEditSlot,
        listsSongInstrument,
        ...instruments,
        // Page state and handlers the rows only bind (never called here).
        isReadOnly: false,
        readOnlyHint: '',
        hasDocStructure: Vue.computed(() => trackerStore.hasDocStructure),
        isSidSong: Vue.computed(() => trackerStore.isSidSong),
        canAddSidInstrumentAt: () => false,
        canPickSidPresetAt: () => false,
        sidPresetList: [],
        onSidPresetSelect: noop,
        canPickAhxPresetAt: () => false,
        ahxPresetList: [],
        ahxInstrumentCount: 0,
        onAhxPresetSelect: noop,
        onAddInstrumentClick: noop,
        ahxInstrumentsHint: '',
        masterOutputNode: null,
        audioContext: null,
        isPlaying: false,
        formatGainAsDb: (v: number) => String(v),
        stepInstrumentPage: noop,
        setActiveInstrument: noop,
        refocusTracker: noop,
        blurAndRefocusTracker: noop,
        onSlotVolumeChange: noop,
        ...overrides,
      };
    },
  });
}
