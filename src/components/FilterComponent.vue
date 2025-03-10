<template>
  <q-card class="filter-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Filter {{ props.nodeId }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="filter-container">
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
        <!-- Show cutoff only if filter type is NOT Comb -->
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
        <!-- Show comb frequency when filter type is Comb -->
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
        <!-- Always show resonance -->
        <audio-knob-component
          v-model="filterState.resonance"
          label="Resonance"
          :min="0.0"
          :max="1.0"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleResonanceChange"
        />
        <!-- Always show KeyTracking -->
        <audio-knob-component
          v-model="filterState.keytracking"
          label="KeyTracking"
          :min="0.0"
          :max="1.0"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleKeyTrackingChange"
        />
        <!-- Only show Gain knob if enabled -->
        <audio-knob-component
          v-if="gainEnabled"
          v-model="filterState.gain"
          label="Gain"
          :min="0.0"
          :max="1.2"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleGainChange"
        />
        <!-- Show comb dampening when filter type is Comb -->
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
        <q-select
          v-model="filterState.oversampling"
          label="Oversampling"
          :options="oversamplingOptions"
          @update:modelValue="handleOversamplingChange"
          dense
          class="wide-select"
          emit-value
          map-options
        />
      </div>
      <!-- Routing component so you can reassign connections -->
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
  node: AudioNode | null;
  nodeId: number;
}

const props = withDefaults(defineProps<Props>(), {
  node: null,
  nodeId: 0,
});
const slopeEnabled = ref(true);
const gainEnabled = ref(false);
const store = useAudioSystemStore();
const { filterStates } = storeToRefs(store);

const waveformCanvas = ref<HTMLCanvasElement | null>(null);

// Computed filter state with default values if not already in the store.
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

// Define options for filter type, slope and oversampling dropdowns
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

const oversamplingOptions = [
  { label: 'Off', value: 0 },
  { label: '2x', value: 2 },
  { label: '4x', value: 4 },
  { label: '8x', value: 8 },
  { label: '16x', value: 16 },
];

// Handlers for updating state
const handleActiveChange = (newValue: boolean) => {
  const currentState = { ...filterState.value, active: newValue };
  store.filterStates.set(props.nodeId, { ...toRaw(currentState) });
};

const handleGainChange = (newVal: number) => {
  const currentState = { ...filterState.value, gain: newVal };
  store.filterStates.set(props.nodeId, { ...toRaw(currentState) });
};

const handleCutoffChange = (newVal: number) => {
  const currentState = { ...filterState.value, cutoff: newVal };
  store.filterStates.set(props.nodeId, { ...toRaw(currentState) });
};

const handleResonanceChange = (newVal: number) => {
  const currentState = { ...filterState.value, resonance: newVal };
  store.filterStates.set(props.nodeId, { ...toRaw(currentState) });
};

const handleKeyTrackingChange = (newVal: number) => {
  const currentState = { ...filterState.value, keytracking: newVal };
  store.filterStates.set(props.nodeId, { ...toRaw(currentState) });
};

const handleFilterTypeChange = (newVal: FilterType) => {
  if (newVal === FilterType.Ladder || newVal === FilterType.Comb) {
    slopeEnabled.value = false;
  } else {
    slopeEnabled.value = true;
  }

  switch (newVal) {
    case FilterType.Ladder:
    case FilterType.Peaking:
    case FilterType.HighShelf:
    case FilterType.LowShelf:
      gainEnabled.value = true;
      break;
    default:
      gainEnabled.value = false;
  }

  const currentState = { ...filterState.value, filter_type: newVal };
  store.filterStates.set(props.nodeId, { ...toRaw(currentState) });
};

const handleFilterSlopeChange = (newVal: FilterSlope) => {
  const currentState = { ...filterState.value, filter_slope: newVal };
  store.filterStates.set(props.nodeId, { ...toRaw(currentState) });
};

