<template>
  <q-card class="filter-card">
    <q-card-section class="card-header">
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
      <div class="row q-col-gutter-md">
        <div class="col-12">
          <q-select
            v-model="impulseSource"
            :options="impulseSourceOptions"
            label="Impulse Source"
            dense
            outlined
          />
        </div>

        <!-- Upload WAV option -->
        <div v-if="impulseSource === 'upload'" class="col-12">
          <div class="text-subtitle2">Upload Custom Impulse</div>
          <input type="file" accept=".wav" @change="handleWavFileUpload" />
        </div>

        <!-- Hall Reverb Generator -->
        <div v-if="impulseSource === 'hall'" class="col-12">
          <div class="text-subtitle2">Hall Reverb Generator</div>
          <div class="knob-group">
            <audio-knob-component
              v-model="hallParams.decayTime"
              label="Decay Time"
              :min="0.1"
              :max="10"
              :step="0.1"
              :decimals="1"
            />
            <audio-knob-component
              v-model="hallParams.roomSize"
              label="Room Size"
              :min="0"
              :max="1"
              :step="0.01"
              :decimals="2"
            />
          </div>
          <q-btn
            label="Generate Hall Reverb"
            color="primary"
            @click="handleGenerateHall"
            class="q-mt-sm"
          />
        </div>

        <!-- Plate Reverb Generator -->
        <div v-if="impulseSource === 'plate'" class="col-12">
          <div class="text-subtitle2">Plate Reverb Generator</div>
          <div class="knob-group">
            <audio-knob-component
              v-model="plateParams.decayTime"
              label="Decay Time"
              :min="0.1"
              :max="10"
              :step="0.1"
              :decimals="1"
            />
            <audio-knob-component
              v-model="plateParams.diffusion"
              label="Diffusion"
              :min="0"
              :max="1"
              :step="0.01"
              :decimals="2"
            />
          </div>
          <q-btn
            label="Generate Plate Reverb"
            color="primary"
            @click="handleGeneratePlate"
            class="q-mt-sm"
          />
        </div>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, toRaw } from 'vue';
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

const instrumentStore = useInstrumentStore();
const nodeStateStore = useNodeStateStore();
const { convolverStates } = storeToRefs(nodeStateStore);

const displayName = computed(() => props.nodeName || 'Convolver');

// Initialize impulse source from convolver state's generator field
const initializeImpulseSource = (): 'upload' | 'hall' | 'plate' => {
  const state = convolverStates.value.get(props.nodeId);
  if (state?.generator) {
    return state.generator.type;
  }
  return 'upload';
};

// Impulse source selection
const impulseSource = ref<'upload' | 'hall' | 'plate'>(initializeImpulseSource());
const impulseSourceOptions = ['upload', 'hall', 'plate'];

// Initialize parameters from generator state if available
const initializeHallParams = () => {
  const state = convolverStates.value.get(props.nodeId);
  if (state?.generator && state.generator.type === 'hall') {
    return {
      decayTime: state.generator.decayTime,
      roomSize: state.generator.size,
    };
  }
  return { decayTime: 2.0, roomSize: 0.8 };
};

const initializePlateParams = () => {
  const state = convolverStates.value.get(props.nodeId);
  if (state?.generator && state.generator.type === 'plate') {
    return {
      decayTime: state.generator.decayTime,
      diffusion: state.generator.size,
    };
  }
  return { decayTime: 2.0, diffusion: 0.6 };
};

// Hall reverb parameters
const hallParams = ref(initializeHallParams());

// Plate reverb parameters
const plateParams = ref(initializePlateParams());

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

      // Clear generator field since this is a custom upload (save binary data)
      const currentState = ensureConvolverState();
      const cleanState: ConvolverState = {
        id: props.nodeId,
        wetMix: currentState.wetMix,
        active: currentState.active,
        // Explicitly omit generator so binary data is saved
      };
      persistConvolverState(cleanState);
      syncConvolverToInstrument(cleanState);
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
  // Convert reactive state to plain object for postMessage
  // Use JSON parse/stringify to create a deep clone and strip Vue reactivity
  const plainState = JSON.parse(JSON.stringify(toRaw(state))) as ConvolverState;
  instrumentStore.currentInstrument?.updateConvolverState(props.nodeId, plainState);
};

const handleEnabledChange = (val: boolean) => {
  updateConvolverState({ active: val });
};

const handleWetMixChange = (val: number) => {
  updateConvolverState({ wetMix: val });
};

const handleGenerateHall = () => {
  if (!instrumentStore.currentInstrument || !instrumentStore.audioSystem) return;

  // Generate hall reverb
  instrumentStore.currentInstrument.generateHallReverb(
    props.nodeId,
    hallParams.value.decayTime,
    hallParams.value.roomSize,
  );

  // Update convolver state with generator parameters
  const sampleRate = instrumentStore.audioSystem.audioContext.sampleRate;
  updateConvolverState({
    generator: {
      type: 'hall',
      decayTime: hallParams.value.decayTime,
      size: hallParams.value.roomSize,
      sampleRate: sampleRate,
    },
  });
};

const handleGeneratePlate = () => {
  if (!instrumentStore.currentInstrument || !instrumentStore.audioSystem) return;

  // Generate plate reverb
  instrumentStore.currentInstrument.generatePlateReverb(
    props.nodeId,
    plateParams.value.decayTime,
    plateParams.value.diffusion,
  );

  // Update convolver state with generator parameters
  const sampleRate = instrumentStore.audioSystem.audioContext.sampleRate;
  updateConvolverState({
    generator: {
      type: 'plate',
      decayTime: plateParams.value.decayTime,
      size: plateParams.value.diffusion,
      sampleRate: sampleRate,
    },
  });
};

onMounted(() => {
  syncConvolverToInstrument(ensureConvolverState());
});
</script>

<style scoped>
.card-header {
  background: linear-gradient(135deg, var(--panel-background-alt), var(--panel-background));
  color: var(--text-primary);
  border-bottom: 1px solid var(--panel-border);
}

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
