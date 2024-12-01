<template>
  <q-card class="filter-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Filter {{ Index + 1 }}</div>
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
          v-model="filterState.feedback"
          label="Feedback"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleFeedbackChange"
        />

        <audio-knob-component
          v-model="filterState.damping"
          label="Damping"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleDampingChange"
        />
      </div>

      <div class="canvas-wrapper">
        <canvas></canvas>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { type FilterState } from 'src/audio/dsp/variable-comb-filter';

interface Props {
  node: AudioNode | null;
  Index: number;
}

const props = withDefaults(defineProps<Props>(), { node: null, Index: 0 });
//const node = computed(() => props.node);

const store = useAudioSystemStore();
const { filterStates } = storeToRefs(store);
// Create a reactive reference to the oscillator state
const filterState = computed({
  get: () => {
    const state = filterStates.value.get(props.Index);
    if (!state) {
      console.warn(`No state found for oscillator ${props.Index}`);
      return {
        id: props.Index,
        feedback: 0.5,
        damping: 0.5,
        is_enabled: false,
      };
    }
    return state;
  },
  set: (newState: FilterState) => {
    store.filterStates.set(props.Index, { ...newState });
  },
});

const handleEnabledChange = (val: boolean) => {
  const currentState = {
    ...filterState.value,
    is_enabled: val,
  };
  store.filterStates.set(props.Index, currentState);
};

const handleFeedbackChange = (val: number) => {
  const currentState = {
    ...filterState.value,
    feedback: val,
  };
  store.filterStates.set(props.Index, currentState);
};

const handleDampingChange = (val: number) => {
  const currentState = {
    ...filterState.value,
    damping: val,
  };
  store.filterStates.set(props.Index, currentState);
};

onMounted(() => {});

watch(
  () => ({ ...filterStates.value.get(props.Index) }), // Create new reference
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      ('');
      if (newState.id === props.Index) {
        store.currentInstrument?.updateFilterState(
          props.Index,
          newState as FilterState,
        );
      }
    }
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
  width: 100%;
  height: 100%;
  border: 1px solid #ccc;
  background-color: rgb(200, 200, 200);
  border-radius: 4px;
}
</style>
