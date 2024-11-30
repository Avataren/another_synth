<template>
  <q-card class="oscillator-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Oscillator {{ oscIndex + 1 }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="oscillator-container">
      <div class="knob-group">
        <audio-knob-component
          v-model="gain"
          label="Gain"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="2"
          @update:modelValue="handleGainChange"
        />

        <audio-knob-component
          v-model="detune_oct"
          label="Octave"
          :min="-5"
          :max="5"
          :step="1"
          :decimals="0"
          @update:modelValue="handleDetuneChange"
        />

        <audio-knob-component
          v-model="detune_semi"
          label="Semitones"
          :min="-12"
          :max="12"
          :step="1"
          :decimals="0"
          @update:modelValue="handleDetuneChange"
        />

        <audio-knob-component
          v-model="detune_cents"
          label="Cents"
          :min="-100"
          :max="100"
          :step="1"
          :decimals="0"
          @update:modelValue="handleDetuneChange"
        />
      </div>

      <div class="canvas-wrapper">
        <canvas></canvas>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, watch, ref } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';

interface Props {
  node: AudioNode | null;
  oscIndex: number;
}

const props = withDefaults(defineProps<Props>(), { node: null, oscIndex: 0 });
const node = computed(() => props.node);

const gain = ref(1.0);
const detune_oct = ref(0.0);
const detune_semi = ref(0.0);
const detune_cents = ref(0.0);

onMounted(() => {
  if (props.node) {
    // Your initialization logic here
  }
});

watch(node, (newNode, _oldNode) => {
  if (newNode) {
    // Your node watch logic here
  }
});

const totalDetune = computed(() => {
  return (
    detune_oct.value * 1200 + // 1 octave = 1200 cents
    detune_semi.value * 100 + // 1 semitone = 100 cents
    detune_cents.value
  );
});

// Handle gain changes
const handleGainChange = (newValue: number) => {
  if (node.value instanceof GainNode) {
    node.value.gain.setValueAtTime(newValue, node.value.context.currentTime);
  }
};

// Handle any detune changes
const handleDetuneChange = () => {
  if (node.value instanceof OscillatorNode) {
    node.value.detune.setValueAtTime(
      totalDetune.value,
      node.value.context.currentTime,
    );
  }
};
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
