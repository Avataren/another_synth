<template>
  <q-card class="lfo-card">
    <!-- Header: forwards events to parent -->
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

    <!-- Main LFO content, shown only when not minimized -->
    <q-card-section class="lfo-container" v-show="!props.isMinimized">
      <!-- Top row: Toggles and Main Knobs (including Waveform knob) -->
      <div class="top-row">
        <div class="toggle-group">
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
            :model-value="(lfoState.triggerMode ?? 0) !== 0"
            label="Trigger"
            @update:modelValue="handleTriggerModeChange"
          />
        </div>

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
          <!-- Waveform knob on the same row -->
          <audio-knob-component
            v-model="waveform"
            label="Waveform"
            :min="0"
            :max="4"
            :step="1"
            :decimals="0"
            @update:modelValue="handleWaveformChange"
          />
        </div>
      </div>

      <!-- Middle row: Waveform canvas -->
      <div class="waveform-canvas-row">
        <canvas ref="waveformCanvas"></canvas>
      </div>

      <!-- Bottom row: Loop Controls -->
      <div class="loop-controls-row">
        <q-select
          v-model="lfoState.loopMode"
          :options="loopModeOptions"
          label="Loop Mode"
          option-label="label"
          option-value="value"
          emit-value
          map-options
          style="min-width: 120px"
          @update:modelValue="handleLoopModeChange"
        />

        <audio-knob-component
          v-model="lfoState.loopStart"
          label="Loop Start"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleLoopStartChange"
        />
        <audio-knob-component
          v-model="lfoState.loopEnd"
          label="Loop End"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleLoopEndChange"
        />
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
import { computed, onMounted, ref, watch, onBeforeUnmount } from 'vue';
import AudioCardHeader from './AudioCardHeader.vue'; // <-- be sure to import
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useInstrumentStore } from 'src/stores/instrument-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import { useLayoutStore } from 'src/stores/layout-store';
import { storeToRefs } from 'pinia';
import { type LfoState } from 'src/audio/types/synth-layout';
import RoutingComponent from './RoutingComponent.vue';
import { VoiceNodeType } from 'src/audio/types/synth-layout';
import { throttle } from 'src/utils/util';

// Define props
interface Props {
  node: AudioNode | null;
  nodeId: string;
  isMinimized?: boolean;
  nodeName?: string;
}
const props = withDefaults(defineProps<Props>(), {
  node: null,
  nodeId: '',
  isMinimized: false,
});

// Define emits for forwarding events
const emit = defineEmits(['plusClicked', 'minimizeClicked', 'closeClicked']);

// Forwarding methods: simply log and emit
function forwardPlus() {
  emit('plusClicked', VoiceNodeType.LFO);
}
function forwardMinimize() {
  emit('minimizeClicked');
}
function forwardClose() {
  emit('closeClicked', props.nodeId);
}

// Store references and local refs
const instrumentStore = useInstrumentStore();
const nodeStateStore = useNodeStateStore();
const layoutStore = useLayoutStore();
const { lfoStates } = storeToRefs(nodeStateStore);
const waveformCanvas = ref<HTMLCanvasElement | null>(null);
const waveform = ref<number>(0);

const displayName = computed(
  () =>
    props.nodeName ||
    layoutStore.getNodeName(props.nodeId) ||
    `LFO ${props.nodeId}`,
);

function handleNameChange(name: string) {
  layoutStore.renameNode(props.nodeId, name);
}

// We'll cache the drawn waveform as an offscreen canvas.
let cachedWaveformCanvas: HTMLCanvasElement | null = null;
const throttledUpdateWaveformDisplay = throttle(async () => {
  await updateCachedWaveform();
  updateWaveformDisplay();
}, 1000 / 60);

// Create a reactive reference to the LFO state
const lfoState = computed<LfoState>({
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
        loopMode: 0,
        loopStart: 0.0,
        loopEnd: 1.0,
      };
    }
    return state;
  },
  set: (newState) => {
    nodeStateStore.lfoStates.set(props.nodeId, newState);
  },
});

