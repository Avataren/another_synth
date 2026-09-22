import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({
    previewAhxNoteOn: async () => true,
    previewAhxNoteOff: () => undefined,
  }),
}));
vi.mock('src/components/tracker/pattern-canvas/PatternCanvas.vue', async () => ({
  default: (await import('./helpers/pattern-canvas-stub')).PatternCanvasStub,
}));

import AhxInstrumentPage from 'pages/AhxInstrumentPage.vue';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import AhxAuditionBar from 'src/components/ahx/AhxAuditionBar.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';

/**
 * B3: the two-zone redesign's page-level contracts (plan §7.3) — the 4
 * fieldsets carry exactly the testids §1.2's mapping table names (no field
 * lost or duplicated in the reflow), AhxAuditionBar is wired with the page's
 * state, and the PList table's toggle (default hidden) plus the
 * focusField-opens-the-table fix (D-E point 1, the plan's top risk).
 */
const karma = (): ArrayBuffer => {
  const b = readFileSync(resolve(__dirname, '../../public/demos/ahx/karma.ahx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

async function mountEditor(slot: number) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/ahx/instrument/:slot', name: 'ahx-instrument-display', component: AhxInstrumentPage },
      { path: '/tracker', component: { template: '<div/>' } },
    ],
  });
  await router.push(`/ahx/instrument/${slot}`);
  await router.isReady();
  return mount(AhxInstrumentPage, {
    attachTo: document.body,
    global: { plugins: [router], stubs: { QPage: { template: '<div><slot /></div>' }, QIcon: true, QBtn: true } },
  });
}
type Wrapper = Awaited<ReturnType<typeof mountEditor>>;
const el = (w: Wrapper, testid: string) => w.get(`[data-testid="${testid}"]`);

const FIELDSET_MAP: Record<string, string[]> = {
  'Level & wave': ['ahx-field-volume', 'ahx-seg-waveLength', 'ahx-field-waveLength'],
  Vibrato: ['ahx-field-vibratoDelay', 'ahx-field-vibratoSpeed', 'ahx-field-vibratoDepth'],
  Square: ['ahx-field-squareLowerLimit', 'ahx-field-squareUpperLimit', 'ahx-field-squareSpeed'],
  Filter: [
    'ahx-field-filterLowerLimit',
    'ahx-field-filterUpperLimit',
    'ahx-field-filterSpeed',
    'ahx-field-hardCutRelease',
    'ahx-field-hardCutReleaseFrames',
  ],
};
const ALL_FIELDS = Object.values(FIELDSET_MAP).flat();

/** `AhxSegmented` renders no bare `data-testid`, only `${testid}-${option}` per radio. */
const fieldPresent = (scope: { find: (selector: string) => { exists: () => boolean } }, testid: string): boolean =>
  scope.find(`[data-testid="${testid}"]`).exists() || scope.find(`[data-testid^="${testid}-"]`).exists();

describe('AhxInstrumentPage layout (B3)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(new Uint8Array(karma()));
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('groups the 14 controls into exactly the 4 fieldsets the redesign specifies', async () => {
    const w = await mountEditor(1);
    const fieldsets = w.findAll('fieldset');
    expect(fieldsets).toHaveLength(4);
    const legends = Object.keys(FIELDSET_MAP);
    expect(fieldsets.map((fs) => fs.get('legend').text())).toEqual(legends);
    legends.forEach((legend, i) => {
      const fs = fieldsets[i]!;
      for (const field of FIELDSET_MAP[legend]!) {
        expect(fieldPresent(fs, field)).toBe(true);
      }
      for (const other of ALL_FIELDS.filter((f) => !FIELDSET_MAP[legend]!.includes(f))) {
        expect(fieldPresent(fs, other)).toBe(false);
      }
    });
    for (const field of ALL_FIELDS) {
      expect(fieldPresent(w, field)).toBe(true);
    }
    w.unmount();
  });

  it('the vibrato/square/filter fieldsets each carry their matching motion lane; Level & wave has none', async () => {
    const w = await mountEditor(1);
    const fieldsets = w.findAll('fieldset');
    expect(fieldsets[0]!.find('[data-testid="ahx-vibrato-lane"]').exists()).toBe(false);
    expect(fieldsets[0]!.find('[data-testid^="ahx-sweep-lane-"]').exists()).toBe(false);
    expect(fieldsets[1]!.find('[data-testid="ahx-vibrato-lane"]').exists()).toBe(true);
    expect(fieldsets[2]!.find('[data-testid="ahx-sweep-lane-square"]').exists()).toBe(true);
    expect(fieldsets[3]!.find('[data-testid="ahx-sweep-lane-filter"]').exists()).toBe(true);
    w.unmount();
  });

  it('AhxAuditionBar receives the page state as props', async () => {
    const w = await mountEditor(1);
    const bar = w.findComponent(AhxAuditionBar);
    expect(bar.exists()).toBe(true);
    expect(bar.props('audible')).toBe(true);
    expect(bar.props('octave')).toBe(4);
    expect(bar.props('stripStart')).toBe(48);
    expect(bar.props('latch')).toBe(false);
    expect(bar.props('restrike')).toBe(false);
    expect(bar.props('midiStatus')).toEqual({ state: 'idle', devices: [] });
    w.unmount();
  });

  it('AhxAuditionBar’s emits reach the same handlers the inline code used to call: set-octave moves the shown octave', async () => {
    const w = await mountEditor(1);
    const bar = w.findComponent(AhxAuditionBar);
    await bar.vm.$emit('set-octave', 5);
    expect(el(w, 'ahx-octave').text()).toBe('Oct 5');
    w.unmount();
  });

  describe('the PList table toggle (D-E)', () => {
    it('starts hidden, and clicking the toggle reveals it', async () => {
      const w = await mountEditor(1);
      const toggle = el(w, 'ahx-plist-table-toggle');
      expect(toggle.attributes('aria-expanded')).toBe('false');
      expect(toggle.text()).toBe('Show table');
      const table = el(w, 'ahx-plist').element.closest('.ahx-plist-scroll') as HTMLElement;
      expect(table.style.display).toBe('none');
      await toggle.trigger('click');
      expect(el(w, 'ahx-plist-table-toggle').attributes('aria-expanded')).toBe('true');
      expect(el(w, 'ahx-plist-table-toggle').text()).toBe('Hide table');
      expect(table.style.display).not.toBe('none');
      w.unmount();
    });

    it('a double-click hand-off from the canvas opens the table from hidden, and focuses the field', async () => {
      const w = await mountEditor(1);
      const table = el(w, 'ahx-plist').element.closest('.ahx-plist-scroll') as HTMLElement;
      expect(table.style.display).toBe('none');
      w.findComponent(PatternCanvas).vm.$emit('cellSelected', { row: 1, column: 1, trackIndex: 0 });
      await nextTick();
      w.get('.plist-canvas__stage').element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await nextTick();
      await nextTick();
      expect(el(w, 'ahx-plist-table-toggle').attributes('aria-expanded')).toBe('true');
      expect(table.style.display).not.toBe('none');
      expect((document.activeElement as HTMLElement | null)?.getAttribute('data-testid')).toBe('ahx-plist-1-waveform');
      w.unmount();
    });
  });
});
