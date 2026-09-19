import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type RouteRecordRaw } from 'vue-router';
import routes from 'src/router/routes';
import { ahxSlotRedirect } from 'src/router/ahx-slot-guard';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';

const karma = (): ArrayBuffer => {
  const b = readFileSync(resolve(__dirname, '../../public/demos/ahx/karma.ahx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/**
 * The real route table with its real guards, but not its real pages: pushing to
 * a route would otherwise load IndexPage, TrackerPage and the layout with
 * everything they import, which is slow under a loaded suite and not what is
 * under test (which route a URL ends on).
 */
const stub = { render: () => null };
const withStubPages = (table: RouteRecordRaw[]): RouteRecordRaw[] =>
  table.map((route) => ({
    ...route,
    ...(route.component ? { component: stub } : {}),
    ...(route.children ? { children: withStubPages(route.children) } : {}),
  })) as RouteRecordRaw[];

function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes: withStubPages(routes) });
}

describe('legacy synth-editor URLs and AHX slots', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('ahxSlotRedirect sends an AHX slot to the AHX editor and leaves every other slot alone', () => {
    const store = useTrackerStore();
    expect(ahxSlotRedirect(1)).toBeNull(); // nothing loaded: an empty slot
    store.loadSongFile(importAhxToTrackerSong(karma()));
    expect(ahxSlotRedirect(1)).toEqual({ name: 'ahx-instrument-display', params: { slot: 1 } });
    expect(ahxSlotRedirect(60)).toBeNull(); // an empty slot of the AHX song
    // An AHX slot whose instrument was dropped (crafted file): nothing to edit, so the tracker.
    delete store.instrumentSlots[0]!.ahxData;
    expect(ahxSlotRedirect(1)).toEqual({ path: '/tracker' });
  });

  it('#/patch/instrument/N does not open the synth editor on an AHX slot', async () => {
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    const router = makeRouter();
    await router.push('/patch/instrument/2');
    expect(router.currentRoute.value.name).toBe('ahx-instrument-display');
    expect(router.currentRoute.value.params.slot).toBe('2');
  });

  it('?editSongPatch=N on /patch and on /tracker is forwarded to the AHX editor for an AHX slot', async () => {
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    const router = makeRouter();
    await router.push('/patch?editSongPatch=3');
    expect(router.currentRoute.value.name).toBe('ahx-instrument-display');
    await router.push('/tracker?editSongPatch=4');
    expect(router.currentRoute.value.name).toBe('ahx-instrument-display');
    expect(router.currentRoute.value.params.slot).toBe('4');
  });

  it('still opens the synth editor for a slot that is not AHX', async () => {
    const router = makeRouter();
    await router.push('/patch/instrument/2');
    expect(router.currentRoute.value.name).toBe('patch-instrument-editor');
    await router.push('/patch?editSongPatch=3');
    expect(router.currentRoute.value.name).toBe('patch-instrument-editor');
    expect(router.currentRoute.value.params.slot).toBe('3');
  });

  it('an AHX slot with no instrument goes back to the tracker instead of the editor', async () => {
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    delete store.instrumentSlots[0]!.ahxData;
    const router = makeRouter();
    await router.push('/patch/instrument/1');
    expect(router.currentRoute.value.path).toBe('/tracker');
  });
});
