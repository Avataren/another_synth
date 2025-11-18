<template>
  <q-page class="page-container">
    <!-- Middle Scrollable Area: All DSP Nodes using CSS Grid -->
    <div class="middle-scroll q-pa-md">
      <div class="grid-container">
        <!-- Generators Column -->
        <div class="node-bg column">
          <div class="header">Generators</div>

          <!-- Wavetable Oscillator -->
          <generic-tab-container
            v-if="wavetableOscillatorNodes.length"
            :nodes="wavetableOscillatorNodes"
            :destinationNode="destinationNode"
            :componentName="WavetableOscillatorComponent"
            nodeLabel="WtOsc"
          />
          <div v-else class="empty-state">
            <q-btn
              color="primary"
              label="Add Wavetable Oscillator"
              @click="addWavetableOscillator"
              icon="add"
            />
          </div>

          <!-- Oscillator -->
          <generic-tab-container
            v-if="oscillatorNodes.length"
            :nodes="oscillatorNodes"
            :destinationNode="destinationNode"
            :componentName="OscillatorComponent"
            nodeLabel="Osc"
          />
          <div v-else class="empty-state">
            <q-btn
              color="primary"
              label="Add Oscillator"
              @click="addOscillator"
              icon="add"
            />
          </div>

          <generic-tab-container
            v-if="samplerNodes.length"
            :nodes="samplerNodes"
            :destinationNode="destinationNode"
            :componentName="SamplerComponent"
            nodeLabel="Sampler"
          />
          <div v-else class="empty-state">
            <q-btn
              color="primary"
              label="Add Sampler"
              @click="addSampler"
              icon="add"
            />
          </div>

          <!-- Noise -->
          <generic-tab-container
            v-if="noiseNodes.length"
            :nodes="noiseNodes"
            :destinationNode="destinationNode"
            :componentName="NoiseComponent"
            nodeLabel="Noise"
          />
          <div v-else class="empty-state">
            <q-btn
              color="primary"
              label="Add Noise Generator"
              @click="addNoise"
              icon="add"
            />
          </div>

          <!-- Arpeggiator -->
          <generic-tab-container
            v-if="arpeggiatorNodes.length"
            :nodes="arpeggiatorNodes"
            :destinationNode="destinationNode"
            :componentName="ArpeggiatorComponent"
            nodeLabel="Arp"
          />
          <div v-else class="empty-state">
            <q-btn
              color="primary"
              label="Add Arpeggiator"
              :disable="true"
              @click="addArpeggiator"
              icon="add"
            />
          </div>

          <!-- Velocity -->
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

          <!-- LFO -->
          <generic-tab-container
            v-if="lfoNodes.length"
            :nodes="lfoNodes"
            :destinationNode="destinationNode"
            :componentName="LfoComponent"
            nodeLabel="LFO"
          />
          <div v-else class="empty-state">
            <q-btn color="primary" label="Add LFO" @click="addLfo" icon="add" />
          </div>

          <!-- Envelope -->
          <generic-tab-container
            v-if="envelopeNodes.length"
            :nodes="envelopeNodes"
            :destinationNode="destinationNode"
            :componentName="EnvelopeComponent"
            nodeLabel="Env"
          />
          <div v-else class="empty-state">
            <q-btn
              color="primary"
              label="Add Envelope"
              @click="addEnvelope"
              icon="add"
            />
          </div>
        </div>

        <!-- Effects Column -->
        <div class="node-bg column">
          <div class="header">Filters</div>

          <!-- Filter -->
          <generic-tab-container
            v-if="filterNodes.length"
            :nodes="filterNodes"
            :destinationNode="destinationNode"
            :componentName="FilterComponent"
            nodeLabel="Filter"
          />
          <div v-else class="empty-state">
            <q-btn
              color="primary"
              label="Add Filter"
              @click="addFilter"
              icon="add"
            />
          </div>

          <div class="header" style="margin-top: 4rem">Effects</div>

          <generic-tab-container
            v-if="chorusNodes.length"
            :nodes="chorusNodes"
            :destinationNode="destinationNode"
            :componentName="ChorusComponent"
            nodeLabel="Chorus"
          />
          <div v-else class="empty-state">
            <q-btn
              color="primary"
              label="Add Chorus"
              @click="addChorus"
              icon="add"
            />
          </div>

          <!-- Delay -->
          <generic-tab-container
            v-if="delayNodes.length"
            :nodes="delayNodes"
            :destinationNode="destinationNode"
            :componentName="DelayComponent"
            nodeLabel="Delay"
          />
          <div v-else class="empty-state">
            <q-btn
              color="primary"
              label="Add Delay"
              @click="addDelay"
              icon="add"
            />
          </div>

          <generic-tab-container
            v-if="reverbNodes.length"
            :nodes="reverbNodes"
            :destinationNode="destinationNode"
            :componentName="ReverbComponent"
            nodeLabel="CReverb"
          />

          <!-- Convolver -->
          <generic-tab-container
            v-if="convolverNodes.length"
            :nodes="convolverNodes"
            :destinationNode="destinationNode"
            :componentName="ConvolverComponent"
            nodeLabel="Convolver"
          />
          <div v-else class="empty-state">
            <q-btn
              color="primary"
              label="Add Convolver"
              @click="addConvolver"
              icon="add"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Bottom Fixed Row: utility components (no presets here) -->
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
import SamplerComponent from 'src/components/SamplerComponent.vue';

