<template>
  <q-card class="oscillator-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Oscillator {{ oscIndex + 1 }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="oscillator-container">
      <div class="knob-group">
        <q-toggle
          v-model="oscillatorState.is_active"
          label="Active"
          @update:modelValue="handleActiveChange"
        />
        <q-toggle
          v-model="oscillatorState.hardsync"
          label="Hard Sync"
          @update:modelValue="handleHardSyncChange"
        />
      </div>
      <div class="knob-group">
        <audio-knob-component
          v-model="oscillatorState.gain"
          label="Gain"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="2"
          @update:modelValue="handleGainChange"
        />

        <audio-knob-component
          v-model="oscillatorState.detune_oct"
          label="Octave"
          :min="-5"
          :max="5"
          :step="1"
          :decimals="0"
          @update:modelValue="handleDetuneChange"
        />

        <audio-knob-component
          v-model="oscillatorState.detune_semi"
          label="Semitones"
          :min="-12"
          :max="12"
          :step="1"
          :decimals="0"
          @update:modelValue="handleDetuneChange"
        />

        <audio-knob-component
          v-model="oscillatorState.detune_cents"
          label="Cents"
          :min="-100"
          :max="100"
          :step="1"
          :decimals="0"
          @update:modelValue="handleDetuneChange"
        />

        <audio-knob-component
          v-model="waveform"
          label="Waveform"
          :min="0"
          :max="3"
          :step="1"
          :decimals="0"
          @update:modelValue="handleWaveformChange"
        />
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { type OscillatorState } from 'src/audio/wavetable/wavetable-oscillator';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import { type WaveformType } from 'src/audio/wavetable/wave-utils';

interface Props {
  node: AudioNode | null;
  oscIndex: number;
}

const props = withDefaults(defineProps<Props>(), { node: null, oscIndex: 0 });
//const node = computed(() => props.node);

const store = useAudioSystemStore();
const { oscillatorStates } = storeToRefs(store);
const waveform = ref<number>(0);
// Create a reactive reference to the oscillator state
const oscillatorState = computed({
  get: () => {
    const state = oscillatorStates.value.get(props.oscIndex);
    if (!state) {
      console.warn(`No state found for oscillator ${props.oscIndex}`);
      return {
        id: props.oscIndex,
        gain: 1.0,
        detune_oct: 0,
        detune_semi: 0,
        detune_cents: 0,
        detune: 0,
        hardsync: false,
        waveform: 'sine',
        is_active: true,
      } as OscillatorState;
    }
    return state;
  },
  set: (newState: OscillatorState) => {
    store.oscillatorStates.set(props.oscIndex, { ...newState });
  },
});

onMounted(() => {
  if (!oscillatorStates.value.has(props.oscIndex)) {
    oscillatorStates.value.set(props.oscIndex, oscillatorState.value);
  }
  // store.currentInstrument?.updateOscillatorState(
  //   props.oscIndex,
  //   oscillatorStates.value!.get(props.oscIndex)!,
  // );
});

const totalDetune = computed(() => {
  return (
    oscillatorState.value.detune_oct * 1200 +
    oscillatorState.value.detune_semi * 100 +
    oscillatorState.value.detune_cents
  );
});

const handleWaveformChange = (newWaveform: number) => {
  let wf: WaveformType = 'sine';
  switch (newWaveform) {
    case 0:
      wf = 'sine';
      break;
    case 1:
      wf = 'triangle';
      break;
    case 2:
      wf = 'sawtooth';
      break;
    case 3:
      wf = 'square';
      break;
    default:
      break;
  }

  const currentState = {
    ...oscillatorState.value,
    waveform: wf,
  };
  store.oscillatorStates.set(props.oscIndex, currentState);
};

const handleHardSyncChange = (newValue: boolean) => {
  const currentState = {
    ...oscillatorState.value,
    hardsync: newValue,
  };
  store.oscillatorStates.set(props.oscIndex, currentState);
};

const handleActiveChange = (newValue: boolean) => {
  const currentState = {
    ...oscillatorState.value,
    is_active: newValue,
  };
  store.oscillatorStates.set(props.oscIndex, currentState);
};

// Handle gain changes
const handleGainChange = (newValue: number) => {
  // Create a completely new state object
  const currentState = {
    ...oscillatorState.value,
    gain: newValue,
  };
  // Update the store with the new object
  store.oscillatorStates.set(props.oscIndex, currentState);
};

// Handle any detune changes
const handleDetuneChange = () => {
  // Create a new state object with updated detune
  const currentState = {
    ...oscillatorState.value,
    detune: totalDetune.value,
  };
  store.oscillatorStates.set(props.oscIndex, currentState);

  // if (node.value instanceof OscillatorNode) {
  //   node.value.detune.setValueAtTime(
  //     totalDetune.value,
  //     node.value.context.currentTime,
  //   );
  // }
};

// Watch the oscillator state
watch(
  () => ({ ...oscillatorStates.value.get(props.oscIndex) }), // Create new reference
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState.id === props.oscIndex) {
        // console.log('state changed!');
        store.currentInstrument?.updateOscillatorState(
          props.oscIndex,
          newState as OscillatorState,
        );
      }
    }
  },
  { deep: true, immediate: true },
);
</script>

<style scoped>
.oscillator-card {
  width: 600px;
  margin: 0 auto;
}

.oscillator-container {
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
