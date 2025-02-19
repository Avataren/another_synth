<template>
  <q-card class="envelope-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Envelope {{ nodeId }}</div>
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
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import RoutingComponent from './RoutingComponent.vue';
import type { EnvelopeConfig } from 'src/audio/types/synth-layout';
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

const handleAttackCoeffChange = (envVal: number) => {
  const currentState = {
    ...envelopeState.value,
    attackCurve: envVal,
  };
  store.envelopeStates.set(props.nodeId, currentState);
};

const handleDecayCoeffChange = (envVal: number) => {
  const currentState = {
    ...envelopeState.value,
    decayCurve: envVal,
  };
  store.envelopeStates.set(props.nodeId, currentState);
};

const handleReleaseCoeffChange = (envVal: number) => {
  const currentState = {
    ...envelopeState.value,
    releaseCurve: envVal,
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

const updateEnvelopePreview = () => {
  const config = envelopeState.value;
  const previewDuration = config.attack + config.decay + 1 + config.release;

  store.currentInstrument
    ?.getEnvelopePreview(config, previewDuration)
    .then((previewData) => {
      drawEnvelopePreviewWithData(previewData);
    })
    .catch((_err) => {
      //console.error('Failed to get envelope preview:', err);
    });
};

const drawEnvelopePreviewWithData = (previewData: Float32Array) => {
  const canvas = waveformCanvas.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Set canvas dimensions
  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;
  canvas.width = width;
  canvas.height = height;

  ctx.fillStyle = 'rgb(32, 45, 66)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Downsample the preview data to match the canvas width.
  const totalSamples = previewData.length;
  const step = totalSamples / width;

  ctx.beginPath();
  ctx.strokeStyle = 'rgb(160, 190, 225)';
  ctx.lineWidth = 2;

  // Map the envelope value (0 to 1) to canvas y-coordinate.
  ctx.moveTo(0, height - previewData[0]! * height);

  for (let x = 1; x < width; x++) {
    const sampleIndex = Math.floor(x * step);
    const value = previewData[sampleIndex];
    const y = height - value! * height;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
};

onMounted(() => {
  if (!envelopeStates.value.has(props.nodeId)) {
    envelopeStates.value.set(props.nodeId, envelopeState.value);
  }
  setTimeout(updateEnvelopePreview, 250);

  // Add resize listener
  window.addEventListener('resize', updateEnvelopePreview);
});

onUnmounted(() => {
  window.removeEventListener('resize', updateEnvelopePreview);
});

// Watch for changes in the envelope state
watch(
  () => ({ ...envelopeStates.value.get(props.nodeId) }),
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState.id === props.nodeId) {
        store.currentInstrument?.updateEnvelopeState(
          props.nodeId,
          newState as EnvelopeConfig,
        );
        updateEnvelopePreview();
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
  /* border-radius: 4px; */
}
</style>
