<template>
  <q-card class="oscillator-card">
    <!-- Header: forward events to container -->
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

    <!-- Main content is shown only when not minimized -->
    <q-card-section class="oscillator-container" v-show="!props.isMinimized">
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
            v-model="oscillatorState.waveform"
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
        :source-id="props.nodeId"
        :source-type="VoiceNodeType.Oscillator"
        :debug="true"
      />
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import AudioCardHeader from './AudioCardHeader.vue'; // New header component
import AudioKnobComponent from './AudioKnobComponent.vue';
import RoutingComponent from './RoutingComponent.vue';
import { useInstrumentStore } from 'src/stores/instrument-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import { useLayoutStore } from 'src/stores/layout-store';
import { storeToRefs } from 'pinia';
import { VoiceNodeType } from 'src/audio/types/synth-layout';
import type OscillatorState from 'src/audio/models/OscillatorState';

interface Props {
  nodeId: string;
  isMinimized?: boolean;
  nodeName?: string;
}

// Default isMinimized to false
const props = withDefaults(defineProps<Props>(), {
  isMinimized: false,
});

// Define events we want to forward to the parent
const emit = defineEmits(['plusClicked', 'minimizeClicked', 'closeClicked']);

function forwardPlus() {
  emit('plusClicked', VoiceNodeType.Oscillator);
}
function forwardMinimize() {
  emit('minimizeClicked');
}
function forwardClose() {
  emit('closeClicked', props.nodeId);
}

// Reference to the audio system store
const instrumentStore = useInstrumentStore();
const nodeStateStore = useNodeStateStore();
const layoutStore = useLayoutStore();
const { oscillatorStates } = storeToRefs(nodeStateStore);

const displayName = computed(
  () =>
    props.nodeName ||
    layoutStore.getNodeName(props.nodeId) ||
    `Oscillator ${props.nodeId}`,
);

function handleNameChange(name: string) {
  layoutStore.renameNode(props.nodeId, name);
}

// Computed oscillator state
const oscillatorState = computed<OscillatorState>({
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
        hard_sync: false,
        gain: 1,
        feedback_amount: 0,
        waveform: 0,
        active: false,
        unison_voices: 1,
        spread: 0,
        wave_index: 0,
      };
    }
    return state;
  },
  set: (newState: OscillatorState) => {
    nodeStateStore.oscillatorStates.set(props.nodeId, newState);
  },
});

onMounted(() => {
  // Ensure an oscillator state exists for this node
  if (!oscillatorStates.value.has(props.nodeId)) {
    oscillatorStates.value.set(props.nodeId, oscillatorState.value);
  }
});

const totalDetune = computed(() => {
  return (
    oscillatorState.value.detune_oct! * 1200 +
    oscillatorState.value.detune_semi! * 100 +
    oscillatorState.value.detune_cents!
  );
});

/** Knob handlers below **/
function handleActiveChange(newValue: boolean) {
  const currentState = { ...oscillatorState.value, active: newValue };
  nodeStateStore.oscillatorStates.set(props.nodeId, currentState);
}
function handleHardSyncChange(newValue: boolean) {
  const currentState = { ...oscillatorState.value, hard_sync: newValue };
  nodeStateStore.oscillatorStates.set(props.nodeId, currentState);
}
function handleWaveformChange(newValue: number) {
  const currentState = { ...oscillatorState.value, waveform: newValue };
  nodeStateStore.oscillatorStates.set(props.nodeId, currentState);
}
function handleUnisonVoicesChange(newValue: number) {
  const currentState = { ...oscillatorState.value, unison_voices: newValue };
  nodeStateStore.oscillatorStates.set(props.nodeId, currentState);
}
function handleUnisonSpreadChange(newValue: number) {
  const currentState = { ...oscillatorState.value, spread: newValue };
  nodeStateStore.oscillatorStates.set(props.nodeId, currentState);
}
function handleModIndexChange(newValue: number) {
  const currentState = { ...oscillatorState.value, phase_mod_amount: newValue };
  nodeStateStore.oscillatorStates.set(props.nodeId, currentState);
}
function handleFeedbackChange(newValue: number) {
  const currentState = { ...oscillatorState.value, feedback_amount: newValue };
  nodeStateStore.oscillatorStates.set(props.nodeId, currentState);
}
function handleGainChange(newValue: number) {
  const currentState = { ...oscillatorState.value, gain: newValue };
  nodeStateStore.oscillatorStates.set(props.nodeId, currentState);
}
function handleDetuneChange() {
  const currentState = {
    ...oscillatorState.value,
    detune: totalDetune.value,
  };
  nodeStateStore.oscillatorStates.set(props.nodeId, currentState);
}

// Watch the oscillator state in the store and notify the current instrument
// Watch the oscillator state in the store
watch(
  () => ({ ...oscillatorStates.value.get(props.nodeId) }),
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState && newState.id === props.nodeId) {
        instrumentStore.currentInstrument?.updateOscillatorState(
          props.nodeId,
          newState as OscillatorState, // <-- cast here
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
}

.detune-group {
  display: flex;
  gap: 0.5rem;
}
</style>
