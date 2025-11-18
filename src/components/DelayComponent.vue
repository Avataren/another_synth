<template>
  <q-card class="filter-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Delay</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="filter-container">
      <div class="knob-group">
        <q-toggle
          v-model="delayState.active"
          label="Enabled"
          @update:modelValue="handleEnabledChange"
        />
        <audio-knob-component
          v-model="delayState.delayMs"
          label="Delay"
          :min="0"
          :max="2000"
          :step="1"
          :decimals="1"
          @update:modelValue="handleDelayChange"
        />
        <audio-knob-component
          v-model="delayState.feedback"
          label="Feedback"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleFeedbackChange"
        />
        <audio-knob-component
          v-model="delayState.wetMix"
          label="Mix"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleWetMixChange"
        />
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { type DelayState } from 'src/audio/types/synth-layout';

interface Props {
  nodeId: string;
}
const props = withDefaults(defineProps<Props>(), {
  nodeId: '',
});

const store = useAudioSystemStore();
const { delayStates } = storeToRefs(store);

// Create a reactive reference to the oscillator state
const delayState = computed({
  get: () => {
    const state = delayStates.value.get(props.nodeId);
    if (!state) {
      return {
        id: props.nodeId,
        delayMs: 500,
        feedback: 0.5,
        wetMix: 0.1,
        active: true,
      };
    }
    return state;
  },
  set: (newState: DelayState) => {
    store.delayStates.set(props.nodeId, { ...newState });
  },
});

const handleEnabledChange = (val: boolean) => {
  const currentState = {
    ...delayState.value,
    active: val,
  };

  store.delayStates.set(props.nodeId, currentState);
};

const handleWetMixChange = (val: number) => {
  const currentState = {
    ...delayState.value,
    wetMix: val,
  };
  store.delayStates.set(props.nodeId, currentState);
};

const handleDelayChange = (val: number) => {
  const currentState = {
    ...delayState.value,
    delayMs: val,
  };
  store.delayStates.set(props.nodeId, currentState);
};

const handleFeedbackChange = (val: number) => {
  const currentState = {
    ...delayState.value,
    feedback: val,
  };
  store.delayStates.set(props.nodeId, currentState);
};

watch(
  () => delayState.value,
  (newState) => {
    store.currentInstrument?.updateDelayState(props.nodeId, {
      ...newState,
    });
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
