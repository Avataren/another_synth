<template>
  <q-card class="lfo-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">LFO {{ nodeId }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="lfo-container">
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
            v-model="triggerMode"
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

// We'll cache the drawn waveform as an offscreen canvas.
let cachedWaveformCanvas: HTMLCanvasElement | null = null;

// Create a reactive reference to the LFO state.
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
        loopMode: 0,
        loopStart: 0.0,
        loopEnd: 1.0,
      };
    }
    return state;
  },
  set: (newState) => {
    store.lfoStates.set(props.nodeId, newState);
  },
});

// Loop mode options: Off = 0, Loop = 1, PingPong = 2.
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
    // Set canvas resolution based on its displayed size.
    const width = canvas.offsetWidth;
    const height = canvas.offsetHeight;
    canvas.width = width;
    canvas.height = height;

    // Make sure the instrument is ready before drawing:
    setTimeout(async () => {
      await updateCachedWaveform();
      updateWaveformDisplay();
    }, 25);

    // Add mouse listeners for draggable loop markers.
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
  await updateCachedWaveform();
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
  await updateCachedWaveform();
  updateWaveformDisplay();
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

const handleLoopModeChange = (newValue: number) => {
  const currentState = {
    ...lfoState.value,
    loopMode: newValue,
  };
  store.lfoStates.set(props.nodeId, currentState);
  updateWaveformDisplay();
};

const handleLoopStartChange = (newLoopStart: number) => {
  const loopEnd = Math.max(newLoopStart, lfoState.value.loopEnd);
  const currentState = {
    ...lfoState.value,
    loopStart: newLoopStart,
    loopEnd,
  };
  store.lfoStates.set(props.nodeId, currentState);
  updateWaveformDisplay();
};

const handleLoopEndChange = (newLoopEnd: number) => {
  const loopStart = Math.min(newLoopEnd, lfoState.value.loopStart);
  const currentState = {
    ...lfoState.value,
    loopEnd: newLoopEnd,
    loopStart,
  };
  store.lfoStates.set(props.nodeId, currentState);
  updateWaveformDisplay();
};

/**
 * Creates an offscreen canvas of the same size as the visible canvas,
 * draws the background grids, waveform fill and outline, and caches it.
 */
const updateCachedWaveform = async () => {
  if (!waveformCanvas.value) return;
  const width = waveformCanvas.value.width;
  const height = waveformCanvas.value.height;

  // Get the waveform data from the Rust (or wherever) side.
  // Ensure your store.currentInstrument is ready before calling this.
  const waveformData = await store.currentInstrument?.getLfoWaveform(
    lfoState.value.waveform,
    lfoState.value.phaseOffset,
    width,
  );

  if (!waveformData) return;

  // Create an offscreen canvas.
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const offCtx = offscreen.getContext('2d');
  if (!offCtx) return;

  // Draw background.
  offCtx.fillStyle = '#f8f9fa';
  offCtx.fillRect(0, 0, width, height);

  // Draw grid lines.
  offCtx.strokeStyle = 'rgba(33, 150, 243, 0.1)';
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

  // Draw waveform filled area.
  offCtx.beginPath();
  for (let i = 0; i < waveformData.length; i++) {
    const x = i;
    const y = ((1 - waveformData[i]!) * height) / 2;
    if (i === 0) {
      offCtx.moveTo(x, y);
    } else {
      offCtx.lineTo(x, y);
    }
  }
  offCtx.lineTo(width, height);
  offCtx.lineTo(0, height);
  offCtx.closePath();
  const gradient = offCtx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(33, 150, 243, 0.1)');
  gradient.addColorStop(1, 'rgba(33, 150, 243, 0.3)');
  offCtx.fillStyle = gradient;
  offCtx.fill();

  // Draw waveform outline.
  offCtx.beginPath();
  for (let i = 0; i < waveformData.length; i++) {
    const x = i;
    const y = ((1 - waveformData[i]!) * height) / 2;
    if (i === 0) {
      offCtx.moveTo(x, y);
    } else {
      offCtx.lineTo(x, y);
    }
  }
  offCtx.strokeStyle = '#1976D2';
  offCtx.lineWidth = 2;
  offCtx.stroke();

  // Cache the offscreen canvas.
  cachedWaveformCanvas = offscreen;
};

/**
 * Redraws the visible canvas by blitting the cached waveform image
 * and then drawing loop markers on top.
 */
const updateWaveformDisplay = () => {
  if (!waveformCanvas.value) return;
  const canvas = waveformCanvas.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;

  // Clear the canvas.
  ctx.clearRect(0, 0, width, height);

  // Draw the cached waveform image if available.
  if (cachedWaveformCanvas) {
    ctx.drawImage(cachedWaveformCanvas, 0, 0);
  }

  // Overlay loop markers if looping is active.
  if (lfoState.value.loopMode !== 0) {
    const loopStartX = lfoState.value.loopStart * width;
    const loopEndX = lfoState.value.loopEnd * width;
    ctx.strokeStyle = 'red';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(loopStartX, 0);
    ctx.lineTo(loopStartX, height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(loopEndX, 0);
    ctx.lineTo(loopEndX, height);
    ctx.stroke();
  }
};

let draggingHandle: 'start' | 'end' | null = null;

const onCanvasMouseDown = (e: MouseEvent) => {
  if (!waveformCanvas.value) return;
  const rect = waveformCanvas.value.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const threshold = 5; // pixels
  const loopStartX = lfoState.value.loopStart * waveformCanvas.value.width;
  const loopEndX = lfoState.value.loopEnd * waveformCanvas.value.width;
  if (Math.abs(x - loopStartX) < threshold) {
    draggingHandle = 'start';
  } else if (Math.abs(x - loopEndX) < threshold) {
    draggingHandle = 'end';
  }
};

const onCanvasMouseMove = (e: MouseEvent) => {
  if (!draggingHandle || !waveformCanvas.value) return;
  const rect = waveformCanvas.value.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const newVal = Math.max(0, Math.min(1, x / waveformCanvas.value.width));
  if (draggingHandle === 'start') {
    handleLoopStartChange(newVal);
  } else if (draggingHandle === 'end') {
    handleLoopEndChange(newVal);
  }
  updateWaveformDisplay();
};

const onCanvasMouseUp = () => {
  draggingHandle = null;
};

window.addEventListener('mouseup', onCanvasMouseUp);

// Watch for changes in LFO state and update the instrument.
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
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* Top row: toggles + main knobs (including waveform knob) */
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
}

.knob-group {
  display: flex;
  gap: 1rem;
  justify-content: space-around;
  align-items: center;
}

/* Middle row: waveform canvas */
.waveform-canvas-row {
  display: flex;
  justify-content: center;
  align-items: center;
}

.waveform-canvas-row canvas {
  width: 100%;
  height: 160px;
  border: 1px solid #e0e0e0;
  background-color: #f8f9fa;
  border-radius: 4px;
  box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
}

/* Bottom row: loop controls */
.loop-controls-row {
  display: flex;
  gap: 1rem;
  justify-content: center;
  align-items: center;
}
</style>
