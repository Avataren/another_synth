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
      <!-- <div class="knob-group">
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

        <audio-knob-component
          v-model="noiseState.gain"
          label="Gain"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleGainChange"
        />
      </div> -->

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
import { onMounted } from 'vue';
// import AudioKnobComponent from './AudioKnobComponent.vue';
import RoutingComponent from './RoutingComponent.vue';
// import { useAudioSystemStore } from 'src/stores/audio-system-store';
// import { storeToRefs } from 'pinia';
import { VoiceNodeType } from 'src/audio/types/synth-layout';

interface Props {
  nodeId: number;
}
const props = withDefaults(defineProps<Props>(), {
  nodeId: 0,
});
//const props = withDefaults(defineProps<Props>(), { node: null, Index: 0 });

// const store = useAudioSystemStore();
// const { velocityStates } = storeToRefs(store);

// Create a reactive reference to the oscillator state
// const filterState = computed({
//   get: () => {
//     const state = velocityState.value;
//     if (!state) {
//       return {
//         is_enabled: false,
//       };
//     }
//     return state;
//   },
//   set: (newState: VelocityState) => {
//     store.velocityState = { ...newState };
//   },
// });

// const handleResonanceChange = (val: number) => {
//   const currentState = {
//     ...filterState.value,
//     resonance: val,
//   };
//   store.filterStates.set(props.Index, currentState);
// };

// const handleEnabledChange = (val: boolean) => {
//   const currentState = {
//     ...filterState.value,
//     is_enabled: val,
//   };
//   store.velocityState = currentState;
// };

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

// watch(
//   () => filterState.value,
//   (newState) => {
//     console.log('todo: update velocityState in instrument.ts ', newState);
//     // store.currentInstrument?.updateNoiseState(
//     //   props.noiseId,
//     //   newState as NoiseState,
//     // );
//   },
//   { deep: true, immediate: true },
// );
</script>

<style scoped>
.filter-card {
  width: 600px;
  margin: 0.5rem auto;
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
