<template>
  <q-card class="oscillator-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Oscillator {{ nodeId }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="oscillator-container">
      <div class="top-row">
        <div class="toggle-group">
          <q-toggle
            v-model="oscillatorState.active"
            label="Active"
            @update:modelValue="handleActiveChange"
          />

          <q-toggle
            v-model="oscillatorState.hard_sync"
            label="Hard Sync"
            @update:modelValue="handleHardSyncChange"
          />
        </div>
      </div>

      <div class="controls-row">
        <div class="main-controls-group">
          <audio-knob-component
            v-model="oscillatorState.gain!"
            label="Gain"
            :min="0"
            :max="1"
            :step="0.001"
            :decimals="2"
            @update:modelValue="handleGainChange"
          />

          <audio-knob-component
            v-model="oscillatorState.phase_mod_amount!"
            label="ModIndex"
            :min="0"
            :max="30"
            :step="0.001"
            :decimals="3"
            @update:modelValue="handleModIndexChange"
          />

          <audio-knob-component
            v-model="oscillatorState.feedback_amount!"
            label="Feedback"
            :min="0"
            :max="1"
            :step="0.001"
            :decimals="3"
            @update:modelValue="handleFeedbackChange"
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
      </div>

      <div class="detune-row">
        <div class="detune-group">
          <audio-knob-component
            v-model="oscillatorState.detune_oct!"
            label="Octave"
            :min="-5"
            :max="5"
            :step="1"
            :decimals="0"
            scale="half"
            @update:modelValue="handleDetuneChange"
          />

          <audio-knob-component
            v-model="oscillatorState.detune_semi!"
            label="Semitones"
            :min="-12"
            :max="12"
            :step="1"
            :decimals="0"
            scale="half"
            @update:modelValue="handleDetuneChange"
          />

          <audio-knob-component
            v-model="oscillatorState.detune_cents!"
            label="Cents"
            :min="-100"
            :max="100"
            :step="1"
            :decimals="0"
            scale="half"
            @update:modelValue="handleDetuneChange"
          />

          <audio-knob-component
            v-model="oscillatorState.unison_voices!"
            label="Unison"
            :min="1"
            :max="10"
            :step="1"
            :decimals="0"
            scale="half"
            @update:modelValue="handleUnisonVoicesChange"
          />

          <audio-knob-component
            v-model="oscillatorState.spread!"
            label="Spread"
            :min="0"
            :max="100"
            :step="1"
            :decimals="0"
            scale="half"
            @update:modelValue="handleUnisonSpreadChange"
          />
        </div>
      </div>

      <routing-component
        :source-id="nodeId"
        :source-type="VoiceNodeType.Oscillator"
        :debug="true"
      />
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
// import { type WaveformType } from 'src/audio/wavetable/wave-utils';
import type OscillatorState from 'src/audio/models/OscillatorState';
import RoutingComponent from './RoutingComponent.vue';
import { VoiceNodeType } from 'src/audio/types/synth-layout';
// import { Waveform } from 'app/public/wasm/audio_processor';

interface Props {
  node: AudioNode | null;
  nodeId: number;
}

const props = withDefaults(defineProps<Props>(), {
  node: null,
  nodeId: 0,
});
//const node = computed(() => props.node);

const store = useAudioSystemStore();
const { oscillatorStates } = storeToRefs(store);
//const waveformCanvas = ref<HTMLCanvasElement | null>(null);
const waveform = ref<number>(0);
// Create a reactive reference to the oscillator state
const oscillatorState = computed({
  get: () => {
    const state = oscillatorStates.value.get(props.nodeId);
    if (!state) {
      console.warn(`No state found for oscillator ${props.nodeId}`);
      return {
        phase_mod_amount: 0,
        freq_mod_amount: 0,
        detune_oct: 0,
        detune_semi: 0,
        detune_cents: 0,
        detune: 0,
        gain: 1,
        active: false,
        unison_voices: 1,
        spread: 0,
      } as OscillatorState;
    }
    return state;
  },
  set: (newState: OscillatorState) => {
    store.oscillatorStates.set(props.nodeId, newState);
  },
});

