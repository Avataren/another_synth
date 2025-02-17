<template>
  <q-page class="column">
    <!-- Top row with analyzers -->
    <div class="row q-col-gutter-md q-mb-md">
      <div class="col-6">
        <oscilloscope-component :node="destinationNode" />
      </div>
      <div class="col-6">
        <frequency-analyzer-component :node="destinationNode" />
      </div>
    </div>

    <!-- Main three columns -->
    <div class="row q-col-gutter-md flex-grow">
      <!-- Generators column -->
      <div class="col-4 column q-gutter-y-md node-bg">
        <div class="text-h6">Generators</div>

        <wavetable-oscillator-component
          v-for="osc in wavetableOscillatorNodes"
          :key="osc.id"
          :node="destinationNode"
          :nodeId="osc.id"
        />

        <oscillator-component
          v-for="osc in oscillatorNodes"
          :key="osc.id"
          :node="destinationNode"
          :nodeId="osc.id"
        />
        <noise-component
          v-for="noise in noiseNodes"
          :key="noise.id"
          :node="destinationNode"
          :noiseId="noise.id"
        />
      </div>

      <!-- Modulators column -->
      <div class="col-4 column q-gutter-y-md node-bg">
        <div class="text-h6">Modulators</div>
        <lfo-component
          v-for="lfo in lfoNodes"
          :key="lfo.id"
          :node="destinationNode"
          :nodeId="lfo.id"
        />
        <envelope-component
          v-for="env in envelopeNodes"
          :key="env.id"
          :node="destinationNode"
          :nodeId="env.id"
        />
      </div>

      <!-- Filters column -->
      <div class="col-4 column q-gutter-y-md node-bg">
        <div class="text-h6">Filters</div>
        <filter-component
          v-for="filter in filterNodes"
          :key="filter.id"
          :node="destinationNode"
          :nodeId="filter.id"
        />
      </div>
    </div>

    <!-- Bottom keyboard -->
    <div class="row q-mt-md">
      <div class="col">
        <piano-keyboard-component />
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import OscilloscopeComponent from 'src/components/OscilloscopeComponent.vue';
import WavetableOscillatorComponent from 'src/components/WavetableOscillatorComponent.vue';
import FrequencyAnalyzerComponent from 'src/components/FrequencyAnalyzerComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import PianoKeyboardComponent from 'src/components/PianoKeyboardComponent.vue';
import OscillatorComponent from 'src/components/OscillatorComponent.vue';
import EnvelopeComponent from 'src/components/EnvelopeComponent.vue';
import FilterComponent from 'src/components/FilterComponent.vue';
import NoiseComponent from 'src/components/NoiseComponent.vue';
import LfoComponent from 'src/components/LfoComponent.vue';
import { storeToRefs } from 'pinia';
import { computed } from 'vue';
import { VoiceNodeType } from 'src/audio/types/synth-layout';

const store = useAudioSystemStore();
const { destinationNode } = storeToRefs(store);

// Get nodes for voice 0
const wavetableOscillatorNodes = computed(() =>
  store.getVoiceNodes(0, VoiceNodeType.WavetableOscillator),
);

const oscillatorNodes = computed(() =>
  store.getVoiceNodes(0, VoiceNodeType.Oscillator),
);
const envelopeNodes = computed(() =>
  store.getVoiceNodes(0, VoiceNodeType.Envelope),
);
const filterNodes = computed(() =>
  store.getVoiceNodes(0, VoiceNodeType.Filter),
);

const noiseNodes = computed(() => store.getVoiceNodes(0, VoiceNodeType.Noise));
const lfoNodes = computed(() => store.getVoiceNodes(0, VoiceNodeType.LFO));
//const lfoNodes = computed(() => store.getVoiceNodes(0, VoiceNodeType.LFO));

// For debugging - watch when nodes are available
// Note: Remove in production
// whenever(oscillatorNodes, (nodes) => {
//   console.log('Oscillator nodes:', nodes);
// });
</script>

<style>
.node-bg {
  /* background-color: red; */
  padding: 0.5rem;
}
.column {
  padding: 1rem;
}
</style>
