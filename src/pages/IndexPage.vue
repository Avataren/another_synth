<template>
  <q-page class="page-container" @click.capture="handleLeftClickClose">
    <div class="patch-layout">
      <!-- Song patch editing banner -->
      <div v-if="isEditingSongPatch" class="song-patch-banner">
        <div class="song-patch-banner__info">
          <q-icon name="edit" size="sm" />
          <span class="song-patch-banner__label">Editing Song Patch</span>
          <span class="song-patch-banner__slot">Slot #{{ String(editingSlotNumber).padStart(2, '0') }}</span>
          <span class="song-patch-banner__name">{{ editingPatchName }}</span>
        </div>
        <div class="song-patch-banner__actions">
          <q-btn
            flat
            dense
            color="primary"
            icon="save"
            label="Save"
            @click="saveSongPatch"
          />
          <q-btn
            flat
            dense
            color="white"
            icon="arrow_back"
            label="Back to Tracker"
            @click="backToTracker"
          />
        </div>
      </div>

      <div class="preset-row q-pa-sm">
        <PresetManager />
      </div>

      <div class="tool-menu q-pa-sm">
        <div class="tool-menu__info">
          <div class="tool-menu__title">Patch tools</div>
          <div class="tool-menu__hint">
            Right-click anywhere in the grid to add nodes
          </div>
        </div>
        <div v-if="portamentoState" class="tool-menu__portamento">
          <div class="tool-menu__portamento-label">Portamento</div>
          <q-toggle
            dense
            size="sm"
            v-model="portamentoActive"
            :label="portamentoActive ? 'On' : 'Off'"
            @update:model-value="commitPortamento"
          />
          <q-slider
            v-model="portamentoTime"
            dense
            color="primary"
            :min="0"
            :max="1"
            :step="0.005"
            class="tool-menu__portamento-slider"
            @change="commitPortamento"
          />
          <div class="tool-menu__portamento-value">{{ portamentoTimeLabel }}</div>
        </div>
        <div class="tool-menu__actions">
          <q-btn
            color="primary"
            dense
            unelevated
            icon="add_circle"
            label="Add node"
            @click="openAddMenuFromButton"
          />
        </div>
        <div class="tool-menu__toggles">
          <label class="tool-checkbox">
            <input v-model="showMacroRow" type="checkbox" />
            <span>Show macros</span>
          </label>
          <label class="tool-checkbox">
            <input v-model="showVisualizerRow" type="checkbox" />
            <span>Show visualizer & piano</span>
          </label>
        </div>
      </div>

      <div v-show="showMacroRow" class="macro-row q-pa-sm">
        <MacroControls />
      </div>

      <div v-show="showVisualizerRow" class="visualizer-row q-pa-md">
        <div class="row q-col-gutter-md">
          <div class="col-12 col-sm-6 col-lg-4">
            <oscilloscope-component :node="destinationNode" />
          </div>
          <div class="col-12 col-sm-6 col-lg-4">
            <piano-keyboard-component />
          </div>
          <div class="col-12 col-sm-6 col-lg-4">
            <frequency-analyzer-component :node="destinationNode" />
          </div>
        </div>
      </div>

      <div class="patch-scroll q-pa-md" @contextmenu.prevent.stop="openAddMenu">
        <div class="grid-container">
          <div class="node-bg column generators">
            <div class="header">Generators</div>
            <generic-tab-container
              v-if="wavetableOscillatorNodes.length"
              :nodes="wavetableOscillatorNodes"
              :destinationNode="destinationNode"
              :componentName="WavetableOscillatorComponent"
              nodeLabel="WtOsc"
            />
            <generic-tab-container
              v-if="oscillatorNodes.length"
              :nodes="oscillatorNodes"
              :destinationNode="destinationNode"
              :componentName="OscillatorComponent"
              nodeLabel="Osc"
            />
            <generic-tab-container
              v-if="samplerNodes.length"
              :nodes="samplerNodes"
              :destinationNode="destinationNode"
              :componentName="SamplerComponent"
              nodeLabel="Sampler"
            />
            <generic-tab-container
              v-if="noiseNodes.length"
              :nodes="noiseNodes"
              :destinationNode="destinationNode"
              :componentName="NoiseComponent"
              nodeLabel="Noise"
            />
            <generic-tab-container
              v-if="arpeggiatorNodes.length"
              :nodes="arpeggiatorNodes"
              :destinationNode="destinationNode"
              :componentName="ArpeggiatorComponent"
              nodeLabel="Arp"
            />
            <generic-tab-container
              v-if="velocityNodes.length"
              :nodes="velocityNodes"
              :destinationNode="destinationNode"
              :componentName="VelocityComponent"
              nodeLabel="Velocity"
            />
          </div>

          <div class="node-bg column modulators">
            <div class="header">Modulators</div>
            <generic-tab-container
              v-if="lfoNodes.length"
              :nodes="lfoNodes"
              :destinationNode="destinationNode"
              :componentName="LfoComponent"
              nodeLabel="LFO"
            />
            <generic-tab-container
              v-if="envelopeNodes.length"
              :nodes="envelopeNodes"
              :destinationNode="destinationNode"
              :componentName="EnvelopeComponent"
              nodeLabel="Env"
            />
          </div>

          <div class="node-bg effects">
            <div class="header">Effects</div>
            <div class="effects-grid">
              <generic-tab-container
                v-if="filterNodes.length"
                :nodes="filterNodes"
                :destinationNode="destinationNode"
                :componentName="FilterComponent"
                nodeLabel="Filter"
              />
              <generic-tab-container
                v-if="chorusNodes.length"
                :nodes="chorusNodes"
                :destinationNode="destinationNode"
                :componentName="ChorusComponent"
                nodeLabel="Chorus"
              />
              <generic-tab-container
                v-if="delayNodes.length"
                :nodes="delayNodes"
                :destinationNode="destinationNode"
                :componentName="DelayComponent"
                nodeLabel="Delay"
              />
              <generic-tab-container
                v-if="compressorNodes.length"
                :nodes="compressorNodes"
                :destinationNode="destinationNode"
                :componentName="CompressorComponent"
                nodeLabel="Comp"
              />
              <generic-tab-container
                v-if="saturationNodes.length"
                :nodes="saturationNodes"
                :destinationNode="destinationNode"
                :componentName="SaturationComponent"
                nodeLabel="Saturation"
              />
              <generic-tab-container
                v-if="bitcrusherNodes.length"
                :nodes="bitcrusherNodes"
                :destinationNode="destinationNode"
                :componentName="BitcrusherComponent"
                nodeLabel="Bitcrusher"
              />
              <generic-tab-container
                v-if="reverbNodes.length"
                :nodes="reverbNodes"
                :destinationNode="destinationNode"
                :componentName="ReverbComponent"
                nodeLabel="CReverb"
              />
              <generic-tab-container
                v-if="convolverNodes.length"
                :nodes="convolverNodes"
                :destinationNode="destinationNode"
                :componentName="ConvolverComponent"
                nodeLabel="Convolver"
              />
            </div>
          </div>
        </div>
      </div>

      <q-menu
        ref="addMenu"
        v-model="addMenuVisible"
        no-parent-event
        context-menu
        touch-position
        class="add-node-menu"
        transition-show="jump-down"
        transition-hide="jump-up"
      >
        <q-list dense>
          <template
            v-for="(section, sectionIndex) in addMenuSections"
            :key="section.label"
          >
            <q-item-label header class="menu-section-header">
              {{ section.label }}
            </q-item-label>
            <q-item
              v-for="item in section.items"
              :key="item.type"
              clickable
              @click="handleAddNode(item.type)"
            >
              <q-item-section avatar>
                <q-icon :name="item.icon" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ item.label }}</q-item-label>
                <q-item-label v-if="item.caption" caption>
                  {{ item.caption }}
                </q-item-label>
              </q-item-section>
            </q-item>
            <q-separator
              v-if="sectionIndex < addMenuSections.length - 1"
              spaced
              inset
            />
          </template>
        </q-list>
      </q-menu>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useInstrumentStore } from 'src/stores/instrument-store';
