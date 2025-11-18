<template>
  <q-card class="filter-card">
    <!-- Replaced the old header with the AudioCardHeader component -->
    <audio-card-header
      :title="displayName"
      :editable="true"
      :isMinimized="props.isMinimized"
      @plusClicked="forwardPlus"
      @minimizeClicked="forwardMinimize"
      @closeClicked="forwardClose"
      @update:title="handleNameChange"
    />

    <q-separator />

    <!-- Main content is only displayed if not minimized -->
    <q-card-section class="filter-container" v-show="!props.isMinimized">
      <!-- Toggle for filter active state -->
      <div class="knob-group">
        <q-toggle
          v-model="filterState.active"
          label="Active"
          @update:modelValue="handleActiveChange"
        />
      </div>

      <!-- A canvas to display the filter response curve -->
      <div class="canvas-wrapper">
        <canvas ref="waveformCanvas"></canvas>
      </div>

      <!-- Controls for cutoff, comb and other knobs -->
      <div class="knob-group">
        <audio-knob-component
          v-if="filterState.filter_type !== FilterType.Comb"
          v-model="filterState.cutoff"
          label="Cutoff (Hz)"
          :min="20"
          :max="20000"
          :step="1"
          :decimals="0"
          @update:modelValue="handleCutoffChange"
        />
        <audio-knob-component
          v-if="filterState.filter_type === FilterType.Comb"
          v-model="filterState.comb_frequency"
          label="Comb Frequency"
          :min="55"
          :max="880"
          :step="1"
          :decimals="0"
          @update:modelValue="handleCombFrequencyChange"
        />
        <audio-knob-component
          v-model="filterState.resonance"
          label="Resonance"
          :min="0.0"
          :max="1.0"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleResonanceChange"
        />
        <audio-knob-component
          v-model="filterState.keytracking"
          label="KeyTracking"
          :min="0.0"
          :max="1.0"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleKeyTrackingChange"
        />
        <audio-knob-component
          v-if="gainEnabled"
          v-model="filterState.gain"
          label="Gain"
          :min="0.0"
          :max="2.0"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleGainChange"
        />
        <audio-knob-component
          v-if="filterState.filter_type === FilterType.Comb"
          v-model="filterState.comb_dampening"
          label="Comb Dampening"
          :min="0.0"
          :max="1.0"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleCombDampeningChange"
        />
      </div>

      <!-- Dropdowns for filter type, slope and oversampling -->
      <div class="knob-group">
        <q-select
          v-model="filterState.filter_type"
          label="Filter Type"
          :options="filterTypeOptions"
          @update:modelValue="handleFilterTypeChange"
          dense
          class="wide-select"
          emit-value
          map-options
        />
        <q-select
          v-model="filterState.filter_slope"
          label="Filter Slope"
          :options="filterSlopeOptions"
          :disable="!slopeEnabled"
          @update:modelValue="handleFilterSlopeChange"
          dense
          class="wide-select"
          emit-value
          map-options
        />
        <!-- <q-select
          v-model="filterState.oversampling"
          label="Oversampling"
          :options="oversamplingOptions"
          @update:modelValue="handleOversamplingChange"
          dense
          class="wide-select"
          emit-value
          map-options
        /> -->
      </div>

      <!-- Routing component -->
      <routing-component
        :source-id="props.nodeId"
        :source-type="VoiceNodeType.Filter"
        :debug="true"
      />
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, toRaw } from 'vue';
import AudioCardHeader from './AudioCardHeader.vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import RoutingComponent from './RoutingComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { throttle } from 'src/utils/util';
import {
  FilterSlope,
  type FilterState,
  FilterType,
  VoiceNodeType,
} from 'src/audio/types/synth-layout';

interface Props {
  nodeId: number;
  isMinimized?: boolean;
  nodeName?: string;
}

// Default isMinimized to false
const props = withDefaults(defineProps<Props>(), {
  isMinimized: false,
});

// Define events we want to forward
const emit = defineEmits(['plusClicked', 'minimizeClicked', 'closeClicked']);
function forwardPlus() {
  emit('plusClicked', VoiceNodeType.Filter);
}
function forwardMinimize() {
  emit('minimizeClicked');
}
function forwardClose() {
  emit('closeClicked', props.nodeId);
}

// Slope/gain toggles for certain filter types
const slopeEnabled = ref(true);
const gainEnabled = ref(true);

