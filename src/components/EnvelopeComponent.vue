<template>
  <q-card class="envelope-card">
    <!-- Replaced the old <q-card-section> header with AudioCardHeader -->
    <audio-card-header
      :title="displayName"
      :editable="true"
      :isMinimized="props.isMinimized"
      @plusClicked="forwardPlus"
      @minimizeClicked="forwardMinimize"
      @closeClicked="forwardClose"
      @update:title="handleNameChange"
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
import { useInstrumentStore } from 'src/stores/instrument-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import { useLayoutStore } from 'src/stores/layout-store';
import { storeToRefs } from 'pinia';
import {
  VoiceNodeType,
  type EnvelopeConfig,
} from 'src/audio/types/synth-layout';
import { throttle } from 'quasar';

interface Props {
  nodeId: string;
  isMinimized?: boolean; // default: false
  nodeName?: string;
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
const instrumentStore = useInstrumentStore();
const nodeStateStore = useNodeStateStore();
const layoutStore = useLayoutStore();
const { envelopeStates } = storeToRefs(nodeStateStore);

const displayName = computed(
  () =>
    props.nodeName ||
    layoutStore.getNodeName(props.nodeId) ||
    `Envelope ${props.nodeId}`,
);

function handleNameChange(name: string) {
  layoutStore.renameNode(props.nodeId, name);
}

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
    nodeStateStore.envelopeStates.set(props.nodeId, { ...newState });
  },
});

/** Envelope event handlers **/
function handleActiveChange(newValue: boolean) {
  nodeStateStore.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    active: newValue,
  });
}

function handleAttackCoeffChange(envVal: number) {
  nodeStateStore.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    attackCurve: envVal,
  });
}

function handleDecayCoeffChange(envVal: number) {
  nodeStateStore.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    decayCurve: envVal,
  });
}

function handleReleaseCoeffChange(envVal: number) {
  nodeStateStore.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    releaseCurve: envVal,
  });
}

function handleAttackChange(envVal: number) {
  nodeStateStore.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    attack: envVal,
  });
}

function handleDecayChange(envVal: number) {
  nodeStateStore.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    decay: envVal,
  });
}

function handleSustainChange(envVal: number) {
  nodeStateStore.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    sustain: envVal,
  });
}

function handleReleaseChange(envVal: number) {
  nodeStateStore.envelopeStates.set(props.nodeId, {
    ...envelopeState.value,
    release: envVal,
  });
}

// -----------------------------------------------------
// Theme color caching for canvas drawing
// -----------------------------------------------------
let cachedBgColor = '#0b111a';
let cachedAccentColor = 'rgb(77, 242, 197)';
let envThemeObserver: MutationObserver | null = null;

function updateEnvThemeColors() {
  const style = getComputedStyle(document.documentElement);
  cachedBgColor = style.getPropertyValue('--app-background').trim() || '#0b111a';
  cachedAccentColor = style.getPropertyValue('--tracker-accent-primary').trim() || 'rgb(77, 242, 197)';
}

/** Envelope preview drawing logic **/
function updateEnvelopePreview() {
  const config = envelopeState.value;
  const previewDuration = config.attack + config.decay + 1 + config.release;

  instrumentStore.currentInstrument
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
  ctx.fillStyle = cachedBgColor;
  ctx.fillRect(0, 0, width, height);

  // Draw grid lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += width / 8) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += height / 4) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Downsample to fit canvas width
  const totalSamples = previewData.length;
  const step = totalSamples / width;

  ctx.beginPath();
  ctx.strokeStyle = cachedAccentColor;
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

  // Initialize theme colors
  updateEnvThemeColors();

  // Watch for theme changes
  envThemeObserver = new MutationObserver(() => {
    updateEnvThemeColors();
    throttledUpdateEnvelopePreview();
  });
  envThemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // Delay the initial draw a bit
  setTimeout(updateEnvelopePreview, 250);

  // Listen for window resize to re-draw
  window.addEventListener('resize', throttledUpdateEnvelopePreview);
});

onUnmounted(() => {
  window.removeEventListener('resize', throttledUpdateEnvelopePreview);
  envThemeObserver?.disconnect();
});

/** Watch for changes in the store's envelope state **/
watch(
  () => ({ ...envelopeStates.value.get(props.nodeId) }),
  async (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState && newState.id === props.nodeId) {
        // Cast to EnvelopeConfig if needed for strict type checks
        await instrumentStore.currentInstrument?.updateEnvelopeState(
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
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  background-color: var(--app-background, #0b111a);
  border-radius: 6px;
}
</style>