// Modulators DSP components
import LfoComponent from 'src/components/LfoComponent.vue';
import EnvelopeComponent from 'src/components/EnvelopeComponent.vue';

// Filters DSP components
import FilterComponent from 'src/components/FilterComponent.vue';
import DelayComponent from 'src/components/DelayComponent.vue';
import ConvolverComponent from 'src/components/ConvolverComponent.vue';
import ReverbComponent from 'src/components/ReverbComponent.vue';
// Generic Tab Container
import GenericTabContainer from 'src/components/GenericTabContainer.vue';

// Node type definitions
import { VoiceNodeType } from 'src/audio/types/synth-layout';
import ChorusComponent from 'src/components/ChorusComponent.vue';

const store = useAudioSystemStore();
const { destinationNode } = storeToRefs(store);

// Improved computed properties with proper safeguards
// Velocity (only one instance)
const velocityNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.GlobalVelocity);
  return Array.isArray(nodes) ? nodes : [];
});

// Generators DSP nodes
const oscillatorNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.Oscillator);
  return Array.isArray(nodes) ? nodes : [];
});

const wavetableOscillatorNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.WavetableOscillator);
  return Array.isArray(nodes) ? nodes : [];
});

const samplerNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.Sampler);
  return Array.isArray(nodes) ? nodes : [];
});

const noiseNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.Noise);
  return Array.isArray(nodes) ? nodes : [];
});

const arpeggiatorNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.ArpeggiatorGenerator);
  return Array.isArray(nodes) ? nodes : [];
});

// Modulators DSP nodes
const lfoNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.LFO);
  return Array.isArray(nodes) ? nodes : [];
});

const envelopeNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.Envelope);
  return Array.isArray(nodes) ? nodes : [];
});

// Filters DSP nodes
const filterNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.Filter);
  return Array.isArray(nodes) ? nodes : [];
});

const delayNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.Delay);
  return Array.isArray(nodes) ? nodes : [];
});

const chorusNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.Chorus);
  return Array.isArray(nodes) ? nodes : [];
});

const reverbNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.Reverb);
  return Array.isArray(nodes) ? nodes : [];
});

const convolverNodes = computed(() => {
  const nodes = store.getVoiceNodes(0, VoiceNodeType.Convolver);
  return Array.isArray(nodes) ? nodes : [];
});

// Node creation functions
function addWavetableOscillator() {
  store.currentInstrument?.createNode(VoiceNodeType.WavetableOscillator);
}

function addOscillator() {
  store.currentInstrument?.createNode(VoiceNodeType.Oscillator);
}

function addNoise() {
  store.currentInstrument?.createNode(VoiceNodeType.Noise);
}

function addSampler() {
  store.currentInstrument?.createNode(VoiceNodeType.Sampler);
}

function addArpeggiator() {
  store.currentInstrument?.createNode(VoiceNodeType.ArpeggiatorGenerator);
}

function addLfo() {
  store.currentInstrument?.createNode(VoiceNodeType.LFO);
}

function addEnvelope() {
  store.currentInstrument?.createNode(VoiceNodeType.Envelope);
}

function addFilter() {
  store.currentInstrument?.createNode(VoiceNodeType.Filter);
}

function addDelay() {
  store.currentInstrument?.createNode(VoiceNodeType.Delay);
}

function addChorus() {
  store.currentInstrument?.createNode(VoiceNodeType.Chorus);
}

function addConvolver() {
  store.currentInstrument?.createNode(VoiceNodeType.Convolver);
}
</script>

<style scoped>
/* Full viewport container */
.page-container {
  display: flex;
  flex-direction: column;
  height: 96vh;
  overflow: hidden;
}

/* Fixed height for bottom row with scrolling overflow */
.bottom-row {
  flex: 0 0 220px; /* Prevents flex shrink/grow and sets a fixed basis */
  overflow-y: hidden;
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
  flex-direction: column;
  gap: 1rem;
}

/* Fix each generic-tab-container's width to 600px */
.generic-tab-container {
  flex: 0 0 auto;
  width: 600px;
}

/* Empty state styling */
.empty-state {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  margin-bottom: 1rem;
  margin: 0 auto;
  width: 600px;
}
</style>