const loopModeOptions = [
  { label: 'Off', value: 0 },
  { label: 'Loop', value: 1 },
  { label: 'PingPong', value: 2 },
];

onMounted(async () => {
  if (!lfoStates.value.has(props.nodeId)) {
    lfoStates.value.set(props.nodeId, lfoState.value);
  }

  if (waveformCanvas.value) {
    const canvas = waveformCanvas.value;
    // Set canvas resolution based on displayed size
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    canvas.width = width;
    canvas.height = height;

    // Delay a bit to ensure instrument is ready
    setTimeout(async () => {
      await updateCachedWaveform();
      updateWaveformDisplay();
    }, 25);

    // Add mouse listeners for draggable loop markers
    canvas.addEventListener('mousedown', onCanvasMouseDown);
    canvas.addEventListener('mousemove', onCanvasMouseMove);
  }
});

onBeforeUnmount(() => {
  if (waveformCanvas.value) {
    waveformCanvas.value.removeEventListener('mousedown', onCanvasMouseDown);
    waveformCanvas.value.removeEventListener('mousemove', onCanvasMouseMove);
  }
  window.removeEventListener('mouseup', onCanvasMouseUp);
});

// Handler methods
async function handleFrequencyChange(newFrequency: number) {
  nodeStateStore.lfoStates.set(props.nodeId, {
    ...lfoState.value,
    frequency: newFrequency,
  });
  await throttledUpdateWaveformDisplay();
}
async function handlePhaseChange(newPhase: number) {
  nodeStateStore.lfoStates.set(props.nodeId, {
    ...lfoState.value,
    phaseOffset: newPhase,
  });
  await throttledUpdateWaveformDisplay();
}
function handleGainChange(newGain: number) {
  nodeStateStore.lfoStates.set(props.nodeId, { ...lfoState.value, gain: newGain });
}
async function handleWaveformChange(newWaveform: number) {
  nodeStateStore.lfoStates.set(props.nodeId, {
    ...lfoState.value,
    waveform: newWaveform,
  });
  await updateCachedWaveform();
  updateWaveformDisplay();
}
function handleTriggerModeChange(newTriggerMode: boolean) {
  nodeStateStore.lfoStates.set(props.nodeId, {
    ...lfoState.value,
    triggerMode: newTriggerMode ? 1 : 0,
  });
}
function handleActiveChange(newValue: boolean) {
  nodeStateStore.lfoStates.set(props.nodeId, { ...lfoState.value, active: newValue });
}
async function handleAbsoluteChange(newValue: boolean) {
  nodeStateStore.lfoStates.set(props.nodeId, {
    ...lfoState.value,
    useAbsolute: newValue,
  });
  await updateCachedWaveform();
  updateWaveformDisplay();
}
async function handleNormalizedChange(newValue: boolean) {
  nodeStateStore.lfoStates.set(props.nodeId, {
    ...lfoState.value,
    useNormalized: newValue,
  });
  await updateCachedWaveform();
  updateWaveformDisplay();
}
function handleLoopModeChange(newValue: number) {
  nodeStateStore.lfoStates.set(props.nodeId, { ...lfoState.value, loopMode: newValue });
  updateWaveformDisplay();
}
function handleLoopStartChange(newLoopStart: number) {
  const loopEnd = Math.max(newLoopStart, lfoState.value.loopEnd);
  nodeStateStore.lfoStates.set(props.nodeId, {
    ...lfoState.value,
    loopStart: newLoopStart,
    loopEnd,
  });
  updateWaveformDisplay();
}
function handleLoopEndChange(newLoopEnd: number) {
  const loopStart = Math.min(newLoopEnd, lfoState.value.loopStart);
  nodeStateStore.lfoStates.set(props.nodeId, {
    ...lfoState.value,
    loopEnd: newLoopEnd,
    loopStart,
  });
  updateWaveformDisplay();
}

/**
 * Creates an offscreen canvas with the waveform, grids, etc.
 */
