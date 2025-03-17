<template>
  <q-card class="filter-card">
    <!-- Header: forward events to container -->
    <audio-card-header
      title="Noise"
      :isMinimized="props.isMinimized"
      @plusClicked="forwardPlus"
      @minimizeClicked="forwardMinimize"
      @closeClicked="forwardClose"
    />

    <q-separator />

    <!-- Main content is shown only when not minimized -->
    <q-card-section class="filter-container" v-show="!props.isMinimized">
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

        <audio-knob-component
          v-model="noiseState.gain"
          label="Gain"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleGainChange"
        />
      </div>

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
import AudioCardHeader from './AudioCardHeader.vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import RoutingComponent from './RoutingComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { VoiceNodeType } from 'src/audio/types/synth-layout';
import { type NoiseState, NoiseType } from 'src/audio/types/noise';

// Define component props (do not destructure to preserve reactivity)
interface Props {
  nodeId: number;
  isMinimized?: boolean;
}
const props = withDefaults(defineProps<Props>(), {
  isMinimized: false,
});

// Define emit to forward events upward
const emit = defineEmits(['plusClicked', 'minimizeClicked', 'closeClicked']);

function forwardPlus() {
  emit('plusClicked', VoiceNodeType.Noise);
}
function forwardMinimize() {
  emit('minimizeClicked');
}
function forwardClose() {
  emit('closeClicked', props.nodeId);
}

// Audio system store for managing the noise state.
const store = useAudioSystemStore();
const { noiseState } = storeToRefs(store);

// Utility function for noise type display.
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

// Computed property for noise state.
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

// Handlers for toggle and knob changes.
function handleEnabledChange(val: boolean) {
  const currentState = { ...filterState.value, is_enabled: val };
  store.noiseState = currentState;
}

function handleNoiseTypeChange(val: number) {
  const currentState = { ...filterState.value, noiseType: val as NoiseType };
  store.noiseState = currentState;
}

function handleCutoffChange(val: number) {
  const currentState = { ...filterState.value, cutoff: val };
  store.noiseState = currentState;
}

function handleGainChange(val: number) {
  const currentState = { ...filterState.value, gain: val };
  store.noiseState = currentState;
}

onMounted(() => {
  console.log('NoiseFilter mounted for node', props.nodeId);
});

watch(
  () => filterState.value,
  (newState) => {
    console.log('NoiseFilter: updating noise state', newState);
    store.currentInstrument?.updateNoiseState(props.nodeId, newState);
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
</style>
