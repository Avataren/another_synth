<template>
  <q-card class="envelope-card">
    <!-- Replaced the old <q-card-section> header with AudioCardHeader -->
    <audio-card-header
      title="Envelope"
      :isMinimized="props.isMinimized"
      @plusClicked="forwardPlus"
      @minimizeClicked="forwardMinimize"
      @closeClicked="forwardClose"
    />

    <q-separator />

    <!-- Main content is shown only when not minimized -->
    <q-card-section class="envelope-container" v-show="!props.isMinimized">
      <div class="knob-group">
        <q-toggle
          v-model="envelopeState.active"
          label="Active"
          @update:modelValue="handleActiveChange"
        />
      </div>

      <div class="canvas-wrapper">
        <canvas ref="waveformCanvas"></canvas>
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
          v-model="envelopeState.attackCurve"
          label="ACoeff"
          scale="half"
          :min="-10"
          :max="10"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleAttackCoeffChange"
        />

        <audio-knob-component
          v-model="envelopeState.decay"
          label="Decay"
          :min="0"
          :max="10"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleDecayChange"
        />

        <audio-knob-component
          v-model="envelopeState.decayCurve"
          label="DCoeff"
          scale="half"
          :min="-10"
          :max="10"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleDecayCoeffChange"
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
          v-model="envelopeState.releaseCurve"
          label="RCoeff"
          scale="half"
          :min="-10"
          :max="10"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleReleaseCoeffChange"
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
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

// New header component for consistent styling and event handling
import AudioCardHeader from './AudioCardHeader.vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import RoutingComponent from './RoutingComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import {
  VoiceNodeType,
  type EnvelopeConfig,
} from 'src/audio/types/synth-layout';
import { throttle } from 'quasar';

interface Props {
  nodeId: number;
  isMinimized?: boolean; // default: false
}

const props = withDefaults(defineProps<Props>(), {
  isMinimized: false,
});

// Forward events to parent, matching the style of your Noise/Oscillator components
const emit = defineEmits(['plusClicked', 'minimizeClicked', 'closeClicked']);

function forwardPlus() {
  emit('plusClicked', VoiceNodeType.Envelope);
}
function forwardMinimize() {
  emit('minimizeClicked');
}
function forwardClose() {
  emit('closeClicked', props.nodeId);
}

// Audio store & references
const store = useAudioSystemStore();
const { envelopeStates } = storeToRefs(store);

// Canvas ref for envelope preview
const waveformCanvas = ref<HTMLCanvasElement | null>(null);

// Envelope state computed
const envelopeState = computed<EnvelopeConfig>({
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

/** Envelope event handlers **/
function handleActiveChange(newValue: boolean) {
  store.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    active: newValue,
  });
}

function handleAttackCoeffChange(envVal: number) {
  store.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    attackCurve: envVal,
  });
}

function handleDecayCoeffChange(envVal: number) {
  store.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    decayCurve: envVal,
  });
}

function handleReleaseCoeffChange(envVal: number) {
  store.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    releaseCurve: envVal,
  });
}

function handleAttackChange(envVal: number) {
  store.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    attack: envVal,
  });
}

function handleDecayChange(envVal: number) {
  store.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    decay: envVal,
  });
}

function handleSustainChange(envVal: number) {
  store.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    sustain: envVal,
  });
}

function handleReleaseChange(envVal: number) {
  store.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    release: envVal,
  });
}

/** Envelope preview drawing logic **/
function updateEnvelopePreview() {
  const config = envelopeState.value;
  const previewDuration = config.attack + config.decay + 1 + config.release;

  store.currentInstrument
    ?.getEnvelopePreview(config, previewDuration)
    .then((previewData) => {
      drawEnvelopePreviewWithData(previewData);
    })
    .catch(() => {
      // Silently fail or handle error
    });
}

const throttledUpdateEnvelopePreview = throttle(
  updateEnvelopePreview,
  1000 / 60,
);

function drawEnvelopePreviewWithData(previewData: Float32Array) {
  const canvas = waveformCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;
  canvas.width = width;
  canvas.height = height;

  // Background
  ctx.fillStyle = 'rgb(32, 45, 66)';
  ctx.fillRect(0, 0, width, height);

  // Downsample to fit canvas width
  const totalSamples = previewData.length;
  const step = totalSamples / width;

  ctx.beginPath();
  ctx.strokeStyle = 'rgb(160, 190, 225)';
  ctx.lineWidth = 2;

  ctx.moveTo(0, height - previewData[0]! * height);
  for (let x = 1; x < width; x++) {
    const sampleIndex = Math.floor(x * step);
    const value = previewData[sampleIndex];
    const y = height - (value ?? 0) * height;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
}

onMounted(() => {
  // Ensure an EnvelopeState entry exists for this node
  if (!envelopeStates.value.has(props.nodeId)) {
    envelopeStates.value.set(props.nodeId, envelopeState.value);
  }

  // Delay the initial draw a bit
  setTimeout(updateEnvelopePreview, 250);

  // Listen for window resize to re-draw
  window.addEventListener('resize', throttledUpdateEnvelopePreview);
});

onUnmounted(() => {
  window.removeEventListener('resize', throttledUpdateEnvelopePreview);
});

/** Watch for changes in the store's envelope state **/
watch(
  () => ({ ...envelopeStates.value.get(props.nodeId) }),
  async (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState && newState.id === props.nodeId) {
        // Cast to EnvelopeConfig if needed for strict type checks
        await store.currentInstrument?.updateEnvelopeState(
          props.nodeId,
          newState as EnvelopeConfig,
        );
        throttledUpdateEnvelopePreview();
      }
    }
  },
  { deep: true, immediate: true },
);
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
  align-items: baseline;
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
  border: none;
  background-color: rgb(200, 200, 200);
}
</style>
