<template>
  <q-page class="page-container" @click.capture="handleLeftClickClose">
    <div class="tool-menu q-pa-sm">
      <div class="tool-menu__info">
        <div class="tool-menu__title">Patch tools</div>
        <div class="tool-menu__hint">
          Right-click anywhere in the grid to add nodes
        </div>
      </div>
      <div
        v-if="portamentoState"
        class="tool-menu__portamento"
      >
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
    </div>

    <!-- Middle Scrollable Area: All DSP Nodes using CSS Grid -->
    <div
      class="middle-scroll q-pa-md"
      @contextmenu.prevent.stop="openAddMenu"
    >
      <div class="grid-container">
        <!-- Generators Column -->
        <div class="node-bg column">
          <div class="header">Generators</div>

          <!-- Wavetable Oscillator -->
          <generic-tab-container
            v-if="wavetableOscillatorNodes.length"
            :nodes="wavetableOscillatorNodes"
            :destinationNode="destinationNode"
            :componentName="WavetableOscillatorComponent"
            nodeLabel="WtOsc"
          />

          <!-- Oscillator -->
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

          <!-- Noise -->
          <generic-tab-container
            v-if="noiseNodes.length"
            :nodes="noiseNodes"
            :destinationNode="destinationNode"
            :componentName="NoiseComponent"
            nodeLabel="Noise"
          />

          <!-- Arpeggiator -->
          <generic-tab-container
            v-if="arpeggiatorNodes.length"
            :nodes="arpeggiatorNodes"
            :destinationNode="destinationNode"
            :componentName="ArpeggiatorComponent"
            nodeLabel="Arp"
          />

          <!-- Velocity -->
          <generic-tab-container
            v-if="velocityNodes.length"
            :nodes="velocityNodes"
            :destinationNode="destinationNode"
            :componentName="VelocityComponent"
            nodeLabel="Velocity"
          />
        </div>

        <!-- Modulators Column -->
        <div class="node-bg column">
          <div class="header">Modulators</div>

          <!-- LFO -->
          <generic-tab-container
            v-if="lfoNodes.length"
            :nodes="lfoNodes"
            :destinationNode="destinationNode"
            :componentName="LfoComponent"
            nodeLabel="LFO"
          />

          <!-- Envelope -->
          <generic-tab-container
            v-if="envelopeNodes.length"
            :nodes="envelopeNodes"
            :destinationNode="destinationNode"
            :componentName="EnvelopeComponent"
            nodeLabel="Env"
          />
        </div>

        <!-- Effects Column -->
        <div class="node-bg column">
          <div class="header">Filters</div>

          <!-- Filter -->
          <generic-tab-container
            v-if="filterNodes.length"
            :nodes="filterNodes"
            :destinationNode="destinationNode"
            :componentName="FilterComponent"
            nodeLabel="Filter"
          />

          <div class="header" style="margin-top: 4rem">Effects</div>

          <generic-tab-container
            v-if="chorusNodes.length"
            :nodes="chorusNodes"
            :destinationNode="destinationNode"
            :componentName="ChorusComponent"
            nodeLabel="Chorus"
          />

          <!-- Delay -->
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
            v-if="reverbNodes.length"
            :nodes="reverbNodes"
            :destinationNode="destinationNode"
            :componentName="ReverbComponent"
            nodeLabel="CReverb"
          />

          <!-- Convolver -->
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

    <!-- Bottom Fixed Row: utility components (no presets here) -->
    <div class="bottom-row q-pa-md">
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
  </q-page>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useInstrumentStore } from 'src/stores/instrument-store';
import { useLayoutStore } from 'src/stores/layout-store';
import { useNodeStateStore } from 'src/stores/node-state-store';

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

// Filters DSP components
import FilterComponent from 'src/components/FilterComponent.vue';
import DelayComponent from 'src/components/DelayComponent.vue';
import ConvolverComponent from 'src/components/ConvolverComponent.vue';
import ReverbComponent from 'src/components/ReverbComponent.vue';
import CompressorComponent from 'src/components/CompressorComponent.vue';
import SaturationComponent from 'src/components/SaturationComponent.vue';
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

const instrumentStore = useInstrumentStore();
const layoutStore = useLayoutStore();
const nodeStateStore = useNodeStateStore();
const { destinationNode } = storeToRefs(instrumentStore);

const addMenuVisible = ref(false);
const addMenu = ref<QMenuController | null>(null);

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
</script>

<style scoped>
/* Full viewport container */
.page-container {
  display: flex;
  flex-direction: column;
  height: 96vh;
  overflow: hidden;
}

.tool-menu {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 12px;
  background: #15181d;
  border-bottom: 1px solid #2b3140;
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
  color: #e9eef7;
}

.tool-menu__hint {
  font-size: 12px;
  color: #9fb2cc;
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

.tool-menu__portamento {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: #0e1117;
  border: 1px solid #273140;
  border-radius: 8px;
  min-width: 260px;
  max-width: 420px;
}

.tool-menu__portamento-label {
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #e9eef7;
  font-size: 11px;
}

.tool-menu__portamento-value {
  font-size: 12px;
  color: #9fb2cc;
  min-width: 56px;
  text-align: right;
}

.tool-menu__portamento-slider {
  width: 160px;
  min-width: 140px;
}

/* Fixed height for bottom row with scrolling overflow */
.bottom-row {
  flex: 0 0 220px; /* Prevents flex shrink/grow and sets a fixed basis */
  overflow-y: hidden;
  box-sizing: border-box;
  padding: 0.2rem 0 0 0;
  margin: 0;
  background-color: #1d2023;
  border-top: 1px solid #444;
}

/* Middle area scrollable */
.middle-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  background-image: linear-gradient(rgb(49, 69, 105), rgb(25, 38, 56));
}

.add-node-menu {
  min-width: 280px;
  background: #11151c;
  color: #e9eef7;
}

.menu-section-header {
  color: #8fa5c5;
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
  /* Each column will be at least 600px wide */
  grid-template-columns: repeat(auto-fit, minmax(600px, 1fr));
}

/* Force columns to stack when viewport is below 900px */
@media (max-width: 900px) {
  .grid-container {
    grid-template-columns: 1fr;
  }
}

/* Each node container gets a fixed min-width to prevent overlap */
.node-bg {
  min-width: 300px;
  padding: 0.5rem;
  box-sizing: border-box;
  width: 100%;
}

/* Allow multiple DSP components per column */
.column {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* Fix each generic-tab-container's width to 600px */
.generic-tab-container {
  flex: 0 0 auto;
  width: 600px;
}
</style>