async function updateCachedWaveform() {
  if (!waveformCanvas.value) return;
  const width = waveformCanvas.value.width;
  const height = waveformCanvas.value.height;

  // Acquire waveform data from the instrument
  const waveformData = await instrumentStore.currentInstrument?.getLfoWaveform(
    lfoState.value.waveform,
    lfoState.value.phaseOffset,
    lfoState.value.frequency,
    width,
    lfoState.value.useAbsolute,
    lfoState.value.useNormalized,
  );
  if (!waveformData) return;

  // Create an offscreen canvas
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) return;

  // Background fill
  offCtx.fillStyle = '#1e2a3a';
  offCtx.fillRect(0, 0, width, height);

  // Grid lines
  offCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  offCtx.lineWidth = 1;
  for (let x = 0; x < width; x += width / 8) {
    offCtx.beginPath();
    offCtx.moveTo(x, 0);
    offCtx.lineTo(x, height);
    offCtx.stroke();
  }
  for (let y = 0; y < height; y += height / 4) {
    offCtx.beginPath();
    offCtx.moveTo(0, y);
    offCtx.lineTo(width, y);
    offCtx.stroke();
  }

  // Center line
  offCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  offCtx.beginPath();
  offCtx.moveTo(0, height / 2);
  offCtx.lineTo(width, height / 2);
  offCtx.stroke();

  // Bars
  const barWidth = Math.max(1, Math.ceil(width / waveformData.length / 2));
  const gap = Math.max(0, Math.floor(barWidth / 3));

  const barGradient = offCtx.createLinearGradient(0, 0, 0, height);
  barGradient.addColorStop(0, '#4fc3f7');
  barGradient.addColorStop(1, '#0277bd');
  offCtx.fillStyle = barGradient;

  for (let i = 0; i < waveformData.length; i++) {
    const x = i * (barWidth + gap);
    const normalizedValue = waveformData[i]!;
    const barHeight = Math.abs(normalizedValue) * (height / 2);

    if (normalizedValue >= 0) {
      offCtx.fillRect(x, height / 2 - barHeight, barWidth, barHeight);
    } else {
      offCtx.fillRect(x, height / 2, barWidth, barHeight);
    }
  }

  // Store offscreen canvas for blitting
  cachedWaveformCanvas = offscreen;
}

/**
 * Blits cached waveform, draws loop markers if active
 */
