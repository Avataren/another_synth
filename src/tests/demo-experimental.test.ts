import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

vi.mock('quasar', () => ({ useQuasar: () => ({ notify: vi.fn() }) }));

import DemoSongBrowser from 'src/components/tracker/DemoSongBrowser.vue';

/**
 * The demo browser marks the C64 SID collection as experimental: a `.sid` is
 * transcribed from what its player plays (plan-psid-import.md), so the song
 * approximates the original. Its tab says so, and so does a notice while it
 * is open; the other collections carry neither.
 */

const manifest = {
  collections: [
    { id: 'goattracker', name: 'GoatTracker', songs: [{ file: 'goattracker/a/x.sng', title: 'X', format: 'GT2', channels: 3, bytes: 10 }] },
    { id: 'sid', name: 'C64 SID', songs: [{ file: 'sid/hubbard_rob/commando.sid', title: 'Commando', format: 'SID', channels: 3, bytes: 10 }] },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('the demo browser: experimental collections', () => {
  it('tags the SID tab and shows the notice only while the SID collection is open', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 })),
    );
    const w = mount(DemoSongBrowser, { props: { modelValue: true } });
    await flushPromises();
    const tabs = w.findAll('.demo-tab');
    expect(tabs.map((t) => t.find('.demo-tab-experimental').exists())).toEqual([false, true]);
    // The first collection opens first: no notice.
    expect(w.find('.demo-experimental-notice').exists()).toBe(false);
    await tabs[1]!.trigger('click');
    expect(w.find('.demo-experimental-notice').text()).toMatch(/^Experimental: .*approximates the original/);
    await tabs[0]!.trigger('click');
    expect(w.find('.demo-experimental-notice').exists()).toBe(false);
  });
});
