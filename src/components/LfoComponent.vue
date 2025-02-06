<template>
  <q-card class="lfo-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">LFO {{ nodeId + 1 }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="lfo-container">
      <div class="knob-group">
        <q-toggle
          v-model="lfoState.active"
          label="Active"
          @update:modelValue="handleActiveChange"
        />

        <q-toggle
          v-model="lfoState.useNormalized"
          label="Normalized"
          @update:modelValue="handleNormalizedChange"
        />

        <q-toggle
          v-model="lfoState.useAbsolute"
          label="Absolute"
          @update:modelValue="handleAbsoluteChange"
        />
      </div>

      <div class="knob-group">
        <audio-knob-component
          v-model="lfoState.frequency"
          label="Frequency"
          :min="0.01"
          :max="20"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleFrequencyChange"
        />

        <audio-knob-component
          v-model="waveform"
          label="Waveform"
          :min="0"
          :max="3"
          :step="1"
          :decimals="0"
          @update:modelValue="handleWaveformChange"
        />

        <audio-knob-component
          v-model="triggerMode"
          label="Trigger"
          :min="0"
          :max="1"
          :step="1"
          :decimals="0"
          @update:modelValue="handleTriggerModeChange"
        />

        <audio-knob-component
          v-model="lfoState.gain"
          label="Gain"
          :min="-5"
          :max="5"
          :step="0.001"
          :decimals="2"
          @update:modelValue="handleGainChange"
        />
      </div>
      <routing-component
        :source-id="props.nodeId"
        :source-type="VoiceNodeType.LFO"
        :debug="true"
      />
      <!-- Waveform visualization -->
      <div class="canvas-wrapper">
        <canvas ref="waveformCanvas"></canvas>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { type LfoState } from 'src/audio/types/synth-layout';
import RoutingComponent from './RoutingComponent.vue';
import { VoiceNodeType } from 'src/audio/types/synth-layout';

interface Props {
  node: AudioNode | null;
  nodeId: number;
}

const props = withDefaults(defineProps<Props>(), {
  node: null,
  nodeId: 0,
});

const store = useAudioSystemStore();
const { lfoStates } = storeToRefs(store);
const waveformCanvas = ref<HTMLCanvasElement | null>(null);
const waveform = ref<number>(0);
const triggerMode = ref<number>(0);

// Create a reactive reference to the LFO state
const lfoState = computed({
  get: () => {
    const state = lfoStates.value.get(props.nodeId);
    if (!state) {
      console.warn(`No state found for LFO ${props.nodeId}`);
      return {
        frequency: 1.0,
        waveform: 0,
        useAbsolute: false,
        useNormalized: false,
        triggerMode: 0,
        gain: 1.0,
        active: true,
      };
    }
    return state;
  },
  set: (newState) => {
    store.lfoStates.set(props.nodeId, newState);
  },
});

onMounted(async () => {
  if (!lfoStates.value.has(props.nodeId)) {
    lfoStates.value.set(props.nodeId, lfoState.value);
  }
  await updateWaveformDisplay();
});

const handleFrequencyChange = (newFrequency: number) => {
  const currentState = {
    ...lfoState.value,
    frequency: newFrequency,
  };
  store.lfoStates.set(props.nodeId, currentState);
};

const handleGainChange = (newGain: number) => {
  const currentState = {
    ...lfoState.value,
    gain: newGain,
  };
  store.lfoStates.set(props.nodeId, currentState);
};


const handleWaveformChange = async (newWaveform: number) => {
  const currentState = {
    ...lfoState.value,
    waveform: newWaveform,
  };
  store.lfoStates.set(props.nodeId, currentState);
  await updateWaveformDisplay();
};

const handleTriggerModeChange = (newTriggerMode: number) => {
  const currentState = {
    ...lfoState.value,
    triggerMode: newTriggerMode,
  };
  store.lfoStates.set(props.nodeId, currentState);
};

const handleActiveChange = (newValue: boolean) => {
  const currentState = {
    ...lfoState.value,
    active: newValue,
  };
  store.lfoStates.set(props.nodeId, currentState);
};

const handleAbsoluteChange = (newValue: boolean) => {
  const currentState = {
    ...lfoState.value,
    useAbsolute: newValue,
  };
  store.lfoStates.set(props.nodeId, currentState);
};

const handleNormalizedChange = (newValue: boolean) => {
  const currentState = {
    ...lfoState.value,
    useNormalized: newValue,
  };
  store.lfoStates.set(props.nodeId, currentState);
};

const updateWaveformDisplay = async () => {
  if (!waveformCanvas.value) return;

  const canvas = waveformCanvas.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Get the actual canvas dimensions
  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;

  // Set the canvas resolution to match its display size
  canvas.width = width;
  canvas.height = height;

  // Clear the canvas
  ctx.clearRect(0, 0, width, height);

  try {
    // Check if the store and instrument are ready
    if (!store.currentInstrument?.isReady) {
      // Use the public getter
      // If not ready, retry after a short delay
      setTimeout(updateWaveformDisplay, 100);
      return;
    }

    // Get waveform data from the WASM module
    const waveformData = await store.currentInstrument.getLfoWaveform(
      lfoState.value.waveform,
      width,
    );

    // Draw the waveform
    ctx.beginPath();
    ctx.strokeStyle = '#2196F3'; // Blue color
    ctx.lineWidth = 2;

    for (let i = 0; i < waveformData.length; i++) {
      const x = i;
      // Map the y value from [-1, 1] to [0, height]
      const y = ((1 - waveformData[i]!) * height) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }

    ctx.stroke();
  } catch (err: unknown) {
    // Properly type the error
    console.warn('Could not update waveform display:', err);
    // Properly type check the error
    if (err instanceof Error && err.message === 'Audio system not ready') {
      setTimeout(updateWaveformDisplay, 100);
    }
  }
};

// Watch the LFO state
watch(
  () => ({ ...lfoStates.value.get(props.nodeId) }),
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      // Ensure the newState has all required properties
      const completeState: LfoState = {
        id: props.nodeId,
        frequency: newState?.frequency ?? 1.0,
        waveform: newState?.waveform ?? 0,
        useAbsolute: newState?.useAbsolute ?? false,
        useNormalized: newState?.useNormalized ?? false,
        triggerMode: newState?.triggerMode ?? 0,
        gain: newState?.gain ?? 1,
        active: newState?.active ?? true,
      };

      if (completeState.id === props.nodeId) {
        store.currentInstrument?.updateLfoState(props.nodeId, completeState);
      }
    }
  },
  { deep: true, immediate: true },
);
</script>

<style scoped>
.lfo-card {
  width: 600px;
  margin: 0 auto;
}

.lfo-container {
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
