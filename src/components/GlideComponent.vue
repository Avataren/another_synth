<template>
  <q-card class="glide-card">
    <q-card-section class="row items-center justify-between">
      <div class="text-subtitle2">{{ displayName }}</div>
      <q-toggle v-model="localState.active" label="Glide" @update:model-value="commit" />
    </q-card-section>
    <q-separator />
    <q-card-section class="column q-gutter-sm">
      <q-slider
        v-model="localState.time"
        label
        color="primary"
        :min="0"
        :max="1"
        :step="0.005"
        label-always
        :label-value="`${localState.time.toFixed(3)}s`"
        @change="commit"
      />
      <div class="caption">Time</div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useNodeStateStore } from 'src/stores/node-state-store';
import { useInstrumentStore } from 'src/stores/instrument-store';
import type { GlideState } from 'src/audio/types/synth-layout';

const props = defineProps<{
  nodeId: string;
  nodeName?: string;
}>();

const nodeStateStore = useNodeStateStore();
const instrumentStore = useInstrumentStore();

const displayName = computed(() => props.nodeName || 'Glide');

const localState = computed({
  get: () => {
    return (
      nodeStateStore.glideStates.get(props.nodeId) ?? {
        id: props.nodeId,
        time: 0,
        active: false,
      }
    );
  },
  set: (val: GlideState) => {
    nodeStateStore.glideStates.set(props.nodeId, { ...val, id: props.nodeId });
  },
});

function commit() {
  const state = localState.value;
  nodeStateStore.glideStates.set(props.nodeId, { ...state, id: props.nodeId });
  instrumentStore.currentInstrument?.updateGlideState(props.nodeId, state);
}
</script>

<style scoped>
.glide-card {
  min-width: 240px;
}
.caption {
  font-size: 11px;
  color: #aaa;
  margin-top: -8px;
}
</style>
