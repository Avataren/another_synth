<template>
  <q-card class="filter-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">{{ displayName }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="filter-container">
      <div class="knob-group">
        <q-toggle
          v-model="convolverState.active"
          label="Enabled"
          @update:modelValue="handleEnabledChange"
        />
        <audio-knob-component
          v-model="convolverState.wetMix"
          label="Mix"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleWetMixChange"
        />
      </div>
    </q-card-section>
    <q-card-section class="import-section">
      <div class="row">
        <div class="col-6">
          <div class="text-h6">Import Impulse Response</div>

          <input type="file" accept=".wav" @change="handleWavFileUpload" />
        </div>
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
import { type ConvolverState } from 'src/audio/types/synth-layout';

interface Props {
  nodeId: string;
  nodeName?: string;
}
const props = withDefaults(defineProps<Props>(), {
  nodeId: '',
});
//const props = withDefaults(defineProps<Props>(), { node: null, Index: 0 });

const instrumentStore = useInstrumentStore();
const nodeStateStore = useNodeStateStore();
const { convolverStates } = storeToRefs(nodeStateStore);

const displayName = computed(() => props.nodeName || 'Convolver');

const handleWavFileUpload = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  const file = input.files[0];
  if (!file) {
    console.error('No file selected');
    return;
  }
  try {
    const arrayBuffer = await file.arrayBuffer();
    const wavBytes = new Uint8Array(arrayBuffer);
    console.log('WAV file loaded, size:', wavBytes.length);

    if (instrumentStore.currentInstrument) {
      // Call the new import function on your instrument
      instrumentStore.currentInstrument.importImpulseWaveformData(props.nodeId, wavBytes);
    } else {
      console.error('Instrument instance not available');
    }
  } catch (err) {
    console.error('Error reading WAV file:', err);
    alert(err);
  }
};

// Create a reactive reference to the oscillator state
const ensureConvolverState = (): ConvolverState => {
  const state = convolverStates.value.get(props.nodeId);
  if (state) {
    return state;
  }
  return {
    id: props.nodeId,
    wetMix: 0.1,
    active: false,
  };
};

const persistConvolverState = (state: ConvolverState) => {
  nodeStateStore.convolverStates.set(props.nodeId, { ...state });
};

const convolverState = computed({
  get: () => ensureConvolverState(),
  set: (newState: ConvolverState) => {
    persistConvolverState({
      ...newState,
      id: props.nodeId,
    });
  },
});

const updateConvolverState = (patch: Partial<ConvolverState>) => {
  const next = {
    ...ensureConvolverState(),
    ...patch,
    id: props.nodeId,
  };
  persistConvolverState(next);
  syncConvolverToInstrument(next);
};

const syncConvolverToInstrument = (state: ConvolverState) => {
  instrumentStore.currentInstrument?.updateConvolverState(props.nodeId, {
    ...state,
  });
};

const handleEnabledChange = (val: boolean) => {
  updateConvolverState({ active: val });
};

const handleWetMixChange = (val: number) => {
  updateConvolverState({ wetMix: val });
};

onMounted(() => {
  syncConvolverToInstrument(ensureConvolverState());
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
