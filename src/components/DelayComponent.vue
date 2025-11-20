<template>
  <q-card class="filter-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">{{ displayName }}</div>
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
import { computed, onMounted } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useInstrumentStore } from 'src/stores/instrument-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import { storeToRefs } from 'pinia';
import { type DelayState } from 'src/audio/types/synth-layout';

interface Props {
  nodeId: string;
  nodeName?: string;
}
const props = withDefaults(defineProps<Props>(), {
  nodeId: '',
});

const instrumentStore = useInstrumentStore();
const nodeStateStore = useNodeStateStore();
const { delayStates } = storeToRefs(nodeStateStore);

const ensureDelayState = (): DelayState => {
  const existing = delayStates.value.get(props.nodeId);
  if (existing) {
    return existing;
  }
  return {
    id: props.nodeId,
    delayMs: 500,
    feedback: 0.5,
    wetMix: 0.1,
    active: true,
  };
};

const persistDelayState = (state: DelayState) => {
  nodeStateStore.delayStates.set(props.nodeId, { ...state });
};

const displayName = computed(() => props.nodeName || 'Delay');

// Create a reactive reference to the delay state sourced from node-state-store
const delayState = computed({
  get: () => ensureDelayState(),
  set: (newState: DelayState) => {
    persistDelayState({
      ...newState,
      id: props.nodeId,
    });
  },
});

const updateDelayState = (patch: Partial<DelayState>) => {
  const next = {
    ...ensureDelayState(),
    ...patch,
    id: props.nodeId,
  };
  persistDelayState(next);
  syncDelayToInstrument(next);
};

const syncDelayToInstrument = (state: DelayState) => {
  instrumentStore.currentInstrument?.updateDelayState(props.nodeId, {
    ...state,
  });
};

const handleEnabledChange = (val: boolean) => {
  updateDelayState({ active: val });
};

const handleWetMixChange = (val: number) => {
  updateDelayState({ wetMix: val });
};

const handleDelayChange = (val: number) => {
  updateDelayState({ delayMs: val });
};

const handleFeedbackChange = (val: number) => {
  updateDelayState({ feedback: val });
};

onMounted(() => {
  syncDelayToInstrument(ensureDelayState());
});
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
