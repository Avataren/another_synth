<template>
  <q-card class="compressor-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">{{ displayName }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="compressor-controls">
      <div class="knob-grid">
        <div class="toggle-cell">
          <q-toggle
            v-model="compressorState.active"
            label="Enabled"
            @update:modelValue="handleActiveChange"
          />
        </div>
        <audio-knob-component
          v-model="compressorState.thresholdDb"
          label="Threshold (dB)"
          :min="-60"
          :max="0"
          :step="0.5"
          :decimals="1"
          @update:modelValue="handleThresholdChange"
        />
        <audio-knob-component
          v-model="compressorState.ratio"
          label="Ratio"
          :min="1"
          :max="20"
          :step="0.1"
          :decimals="1"
          @update:modelValue="handleRatioChange"
        />
        <audio-knob-component
          v-model="compressorState.attackMs"
          label="Attack (ms)"
          :min="0.1"
          :max="200"
          :step="1"
          :decimals="1"
          @update:modelValue="handleAttackChange"
        />
        <audio-knob-component
          v-model="compressorState.releaseMs"
          label="Release (ms)"
          :min="5"
          :max="500"
          :step="5"
          :decimals="0"
          @update:modelValue="handleReleaseChange"
        />
        <audio-knob-component
          v-model="compressorState.makeupGainDb"
          label="Makeup (dB)"
          :min="0"
          :max="24"
          :step="0.5"
          :decimals="1"
          @update:modelValue="handleMakeupChange"
        />
        <audio-knob-component
          v-model="compressorState.mix"
          label="Mix"
          :min="0"
          :max="1"
          :step="0.01"
          :decimals="2"
          @update:modelValue="handleMixChange"
        />
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useInstrumentStore } from 'src/stores/instrument-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import { type CompressorState } from 'src/audio/types/synth-layout';

interface Props {
  nodeId: string;
  nodeName?: string;
}

const props = defineProps<Props>();

const instrumentStore = useInstrumentStore();
const nodeStateStore = useNodeStateStore();

const ensureState = (): CompressorState => {
  const existing = nodeStateStore.compressorStates.get(props.nodeId);
  if (existing) {
    return existing;
  }
  return {
    id: props.nodeId,
    active: true,
    thresholdDb: -12,
    ratio: 4,
    attackMs: 10,
    releaseMs: 80,
    makeupGainDb: 3,
    mix: 0.5,
  };
};

const persistState = (state: CompressorState) => {
  nodeStateStore.compressorStates.set(props.nodeId, { ...state });
};

const displayName = computed(() => props.nodeName || 'Compressor');

const compressorState = computed({
  get: () => ensureState(),
  set: (next: CompressorState) => {
    persistState({
      ...next,
      id: props.nodeId,
    });
  },
});

const syncToInstrument = (state: CompressorState) => {
  instrumentStore.currentInstrument?.updateCompressorState(props.nodeId, {
    ...state,
  });
};

const updateState = (patch: Partial<CompressorState>) => {
  const next = {
    ...ensureState(),
    ...patch,
    id: props.nodeId,
  };
  persistState(next);
  syncToInstrument(next);
};

const handleActiveChange = (active: boolean) => updateState({ active });
const handleThresholdChange = (thresholdDb: number) =>
  updateState({ thresholdDb });
const handleRatioChange = (ratio: number) => updateState({ ratio });
const handleAttackChange = (attackMs: number) => updateState({ attackMs });
const handleReleaseChange = (releaseMs: number) =>
  updateState({ releaseMs });
const handleMakeupChange = (makeupGainDb: number) =>
  updateState({ makeupGainDb });
const handleMixChange = (mix: number) => updateState({ mix });

onMounted(() => {
  syncToInstrument(ensureState());
});
</script>

<style scoped>
.compressor-card {
  width: 600px;
  margin: 0.5rem auto;
}

.compressor-controls {
  padding: 1rem;
}

.knob-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
}

.toggle-cell {
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
