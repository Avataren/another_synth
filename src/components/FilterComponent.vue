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
      <!-- A canvas to display a simple filter response curve -->
      <div class="canvas-wrapper">
        <canvas ref="waveformCanvas"></canvas>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, toRaw } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import RoutingComponent from './RoutingComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
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
    // Use toRaw to ensure we store a plain object
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

// Draw a basic filter response curve.
const drawFilterCurve = () => {
  const canvas = waveformCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;
  canvas.width = width;
  canvas.height = height;

  ctx.clearRect(0, 0, width, height);

  ctx.beginPath();
  ctx.strokeStyle = '#FF9800';
  ctx.lineWidth = 2;

  for (let x = 0; x <= width; x++) {
    const freq = 20 * Math.pow(20000 / 20, x / width);
    let gain;
    if (freq <= filterState.value.cutoff) {
      gain = 1;
    } else {
      gain =
        1 / (1 + (freq - filterState.value.cutoff) / filterState.value.cutoff);
    }
    const y = height - gain * height;
    if (x === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
};

watch(
  () => ({ ...filterStates.value.get(props.nodeId) }),
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState.id === props.nodeId) {
        // Pass a plain object to updateFilterState
        store.currentInstrument?.updateFilterState(props.nodeId, {
          ...toRaw(newState),
        } as FilterState);
        drawFilterCurve();
      }
    }
  },
  { deep: true, immediate: true },
);

onMounted(() => {
  if (!filterStates.value.has(props.nodeId)) {
    store.filterStates.set(props.nodeId, { ...toRaw(filterState.value) });
  }
  drawFilterCurve();
  window.addEventListener('resize', drawFilterCurve);
});

onUnmounted(() => {
  window.removeEventListener('resize', drawFilterCurve);
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
  background-color: rgb(200, 200, 200);
  border-radius: 4px;
}

/* Custom class to increase width of q-select */
.wide-select {
  width: 250px;
}
</style>
