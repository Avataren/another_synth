<template>
  <q-card class="filter-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Convolver</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="filter-container">
      <div class="knob-group">
        <q-toggle
          v-model="convolverState.active"
          label="Enabled"
          @update:modelValue="handleEnabledChange"
        />
      </div>
      <div class="knob-group">
        <audio-knob-component
          v-model="convolverState.wetMix"
          label="Mix"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="0"
          @update:modelValue="handleWetMixChange"
        />
      </div>

      <div class="canvas-wrapper">
        <canvas ref="frequencyCanvas" width="565" height="120"></canvas>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { type ConvolverState } from 'src/audio/types/synth-layout';

interface Props {
  nodeId: number;
}
const props = withDefaults(defineProps<Props>(), {
  nodeId: 0,
});
//const props = withDefaults(defineProps<Props>(), { node: null, Index: 0 });

const store = useAudioSystemStore();
const { convolverStates } = storeToRefs(store);

// Create a reactive reference to the oscillator state
const convolverState = computed({
  get: () => {
    const state = convolverStates.value.get(props.nodeId);
    if (!state) {
      return {
        id: props.nodeId,
        wetMix: 0.1,
        active: false,
      };
    }
    return state;
  },
  set: (newState: ConvolverState) => {
    store.convolverStates.set(props.nodeId, { ...newState });
  },
});

const handleEnabledChange = (val: boolean) => {
  const currentState = {
    ...convolverState.value,
    is_enabled: val,
  };

  store.convolverStates.set(props.nodeId, currentState);
};

const handleWetMixChange = (val: number) => {
  const currentState = {
    ...convolverState.value,
    wetMix: val,
  };
  store.convolverStates.set(props.nodeId, currentState);
};

watch(
  () => convolverState.value,
  (newState) => {
    store.currentInstrument?.updateConvolverState(
      props.nodeId,
      newState as ConvolverState,
    );
  },
  { deep: true, immediate: true },
);
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
