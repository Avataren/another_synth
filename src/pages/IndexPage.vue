<template>
  <q-page class="row items-center justify-evenly">
    <oscilloscope-component :node="destinationNode" />
    <frequency-analyzer-component :node="destinationNode" />
    <piano-keyboard-component />

    <oscillator-component
      v-for="osc in oscillatorNodes"
      :key="osc.id"
      :node="destinationNode"
      :nodeId="osc.id"
    />
    <lfo-component
      v-for="lfo in lfoNodes"
      :key="lfo.id"
      :node="destinationNode"
      :nodeId="lfo.id"
    />

    <noise-component
      v-for="noise in noiseNodes"
      :key="noise.id"
      :node="destinationNode"
      :noiseId="noise.id"
    />

    <envelope-component
      v-for="env in envelopeNodes"
      :key="env.id"
      :node="destinationNode"
      :nodeId="env.id"
    />

    <filter-component
      v-for="filter in filterNodes"
      :key="filter.id"
      :node="destinationNode"
      :nodeId="filter.id"
    />
  </q-page>
</template>

<script setup lang="ts">
import OscilloscopeComponent from 'src/components/OscilloscopeComponent.vue';
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