const store = useAudioSystemStore();
const { filterStates } = storeToRefs(store);

const displayName = computed(
  () => props.nodeName || store.getNodeName(props.nodeId) || `Filter ${props.nodeId}`,
);

function handleNameChange(name: string) {
  store.renameNode(props.nodeId, name);
}
const waveformCanvas = ref<HTMLCanvasElement | null>(null);

// Computed filter state with default values
const filterState = computed<FilterState>({
  get: () => {
    const state = filterStates.value.get(props.nodeId);
    if (!state) {
      console.warn(`No state found for filter ${props.nodeId}`);
      return {
        id: props.nodeId,
        cutoff: 20000,
        resonance: 0.7,
        keytracking: 0,
        comb_frequency: 220,
        comb_dampening: 0.5,
        gain: 0.5,
        oversampling: 0,
        filter_type: FilterType.LowPass,
        filter_slope: FilterSlope.Db12,
        active: true,
      } as FilterState;
    }
    return state;
  },
  set: (newState: FilterState) => {
    store.filterStates.set(props.nodeId, { ...toRaw(newState) });
  },
});

// Select option definitions
const filterTypeOptions = [
  { label: 'Low Pass', value: FilterType.LowPass },
  { label: 'Notch', value: FilterType.Notch },
  { label: 'High Pass', value: FilterType.HighPass },
  { label: 'Ladder 24db', value: FilterType.Ladder },
  { label: 'Comb', value: FilterType.Comb },
  { label: 'Low Shelf', value: FilterType.LowShelf },
  { label: 'Peaking', value: FilterType.Peaking },
  { label: 'High Shelf', value: FilterType.HighShelf },
];
const filterSlopeOptions = [
  { label: '12 dB/oct', value: FilterSlope.Db12 },
  { label: '24 dB/oct', value: FilterSlope.Db24 },
];
// const oversamplingOptions = [
//   { label: 'Off', value: 0 },
//   { label: '2x', value: 2 },
//   { label: '4x', value: 4 },
//   { label: '8x', value: 8 },
//   { label: '16x', value: 16 },
// ];

// Handlers for state changes
function handleActiveChange(newValue: boolean) {
  store.filterStates.set(props.nodeId, {
    ...toRaw(filterState.value),
    active: newValue,
  });
}
function handleGainChange(newVal: number) {
  store.filterStates.set(props.nodeId, {
    ...toRaw(filterState.value),
    gain: newVal,
  });
}
function handleCutoffChange(newVal: number) {
  store.filterStates.set(props.nodeId, {
    ...toRaw(filterState.value),
    cutoff: newVal,
  });
}
function handleResonanceChange(newVal: number) {
  store.filterStates.set(props.nodeId, {
    ...toRaw(filterState.value),
    resonance: newVal,
  });
}
function handleKeyTrackingChange(newVal: number) {
  store.filterStates.set(props.nodeId, {
    ...toRaw(filterState.value),
    keytracking: newVal,
  });
}
function handleFilterTypeChange(newVal: FilterType) {
  // Decide if slope is enabled
  slopeEnabled.value = !(
    newVal === FilterType.Ladder || newVal === FilterType.Comb
  );

  // Decide if gain is enabled
  switch (newVal) {
    case FilterType.Ladder:
    case FilterType.Peaking:
    case FilterType.HighShelf:
    case FilterType.LowShelf:
      gainEnabled.value = true;
      break;
    default:
      gainEnabled.value = true;
  }

  store.filterStates.set(props.nodeId, {
    ...toRaw(filterState.value),
    filter_type: newVal,
  });
}
function handleFilterSlopeChange(newVal: FilterSlope) {
  store.filterStates.set(props.nodeId, {
    ...toRaw(filterState.value),
    filter_slope: newVal,
  });
}
// function handleOversamplingChange(newVal: number) {
//   store.filterStates.set(props.nodeId, {
//     ...toRaw(filterState.value),
//     oversampling: newVal,
//   });
// }
function handleCombFrequencyChange(newVal: number) {
  store.filterStates.set(props.nodeId, {
    ...toRaw(filterState.value),
    comb_frequency: newVal,
  });
}
function handleCombDampeningChange(newVal: number) {
  store.filterStates.set(props.nodeId, {
    ...toRaw(filterState.value),
    comb_dampening: newVal,
  });
}

// -----------------------------------------------------
// Throttled waveform update and caching logic
// -----------------------------------------------------
let cachedWaveformCanvas: HTMLCanvasElement | null = null;

