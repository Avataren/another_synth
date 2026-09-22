import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({
    previewAhxNoteOn: async () => true,
    previewAhxNoteOff: () => undefined,
  }),
}));

import AhxInstrumentPage from 'pages/AhxInstrumentPage.vue';
import OscilloscopeComponent from 'src/components/OscilloscopeComponent.vue';
import FrequencyAnalyzerComponent from 'src/components/FrequencyAnalyzerComponent.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { ahxPreviewOutputNode } from 'src/audio/tracker/ahx-preview-output';

/**
 * B2 wiring smoke test: the analyzer row on AhxInstrumentPage binds
 * :node="ahxPreviewOutputNode" (the direct module import, mirroring
 * ahxPListPlayhead) to the two reused, unmodified visualizer components, and
 * gates on the same `audible` flag the audition bar already uses. Not an
 * audio-correctness test — OscilloscopeComponent/FrequencyAnalyzerComponent
 * are untouched by this plan.
 */

const karma = (): ArrayBuffer => {
  const b = readFileSync(resolve(__dirname, '../../public/demos/ahx/karma.ahx'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/** A minimal stand-in AudioNode: enough surface for both components' attach paths to run without throwing. */
function fakeAudioNode(): AudioNode {
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    frequencyBinCount: 128,
    connect: () => undefined,
    disconnect: () => undefined,
    getByteTimeDomainData: () => undefined,
    getByteFrequencyData: () => undefined,
  };
  const splitter = { connect: () => undefined, disconnect: () => undefined };
  const context = {
    createAnalyser: () => ({ ...analyser }),
    createChannelSplitter: () => ({ ...splitter }),
  };
  return {
    context,
    connect: () => undefined,
    disconnect: () => undefined,
    numberOfOutputs: 1,
  } as unknown as AudioNode;
}

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
    global: {
      plugins: [router],
      stubs: { QPage: { template: '<div><slot /></div>' }, QIcon: true, QBtn: true },
    },
  });
}

type Wrapper = Awaited<ReturnType<typeof mountEditor>>;
const has = (w: Wrapper, testid: string) => w.find(`[data-testid="${testid}"]`).exists();

describe('AhxInstrumentPage analyzer row (B2)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    ahxPreviewOutputNode.value = null;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    ahxPreviewOutputNode.value = null;
  });

  function load() {
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(new Uint8Array(karma()));
    return store;
  }

  it('audible: renders the analyzer row with both components bound to ahxPreviewOutputNode', async () => {
    load();
    const w = await mountEditor(1);
    expect(has(w, 'ahx-analyzer-row')).toBe(true);
    expect(has(w, 'ahx-analyzer-off')).toBe(false);
    const osc = w.findComponent(OscilloscopeComponent);
    const freq = w.findComponent(FrequencyAnalyzerComponent);
    expect(osc.exists()).toBe(true);
    expect(freq.exists()).toBe(true);
    expect(osc.props('node')).toBe(ahxPreviewOutputNode.value);
    expect(freq.props('node')).toBe(ahxPreviewOutputNode.value);
    expect(osc.props('node')).toBeNull();
  });

  it('not audible: renders ahx-analyzer-off, no analyzer components mounted', async () => {
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(null);
    const w = await mountEditor(1);
    expect(has(w, 'ahx-analyzer-row')).toBe(false);
    expect(has(w, 'ahx-analyzer-off')).toBe(true);
    expect(w.findComponent(OscilloscopeComponent).exists()).toBe(false);
    expect(w.findComponent(FrequencyAnalyzerComponent).exists()).toBe(false);
  });

  it('reacts to ahxPreviewOutputNode changing: prop follows the ref, in and back out', async () => {
    load();
    const w = await mountEditor(1);
    const node = fakeAudioNode();
    ahxPreviewOutputNode.value = node;
    await w.vm.$nextTick();
    expect(w.findComponent(OscilloscopeComponent).props('node')).toBe(node);
    expect(w.findComponent(FrequencyAnalyzerComponent).props('node')).toBe(node);
    ahxPreviewOutputNode.value = null;
    await w.vm.$nextTick();
    expect(w.findComponent(OscilloscopeComponent).props('node')).toBeNull();
    expect(w.findComponent(FrequencyAnalyzerComponent).props('node')).toBeNull();
  });
});