function updateWaveformDisplay() {
  if (!waveformCanvas.value) return;
  const canvas = waveformCanvas.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;

  // Clear visible canvas
  ctx.clearRect(0, 0, width, height);

  // Draw cached waveform
  if (cachedWaveformCanvas) {
    ctx.drawImage(cachedWaveformCanvas, 0, 0);
  }

  // Loop overlay
  if (lfoState.value.loopMode !== 0) {
    const loopStartX = lfoState.value.loopStart * width;
    const loopEndX = lfoState.value.loopEnd * width;

    // Translucent overlay
    ctx.fillStyle = 'rgba(255, 193, 7, 0.2)';
    ctx.fillRect(loopStartX, 0, loopEndX - loopStartX, height);

    // Markers
    const handleRadius = 6;
    ctx.strokeStyle = '#ffc107';
    ctx.lineWidth = 2;

    // Loop start line
    ctx.beginPath();
    ctx.moveTo(loopStartX, 0);
    ctx.lineTo(loopStartX, height);
    ctx.stroke();

    // Loop start handle
    const handleGradient = ctx.createRadialGradient(
      loopStartX,
      height - handleRadius * 2,
      0,
      loopStartX,
      height - handleRadius * 2,
      handleRadius,
    );
    handleGradient.addColorStop(0, '#ffecb3');
    handleGradient.addColorStop(1, '#ff8f00');
    ctx.fillStyle = handleGradient;
    ctx.beginPath();
    ctx.arc(
      loopStartX,
      height - handleRadius * 2,
      handleRadius,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.strokeStyle = '#ffa000';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Loop end line
    ctx.strokeStyle = '#ffc107';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(loopEndX, 0);
    ctx.lineTo(loopEndX, height);
    ctx.stroke();

    // Loop end handle
    const handleGradient2 = ctx.createRadialGradient(
      loopEndX,
      height - handleRadius * 2,
      0,
      loopEndX,
      height - handleRadius * 2,
      handleRadius,
    );
    handleGradient2.addColorStop(0, '#ffecb3');
    handleGradient2.addColorStop(1, '#ff8f00');
    ctx.fillStyle = handleGradient2;
    ctx.beginPath();
    ctx.arc(loopEndX, height - handleRadius * 2, handleRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffa000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// Mouse dragging logic for loop markers
let draggingHandle: 'start' | 'end' | null = null;
function onCanvasMouseDown(e: MouseEvent) {
  if (!waveformCanvas.value) return;
  const rect = waveformCanvas.value.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const threshold = 5;
  const loopStartX = lfoState.value.loopStart * waveformCanvas.value.width;
  const loopEndX = lfoState.value.loopEnd * waveformCanvas.value.width;

  if (Math.abs(x - loopStartX) < threshold) {
    draggingHandle = 'start';
  } else if (Math.abs(x - loopEndX) < threshold) {
    draggingHandle = 'end';
  }
}

function onCanvasMouseMove(e: MouseEvent) {
  if (!waveformCanvas.value) return;
  if (draggingHandle) {
    const rect = waveformCanvas.value.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const newVal = Math.max(0, Math.min(1, x / waveformCanvas.value.width));
    if (draggingHandle === 'start') {
      handleLoopStartChange(newVal);
    } else if (draggingHandle === 'end') {
      handleLoopEndChange(newVal);
    }
    updateWaveformDisplay();
    return;
  }

  // Check hover cursor
  const rect = waveformCanvas.value.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const threshold = 10;
  const loopStartX = lfoState.value.loopStart * waveformCanvas.value.width;
  const loopEndX = lfoState.value.loopEnd * waveformCanvas.value.width;

  if (
    Math.abs(x - loopStartX) < threshold ||
    Math.abs(x - loopEndX) < threshold
  ) {
    waveformCanvas.value.style.cursor = 'ew-resize';
  } else {
    waveformCanvas.value.style.cursor = 'default';
  }
}

function onCanvasMouseUp() {
  draggingHandle = null;
}
window.addEventListener('mouseup', onCanvasMouseUp);

// Watch store changes -> notify instrument
watch(
  () => ({ ...lfoStates.value.get(props.nodeId) }),
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
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
        loopMode: newState?.loopMode ?? 0,
        loopStart: newState?.loopStart ?? 0.0,
        loopEnd: newState?.loopEnd ?? 1.0,
      };
      if (completeState.id === props.nodeId) {
        instrumentStore.currentInstrument?.updateLfoState(props.nodeId, completeState);
      }
    }
  },
  { deep: true, immediate: true },
);
</script>

<style scoped>
.lfo-card {
  width: 600px;
  margin: 0rem auto;
  border-radius: 8px;
  overflow: hidden;
}

.lfo-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
}

.top-row {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.toggle-group {
  display: flex;
  gap: 1rem;
  justify-content: space-around;
  align-items: center;
  padding: 0.5rem;
  background-color: rgba(0, 0, 0, 0.03);
  border-radius: 6px;
}

.knob-group {
  display: flex;
  gap: 1rem;
  justify-content: space-around;
  align-items: center;
}

.waveform-canvas-row {
  display: flex;
  justify-content: center;
  align-items: center;
}

.waveform-canvas-row canvas {
  width: 100%;
  height: 160px;
  border: 1px solid rgba(0, 0, 0, 0.2);
  background-color: #1e2a3a;
  border-radius: 4px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15);
  transition: box-shadow 0.2s ease;
}

.waveform-canvas-row canvas:hover {
  box-shadow: 0 3px 6px rgba(0, 0, 0, 0.2);
}

.loop-controls-row {
  display: flex;
  gap: 1rem;
  justify-content: center;
  align-items: center;
  padding: 0.5rem;
  background-color: rgba(0, 0, 0, 0.03);
  border-radius: 6px;
}

.handle-tooltip {
  position: absolute;
  background-color: rgba(0, 0, 0, 0.8);
  color: white;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  pointer-events: none;
  transform: translateY(-100%);
  white-space: nowrap;
}
</style>