import { useLayoutStore } from 'src/stores/layout-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import { usePatchStore } from 'src/stores/patch-store';
import { useTrackerStore } from 'src/stores/tracker-store';
import PresetManager from 'src/components/PresetManager.vue';

// Components moved from the top row (now in the bottom row)
import OscilloscopeComponent from 'src/components/OscilloscopeComponent.vue';
import VelocityComponent from 'src/components/VelocityComponent.vue';
import FrequencyAnalyzerComponent from 'src/components/FrequencyAnalyzerComponent.vue';

// Bottom row component: Piano Keyboard
import PianoKeyboardComponent from 'src/components/PianoKeyboardComponent.vue';

// Generators DSP components
import OscillatorComponent from 'src/components/OscillatorComponent.vue';
import WavetableOscillatorComponent from 'src/components/WavetableOscillatorComponent.vue';
import NoiseComponent from 'src/components/NoiseComponent.vue';
import ArpeggiatorComponent from 'src/components/ArpeggiatorComponent.vue';
import SamplerComponent from 'src/components/SamplerComponent.vue';

// Modulators DSP components
import LfoComponent from 'src/components/LfoComponent.vue';
import EnvelopeComponent from 'src/components/EnvelopeComponent.vue';
import MacroControls from 'src/components/MacroControls.vue';

