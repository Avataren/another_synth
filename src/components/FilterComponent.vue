<template>
  <q-card class="filter-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Filter {{ props.nodeId + 1 }}</div>
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
      <!-- Controls for cutoff and resonance -->
      <div class="knob-group">
        <audio-knob-component
          v-model="filterState.cutoff"
          label="Cutoff (Hz)"
          :min="20"
          :max="20000"
          :step="1"
          :decimals="0"
          @update:modelValue="handleCutoffChange"
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
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import RoutingComponent from './RoutingComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { type FilterState, VoiceNodeType } from 'src/audio/types/synth-layout';

// Define the filter configuration type. Adjust as needed.

interface Props {
  node: AudioNode | null;
  nodeId: number;
}

const props = withDefaults(defineProps<Props>(), {
  node: null,
  nodeId: 0,
});

// Access the audio system store and extract filterStates.
// (This works similarly to envelopeStates in your envelope component.)
const store = useAudioSystemStore();
const { filterStates } = storeToRefs(store);

// A canvas ref to draw a simple filter response curve.
const waveformCanvas = ref<HTMLCanvasElement | null>(null);

// Create a computed reference for the filter state.
// If no state is stored yet for this node, we use default values.
const filterState = computed<FilterState>({
  get: () => {
    const state = filterStates.value.get(props.nodeId);
    if (!state) {
      console.warn(`No state found for filter ${props.nodeId}`);
      return {
        id: props.nodeId,
        cutoff: 1000,
        resonance: 1,
        active: true,
      } as FilterState;
    }
    return state;
  },
  set: (newState: FilterState) => {
    store.filterStates.set(props.nodeId, { ...newState });
  },
});

// Handler for toggling the filter active state.
const handleActiveChange = (newValue: boolean) => {
  const currentState = { ...filterState.value, active: newValue };
  store.filterStates.set(props.nodeId, currentState);
};

// Handler for cutoff changes.
const handleCutoffChange = (newVal: number) => {
  const currentState = { ...filterState.value, cutoff: newVal };
  store.filterStates.set(props.nodeId, currentState);
};

// Handler for resonance changes.
const handleResonanceChange = (newVal: number) => {
  const currentState = { ...filterState.value, resonance: newVal };
  store.filterStates.set(props.nodeId, currentState);
};

// Draw a basic filter response curve as a visual representation.
// This is a placeholder that uses the current cutoff and resonance values.
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

  // For each pixel column, map to a frequency (logarithmically from 20 Hz to 20 kHz)
  // and simulate a roll-off above the cutoff frequency.
  for (let x = 0; x <= width; x++) {
    const freq = 20 * Math.pow(20000 / 20, x / width);
    let gain;
    if (freq <= filterState.value.cutoff) {
      gain = 1;
    } else {
      gain =
        1 / (1 + (freq - filterState.value.cutoff) / filterState.value.cutoff);
    }
    // Map gain (from 0 to 1) to a y position (0 = top, height = bottom)
    const y = height - gain * height;
    if (x === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
};

// Watch for changes in the filter state and update the DSP node via messages.
// This mimics the envelope component’s approach.
watch(
  () => ({ ...filterStates.value.get(props.nodeId) }),
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState.id === props.nodeId) {
        // Send the updated filter state via the instrument messaging system.
        store.currentInstrument?.updateFilterState(
          props.nodeId,
          newState as FilterState,
        );
        drawFilterCurve();
      }
    }
  },
  { deep: true, immediate: true },
);

// When the component mounts, initialize the filter state and start drawing.
onMounted(() => {
  if (!filterStates.value.has(props.nodeId)) {
    filterStates.value.set(props.nodeId, filterState.value);
  }
  drawFilterCurve();
  window.addEventListener('resize', drawFilterCurve);
});

// Clean up the resize listener on unmount.
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
</style>
