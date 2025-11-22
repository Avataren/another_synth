<template>
  <q-card class="effect-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">{{ displayName }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="effect-controls">
      <div class="knob-group">
        <q-toggle
          v-model="bitcrusherState.active"
          label="Enabled"
          @update:modelValue="handleActiveChange"
        />
        <audio-knob-component
          v-model="bitcrusherState.bits"
          label="Bits"
          :min="2"
          :max="24"
          :step="1"
          :decimals="0"
          @update:modelValue="handleBitsChange"
        />
        <audio-knob-component
          v-model="bitcrusherState.downsampleFactor"
          label="Downsample"
          :min="1"
          :max="32"
          :step="1"
          :decimals="0"
          @update:modelValue="handleDownsampleChange"
        />
        <audio-knob-component
          v-model="bitcrusherState.mix"
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
import { storeToRefs } from 'pinia';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useInstrumentStore } from 'src/stores/instrument-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import type { BitcrusherState } from 'src/audio/types/synth-layout';

interface Props {
  nodeId: string;
  nodeName?: string;
}

const props = withDefaults(defineProps<Props>(), {
  nodeId: '',
});

const instrumentStore = useInstrumentStore();
const nodeStateStore = useNodeStateStore();
const { bitcrusherStates } = storeToRefs(nodeStateStore);

const ensureBitcrusherState = (): BitcrusherState => {
  const existing = bitcrusherStates.value.get(props.nodeId);
  if (existing) return existing;
  return {
    id: props.nodeId,
    active: false,
    bits: 12,
    downsampleFactor: 4,
    mix: 0.5,
  };
};

const persistBitcrusherState = (state: BitcrusherState) => {
  nodeStateStore.bitcrusherStates.set(props.nodeId, { ...state });
};

const displayName = computed(() => props.nodeName || 'Bitcrusher');

const bitcrusherState = computed({
  get: () => ensureBitcrusherState(),
  set: (newState: BitcrusherState) => {
    persistBitcrusherState({
      ...newState,
      id: props.nodeId,
    });
  },
});

const syncBitcrusherToInstrument = (state: BitcrusherState) => {
  instrumentStore.currentInstrument?.updateBitcrusherState(props.nodeId, {
    ...state,
    id: props.nodeId,
  });
};

const updateBitcrusherState = (patch: Partial<BitcrusherState>) => {
  const next = {
    ...ensureBitcrusherState(),
    ...patch,
    id: props.nodeId,
  };
  persistBitcrusherState(next);
  syncBitcrusherToInstrument(next);
};

const handleActiveChange = (value: boolean) => {
  updateBitcrusherState({ active: value });
};

const handleBitsChange = (value: number) => {
  updateBitcrusherState({ bits: Math.round(value) });
};

const handleDownsampleChange = (value: number) => {
  updateBitcrusherState({ downsampleFactor: Math.max(1, Math.round(value)) });
};

const handleMixChange = (value: number) => {
  updateBitcrusherState({ mix: value });
};

onMounted(() => {
  syncBitcrusherToInstrument(ensureBitcrusherState());
});
</script>

<style scoped>
.effect-card {
  width: 600px;
  margin: 0.5rem auto;
}

.effect-controls {
  padding: 1rem;
}

.knob-group {
  display: flex;
  justify-content: space-around;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 12px;
}
</style>