// Filters DSP components
import FilterComponent from 'src/components/FilterComponent.vue';
import DelayComponent from 'src/components/DelayComponent.vue';
import ConvolverComponent from 'src/components/ConvolverComponent.vue';
import ReverbComponent from 'src/components/ReverbComponent.vue';
import CompressorComponent from 'src/components/CompressorComponent.vue';
import SaturationComponent from 'src/components/SaturationComponent.vue';
import BitcrusherComponent from 'src/components/BitcrusherComponent.vue';
// Generic Tab Container
import GenericTabContainer from 'src/components/GenericTabContainer.vue';

// Node type definitions
import { VoiceNodeType } from 'src/audio/types/synth-layout';
import type { GlideState } from 'src/audio/types/synth-layout';
import ChorusComponent from 'src/components/ChorusComponent.vue';

type AddMenuItem = {
  label: string;
  type: VoiceNodeType;
  icon: string;
  caption?: string;
};

type AddMenuSection = {
  label: string;
  items: AddMenuItem[];
};

type QMenuController = {
  show: (evt?: Event) => void;
  hide: () => void;
  $el?: HTMLElement | null;
};

const route = useRoute();
const router = useRouter();
const instrumentStore = useInstrumentStore();
const layoutStore = useLayoutStore();
const nodeStateStore = useNodeStateStore();
const patchStore = usePatchStore();
const trackerStore = useTrackerStore();
const { destinationNode } = storeToRefs(instrumentStore);
const { editingSlot, songPatches } = storeToRefs(trackerStore);

const addMenuVisible = ref(false);
const addMenu = ref<QMenuController | null>(null);
const showMacroRow = ref(false);
const showVisualizerRow = ref(true);

// Song patch editing state
const isEditingSongPatch = computed(() => editingSlot.value !== null);
const editingSlotNumber = computed(() => editingSlot.value);
const editingPatchName = computed(() => {
  if (!editingSlot.value) return '';
  const slot = trackerStore.instrumentSlots.find(s => s.slot === editingSlot.value);
  return slot?.instrumentName || slot?.patchName || 'Song Patch';
});

async function loadSongPatchForEditing(slotNumber: number) {
  const slot = trackerStore.instrumentSlots.find(s => s.slot === slotNumber);
  if (!slot?.patchId) return;

  const patch = songPatches.value[slot.patchId];
  if (!patch) return;

  // Load the song patch into the instrument
  await patchStore.applyPatchObject(patch, { setCurrentPatchId: true });
}

async function saveSongPatch() {
  if (!editingSlot.value) return;

  // Serialize current patch state
  const patch = await patchStore.serializePatch(editingPatchName.value);
  if (!patch) return;

  // Update the song patch in tracker store
  trackerStore.updateEditingPatch(patch);
}

function backToTracker() {
  // Save before leaving
  void saveSongPatch().then(() => {
    trackerStore.stopEditing();
    void router.push('/tracker');
  });
}

// Watch for route changes to detect song patch editing
watch(
  () => route.query.editSongPatch,
  async (slotParam) => {
    if (slotParam) {
      const slotNumber = parseInt(slotParam as string, 10);
      if (!Number.isNaN(slotNumber)) {
        trackerStore.startEditingSlot(slotNumber);
        await loadSongPatchForEditing(slotNumber);
      }
    }
  },
  { immediate: true }
);

