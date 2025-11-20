<template>
  <q-card class="sampler-card">
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

    <q-card-section v-show="!props.isMinimized" class="sampler-body">
      <div class="knob-row">
        <audio-knob-component
          v-model="localGain"
          label="Gain"
          :min="0"
          :max="1.5"
          :step="0.001"
          :decimals="3"
        />
      </div>

      <div class="note-row">
        <q-select
          v-model="rootNoteValue"
          :options="noteOptions"
          label="Sample Root Note / Pitch"
          dense
          dark
          filled
          emit-value
          map-options
        />
      </div>

      <div class="detune-row">
        <audio-knob-component
          :model-value="samplerState.detune_oct ?? 0"
          label="Octave"
          :min="-5"
          :max="5"
          :step="1"
          :decimals="0"
          scale="half"
          @update:model-value="handleDetuneOctChange"
        />
        <audio-knob-component
          :model-value="samplerState.detune_semi ?? 0"
          label="Semitones"
          :min="-12"
          :max="12"
          :step="1"
          :decimals="0"
          scale="half"
          @update:model-value="handleDetuneSemiChange"
        />
        <audio-knob-component
          :model-value="samplerState.detune_cents ?? 0"
          label="Cents"
          :min="-100"
          :max="100"
          :step="1"
          :decimals="0"
          scale="half"
          @update:model-value="handleDetuneCentsChange"
        />
      </div>

      <div class="mode-row">
        <q-select
          :model-value="samplerState.loopMode"
          :options="loopModeOptions"
          label="Loop Mode"
          dense
          dark
          filled
          emit-value
          map-options
          @update:model-value="handleLoopModeChange"
        />
        <q-select
          :model-value="samplerState.triggerMode"
          :options="triggerModeOptions"
          label="Trigger"
          dense
          dark
          filled
          emit-value
          map-options
          @update:model-value="handleTriggerModeChange"
        />
      </div>

      <div class="loop-row">
        <q-slider
          :model-value="samplerState.loopStart"
          :min="0"
          :max="samplerState.loopEnd"
          :step="0.001"
          label
          dark
          :label-value="`Start ${(samplerState.loopStart * 100).toFixed(1)}%`"
          @update:model-value="handleLoopStartChange"
        />
        <q-slider
          :model-value="samplerState.loopEnd"
          :min="samplerState.loopStart"
          :max="1"
          :step="0.001"
          label
          dark
          :label-value="`End ${(samplerState.loopEnd * 100).toFixed(1)}%`"
          @update:model-value="handleLoopEndChange"
        />
      </div>

      <div class="file-row">
        <div class="file-info">
          <div class="text-subtitle2">Sample</div>
          <div class="info-line">
            {{ samplerState.fileName || 'None loaded' }}
          </div>
          <div class="info-line" v-if="durationLabel">
            {{ durationLabel }} —
            {{ samplerState.sampleRate }} Hz · {{ samplerState.channels }} ch
          </div>
        </div>
        <div class="file-actions">
          <input
            ref="fileInput"
            type="file"
            accept="audio/wav,.wav"
            class="file-input"
            @change="handleFileUpload"
          />
        </div>
      </div>

      <div class="waveform-section">
        <div class="waveform-header">
          <div class="text-subtitle2">Waveform Preview</div>
          <q-btn
            dense
            flat
            icon="refresh"
            :loading="isWaveformLoading"
            @click="refreshWaveform"
          />
        </div>
        <div class="waveform-canvas-wrapper">
          <canvas
            ref="waveformCanvas"
            :width="waveformWidth"
            :height="waveformHeight"
          ></canvas>
          <div
            v-if="showWaveformPlaceholder"
            class="waveform-placeholder"
          >
            {{ waveformPlaceholderText }}
          </div>
        </div>
      </div>

      <routing-component
        :source-id="props.nodeId"
        :source-type="VoiceNodeType.Sampler"
      />
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import AudioCardHeader from './AudioCardHeader.vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import RoutingComponent from './RoutingComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { useLayoutStore } from 'src/stores/layout-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import {
  VoiceNodeType,
  SamplerLoopMode,
  SamplerTriggerMode,
  type SamplerState,
} from 'src/audio/types/synth-layout';

interface Props {
  node?: AudioNode | null;
  nodeId: string;
  isMinimized?: boolean;
  nodeName?: string;
}

const props = withDefaults(defineProps<Props>(), {
  node: null,
  isMinimized: false,
});

const emit = defineEmits(['plusClicked', 'minimizeClicked', 'closeClicked']);

function forwardPlus() {
  emit('plusClicked', VoiceNodeType.Sampler);
}
function forwardMinimize() {
  emit('minimizeClicked');
}
function forwardClose() {
  emit('closeClicked', props.nodeId);
}

