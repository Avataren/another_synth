<template>
  <q-card class="filter-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Velocity {{ props.nodeId }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="filter-container">
      <div class="knob-group">
        <!-- <q-toggle
          v-model="filterState.is_enabled"
          label="Enabled"
          @update:modelValue="handleEnabledChange"
        /> -->
      </div>
      <div class="knob-group">
        <audio-knob-component
          v-model="localVelocityState.sensitivity"
          label="Sensitivity"
          :min="0"
          :max="2"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleSensitivityChange"
        />

        <audio-knob-component
          v-model="localVelocityState.randomize"
          label="Randomize"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleRandomizeChange"
        />
      </div>

      <!-- Add the routing component -->
      <routing-component
        :source-id="props.nodeId"
        :source-type="VoiceNodeType.Noise"
        :debug="true"
      />
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import RoutingComponent from './RoutingComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import type { VelocityState } from 'src/audio/types/synth-layout';
import { VoiceNodeType } from 'src/audio/types/synth-layout';

interface Props {
  nodeId: number;
}
const props = withDefaults(defineProps<Props>(), {
  nodeId: 0,
});
//const props = withDefaults(defineProps<Props>(), { node: null, Index: 0 });

const store = useAudioSystemStore();
const { velocityState } = storeToRefs(store);

// Create a reactive reference to the oscillator state
const localVelocityState = computed({
  get: () => {
    const state = velocityState.value;
    if (!state) {
      return {
        sensitivity: 1.0,
        randomize: 0.0,
        active: false,
      };
    }
    return state;
  },
  set: (newState: VelocityState) => {
    store.velocityState = { ...newState };
  },
});

const handleSensitivityChange = (val: number) => {
  const currentState = {
    ...localVelocityState.value,
    sensitivity: val,
  };
  localVelocityState.value = currentState;
};

const handleRandomizeChange = (val: number) => {
  const currentState = {
    ...localVelocityState.value,
    randomize: val,
  };
  localVelocityState.value = currentState;
};

// const handleNoiseTypeChange = (val: number) => {
//   const currentState = {
//     ...filterState.value,
//     noiseType: val as NoiseType,
//   };
//   store.velocityState = currentState;
// };

// const handleCutoffChange = (val: number) => {
//   const currentState = {
//     ...filterState.value,
//     cutoff: val,
//   };
//   store.velocityState = currentState;
// };

// const handleGainChange = (val: number) => {
//   const currentState = {
//     ...filterState.value,
//     gain: val,
//   };
//   store.velocityState = currentState;
// };

onMounted(() => {
  //computeFrequencyResponse();
  //noiseGenerator.setSeed(123); // to avoid linter error
});

watch(
  () => localVelocityState.value,
  (newState: VelocityState) => {
    console.log('todo: update velocityState in instrument.ts ', newState);
    store.currentInstrument?.updateVelocityState(
      props.nodeId,
      newState as VelocityState,
    );
  },
  { deep: true, immediate: true },
);
</script>

<style scoped>
.filter-card {
  width: 600px;
  margin: 0.25rem auto; /* Reduced vertical margin */
}

.filter-container {
  padding: 0.5rem; /* Reduced padding */
}

.knob-group {
  display: flex;
  justify-content: space-around;
  align-items: center; /* Center items to reduce extra top space */
  margin-bottom: 0.5rem; /* Reduced bottom margin */
}
</style>
