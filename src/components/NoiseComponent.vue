<template>
  <q-card class="filter-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Noise</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="filter-container">
      <div class="knob-group">
        <q-toggle
          v-model="filterState.is_enabled"
          label="Enabled"
          @update:modelValue="handleEnabledChange"
        />
      </div>
      <div class="knob-group">
        <audio-knob-component
          v-model="noiseState.noiseType"
          label="Noise type"
          :min="0"
          :max="2"
          :step="1"
          :decimals="0"
          :unitFunc="parseNoiseUnit"
          @update:modelValue="handleNoiseTypeChange"
        />

        <audio-knob-component
          v-model="noiseState.cutoff"
          label="Cutoff"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleCutoffChange"
        />
      </div>

      <!-- Add the routing component -->
      <routing-component
        :source-id="noiseId"
        :source-type="VoiceNodeType.Noise"
        :debug="true"
      />

      <div class="canvas-wrapper">
        <canvas ref="frequencyCanvas" width="565" height="120"></canvas>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import RoutingComponent from './RoutingComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { VoiceNodeType } from 'src/audio/types/synth-layout';
import { type NoiseState, NoiseType } from 'src/audio/types/noise';

interface Props {
  noiseId: number;
}
const props = withDefaults(defineProps<Props>(), {
  noiseId: 0,
});
//const props = withDefaults(defineProps<Props>(), { node: null, Index: 0 });
const frequencyCanvas = ref<HTMLCanvasElement | null>(null);

const store = useAudioSystemStore();
const { noiseState } = storeToRefs(store);

const parseNoiseUnit = (val: number) => {
  switch (val as NoiseType) {
    case NoiseType.White:
      return 'White';
    case NoiseType.Brownian:
      return 'Brown';
    case NoiseType.Pink:
      return 'Pink';
    default:
      return 'Unknown';
  }
};

// Create a reactive reference to the oscillator state
const filterState = computed({
  get: () => {
    const state = noiseState.value;
    if (!state) {
      return {
        noiseType: NoiseType.White,
        cutoff: 1,
        gain: 1,
        is_enabled: false,
      };
    }
    return state;
  },
  set: (newState: NoiseState) => {
    store.noiseState = { ...newState };
  },
});

// const handleResonanceChange = (val: number) => {
//   const currentState = {
//     ...filterState.value,
//     resonance: val,
//   };
//   store.filterStates.set(props.Index, currentState);
// };

const handleEnabledChange = (val: boolean) => {
  const currentState = {
    ...filterState.value,
    is_enabled: val,
  };
  store.noiseState = currentState;
};

const handleNoiseTypeChange = (val: number) => {
  const currentState = {
    ...filterState.value,
    noiseType: val as NoiseType,
  };
  store.noiseState = currentState;
};

const handleCutoffChange = (val: number) => {
  const currentState = {
    ...filterState.value,
    cutoff: val,
  };
  store.noiseState = currentState;
};

onMounted(() => {
  //computeFrequencyResponse();
  //noiseGenerator.setSeed(123); // to avoid linter error
});

watch(
  () => filterState.value,
  (newState) => {
    console.log('todo: update noisestate in instrument.ts ', newState);
    store.currentInstrument?.updateNoiseState(
      props.noiseId,
      newState as NoiseState,
    );
  },
  { deep: true, immediate: true },
);
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
  border: 1px solid #ccc;
  background-color: rgb(200, 200, 200);
  border-radius: 4px;
}
</style>
