<template>
  <q-page class="row items-center justify-evenly">
    <oscilloscope-component :node="destinationNode" />
    <frequency-analyzer-component :node="destinationNode" />
  </q-page>
</template>

<script setup lang="ts">
import OscilloscopeComponent from 'src/components/OscilloscopeComponent.vue';
import FrequencyAnalyzerComponent from 'src/components/FrequencyAnalyzerComponent.vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
const { destinationNode } = useAudioSystemStore();
</script>
