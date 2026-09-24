import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';

const scope = vi.hoisted(() => ({ enabled: [] as boolean[], waveform: () => null as Int16Array | null }));
vi.mock('src/stores/tracker-playback-store', () => ({
  useTrackerPlaybackStore: () => ({
    previewAhxNoteOn: async () => true,
    previewAhxNoteOff: () => undefined,
    setAhxPreviewScopeEnabled: (enabled: boolean) => scope.enabled.push(enabled),
    getAhxPreviewWaveform: scope.waveform,
  }),
}));

import AhxInstrumentPage from 'pages/AhxInstrumentPage.vue';
import TrackWaveform from 'src/components/tracker/TrackWaveform.vue';
import FrequencyAnalyzerComponent from 'src/components/FrequencyAnalyzerComponent.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import { ahxPreviewOutputNode } from 'src/audio/tracker/ahx-preview-output';

/**
 * B2 wiring smoke test: the analyzer row on AhxInstrumentPage draws the
 * preview voice with the tracker's own AHX scope (`TrackWaveform` on the
 * voice's snapshots) and a spectrum of `ahxPreviewOutputNode` (the direct
 * module import, mirroring ahxPListPlayhead), gated on the same `audible`
 * flag the audition bar uses. Not an audio-correctness test.
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
    const osc = w.findComponent(TrackWaveform);
    const freq = w.findComponent(FrequencyAnalyzerComponent);
    expect(osc.exists()).toBe(true);
    expect(freq.exists()).toBe(true);
    // The tracker's AHX scope: the preview voice's own snapshots, at the tracker's scope gain.
    expect(osc.props('scopeSource')).toBe(scope.waveform);
    expect(osc.props('scopeGain')).toBe(1);
    expect(freq.props('node')).toBe(ahxPreviewOutputNode.value);
    expect(freq.props('node')).toBeNull();
  });

  it('asks for the preview voice\'s waveform while the page is open, and stops after', async () => {
    load();
    scope.enabled.length = 0;
    const w = await mountEditor(1);
    expect(scope.enabled).toEqual([true]);
    w.unmount();
    expect(scope.enabled).toEqual([true, false]);
  });

  it('not audible: renders ahx-analyzer-off, no analyzer components mounted', async () => {
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(karma()));
    setCurrentAhxSource(null);
    const w = await mountEditor(1);
    expect(has(w, 'ahx-analyzer-row')).toBe(false);
    expect(has(w, 'ahx-analyzer-off')).toBe(true);
    expect(w.findComponent(TrackWaveform).exists()).toBe(false);
    expect(w.findComponent(FrequencyAnalyzerComponent).exists()).toBe(false);
  });

  it('reacts to ahxPreviewOutputNode changing: prop follows the ref, in and back out', async () => {
    load();
    const w = await mountEditor(1);
    const node = fakeAudioNode();
    ahxPreviewOutputNode.value = node;
    await w.vm.$nextTick();
    expect(w.findComponent(FrequencyAnalyzerComponent).props('node')).toBe(node);
    expect(has(w, 'ahx-analyzer-idle')).toBe(false);
    ahxPreviewOutputNode.value = null;
    await w.vm.$nextTick();
    expect(w.findComponent(FrequencyAnalyzerComponent).props('node')).toBeNull();
    expect(has(w, 'ahx-analyzer-idle')).toBe(true);
  });
});
