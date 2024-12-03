<template>
  <q-page class="row items-center justify-evenly">
    <oscilloscope-component :node="destinationNode" />
    <frequency-analyzer-component :node="destinationNode" />
    <piano-keyboard-component />
    <oscillator-component :node="destinationNode" :oscIndex="0" />
    <oscillator-component :node="destinationNode" :oscIndex="1" />
    <noise-component :node="destinationNode" :Index="0" />
    <envelope-component :node="destinationNode" :envIndex="0" />
    <envelope-component :node="destinationNode" :envIndex="1" />
    <filter-component :node="destinationNode" :Index="0" />
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
import { storeToRefs } from 'pinia';

const store = useAudioSystemStore();
const { destinationNode } = storeToRefs(store);
</script>