// Clean up editing state when leaving the page
onUnmounted(() => {
  if (isEditingSongPatch.value) {
    void saveSongPatch();
  }
});

const addMenuSections: AddMenuSection[] = [
  {
    label: 'Generators',
    items: [
      {
        label: 'Wavetable Oscillator',
        type: VoiceNodeType.WavetableOscillator,
        icon: 'waves',
        caption: 'Morph and blend tables',
      },
      {
        label: 'Oscillator',
        type: VoiceNodeType.Oscillator,
        icon: 'graphic_eq',
        caption: 'Classic subtractive starting point',
      },
      {
        label: 'Sampler',
        type: VoiceNodeType.Sampler,
        icon: 'library_music',
        caption: 'Trigger and mangle samples',
      },
      {
        label: 'Noise',
        type: VoiceNodeType.Noise,
        icon: 'grain',
        caption: 'Add texture or drive modulation',
      },
      {
        label: 'Arpeggiator',
        type: VoiceNodeType.ArpeggiatorGenerator,
        icon: 'queue_music',
        caption: 'Gate and pattern generator',
      },
    ],
  },
  {
    label: 'Modulators',
    items: [
      {
        label: 'LFO',
        type: VoiceNodeType.LFO,
        icon: 'show_chart',
        caption: 'Slow, cyclical movement',
      },
      {
        label: 'Envelope',
        type: VoiceNodeType.Envelope,
        icon: 'timeline',
        caption: 'Shape amplitude or filter sweeps',
      },
    ],
  },
  {
    label: 'Tone & FX',
    items: [
      {
        label: 'Filter',
        type: VoiceNodeType.Filter,
        icon: 'tune',
        caption: 'Carve frequencies and resonance',
      },
      {
        label: 'Delay',
        type: VoiceNodeType.Delay,
        icon: 'av_timer',
        caption: 'Echoes for depth',
      },
      {
        label: 'Compressor',
        type: VoiceNodeType.Compressor,
        icon: 'equalizer',
        caption: 'Tame peaks and add punch',
      },
      {
        label: 'Saturation',
        type: VoiceNodeType.Saturation,
        icon: 'whatshot',
        caption: 'Add harmonic drive and warmth',
      },
      {
        label: 'Chorus',
        type: VoiceNodeType.Chorus,
        icon: 'surround_sound',
        caption: 'Width and shimmer',
      },
      {
        label: 'Reverb',
        type: VoiceNodeType.Reverb,
        icon: 'blur_on',
        caption: 'Space and ambience',
      },
      {
        label: 'Convolver',
        type: VoiceNodeType.Convolver,
        icon: 'layers',
        caption: 'Impulse-based rooms and textures',
      },
    ],
  },
];

const handleAddNode = (nodeType: VoiceNodeType) => {
  instrumentStore.currentInstrument?.createNode(nodeType);
  addMenuVisible.value = false;
  addMenu.value?.hide();
};

const openAddMenu = (event?: Event) => {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (addMenu.value?.show) {
    addMenuVisible.value = false;
    addMenu.value.hide();
    nextTick(() => {
      addMenu.value?.show(event);
    });
  } else {
    addMenuVisible.value = true;
  }
};

const openAddMenuFromButton = (
  event: Event,
  _go?: (opts?: { to?: unknown; replace?: boolean; returnRouterError?: boolean }) => Promise<unknown>,
) => {
  openAddMenu(event);
};

const handleLeftClickClose = (event: MouseEvent) => {
  if (!addMenuVisible.value) return;
  if (event.button !== 0) return;

  const menuEl = addMenu.value?.$el;
  if (menuEl && menuEl.contains(event.target as Node)) {
    return;
  }

  addMenuVisible.value = false;
  addMenu.value?.hide();
};

// Improved computed properties with proper safeguards
// Velocity (only one instance)
const velocityNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.GlobalVelocity);
  return Array.isArray(nodes) ? nodes : [];
});

const glideNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Glide);
  return Array.isArray(nodes) ? nodes : [];
});

const portamentoNodeId = computed(() => glideNodes.value[0]?.id ?? null);

