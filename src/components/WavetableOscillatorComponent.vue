<template>
  <q-card class="oscillator-card">
    <!-- Header: forward events to parent -->
    <audio-card-header
      :title="`Wavetable Oscillator ${props.nodeId}`"
      :isMinimized="props.isMinimized"
      @plusClicked="forwardPlus"
      @minimizeClicked="forwardMinimize"
      @closeClicked="forwardClose"
    />

    <q-separator />

    <!-- Main content shown only when not minimized -->
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
            v-model="oscillatorState.wave_index"
            label="WaveIndex"
            :min="0"
            :max="1"
            :step="0.001"
            :decimals="3"
            @update:modelValue="handleWaveformIndexChange"
          />
        </div>
      </div>

      <q-card-section class="import-section">
        <div class="row">
          <div class="col-6">
            <div class="text-h6">Import Wavetable</div>
            <input type="file" accept=".wav" @change="handleWavFileUpload" />
          </div>
          <div class="col-6">
            <WavetableEditor
              :num-harmonics="32"
              @update:wavetable="handleWavetableUpdate"
            />
          </div>
        </div>
      </q-card-section>

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
import AudioCardHeader from './AudioCardHeader.vue'; // <-- Make sure to import this
import AudioKnobComponent from './AudioKnobComponent.vue';
import WavetableEditor from './WaveTable/WavetableEditor.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { storeToRefs } from 'pinia';
import type OscillatorState from 'src/audio/models/OscillatorState';
import RoutingComponent from './RoutingComponent.vue';
import { VoiceNodeType } from 'src/audio/types/synth-layout';

// Define props
interface Props {
  node: AudioNode | null | undefined;
  nodeId: number;
  isMinimized?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  node: null,
  nodeId: 0,
  isMinimized: false,
});

// Define emits for forwarding events
const emit = defineEmits(['plusClicked', 'minimizeClicked', 'closeClicked']);

// Forwarding methods
function forwardPlus() {
  emit('plusClicked', VoiceNodeType.WavetableOscillator);
}
function forwardMinimize() {
  emit('minimizeClicked');
}
function forwardClose() {
  emit('closeClicked', props.nodeId);
}

// Access the store
const store = useAudioSystemStore();
const { wavetableOscillatorStates } = storeToRefs(store);

// Computed for oscillator state
const oscillatorState = computed<OscillatorState>({
  get: () => {
    const state = wavetableOscillatorStates.value.get(props.nodeId);
    if (!state) {
      // Provide a complete fallback default with all required numeric properties.
      return {
        phase_mod_amount: 0,
        freq_mod_amount: 0,
        detune_oct: 0,
        detune_semi: 0,
        detune_cents: 0,
        detune: 0,
        gain: 1,
        feedback_amount: 0,
        hard_sync: false,
        waveform: 0,
        active: false,
        unison_voices: 1,
        spread: 0,
        wave_index: 0,
      } as OscillatorState;
    }
    return state;
  },
  set: (newState: OscillatorState) => {
    store.wavetableOscillatorStates.set(props.nodeId, newState);
  },
});

onMounted(() => {
  if (!wavetableOscillatorStates.value.has(props.nodeId)) {
    wavetableOscillatorStates.value.set(props.nodeId, oscillatorState.value);
  }
});

const totalDetune = computed(() => {
  return (
    oscillatorState.value.detune_oct! * 1200 +
    oscillatorState.value.detune_semi! * 100 +
    oscillatorState.value.detune_cents!
  );
});

// File upload handler
const handleWavFileUpload = async (event: Event) => {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length) return;
  const file = input.files[0];
  if (!file) {
    console.error('No file selected');
    return;
  }
  try {
    const arrayBuffer = await file.arrayBuffer();
    const wavBytes = new Uint8Array(arrayBuffer);
    console.log('WAV file loaded, size:', wavBytes.length);

    if (store.currentInstrument) {
      store.currentInstrument.importWavetableData(props.nodeId, wavBytes);
    } else {
      console.error('Instrument instance not available');
    }
  } catch (err) {
    console.error('Error reading WAV file:', err);
    alert(err);
  }
};

// Wavetable editor callback
const handleWavetableUpdate = (newWavetable: Uint8Array) => {
  console.log('### got wavetable:', newWavetable);
  store.currentInstrument?.importWavetableData(props.nodeId, newWavetable);
};

// Various knob and toggle handlers
const handleWaveformIndexChange = (newValue: number) => {
  const currentState = {
    ...oscillatorState.value,
    wave_index: newValue,
  };
  store.wavetableOscillatorStates.set(props.nodeId, currentState);
};

const handleUnisonVoicesChange = (newValue: number) => {
  const currentState = {
    ...oscillatorState.value,
    unison_voices: newValue,
  };
  store.wavetableOscillatorStates.set(props.nodeId, currentState);
};

const handleUnisonSpreadChange = (newValue: number) => {
  const currentState = {
    ...oscillatorState.value,
    spread: newValue,
  };
  store.wavetableOscillatorStates.set(props.nodeId, currentState);
};

const handleHardSyncChange = (newValue: boolean) => {
  const currentState = {
    ...oscillatorState.value,
    hardsync: newValue,
  };
  store.wavetableOscillatorStates.set(props.nodeId, currentState);
};

const handleModIndexChange = (newValue: number) => {
  const currentState = {
    ...oscillatorState.value,
    phase_mod_amount: newValue,
  };
  store.wavetableOscillatorStates.set(props.nodeId, currentState);
};

const handleFeedbackChange = (newValue: number) => {
  const currentState = {
    ...oscillatorState.value,
    feedback_amount: newValue,
  };
  store.wavetableOscillatorStates.set(props.nodeId, currentState);
};

const handleActiveChange = (newValue: boolean) => {
  const currentState = {
    ...oscillatorState.value,
    active: newValue,
  };
  store.wavetableOscillatorStates.set(props.nodeId, currentState);
};

const handleGainChange = (newValue: number) => {
  const currentState = {
    ...oscillatorState.value,
    gain: newValue,
  };
  store.wavetableOscillatorStates.set(props.nodeId, currentState);
};

const handleDetuneChange = () => {
  const currentState = {
    ...oscillatorState.value,
    detune: totalDetune.value,
  };
  store.wavetableOscillatorStates.set(props.nodeId, currentState);
};

// Watch for changes and notify the instrument
watch(
  () => ({ ...wavetableOscillatorStates.value.get(props.nodeId) }),
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      if (newState.id === props.nodeId) {
        store.currentInstrument?.updateWavetableOscillatorState(
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
  margin: 0 auto;
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
