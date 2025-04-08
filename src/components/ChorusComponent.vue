<template>
  <q-card class="chorus-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Chorus</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="chorus-container">
      <div class="controls-row">
        <q-toggle
          v-model="chorusState.active"
          label="Enabled"
          class="q-mb-md"
          @update:modelValue="handleEnabledChange"
        />
      </div>
      <div class="knob-group">
        <audio-knob-component
          v-model="chorusState.baseDelayMs"
          label="Delay"
          :min="0.1"
          :max="65"
          :step="0.1"
          :decimals="1"
          unit="ms"
          @update:modelValue="handleBaseDelayChange"
        />
        <audio-knob-component
          v-model="chorusState.depthMs"
          label="Depth"
          :min="0"
          :max="25"
          :step="0.1"
          :decimals="1"
          unit="ms"
          @update:modelValue="handleDepthChange"
        />
        <audio-knob-component
          v-model="chorusState.lfoRateHz"
          label="Rate"
          :min="0.01"
          :max="10"
          :step="0.01"
          :decimals="2"
          unit="Hz"
          @update:modelValue="handleRateChange"
        />
      </div>
      <div class="knob-group">
        <audio-knob-component
          v-model="chorusState.feedback"
          label="Feedback"
          :min="0"
          :max="0.98"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleFeedbackChange"
        />
        <audio-knob-component
          v-model="chorusState.feedback_filter"
          label="Filter"
          :min="0"
          :max="1"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleFeedbackFilterChange"
        />
        <audio-knob-component
          v-model="chorusState.mix"
          label="Mix"
          :min="0"
          :max="1"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleMixChange"
        />
        <audio-knob-component
          v-model="chorusState.stereoPhaseOffsetDeg"
          label="Stereo Phase"
          :min="0"
          :max="360"
          :step="1"
          :decimals="0"
          unit="°"
          @update:modelValue="handleStereoPhaseChange"
        />
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue'; // Assuming this path
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { type ChorusState } from 'src/audio/types/synth-layout'; // Adjust path if needed

interface Props {
  nodeId: number;
}
const props = withDefaults(defineProps<Props>(), {
  nodeId: 0,
});

const store = useAudioSystemStore();
// Use chorusStates from the store
const { chorusStates } = storeToRefs(store);

// Create a reactive computed property for the chorus state of the current node
const chorusState = computed({
  get: (): ChorusState => {
    const state = chorusStates.value.get(props.nodeId);
    // Provide sensible defaults if state doesn't exist yet
    if (!state) {
      return {
        id: props.nodeId,
        active: false,
        baseDelayMs: 15.0, // Default base delay
        depthMs: 5.0, // Default depth
        lfoRateHz: 0.5, // Default LFO rate
        feedback: 0.3, // Default feedback
        feedback_filter: 0.5,
        mix: 0.5, // Default mix
        stereoPhaseOffsetDeg: 90.0, // Default stereo phase
      };
    }
    return state;
  },
  set: (newState: ChorusState) => {
    // Update the state in the Pinia store
    store.chorusStates.set(props.nodeId, { ...newState });
  },
});

// --- Event Handlers ---
// Each handler updates the specific property in the local computed state,
// which triggers the 'set' function above, updating the store.

const handleEnabledChange = (val: boolean) => {
  chorusState.value = { ...chorusState.value, active: val };
};

const handleBaseDelayChange = (val: number) => {
  chorusState.value = { ...chorusState.value, baseDelayMs: val };
};

const handleDepthChange = (val: number) => {
  chorusState.value = { ...chorusState.value, depthMs: val };
};

const handleRateChange = (val: number) => {
  chorusState.value = { ...chorusState.value, lfoRateHz: val };
};

const handleFeedbackChange = (val: number) => {
  chorusState.value = { ...chorusState.value, feedback: val };
};

const handleFeedbackFilterChange = (val: number) => {
  chorusState.value = { ...chorusState.value, feedback_filter: val };
};

const handleMixChange = (val: number) => {
  chorusState.value = { ...chorusState.value, mix: val };
};

const handleStereoPhaseChange = (val: number) => {
  chorusState.value = { ...chorusState.value, stereoPhaseOffsetDeg: val };
};

// --- Watcher ---
// Watch for changes in the local computed state and push them to the
// actual audio engine/instrument via the store's currentInstrument reference.
watch(
  () => chorusState.value,
  (newState) => {
    // You need a method on your instrument interface to handle chorus updates
    // Ensure YourInstrumentInterface has this method defined.
    store.currentInstrument?.updateChorusState(props.nodeId, {
      ...newState, // Send the complete new state
    });
  },
  { deep: true, immediate: true }, // immediate: true ensures initial state is sent
);
</script>

<style scoped>
.chorus-card {
  /* Adjust width as needed based on knob count */
  /* Consider making it wider or using two rows */
  width: 100%;
  max-width: 750px; /* Example max width */
  margin: 0.5rem auto;
}

.chorus-container {
  padding: 1rem;
}

.controls-row {
  display: flex;
  justify-content: flex-start; /* Or center/flex-end */
  padding-left: 1rem; /* Align roughly with knobs */
}

.knob-group {
  display: flex;
  flex-wrap: wrap; /* Allow knobs to wrap on smaller screens */
  justify-content: space-around;
  align-items: flex-start;
  gap: 1rem; /* Add some space between knobs */
  margin-bottom: 1rem;
}

/* Optional: Add specific styling for the toggle if needed */
.q-toggle {
  /* Style overrides */
}
</style>
