<template>
  <q-card class="envelope-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Envelope {{ nodeId + 1 }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="envelope-container">
      <div class="knob-group">
        <q-toggle
          v-model="envelopeState.active"
          label="Active"
          @update:modelValue="handleActiveChange"
        />
      </div>

      <div class="knob-group">
        <audio-knob-component
          v-model="envelopeState.attack"
          label="Attack"
          :min="0"
          :max="3"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleAttackChange"
        />

        <audio-knob-component
          v-model="envelopeState.decay"
          label="Decay"
          :min="0"
          :max="3"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleDecayChange"
        />

        <audio-knob-component
          v-model="envelopeState.sustain"
          label="Sustain"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleSustainChange"
        />

        <audio-knob-component
          v-model="envelopeState.release"
          label="Release"
          :min="0"
          :max="3"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleReleaseChange"
        />
      </div>

      <routing-component
        :source-id="props.nodeId"
        :source-type="VoiceNodeType.Envelope"
        :debug="true"
      />

      <div class="canvas-wrapper">
        <canvas ref="waveformCanvas"></canvas>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { type EnvelopeConfig } from 'src/audio/dsp/envelope';
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
const { envelopeStates } = storeToRefs(store);
const waveformCanvas = ref<HTMLCanvasElement | null>(null);

// Function to draw the envelope shape on the canvas - defined first!
const drawEnvelopeShape = () => {
  const canvas = waveformCanvas.value;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Set canvas resolution
  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;
  canvas.width = width;
  canvas.height = height;

  // Clear canvas
  ctx.clearRect(0, 0, width, height);

  // Draw envelope shape
  ctx.beginPath();
  ctx.strokeStyle = '#2196F3';
  ctx.lineWidth = 2;

  const state = envelopeState.value;

  // Calculate time segments
  const totalTime = state.attack + state.decay + 1 + state.release; // 1 second for sustain
  const pixelsPerSecond = width / totalTime;

  // Starting point
  ctx.moveTo(0, height);

  // Attack
  const attackX = state.attack * pixelsPerSecond;
  ctx.lineTo(attackX, 0);

  // Decay
  const decayX = attackX + state.decay * pixelsPerSecond;
  const sustainY = height * (1 - state.sustain);
  ctx.lineTo(decayX, sustainY);

  // Sustain
  const sustainX = decayX + pixelsPerSecond; // 1 second sustain
  ctx.lineTo(sustainX, sustainY);

  // Release
  const releaseX = sustainX + state.release * pixelsPerSecond;
  ctx.lineTo(releaseX, height);

  ctx.stroke();
};

// Create a reactive reference to the envelope state
const envelopeState = computed({
  get: () => {
    const state = envelopeStates.value.get(props.nodeId);
    if (!state) {
      console.warn(`No state found for envelope ${props.nodeId}`);
      return {
        id: props.nodeId,
        attack: 0.0,
        decay: 0.1,
        sustain: 0.5,
        release: 0.1,
        attackCurve: 0.0,
        decayCurve: 0.0,
        releaseCurve: 0.0,
        active: true,
      } as EnvelopeConfig;
    }
    return state;
  },
  set: (newState: EnvelopeConfig) => {
    store.envelopeStates.set(props.nodeId, { ...newState });
  },
});

const handleActiveChange = (newValue: boolean) => {
  const currentState = {
    ...envelopeState.value,
    active: newValue,
  };
  store.envelopeStates.set(props.nodeId, currentState);
};

const handleAttackChange = (envVal: number) => {
  const currentState = {
    ...envelopeState.value,
    attack: envVal,
  };
  store.envelopeStates.set(props.nodeId, currentState);
};

const handleDecayChange = (envVal: number) => {
  const currentState = {
    ...envelopeState.value,
    decay: envVal,
  };
  store.envelopeStates.set(props.nodeId, currentState);
};

const handleSustainChange = (envVal: number) => {
  const currentState = {
    ...envelopeState.value,
    sustain: envVal,
  };
  store.envelopeStates.set(props.nodeId, currentState);
};

const handleReleaseChange = (envVal: number) => {
  const currentState = {
    ...envelopeState.value,
    release: envVal,
  };
  store.envelopeStates.set(props.nodeId, currentState);
};

// Watch for changes in the envelope state - after drawEnvelopeShape is defined
watch(
  () => ({ ...envelopeStates.value.get(props.nodeId) }), // Create new reference
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState.id === props.nodeId) {
        store.currentInstrument?.updateEnvelopeState(
          props.nodeId,
          newState as EnvelopeConfig,
        );
        drawEnvelopeShape(); // Now this reference is valid
      }
    }
  },
  { deep: true, immediate: true },
);

onMounted(() => {
  if (!envelopeStates.value.has(props.nodeId)) {
    envelopeStates.value.set(props.nodeId, envelopeState.value);
  }
  drawEnvelopeShape();

  // Add resize listener
  window.addEventListener('resize', drawEnvelopeShape);
});

onUnmounted(() => {
  window.removeEventListener('resize', drawEnvelopeShape);
});
</script>

<style scoped>
.envelope-card {
  width: 600px;
  margin: 0.5rem auto;
}

.envelope-container {
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