const throttledUpdateWaveformDisplay = throttle(async () => {
  await updateCachedWaveform();
  updateWaveformDisplay();
}, 1000 / 60);

async function updateCachedWaveform() {
  if (!waveformCanvas.value) return;
  const width = waveformCanvas.value.offsetWidth;
  const height = waveformCanvas.value.offsetHeight;

  // Ensure the actual canvas resolution matches offset sizes
  if (
    waveformCanvas.value.width !== width ||
    waveformCanvas.value.height !== height
  ) {
    waveformCanvas.value.width = width;
    waveformCanvas.value.height = height;
  }

  // Create an offscreen canvas to cache the waveform image
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) return;

  // 1) Fill background
  offCtx.fillStyle = '#1e2a3a';
  offCtx.fillRect(0, 0, width, height);

  // 2) Draw grid lines
  offCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  offCtx.lineWidth = 1;
  for (let x = 0; x < width; x += width / 8) {
    offCtx.beginPath();
    offCtx.moveTo(x, 0);
    offCtx.lineTo(x, height);
    offCtx.stroke();
  }
  for (let y = 0; y < height; y += height / 4) {
    offCtx.beginPath();
    offCtx.moveTo(0, y);
    offCtx.lineTo(width, y);
    offCtx.stroke();
  }

  // 3) Fetch the filter response data (same length as canvas width)
  const filterData = await store.currentInstrument?.getFilterResponse(
    props.nodeId,
    width,
  );
  if (!filterData) return;

  // 4) Draw the filter response path
  offCtx.beginPath();
  offCtx.moveTo(0, height); // bottom-left
  for (let i = 0; i < filterData.length; i++) {
    const x = i;
    const y = height - filterData[i]! * height;
    offCtx.lineTo(x, y);
  }
  offCtx.lineTo(filterData.length - 1, height); // bottom at last x
  offCtx.closePath();

  // 5) Fill under the curve
  offCtx.fillStyle = 'rgba(255, 152, 0, 0.3)';
  offCtx.fill();

  // 6) Draw the outline
  offCtx.strokeStyle = '#FF9800';
  offCtx.lineWidth = 2;
  offCtx.stroke();

  // Cache the offscreen canvas for fast redraw
  cachedWaveformCanvas = offscreen;
}

function updateWaveformDisplay() {
  if (!waveformCanvas.value) return;
  const ctx = waveformCanvas.value.getContext('2d');
  if (!ctx) return;
  if (cachedWaveformCanvas) {
    ctx.drawImage(cachedWaveformCanvas, 0, 0);
  }
}
// -----------------------------------------------------

// Watch the filter state in the store
watch(
  () => ({ ...filterStates.value.get(props.nodeId) }),
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState.id === props.nodeId) {
        store.currentInstrument?.updateFilterState(props.nodeId, {
          ...toRaw(newState),
        } as FilterState);
        throttledUpdateWaveformDisplay();
      }
    }
  },
  { deep: true, immediate: true },
);

onMounted(() => {
  // Ensure there's a FilterState entry in the store for this node
  if (!filterStates.value.has(props.nodeId)) {
    store.filterStates.set(props.nodeId, { ...toRaw(filterState.value) });
  }

  // Set up initial canvas size
  if (waveformCanvas.value) {
    const canvas = waveformCanvas.value;
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    canvas.width = width;
    canvas.height = height;

    // Delay slightly before first update
    setTimeout(async () => {
      await updateCachedWaveform();
      updateWaveformDisplay();
    }, 25);
  }

  window.addEventListener('resize', throttledUpdateWaveformDisplay);
});

onUnmounted(() => {
  window.removeEventListener('resize', throttledUpdateWaveformDisplay);
});
</script>

<style scoped>
.filter-card {
  width: 600px;
  margin: 0 auto;
}

.filter-container {
  padding: 1rem;
}

.knob-group {
  display: flex;
  justify-content: space-around;
  align-items: flex-start;
  margin-bottom: 1rem;
}

.canvas-wrapper {
  width: 100%;
  height: 120px;
  margin-top: 1rem;
}

canvas {
  width: 100%;
  height: 100%;
  border: 1px solid #ccc;
  background-color: #1e2a3a; /* match the offscreen background */
  border-radius: 4px;
}

/* Custom class to increase width of q-select */
.wide-select {
  width: 250px;
}
</style>