const store = useAudioSystemStore();
const layoutStore = useLayoutStore();
const nodeStateStore = useNodeStateStore();
const { samplerStates, samplerWaveforms } = storeToRefs(store);

const displayName = computed(
  () =>
    props.nodeName ||
    layoutStore.getNodeName(props.nodeId) ||
    `Sampler ${props.nodeId}`,
);

function handleNameChange(name: string) {
  layoutStore.renameNode(props.nodeId, name);
}

const fallbackState: SamplerState = {
  id: props.nodeId,
  frequency: 440,
  gain: 1,
  detune_oct: 0,
  detune_semi: 0,
  detune_cents: 0,
  detune: 0,
  loopMode: SamplerLoopMode.Off,
  loopStart: 0,
  loopEnd: 1,
  sampleLength: 0,
  rootNote: 60,
  triggerMode: SamplerTriggerMode.Gate,
  active: true,
  sampleRate: 44100,
  channels: 1,
};

const samplerState = computed<SamplerState>(() => {
  return samplerStates.value.get(props.nodeId) ?? fallbackState;
});

const waveformData = computed<Float32Array | undefined>(() => {
  return samplerWaveforms.value.get(props.nodeId);
});

const waveformCanvas = ref<HTMLCanvasElement | null>(null);
const waveformWidth = 512;
const waveformHeight = 120;
const isWaveformLoading = ref(false);
const waveformError = ref<string | null>(null);

const loopModeOptions = [
  { label: 'Off', value: SamplerLoopMode.Off },
  { label: 'Loop', value: SamplerLoopMode.Loop },
  { label: 'Ping-Pong', value: SamplerLoopMode.PingPong },
];

const triggerModeOptions = [
  { label: 'Free', value: SamplerTriggerMode.FreeRunning },
  { label: 'Gate', value: SamplerTriggerMode.Gate },
  { label: 'One Shot', value: SamplerTriggerMode.OneShot },
];

const durationSeconds = computed(() => {
  const state = samplerState.value;
  if (!state.sampleRate || state.sampleRate <= 0) {
    return 0;
  }
  return state.sampleLength / state.sampleRate;
});

const durationLabel = computed(() => {
  const seconds = durationSeconds.value;
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '';
  if (seconds >= 1) {
    return `${seconds.toFixed(2)} s`;
  }
  return `${(seconds * 1000).toFixed(0)} ms`;
});

const fileInput = ref<HTMLInputElement | null>(null);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteOptions = Array.from({ length: 73 }, (_, index) => {
  const midi = 24 + index; // C1 (24) through C7 (96)
  const octave = Math.floor(midi / 12) - 1;
  const label = `${NOTE_NAMES[midi % 12]}${octave}`;
  return { label, value: midi };
});

const localGain = computed({
  get: () => samplerState.value.gain,
  set: (val: number) => handleGainChange(val),
});
const rootNoteValue = computed({
  get: () => samplerState.value.rootNote,
  set: (val: number) => handleRootNoteChange(val),
});

function updateSampler(values: Partial<SamplerState>) {
  nodeStateStore.updateSampler(props.nodeId, values);
}

function handleGainChange(value: number) {
  updateSampler({ gain: Number(value) });
}

function handleRootNoteChange(value: number) {
  updateSampler({ rootNote: Number(value) });
}

function handleDetuneOctChange(value: number | null) {
  if (value == null) return;
  updateSampler({ detune_oct: Math.round(value) });
}

function handleDetuneSemiChange(value: number | null) {
  if (value == null) return;
  updateSampler({ detune_semi: Math.round(value) });
}

function handleDetuneCentsChange(value: number | null) {
  if (value == null) return;
  updateSampler({ detune_cents: Math.round(value) });
}

function handleLoopModeChange(value: SamplerLoopMode) {
  updateSampler({ loopMode: value });
}

function handleTriggerModeChange(value: SamplerTriggerMode) {
  updateSampler({ triggerMode: value });
}

const LOOP_EPSILON = 0.0005;

function handleLoopStartChange(value: number | null) {
  if (value == null) return;
  const clamped = Math.min(Math.max(value, 0), 1);
  let nextEnd = samplerState.value.loopEnd;
  if (nextEnd <= clamped) {
    nextEnd = Math.min(1, clamped + LOOP_EPSILON);
  }
  updateSampler({ loopStart: clamped, loopEnd: nextEnd });
}

function handleLoopEndChange(value: number | null) {
  if (value == null) return;
  const clamped = Math.min(Math.max(value, 0), 1);
  const safeEnd = Math.max(clamped, samplerState.value.loopStart + LOOP_EPSILON);
  updateSampler({ loopEnd: Math.min(1, safeEnd) });
}

