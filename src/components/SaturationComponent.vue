<template>
  <q-card class="effect-card">
    <q-card-section class="card-header">
      <div class="text-h6">{{ displayName }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="effect-controls">
      <div class="knob-group">
        <q-toggle
          v-model="saturationState.active"
          label="Enabled"
          @update:modelValue="handleActiveChange"
        />
        <audio-knob-component
          v-model="saturationState.drive"
          label="Drive"
          :min="0.5"
          :max="8"
          :step="0.05"
          :decimals="2"
          @update:modelValue="handleDriveChange"
        />
        <audio-knob-component
          v-model="saturationState.mix"
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
import { type SaturationState } from 'src/audio/types/synth-layout';

interface Props {
  nodeId: string;
  nodeName?: string;
}

const props = withDefaults(defineProps<Props>(), {
  nodeId: '',
});

const instrumentStore = useInstrumentStore();
const nodeStateStore = useNodeStateStore();
const { saturationStates } = storeToRefs(nodeStateStore);

const ensureSaturationState = (): SaturationState => {
  const existing = saturationStates.value.get(props.nodeId);
  if (existing) return existing;
  return {
    id: props.nodeId,
    active: false,
    drive: 2.0,
    mix: 0.5,
  };
};

const persistSaturationState = (state: SaturationState) => {
  nodeStateStore.saturationStates.set(props.nodeId, { ...state });
};

const displayName = computed(() => props.nodeName || 'Saturation');

const saturationState = computed({
  get: () => ensureSaturationState(),
  set: (newState: SaturationState) => {
    persistSaturationState({
      ...newState,
      id: props.nodeId,
    });
  },
});

const syncSaturationToInstrument = (state: SaturationState) => {
  instrumentStore.currentInstrument?.updateSaturationState(props.nodeId, {
    ...state,
    id: props.nodeId,
  });
};

const updateSaturationState = (patch: Partial<SaturationState>) => {
  const next = {
    ...ensureSaturationState(),
    ...patch,
    id: props.nodeId,
  };
  persistSaturationState(next);
  syncSaturationToInstrument(next);
};

const handleActiveChange = (value: boolean) => {
  updateSaturationState({ active: value });
};

const handleDriveChange = (value: number) => {
  updateSaturationState({ drive: value });
};

const handleMixChange = (value: number) => {
  updateSaturationState({ mix: value });
};

onMounted(() => {
  syncSaturationToInstrument(ensureSaturationState());
});
</script>

<style scoped>
.card-header {
  background: linear-gradient(135deg, var(--panel-background-alt), var(--panel-background));
  color: var(--text-primary);
  border-bottom: 1px solid var(--panel-border);
}

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
  margin-bottom: 1rem;
}
</style>