const portamentoState = computed<GlideState | null>(() => {
  const nodeId = portamentoNodeId.value;
  if (!nodeId) return null;
  return (
    nodeStateStore.glideStates.get(nodeId) ?? {
      id: nodeId,
      time: 0,
      active: false,
    }
  );
});

const portamentoTimeLabel = computed(
  () => `${(portamentoState.value?.time ?? 0).toFixed(3)}s`,
);

const portamentoTime = computed({
  get: () => portamentoState.value?.time ?? 0,
  set: (time: number) => {
    const nodeId = portamentoNodeId.value;
    const state = portamentoState.value;
    if (!nodeId || !state) return;
    nodeStateStore.glideStates.set(nodeId, { ...state, time, id: nodeId });
  },
});

const portamentoActive = computed({
  get: () => portamentoState.value?.active ?? false,
  set: (active: boolean) => {
    const nodeId = portamentoNodeId.value;
    const state = portamentoState.value;
    if (!nodeId || !state) return;
    nodeStateStore.glideStates.set(nodeId, { ...state, active, id: nodeId });
  },
});

const commitPortamento = () => {
  const nodeId = portamentoNodeId.value;
  const state = portamentoState.value;
  if (!nodeId || !state) return;
  nodeStateStore.glideStates.set(nodeId, { ...state, id: nodeId });
  instrumentStore.currentInstrument?.updateGlideState(nodeId, state);
};

// Generators DSP nodes
const oscillatorNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Oscillator);
  return Array.isArray(nodes) ? nodes : [];
});

const wavetableOscillatorNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.WavetableOscillator);
  return Array.isArray(nodes) ? nodes : [];
});

const samplerNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Sampler);
  return Array.isArray(nodes) ? nodes : [];
});

const noiseNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Noise);
  return Array.isArray(nodes) ? nodes : [];
});

const arpeggiatorNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.ArpeggiatorGenerator);
  return Array.isArray(nodes) ? nodes : [];
});

// Modulators DSP nodes
const lfoNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.LFO);
  return Array.isArray(nodes) ? nodes : [];
});

const envelopeNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Envelope);
  return Array.isArray(nodes) ? nodes : [];
});

// Filters DSP nodes
const filterNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Filter);
  return Array.isArray(nodes) ? nodes : [];
});

const delayNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Delay);
  return Array.isArray(nodes) ? nodes : [];
});

const chorusNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Chorus);
  return Array.isArray(nodes) ? nodes : [];
});

const reverbNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Reverb);
  return Array.isArray(nodes) ? nodes : [];
});

const convolverNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Convolver);
  return Array.isArray(nodes) ? nodes : [];
});

const compressorNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Compressor);
  return Array.isArray(nodes) ? nodes : [];
});

const saturationNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Saturation);
  return Array.isArray(nodes) ? nodes : [];
});

const bitcrusherNodes = computed(() => {
  const nodes = layoutStore.getVoiceNodes(0, VoiceNodeType.Bitcrusher);
  return Array.isArray(nodes) ? nodes : [];
});
</script>

<style scoped>
/* Song patch editing banner */
.song-patch-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: linear-gradient(90deg, var(--tracker-active-bg), var(--button-background));
  border-bottom: 1px solid var(--tracker-accent-secondary);
}

.song-patch-banner__info {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--text-primary);
}

.song-patch-banner__label {
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--tracker-accent-secondary);
}

.song-patch-banner__slot {
  font-family: var(--font-tracker);
  font-weight: 700;
  color: var(--tracker-accent-primary);
  background: var(--button-background);
  padding: 2px 8px;
  border-radius: 4px;
}

.song-patch-banner__name {
  color: var(--text-secondary);
  font-weight: 600;
}

.song-patch-banner__actions {
  display: flex;
  gap: 8px;
}

/* Full viewport container */
.page-container {
  display: flex;
  flex-direction: column;
  min-height: var(--q-page-container-height, 100vh);
  background: var(--app-background);
  overflow: hidden;
  height: 100%;
  flex: 1 1 auto;
  position: relative;
  --node-width: 640px;
}

.patch-layout {
  display: grid;
  grid-template-rows: auto auto auto auto 1fr auto;
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  position: absolute;
  inset: 0;
}

.patch-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}

.preset-row {
  background: var(--panel-background);
  border-bottom: 1px solid var(--panel-border);
  flex: 0 0 auto;
}

