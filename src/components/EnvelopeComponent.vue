<template>
  <q-card class="envelope-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Envelope {{ envIndex + 1 }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="envelope-container">
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
          v-model="envelopeState.decay"
          label="Decay"
          :min="0"
          :max="3"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleDecayChange"
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
          v-model="envelopeState.release"
          label="Release"
          :min="0"
          :max="3"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleReleaseChange"
        />
      </div>

      <div class="canvas-wrapper">
        <canvas></canvas>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { type EnvelopeConfig } from 'src/audio/dsp/envelope';

interface Props {
  node: AudioNode | null;
  envIndex: number;
}

const props = withDefaults(defineProps<Props>(), { node: null, envIndex: 0 });
//const node = computed(() => props.node);

const store = useAudioSystemStore();
const { envelopeStates } = storeToRefs(store);
// Create a reactive reference to the oscillator state
const envelopeState = computed({
  get: () => {
    const state = envelopeStates.value.get(props.envIndex);
    if (!state) {
      console.warn(`No state found for oscillator ${props.envIndex}`);
      return {
        attack: 0.0,
        decay: 0.1,
        sustain: 0.5,
        release: 0.1,
        attackCurve: 0.0,
        decayCurve: 0.0,
        releaseCurve: 0.0,
      } as EnvelopeConfig;
    }
    return state;
  },
  set: (newState: EnvelopeConfig) => {
    store.envelopeStates.set(props.envIndex, { ...newState });
  },
});
const handleAttackChange = (envVal: number) => {
  const currentState = {
    ...envelopeState.value,
    attack: envVal,
  };
  store.envelopeStates.set(props.envIndex, currentState);
};
const handleDecayChange = (envVal: number) => {
  const currentState = {
    ...envelopeState.value,
    decay: envVal,
  };
  store.envelopeStates.set(props.envIndex, currentState);
};
const handleSustainChange = (envVal: number) => {
  const currentState = {
    ...envelopeState.value,
    sustain: envVal,
  };
  store.envelopeStates.set(props.envIndex, currentState);
};
const handleReleaseChange = (envVal: number) => {
  const currentState = {
    ...envelopeState.value,
    release: envVal,
  };
  store.envelopeStates.set(props.envIndex, currentState);
};
onMounted(() => {});

watch(
  () => ({ ...envelopeStates.value.get(props.envIndex) }), // Create new reference
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState.id === props.envIndex) {
        // console.log('state changed!');
        store.currentInstrument?.updateEnvelopeState(
          props.envIndex,
          newState as EnvelopeConfig,
        );
      }
    }
  },
  { deep: true, immediate: true },
);
</script>

<style scoped>
.envelope-card {
  width: 600px;
  margin: 0 auto;
}

.envelope-container {
  padding: 1rem;
}

.knob-group {
  display: flex;
  justify-content: space-around;
  align-items: flex-start;
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
  border: 1px solid #ccc;
  background-color: rgb(200, 200, 200);
  border-radius: 4px;
}
</style>
