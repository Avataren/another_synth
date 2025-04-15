<template>
  <q-card class="chorus-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Reverb</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="chorus-container">
      <div class="controls-row">
        <q-toggle
          v-model="reverbState.active"
          label="Enabled"
          class="q-mb-md"
          @update:modelValue="handleEnabledChange"
        />
      </div>
      <div class="knob-group">
        <audio-knob-component
          v-model="reverbState.room_size"
          label="RoomSize"
          :min="0.0"
          :max="1.0"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleRoomSizeChange"
        />
        <audio-knob-component
          v-model="reverbState.damp"
          label="Damp"
          :min="0.0"
          :max="1.0"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleDampChange"
        />
        <audio-knob-component
          v-model="reverbState.dry"
          label="Dry"
          :min="0.0"
          :max="1.0"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleDryChange"
        />
        <audio-knob-component
          v-model="reverbState.wet"
          label="Wet"
          :min="0.0"
          :max="1.0"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleWetChange"
        />
        <audio-knob-component
          v-model="reverbState.width"
          label="Width"
          :min="0.0"
          :max="1.0"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleWidthChange"
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
import { type ReverbState } from 'src/audio/types/synth-layout'; // Adjust path if needed

interface Props {
  nodeId: number;
}
const props = withDefaults(defineProps<Props>(), {
  nodeId: 0,
});

const store = useAudioSystemStore();
// Use chorusStates from the store
const { reverbStates } = storeToRefs(store);

// Create a reactive computed property for the chorus state of the current node
const reverbState = computed({
  get: (): ReverbState => {
    const state = reverbStates.value.get(props.nodeId);
    // Provide sensible defaults if state doesn't exist yet
    if (!state) {
      return {
        id: props.nodeId,
        active: true,
        room_size: 0.95,
        damp: 0.5,
        wet: 0.3,
        dry: 0.7,
        width: 1.0,
      };
    }
    return state;
  },
  set: (newState: ReverbState) => {
    // Update the state in the Pinia store
    store.reverbStates.set(props.nodeId, { ...newState });
  },
});

// --- Event Handlers ---
// Each handler updates the specific property in the local computed state,
// which triggers the 'set' function above, updating the store.

const handleEnabledChange = (val: boolean) => {
  reverbState.value = { ...reverbState.value, active: val };
};

const handleRoomSizeChange = (val: number) => {
  reverbState.value = { ...reverbState.value, room_size: val };
};

const handleDampChange = (val: number) => {
  reverbState.value = { ...reverbState.value, damp: val };
};

const handleDryChange = (val: number) => {
  reverbState.value = { ...reverbState.value, dry: val };
};

const handleWetChange = (val: number) => {
  reverbState.value = { ...reverbState.value, wet: val };
};

const handleWidthChange = (val: number) => {
  reverbState.value = { ...reverbState.value, width: val };
};
// --- Watcher ---
// Watch for changes in the local computed state and push them to the
// actual audio engine/instrument via the store's currentInstrument reference.
watch(
  () => reverbState.value,
  (newState) => {
    store.currentInstrument?.updateReverbState(props.nodeId, {
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
