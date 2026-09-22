import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * MainLayout's top-bar playback cluster (plan-fullscreen-transport.md).
 *
 * Root cause this pins: the cluster used to sit behind
 * `v-if="isPlaying || isPaused"` (MainLayout.vue:24 at main c027f2a2), so a
 * stopped song had no transport in the top bar — and fullscreen hides the
 * tracker page's own transport (TrackerPage.vue:305), leaving nothing. The
 * cluster must now be present in every state; the state only decides labels
 * and which buttons are enabled (D-A: enabled only when the action has
 * something to act on).
 *
 * The store is mocked on a real `defineStore` so `storeToRefs` in the
 * component sees a store-shaped object; Quasar components are stubbed with
 * the repo's plain-template convention (cf. ahx-instrument-page-play.test.ts).
 * The QBtn stub honours `disable` and re-emits `click` so enabled/disabled
 * assertions and click routing are real.
 */

// CpuUsageHeader touches a pinia store at module scope; mocked out so
// importing MainLayout for the suite needs no pinia yet.
vi.mock('src/components/CpuUsageHeader.vue', () => ({
  default: { name: 'CpuUsageHeader', template: '<span />' },
}));

vi.mock('src/stores/tracker-playback-store', async () => {
  // Built on the real pinia defineStore so `storeToRefs(playbackStore)` in
  // MainLayout gets a store the helper accepts; the state refs and transport
  // functions below are the mock's own.
  const { defineStore } = await import('pinia');
  const { ref } = await import('vue');
  const useTestPlaybackStore = defineStore('trackerPlaybackHeaderTest', () => {
    const isPlaying = ref(false);
    const isPaused = ref(false);
    const calls: string[] = [];
    function pause(): void {
      calls.push('pause');
    }
    async function resume(): Promise<void> {
      calls.push('resume');
    }
    function stop(): void {
      calls.push('stop');
    }
    return { isPlaying, isPaused, pause, resume, stop, calls };
  });
  return { useTrackerPlaybackStore: useTestPlaybackStore };
});

import MainLayout from 'src/layouts/MainLayout.vue';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';

/**
 * The runtime store is the mock (above), but the type checker resolves the
 * import against the real module — so every test drives the store through
 * this explicit mock shape instead of the real store's type.
 */
type TestPlaybackStore = {
  isPlaying: boolean;
  isPaused: boolean;
  pause: () => void;
  resume: () => Promise<void>;
  stop: () => void;
  calls: string[];
};

const testStore = () =>
  useTrackerPlaybackStore() as unknown as TestPlaybackStore;

type Wrapper = ReturnType<typeof mountMainLayout>;

function mountMainLayout() {
  return mount(MainLayout, {
    global: {
      stubs: {
        QLayout: { template: '<div><slot /></div>' },
        QHeader: { template: '<header><slot /></header>' },
        QToolbar: { template: '<div><slot /></div>' },
        QToolbarTitle: { template: '<span><slot /></span>' },
        QTabs: { template: '<div><slot /></div>' },
        QRouteTab: { template: '<span><slot /></span>' },
        QSpace: { template: '<span />' },
        QPageContainer: { template: '<div><slot /></div>' },
        RouterView: { template: '<div />' },
        QBtn: {
          // emits declared: without it the @click listener ALSO falls
          // through to the root button, and every click fires twice.
          emits: ['click'],
          template:
            '<button type="button" :disabled="disable" @click="$emit(\'click\')"><slot /></button>',
          props: ['disable'],
        },
      },
    },
  });
}

const el = (w: Wrapper, testid: string) => w.get(`[data-testid="${testid}"]`);
const btn = (w: Wrapper, testid: string) =>
  el(w, testid).element as HTMLButtonElement;

describe('MainLayout top-bar playback cluster (fullscreen transport)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the cluster while STOPPED: visible, both buttons disabled, Stopped label', () => {
    const w = mountMainLayout();
    el(w, 'playback-indicator'); // throws if absent — the bug this fixes
    expect(btn(w, 'playback-toggle').disabled).toBe(true);
    expect(btn(w, 'playback-stop').disabled).toBe(true);
    expect(w.get('.playback-status').text()).toContain('Stopped');
    expect(w.get('.playback-indicator').classes()).toContain('is-stopped');
    w.unmount();
  });

  it('renders the cluster while PLAYING: pause + stop enabled; toggle pauses', async () => {
    const store = testStore();
    store.isPlaying = true;
    const w = mountMainLayout();
    await w.vm.$nextTick();
    expect(btn(w, 'playback-toggle').disabled).toBe(false);
    expect(btn(w, 'playback-stop').disabled).toBe(false);
    expect(w.get('.playback-status').text()).toContain('Playing');
    expect(el(w, 'playback-toggle').attributes('title')).toBe('Pause');
    await el(w, 'playback-toggle').trigger('click');
    expect(store.calls).toEqual(['pause']);
    w.unmount();
  });

  it('renders the cluster while PAUSED: toggle resumes, stop stops', async () => {
    const store = testStore();
    store.isPlaying = false;
    store.isPaused = true;
    const w = mountMainLayout();
    await w.vm.$nextTick();
    expect(btn(w, 'playback-toggle').disabled).toBe(false);
    expect(btn(w, 'playback-stop').disabled).toBe(false);
    expect(w.get('.playback-status').text()).toContain('Paused');
    expect(el(w, 'playback-toggle').attributes('title')).toBe('Resume');
    await el(w, 'playback-toggle').trigger('click');
    await el(w, 'playback-stop').trigger('click');
    expect(store.calls).toEqual(['resume', 'stop']);
    w.unmount();
  });

  it('the stopped-state toggle is a no-op (nothing to act on, D-A)', async () => {
    const store = testStore();
    const w = mountMainLayout();
    // The button is disabled; a synthetic click on it still reaches the
    // handler, which must match no branch while stopped.
    await el(w, 'playback-toggle').trigger('click');
    expect(store.calls).toEqual([]);
    w.unmount();
  });
});
