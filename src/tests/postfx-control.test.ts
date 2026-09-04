/**
 * PostFxFilterControl UI pins (D116): renders all three mode states, emits
 * mode changes, and resolves the LED against the audio clock via the store.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import PostFxFilterControl from 'src/components/PostFxFilterControl.vue';
import {
  resetPostFxRegistryForTests,
  registerPostFxRack,
} from '@another-synth/tracker-playback';
import { usePostFxStore } from 'src/stores/post-fx-store';

// jsdom has no rAF; the LED ticker is pumped manually (pattern-canvas style).
const rafQueue = new Map<number, (time: number) => void>();
let nextRafId = 1;
let rackNow = 100;

beforeEach(() => {
  localStorage.clear();
  resetPostFxRegistryForTests();
  setActivePinia(createPinia());
  rafQueue.clear();
  nextRafId = 1;
  rackNow = 100;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: (time: number) => void) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => {
      rafQueue.delete(id);
    }),
  );
  registerPostFxRack({
    rack: { contextTime: () => rackNow } as never,
    amigaLpf: {
      setParams: () => undefined,
      setLedActive: () => undefined,
      setBypassed: () => undefined,
      cancelPending: () => undefined,
    } as never,
  });
});

/** Fire every queued frame callback once, like one display refresh. */
function pumpFrame(): void {
  const callbacks = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of callbacks) cb(performance.now());
}

function mountControl(compact = false) {
  return mount(PostFxFilterControl, {
    props: { compact },
    global: {
      // The component uses q-icon/q-menu; stub them -- the pins are about
      // mode state and LED resolution, not Quasar rendering.
      stubs: {
        'q-icon': { template: '<span />' },
        'q-menu': { template: '<span><slot /></span>' },
      },
    },
    attachTo: document.body,
  });
}

describe('PostFxFilterControl', () => {
  it('renders all three mode states and marks the active one', () => {
    const wrapper = mountControl();
    const buttons = wrapper.findAll('.post-fx-segment button');
    expect(buttons.map((b) => b.text())).toEqual(['OFF', 'ON', 'AUTO']);
    expect(buttons[2]!.classes()).toContain('active');
    wrapper.unmount();
  });

  it('emits mode-change and updates the store on selection', async () => {
    const wrapper = mountControl();
    const buttons = wrapper.findAll('.post-fx-segment button');
    await buttons[0]!.trigger('click');
    expect(wrapper.emitted('mode-change')).toEqual([['off']]);
    expect(usePostFxStore().mode).toBe('off');
    await buttons[1]!.trigger('click');
    expect(usePostFxStore().mode).toBe('on');
    wrapper.unmount();
  });

  it('the LED resolves against the audio clock, flipping at the scheduled time', async () => {
    const wrapper = mountControl();
    await wrapper.vm.$nextTick();
    pumpFrame();
    expect(wrapper.find('.post-fx-led').classes()).not.toContain('on');

    // E00 scheduled ahead of the rack clock (100): the LED stays dark until
    // the audio clock reaches the scheduled time, then lights.
    usePostFxStore().applyEngineEvent(true, 105);
    pumpFrame();
    expect(wrapper.find('.post-fx-led').classes()).not.toContain('on');

    rackNow = 105;
    pumpFrame();
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.post-fx-led').classes()).toContain('on');
    wrapper.unmount();
  });

  it('the compact chip shows the current mode', () => {
    const wrapper = mountControl(true);
    const chip = wrapper.find('.post-fx-chip');
    expect(chip.exists()).toBe(true);
    expect(chip.text()).toContain('AUTO');
    wrapper.unmount();
  });
});