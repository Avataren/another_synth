<template>
  <q-page class="page-container">
    <!-- Middle Scrollable Area: All DSP Nodes using CSS Grid -->
    <div class="middle-scroll q-pa-md">
      <div class="grid-container">
        <!-- Generators Column -->
        <div class="node-bg column">
          <div class="header">Generators</div>
          <generic-tab-container
            v-if="wavetableOscillatorNodes.length"
            :nodes="wavetableOscillatorNodes"
            :destinationNode="destinationNode"
            :componentName="WavetableOscillatorComponent"
            nodeLabel="Wavetable Osc"
            :key="`wavetable-container-${wavetableOscillatorNodes.length}`"
          />
          <generic-tab-container
            v-if="oscillatorNodes.length"
            :nodes="oscillatorNodes"
            :destinationNode="destinationNode"
            :componentName="OscillatorComponent"
            nodeLabel="Oscillator"
          />
          <generic-tab-container
            v-if="noiseNodes.length"
            :nodes="noiseNodes"
            :destinationNode="destinationNode"
            :componentName="NoiseComponent"
            nodeLabel="Noise"
          />
          <generic-tab-container
            v-if="arpeggiatorNodes.length"
            :nodes="arpeggiatorNodes"
            :destinationNode="destinationNode"
            :componentName="ArpeggiatorComponent"
            nodeLabel="Arpeggiator"
          />
          <generic-tab-container
            v-if="velocityNodes.length"
            :nodes="velocityNodes"
            :destinationNode="destinationNode"
            :componentName="VelocityComponent"
            nodeLabel="Velocity"
          />
        </div>

        <!-- Modulators Column -->
        <div class="node-bg column">
          <div class="header">Modulators</div>
          <generic-tab-container
            v-if="lfoNodes.length"
            :nodes="lfoNodes"
            :destinationNode="destinationNode"
            :componentName="LfoComponent"
            nodeLabel="LFO"
          />
          <generic-tab-container
            v-if="envelopeNodes.length"
            :nodes="envelopeNodes"
            :destinationNode="destinationNode"
            :componentName="EnvelopeComponent"
            nodeLabel="Envelope"
          />
        </div>

        <!-- Effects Column -->
        <div class="node-bg column">
          <div class="header">Filters</div>
          <generic-tab-container
            v-if="filterNodes.length"
            :nodes="filterNodes"
            :destinationNode="destinationNode"
            :componentName="FilterComponent"
            nodeLabel="Filter"
          />
          <div class="header" style="margin-top: 4rem">Effects</div>
          <generic-tab-container
            v-if="delayNodes.length"
            :nodes="delayNodes"
            :destinationNode="destinationNode"
            :componentName="DelayComponent"
            nodeLabel="Delay"
          />
          <generic-tab-container
            v-if="convolverNodes.length"
            :nodes="convolverNodes"
            :destinationNode="destinationNode"
            :componentName="ConvolverComponent"
            nodeLabel="Convolver"
          />
        </div>
      </div>
    </div>

    <!-- Bottom Fixed Row: Four columns -->
    <div class="bottom-row q-pa-md">
      <div class="row q-col-gutter-md">
        <div class="col-12 col-sm-6 col-lg-4">
          <oscilloscope-component :node="destinationNode" />
        </div>
        <div class="col-12 col-sm-6 col-lg-4">
          <piano-keyboard-component />
        </div>
        <div class="col-12 col-sm-6 col-lg-4">
          <frequency-analyzer-component :node="destinationNode" />
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useAudioSystemStore } from 'src/stores/audio-system-store';

// Components moved from the top row (now in the bottom row)
import OscilloscopeComponent from 'src/components/OscilloscopeComponent.vue';
import VelocityComponent from 'src/components/VelocityComponent.vue';
import FrequencyAnalyzerComponent from 'src/components/FrequencyAnalyzerComponent.vue';