.tool-menu {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 12px;
  background: var(--panel-background-alt);
  border-bottom: 1px solid var(--panel-border);
  flex: 0 0 auto;
}

.tool-menu__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tool-menu__title {
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-primary);
}

.tool-menu__hint {
  font-size: 12px;
  color: var(--text-muted);
}

.tool-menu__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.tool-menu__actions .q-btn {
  text-transform: none;
}

.tool-menu__toggles {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
  align-items: center;
}

.tool-checkbox {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
}

.tool-checkbox input[type='checkbox'] {
  width: 14px;
  height: 14px;
  accent-color: var(--tracker-accent-primary);
}

.visualizer-row {
  background: var(--panel-background);
  border-bottom: 1px solid var(--panel-border);
  padding-top: 10px;
  padding-bottom: 10px;
}

.visualizer-row .row {
  align-items: stretch;
}

.visualizer-row .q-col-gutter-md > [class*='col-'] {
  display: flex;
}

.visualizer-row .q-card,
.visualizer-row .piano-keyboard,
.visualizer-row .frequency-analyzer,
.visualizer-row .oscilloscope-container {
  height: 140px;
  min-height: 140px;
  width: 100%;
}

.visualizer-row .oscilloscope-container {
  max-width: none;
  height: 100%;
}

.visualizer-row .piano-keyboard {
  max-width: none;
  margin: 0;
}

.visualizer-row .frequency-analyzer {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.visualizer-row canvas {
  height: 100% !important;
  width: 100% !important;
}

.macro-row {
  background: var(--panel-background);
  border-bottom: 1px solid var(--panel-border);
}

.tool-menu__portamento {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: var(--app-background);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  min-width: 260px;
  max-width: 420px;
}

.tool-menu__portamento-label {
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-primary);
  font-size: 11px;
}

.tool-menu__portamento-value {
  font-size: 12px;
  color: var(--text-muted);
  min-width: 56px;
  text-align: right;
}

.tool-menu__portamento-slider {
  width: 160px;
  min-width: 140px;
}

/* Fixed height for bottom row with scrolling overflow */
/* Middle area scrollable */
.middle-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  background-image: linear-gradient(var(--panel-background-alt), var(--panel-background));
}

.add-node-menu {
  min-width: 280px;
  background: var(--panel-background);
  color: var(--text-primary);
}

.menu-section-header {
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.add-node-menu .q-item {
  min-height: 48px;
}

/* Header styling for DSP columns */
.header {
  text-align: center;
  font-weight: bold;
  margin-bottom: 1rem;
}

/* CSS Grid container for the DSP columns */
.grid-container {
  display: grid;
  gap: 1rem;
  /* Each column will be at least the configured node width */
  grid-template-columns: repeat(auto-fit, minmax(var(--node-width), 1fr));
}

/* Force columns to stack when viewport is below 900px */
@media (max-width: 900px) {
  .grid-container {
    grid-template-columns: 1fr;
  }
}

/* Each node container gets a fixed min-width to prevent overlap */
.node-bg {
  min-width: var(--node-width);
  padding: 0.75rem;
  box-sizing: border-box;
  width: 100%;
  border-radius: 12px;
  border: 1px solid var(--panel-border);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
}

/* Allow multiple DSP components per column */
.column {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.generators {
  background: linear-gradient(135deg, var(--panel-background-alt), var(--panel-background));
}

.modulators {
  background: linear-gradient(135deg, var(--panel-background-alt), var(--panel-background));
}

.effects {
  background: linear-gradient(135deg, var(--panel-background-alt), var(--panel-background));
  grid-column: span 2;
  display: block;
}

.effects-grid {
  column-count: 2;
  column-gap: 1rem;
  column-width: var(--node-width);
}

.effects-grid > * {
  break-inside: avoid;
  width: 100%;
  max-width: var(--node-width);
  margin: 0 0 1rem 0;
}

:deep(.tabs-outer-wrapper) {
  width: 100%;
  max-width: var(--node-width);
  margin: 0 auto;
}

:deep(.tabs-wrapper),
:deep(.panels-wrapper) {
  width: 100%;
}

@media (max-width: 1400px) {
  .effects {
    grid-column: span 1;
  }

  .effects-grid {
    column-count: 1;
  }
}
</style>
