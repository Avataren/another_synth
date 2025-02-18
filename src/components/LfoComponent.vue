<template>
  <q-card class="lfo-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">LFO {{ nodeId }}</div>
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

        <q-toggle
          v-model="triggerMode"
          label="Trigger"
          @update:modelValue="handleTriggerModeChange"
        />
      </div>

      <div class="controls-and-waveform">
        <div class="knob-group">
          <audio-knob-component
            v-model="lfoState.gain"
            label="Gain"
            :min="-5"
            :max="5"
            :step="0.001"
            :decimals="2"
            @update:modelValue="handleGainChange"
          />

          <audio-knob-component
            v-model="lfoState.phaseOffset"
            label="Phase"
            :min="0"
            :max="1"
            :step="0.001"
            :decimals="3"
            @update:modelValue="handlePhaseChange"
          />

          <audio-knob-component
            v-model="lfoState.frequency"
            label="Frequency"
            :min="0.01"
            :max="20"
            :step="0.01"
            :decimals="2"
            @update:modelValue="handleFrequencyChange"
          />

          <div class="waveform-container">
            <div class="waveform-control">
              <audio-knob-component
                v-model="waveform"
                label="Waveform"
                :min="0"
                :max="3"
                :step="1"
                :decimals="0"
                @update:modelValue="handleWaveformChange"
              />
              <div class="canvas-wrapper">
                <canvas ref="waveformCanvas"></canvas>
              </div>
            </div>
          </div>
        </div>
      </div>
      <routing-component
        :source-id="props.nodeId"
        :source-type="VoiceNodeType.LFO"
        :debug="true"
      />
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
const triggerMode = ref<boolean>(false);

// Create a reactive reference to the LFO state
const lfoState = computed({
  get: () => {
    const state = lfoStates.value.get(props.nodeId);
    if (!state) {
      console.warn(`No state found for LFO ${props.nodeId}`);
      return {
        frequency: 1.0,
        waveform: 0,
        phaseOffset: 0,
        useAbsolute: false,
        useNormalized: false,
        triggerMode: 0,
        gain: 1.0,
        active: false,
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

  if (waveformCanvas.value) {
    const canvas = waveformCanvas.value;
    // Set canvas resolution once on mount
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    canvas.width = width;
    canvas.height = height;
    await updateWaveformDisplay();
  }
});

const handleFrequencyChange = (newFrequency: number) => {
  const currentState = {
    ...lfoState.value,
    frequency: newFrequency,
  };
  store.lfoStates.set(props.nodeId, currentState);
};

const handlePhaseChange = async (newPhase: number) => {
  const currentState = {
    ...lfoState.value,
    phaseOffset: newPhase,
  };
  store.lfoStates.set(props.nodeId, currentState);
  updateWaveformDisplay();
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

const handleTriggerModeChange = (newTriggerMode: boolean) => {
  const currentState = {
    ...lfoState.value,
    triggerMode: newTriggerMode ? 1 : 0,
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

  // Use the preset canvas resolution
  const width = canvas.width;
  const height = canvas.height;

  // Clear the canvas without resetting its size
  //ctx.clearRect(0, 0, width, height);

  try {
    if (!store.currentInstrument?.isReady) {
      setTimeout(updateWaveformDisplay, 100);
      return;
    }

    const waveformData = await store.currentInstrument.getLfoWaveform(
      lfoState.value.waveform,
      lfoState.value.phaseOffset,
      width,
    );

    // Draw background
    ctx.fillStyle = '#f8f9fa'; // Light gray background
    ctx.fillRect(0, 0, width, height);

    // Draw grid lines
    ctx.strokeStyle = 'rgba(33, 150, 243, 0.1)';
    ctx.lineWidth = 1;

    // Vertical grid lines
    for (let x = 0; x < width; x += width / 8) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    // Horizontal grid lines
    for (let y = 0; y < height; y += height / 4) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }

    // Draw the waveform (filled area)
    ctx.beginPath();
    for (let i = 0; i < waveformData.length; i++) {
      const x = i;
      const y = ((1 - waveformData[i]!) * height) / 2;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();

    // Create a gradient for the fill
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(33, 150, 243, 0.1)');
    gradient.addColorStop(1, 'rgba(33, 150, 243, 0.3)');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Draw the waveform line on top
    ctx.beginPath();
    for (let i = 0; i < waveformData.length; i++) {
      const x = i;
      const y = ((1 - waveformData[i]!) * height) / 2;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.strokeStyle = '#1976D2';
    ctx.lineWidth = 2;
    ctx.stroke();
  } catch (err: unknown) {
    console.warn('Could not update waveform display:', err);
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
        phaseOffset: newState?.phaseOffset ?? 0.0,
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
  margin: 0.5rem auto;
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

.controls-and-waveform {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.waveform-container {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.waveform-control {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.canvas-wrapper {
  width: 160px;
  height: 80px;
}

canvas {
  width: 100% !important;
  height: 100% !important;
  border: 1px solid #e0e0e0;
  background-color: #f8f9fa;
  border-radius: 4px;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
}
</style>