const handleOversamplingChange = (newVal: number) => {
  const currentState = { ...filterState.value, oversampling: newVal };
  store.filterStates.set(props.nodeId, { ...toRaw(currentState) });
};

const handleCombFrequencyChange = (newVal: number) => {
  const currentState = { ...filterState.value, comb_frequency: newVal };
  store.filterStates.set(props.nodeId, { ...toRaw(currentState) });
};

const handleCombDampeningChange = (newVal: number) => {
  const currentState = { ...filterState.value, comb_dampening: newVal };
  store.filterStates.set(props.nodeId, { ...toRaw(currentState) });
};

// -----------------------------------------------------------------
// Throttled waveform update and caching logic for filter response
// -----------------------------------------------------------------
let cachedWaveformCanvas: HTMLCanvasElement | null = null;
const throttledUpdateWaveformDisplay = throttle(async () => {
  await updateCachedWaveform();
  updateWaveformDisplay();
}, 1000 / 10);

const updateCachedWaveform = async () => {
  if (!waveformCanvas.value) return;
  const width = waveformCanvas.value.offsetWidth;
  const height = waveformCanvas.value.offsetHeight;

  // Only update actual canvas resolution if size has changed.
  if (
    waveformCanvas.value.width !== width ||
    waveformCanvas.value.height !== height
  ) {
    waveformCanvas.value.width = width;
    waveformCanvas.value.height = height;
  }

  // Create an offscreen canvas to cache the waveform image.
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

  // 3) Fetch the filter response data (same length as canvas width).
  const filterData = await store.currentInstrument?.getFilterResponse(
    props.nodeId,
    width,
  );
  if (!filterData) return;

  // 4) Build the filter response path from left to right,
  //    starting at the bottom-left corner (0, height).
  offCtx.beginPath();
  offCtx.moveTo(0, height); // bottom-left
  for (let i = 0; i < filterData.length; i++) {
    // Each i is the x pixel, filterData[i] is normalized magnitude [0..1].
    const x = i;
    const y = height - filterData[i]! * height;
    offCtx.lineTo(x, y);
  }
  // Then go straight down to the bottom at the last x (width-1).
  //offCtx.lineTo(width - 1, height);
  const lastX = filterData.length - 1;
  //const lastY = height - filterData[lastX]! * height;
  console.log('## filterData[lastX]', filterData[lastX]);
  offCtx.lineTo(lastX, height);

  offCtx.closePath();

  // // 5) Fill under the curve
  offCtx.fillStyle = 'rgba(255, 152, 0, 0.3)';
  offCtx.fill();

  // // 6) Draw the outline
  offCtx.strokeStyle = '#FF9800';
  offCtx.lineWidth = 2;
  offCtx.stroke();

  // Cache the offscreen canvas so we can quickly redraw later.
  cachedWaveformCanvas = offscreen;
};

const updateWaveformDisplay = () => {
  if (!waveformCanvas.value) return;
  const canvas = waveformCanvas.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  // Instead of clearing, we simply draw the cached image over the full canvas.
  if (cachedWaveformCanvas) {
    ctx.drawImage(cachedWaveformCanvas, 0, 0);
  }
};

// -----------------------------------------------------------------

watch(
  () => ({ ...filterStates.value.get(props.nodeId) }),
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState.id === props.nodeId) {
        store.currentInstrument?.updateFilterState(props.nodeId, {
          ...toRaw(newState),
        } as FilterState);
        // Use the throttled waveform update instead of an immediate redraw.
        throttledUpdateWaveformDisplay();
      }
    }
  },
  { deep: true, immediate: true },
);

onMounted(() => {
  if (!filterStates.value.has(props.nodeId)) {
    store.filterStates.set(props.nodeId, { ...toRaw(filterState.value) });
  }
  if (waveformCanvas.value) {
    const canvas = waveformCanvas.value;
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    canvas.width = width;
    canvas.height = height;
    // Small delay to ensure the instrument is ready.
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
