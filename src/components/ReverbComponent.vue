<template>
  <q-card class="chorus-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">{{ displayName }}</div>
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
import { computed, onMounted } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useInstrumentStore } from 'src/stores/instrument-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import { storeToRefs } from 'pinia';
import { type ReverbState } from 'src/audio/types/synth-layout';

interface Props {
  nodeId: string;
  nodeName?: string;
}
const props = withDefaults(defineProps<Props>(), {
  nodeId: '',
});

const instrumentStore = useInstrumentStore();
const nodeStateStore = useNodeStateStore();
const { reverbStates } = storeToRefs(nodeStateStore);

const displayName = computed(() => props.nodeName || 'Reverb');

// Create a reactive computed property for the chorus state of the current node
const ensureReverbState = (): ReverbState => {
  const existing = reverbStates.value.get(props.nodeId);
  if (existing) {
    return existing;
  }

  return {
    id: props.nodeId,
    active: true,
    room_size: 0.95,
    damp: 0.5,
    wet: 0.3,
    dry: 0.7,
    width: 1.0,
  };
};

const persistReverbState = (state: ReverbState) => {
  nodeStateStore.reverbStates.set(props.nodeId, { ...state });
};

const reverbState = computed({
  get: (): ReverbState => ensureReverbState(),
  set: (newState: ReverbState) => {
    persistReverbState({
      ...newState,
      id: props.nodeId,
    });
  },
});

const updateReverbState = (patch: Partial<ReverbState>) => {
  const next = {
    ...ensureReverbState(),
    ...patch,
    id: props.nodeId,
  };
  persistReverbState(next);
  syncReverbToInstrument(next);
};

const syncReverbToInstrument = (state: ReverbState) => {
  instrumentStore.currentInstrument?.updateReverbState(props.nodeId, {
    ...state,
  });
};

// --- Event Handlers ---
// Each handler updates the specific property in the local computed state,
// which triggers the 'set' function above, updating the store.

const handleEnabledChange = (val: boolean) => {
  updateReverbState({ active: val });
};

const handleRoomSizeChange = (val: number) => {
  updateReverbState({ room_size: val });
};

const handleDampChange = (val: number) => {
  updateReverbState({ damp: val });
};

const handleDryChange = (val: number) => {
  updateReverbState({ dry: val });
};

const handleWetChange = (val: number) => {
  updateReverbState({ wet: val });
};

const handleWidthChange = (val: number) => {
  updateReverbState({ width: val });
};

onMounted(() => {
  syncReverbToInstrument(ensureReverbState());
});
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