onMounted(() => {
  if (!oscillatorStates.value.has(props.nodeId)) {
    oscillatorStates.value.set(props.nodeId, oscillatorState.value);
  }
  // store.currentInstrument?.updateOscillatorState(
  //   props.oscIndex,
  //   oscillatorStates.value!.get(props.oscIndex)!,
  // );
});

const totalDetune = computed(() => {
  return (
    oscillatorState.value.detune_oct! * 1200 +
    oscillatorState.value.detune_semi! * 100 +
    oscillatorState.value.detune_cents!
  );
});

const handleWaveformChange = (newWaveform: number) => {
  // let wf: Waveform = Waveform.Sine;
  // switch (newWaveform) {
  //   case 0:
  //     wf = Waveform.Sine;
  //     break;
  //   case 1:
  //     wf = Waveform.Triangle;
  //     break;
  //   case 2:
  //     wf = Waveform.Saw;
  //     break;
  //   case 3:
  //     wf = Waveform.Square;
  //     break;
  //   default:
  //     break;
  // }

  const currentState = {
    ...oscillatorState.value,
    waveform: newWaveform,
  };
  store.oscillatorStates.set(props.nodeId, currentState as OscillatorState);
};

const handleUnisonVoicesChange = (newValue: number) => {
  const currentState = {
    ...oscillatorState.value,
    unison_voices: newValue,
  };
  store.oscillatorStates.set(props.nodeId, currentState as OscillatorState);
};

const handleUnisonSpreadChange = (newValue: number) => {
  const currentState = {
    ...oscillatorState.value,
    spread: newValue,
  };
  store.oscillatorStates.set(props.nodeId, currentState as OscillatorState);
};

const handleHardSyncChange = (newValue: boolean) => {
  const currentState = {
    ...oscillatorState.value,
    hardsync: newValue,
  };
  store.oscillatorStates.set(props.nodeId, currentState as OscillatorState);
};

const handleModIndexChange = (newValue: number) => {
  const currentState = {
    ...oscillatorState.value,
    phase_mod_amount: newValue,
  };
  store.oscillatorStates.set(props.nodeId, currentState as OscillatorState);
};

const handleFeedbackChange = (newValue: number) => {
  const currentState = {
    ...oscillatorState.value,
    feedback_amount: newValue,
  };
  store.oscillatorStates.set(props.nodeId, currentState as OscillatorState);
};

const handleActiveChange = (newValue: boolean) => {
  const currentState = {
    ...oscillatorState.value,
    active: newValue,
  };
  store.oscillatorStates.set(props.nodeId, currentState as OscillatorState);
};

// Handle gain changes
const handleGainChange = (newValue: number) => {
  // Create a completely new state object
  const currentState = {
    ...oscillatorState.value,
    gain: newValue,
  };
  // Update the store with the new object
  store.oscillatorStates.set(props.nodeId, currentState);
};

// Handle any detune changes
const handleDetuneChange = () => {
  // Create a new state object with updated detune
  const currentState = {
    ...oscillatorState.value,
    detune: totalDetune.value,
  };
  store.oscillatorStates.set(props.nodeId, currentState);

  // if (node.value instanceof OscillatorNode) {
  //   node.value.detune.setValueAtTime(
  //     totalDetune.value,
  //     node.value.context.currentTime,
  //   );
  // }
};

// Watch the oscillator state
watch(
  () => ({ ...oscillatorStates.value.get(props.nodeId) }), // Create new reference
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState.id === props.nodeId) {
        // console.log('state changed!');
        store.currentInstrument?.updateOscillatorState(
          props.nodeId,
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
  margin: 0.5rem auto;
}

.oscillator-container {
  padding: 1rem;
}

.top-row {
  display: flex;
  margin-bottom: 1rem;
}

.toggle-group {
  display: flex;
  gap: 1rem;
}

.controls-row {
  display: flex;
  justify-content: center;
  margin-bottom: 1rem;
}

.main-controls-group {
  display: flex;
  gap: 0.5rem;
}

.detune-row {
  display: flex;
  justify-content: center;
  /* gap: 0.25rem; */
  /* justify-content: flex-end; */
  /* margin-bottom: 1rem; */
}

.detune-group {
  display: flex;
  gap: 0.5rem;
}
</style>
