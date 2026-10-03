import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

vi.mock('quasar', () => ({ useQuasar: () => ({ notify: vi.fn() }) }));

import DemoSongBrowser from 'src/components/tracker/DemoSongBrowser.vue';

/**
 * The demo browser's experimental marking (`EXPERIMENTAL_COLLECTIONS`) is
 * empty: the C64 SID collection lost its tag when `.sid` files began playing
 * as they are (.ai/plan-psid-playback.md). No tab carries a tag or notice.
 */

const manifest = {
  collections: [
    { id: 'goattracker', name: 'GoatTracker', songs: [{ file: 'goattracker/a/x.sng', title: 'X', format: 'GT2', channels: 3, bytes: 10 }] },
    { id: 'sid', name: 'C64 SID', songs: [{ file: 'sid/hubbard_rob/commando.sid', title: 'Commando', format: 'SID', channels: 3, bytes: 10 }] },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('the demo browser: experimental collections', () => {
  it('tags no tab and shows no notice, the SID collection included', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 })),
    );
    const w = mount(DemoSongBrowser, { props: { modelValue: true } });
    await flushPromises();
    const tabs = w.findAll('.demo-tab');
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.find('.demo-tab-experimental').exists())).toEqual([false, false]);
    await tabs[1]!.trigger('click');
    expect(w.find('.demo-experimental-notice').exists()).toBe(false);
  });
});