function parseWavHeader(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const riff = view.getUint32(0, false);
  const wave = view.getUint32(8, false);
  if (riff !== 0x52494646 || wave !== 0x57415645) {
    throw new Error('Unsupported WAV format');
  }

  let offset = 12;
  let sampleRate = 44100;
  let channels = 1;
  let bitsPerSample = 16;
  let dataLength = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = view.getUint32(offset, false);
    offset += 4;
    const chunkSize = view.getUint32(offset, true);
    offset += 4;

    if (chunkId === 0x666d7420) {
      channels = view.getUint16(offset + 2, true);
      sampleRate = view.getUint32(offset + 4, true);
      bitsPerSample = view.getUint16(offset + 14, true);
    } else if (chunkId === 0x64617461) {
      dataLength = chunkSize;
      break;
    }

    offset += chunkSize;
  }

  const bytesPerSample = bitsPerSample / 8;
  const sampleLength = bytesPerSample
    ? dataLength / (bytesPerSample * Math.max(1, channels))
    : 0;

  return { sampleRate, channels, sampleLength };
}

async function handleFileUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  const file = input.files[0]!;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const header = parseWavHeader(arrayBuffer);
    const wavBytes = new Uint8Array(arrayBuffer);
    nodeStateStore.setSamplerSampleInfo(props.nodeId, {
      sampleLength: header.sampleLength,
      sampleRate: header.sampleRate,
      channels: header.channels,
      fileName: file.name,
    });
    store.currentInstrument?.importSampleData(props.nodeId, wavBytes);
    await refreshWaveform();
  } catch (err) {
    console.error('Failed to import sample:', err);
  } finally {
    if (input) {
      input.value = '';
    }
  }
}

async function refreshWaveform() {
  if (!store.currentInstrument) return;
  try {
    isWaveformLoading.value = true;
    waveformError.value = null;
    await nodeStateStore.fetchSamplerWaveform(props.nodeId, waveformWidth);
  } catch (err) {
    console.error('Failed to refresh waveform', err);
    waveformError.value = 'Unable to load waveform';
  } finally {
    isWaveformLoading.value = false;
  }
}

const showWaveformPlaceholder = computed(() => {
  return (
    (!!waveformError.value || !waveformData.value || waveformData.value.length === 0) &&
    !isWaveformLoading.value
  );
});

const waveformPlaceholderText = computed(() => {
  if (waveformError.value) return waveformError.value;
  if (!samplerState.value.sampleLength) return 'No sample loaded';
  return 'Waveform unavailable';
});

watch(
  () => waveformData.value,
  (data) => {
    drawWaveform(data);
  },
  { immediate: true },
);

watch(
  () => samplerState.value.sampleLength,
  (newLen, oldLen) => {
    if (newLen !== oldLen) {
      void refreshWaveform();
    }
  },
);

onMounted(() => {
  if (!waveformData.value || waveformData.value.length === 0) {
    void refreshWaveform();
  } else {
    drawWaveform(waveformData.value);
  }
});

function drawWaveform(data?: Float32Array) {
  const canvas = waveformCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#13171c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const midY = canvas.height / 2;
  ctx.strokeStyle = '#2c3e50';
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(canvas.width, midY);
  ctx.stroke();

  if (!data || data.length === 0) {
    return;
  }

  ctx.strokeStyle = '#00bcd4';
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * canvas.width;
    const y = midY - data[i]! * (canvas.height / 2 - 2);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
}
</script>

<style scoped>
.sampler-card {
  width: 600px;
  margin: 0.5rem auto;
}

.sampler-body {
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.knob-row {
  display: flex;
  justify-content: space-around;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.mode-row {
  display: flex;
  gap: 1rem;
}

.mode-row > * {
  flex: 1;
}

.note-row {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.detune-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 0.5rem;
}

.note-row > * {
  flex: 1;
}

.waveform-section {
  margin: 1rem 0;
}

.waveform-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.waveform-canvas-wrapper {
  position: relative;
  width: 100%;
  border: 1px solid #2c3e50;
  border-radius: 4px;
  background-color: #13171c;
}

.waveform-canvas-wrapper canvas {
  display: block;
  width: 100%;
}

.waveform-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #8f9dac;
  font-size: 0.85rem;
  pointer-events: none;
}

.loop-row {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.file-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
}

.file-info {
  flex: 1;
}

.info-line {
  font-size: 0.9rem;
  color: #cfd8dc;
}

.file-actions {
  display: flex;
  justify-content: flex-end;
}

.file-input {
  color: #fff;
}
</style>