// Bottom row component: Piano Keyboard
import PianoKeyboardComponent from 'src/components/PianoKeyboardComponent.vue';

// Generators DSP components
import OscillatorComponent from 'src/components/OscillatorComponent.vue';
import WavetableOscillatorComponent from 'src/components/WavetableOscillatorComponent.vue';
import NoiseComponent from 'src/components/NoiseComponent.vue';
import ArpeggiatorComponent from 'src/components/ArpeggiatorComponent.vue';

// Modulators DSP components
import LfoComponent from 'src/components/LfoComponent.vue';
import EnvelopeComponent from 'src/components/EnvelopeComponent.vue';

// Filters DSP components
import FilterComponent from 'src/components/FilterComponent.vue';
import DelayComponent from 'src/components/DelayComponent.vue';
import ConvolverComponent from 'src/components/ConvolverComponent.vue';

// Generic Tab Container
import GenericTabContainer from 'src/components/GenericTabContainer.vue';

// Node type definitions
import { VoiceNodeType } from 'src/audio/types/synth-layout';

const store = useAudioSystemStore();
const { destinationNode } = storeToRefs(store);

// Velocity (only one instance)
const velocityNodes = computed(() =>
  store.getVoiceNodes(0, VoiceNodeType.GlobalVelocity),
);

// Generators DSP nodes
const oscillatorNodes = computed(() =>
  store.getVoiceNodes(0, VoiceNodeType.Oscillator),
);
const wavetableOscillatorNodes = computed(() =>
  store.getVoiceNodes(0, VoiceNodeType.WavetableOscillator),
);
const noiseNodes = computed(() => store.getVoiceNodes(0, VoiceNodeType.Noise));
const arpeggiatorNodes = computed(() =>
  store.getVoiceNodes(0, VoiceNodeType.ArpeggiatorGenerator),
);

// Modulators DSP nodes
const lfoNodes = computed(() => store.getVoiceNodes(0, VoiceNodeType.LFO));
const envelopeNodes = computed(() =>
  store.getVoiceNodes(0, VoiceNodeType.Envelope),
);

// Filters DSP nodes
const filterNodes = computed(() =>
  store.getVoiceNodes(0, VoiceNodeType.Filter),
);
const delayNodes = computed(() => store.getVoiceNodes(0, VoiceNodeType.Delay));
const convolverNodes = computed(() =>
  store.getVoiceNodes(0, VoiceNodeType.Convolver),
);
</script>

<style scoped>
/* Full viewport container */
.page-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

/* Fixed height for bottom row with scrolling overflow */
.bottom-row {
  flex: 0 0 260px; /* Prevents flex shrink/grow and sets a fixed basis */
  overflow-y: auto;
  box-sizing: border-box;
  padding: 0.2rem 0 0 0;
  margin: 0;
  background-color: #1d2023;
  border-top: 1px solid #444;
}

/* Middle area scrollable */
.middle-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  background-image: linear-gradient(rgb(49, 69, 105), rgb(25, 38, 56));
}

/* Header styling for DSP columns */
.header {
  text-align: center;
  font-weight: bold;
  margin-bottom: 1rem;
}

/* CSS Grid container for the DSP columns */
.grid-container {
  display: grid;
  gap: 1rem;
  /* Each column will be at least 600px wide */
  grid-template-columns: repeat(auto-fit, minmax(600px, 1fr));
}

/* Force columns to stack when viewport is below 900px */
@media (max-width: 900px) {
  .grid-container {
    grid-template-columns: 1fr;
  }
}

/* Each node container gets a fixed min-width to prevent overlap */
.node-bg {
  min-width: 300px;
  padding: 0.5rem;
  box-sizing: border-box;
  width: 100%;
}

/* Allow multiple DSP components per column */
.column {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

/* Fix each generic-tab-container's width to 600px */
.generic-tab-container {
  flex: 0 0 auto;
  width: 600px;
}
</style>
