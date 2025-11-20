<!-- <template>
  <q-card class="filter-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Resonator bank {{ Index + 1 }}</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="filter-container">
      <div class="knob-group">
        <q-toggle
          v-model="filterState.is_enabled"
          label="Enabled"
          @update:modelValue="handleEnabledChange"
        />
      </div>
      <div class="knob-group">
        <audio-knob-component
          v-model="filterState.cut"
          label="Cut"
          :min="20"
          :max="20000"
          :step="10"
          :decimals="0"
          @update:modelValue="handleCutoffChange"
        />

        <audio-knob-component
          v-model="filterState.resonance"
          label="Resonance"
          :min="0"
          :max="1"
          :step="0.001"
          :decimals="3"
          @update:modelValue="handleResonanceChange"
        />
      </div>

      <div class="canvas-wrapper">
        <canvas ref="frequencyCanvas" width="565" height="120"></canvas>
      </div>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import AudioKnobComponent from './AudioKnobComponent.vue';
import { useInstrumentStore } from 'src/stores/instrument-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import { storeToRefs } from 'pinia';
import FFT from 'fft.js';
// import VariableCombFilter from 'src/audio/dsp/variable-comb-filter';
import { type FilterState } from 'src/audio/dsp/filter-state';
import FlangerCombFilter from 'src/audio/dsp/flanger-comb-filter';
interface Props {
  node: AudioNode | null;
  Index: number;
}

const props = withDefaults(defineProps<Props>(), { node: null, Index: 0 });
const frequencyCanvas = ref<HTMLCanvasElement | null>(null);

const instrumentStore = useInstrumentStore();
const nodeStateStore = useNodeStateStore();
const { filterStates } = storeToRefs(nodeStateStore);
const { audioSystem } = storeToRefs(instrumentStore);
// Create a reactive reference to the oscillator state
const filterState = computed({
  get: () => {
    const state = filterStates.value.get(props.Index);
    if (!state) {
      console.warn(`No state found for oscillator ${props.Index}`);
      return {
        id: props.Index,
        cut: 1000,
        resonance: 0.5,
        is_enabled: false,
      };
    }
    return state;
  },
  set: (newState: FilterState) => {
    nodeStateStore.filterStates.set(props.Index, { ...newState });
  },
});

const handleResonanceChange = (val: number) => {
  const currentState = {
    ...filterState.value,
    resonance: val,
  };
  nodeStateStore.filterStates.set(props.Index, currentState);
};

const handleEnabledChange = (val: boolean) => {
  const currentState = {
    ...filterState.value,
    is_enabled: val,
  };
  nodeStateStore.filterStates.set(props.Index, currentState);
};

const handleCutoffChange = (val: number) => {
  const currentState = {
    ...filterState.value,
    cut: val,
  };
  nodeStateStore.filterStates.set(props.Index, currentState);
};

onMounted(() => {
  computeFrequencyResponse();
});

watch(
  () => ({ ...filterStates.value.get(props.Index) }), // Create new reference
  (newState, oldState) => {
    if (!oldState || JSON.stringify(newState) !== JSON.stringify(oldState)) {
      ('');
      if (newState.id === props.Index) {
        instrumentStore.currentInstrument?.updateFilterState(
          props.Index,
          newState as FilterState,
        );
        computeFrequencyResponse();
      }
    }
  },
  { deep: true, immediate: true },
);

function computeFrequencyResponse() {
  if (!audioSystem.value) {
    return;
  }
  const N = 8192;
  const sampleRate = 44100;

  const fft = new FFT(N);
  const impulse = new Float32Array(N);
  const response = new Float32Array(N);

  // Generate impulse for comb filter analysis
  impulse[0] = 1;

  // Process through filter
  const filter = new FlangerCombFilter(sampleRate);
  filter.updateState({ ...filterState.value, is_enabled: true });
  filter.clear();
  filter.setFrequency(440);

  // Generate response
  for (let i = 0; i < N; i++) {
    response[i] = filter.process(impulse[i] || 0);
  }

  // Apply Blackman-Harris window
  const window = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a0 = 0.35875;
    const a1 = 0.48829;
    const a2 = 0.14128;
    const a3 = 0.01168;
    window[i] =
      a0 -
      a1 * Math.cos((2 * Math.PI * i) / (N - 1)) +
      a2 * Math.cos((4 * Math.PI * i) / (N - 1)) -
      a3 * Math.cos((6 * Math.PI * i) / (N - 1));
    response[i]! *= window[i]!;
  }

  // Perform FFT
  const freqDomain = fft.createComplexArray();
  fft.realTransform(freqDomain, response);

  // Calculate magnitude response with fixed reference level
  const magnitudes = new Array(N / 2);
  const referenceLevel = 1.0; // Fixed reference instead of dynamic maxMagnitude

  for (let i = 0; i < N / 2; i++) {
    const real = freqDomain[2 * i]!;
    const imag = freqDomain[2 * i + 1]!;
    const magnitude = Math.sqrt(real * real + imag * imag);
    magnitudes[i] = magnitude;
  }

  // Convert to dB with fixed reference
  const magnitudesInDb = new Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    const magnitude = magnitudes[i]!;
    const db = 20 * Math.log10(magnitude / referenceLevel);
    magnitudesInDb[i] = isFinite(db) ? Math.max(db, -120) : -120; // Clamp at -120dB
  }

  // Frequency-dependent smoothing
  const smoothedMagnitudes = new Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    const freq = (i * sampleRate) / (2 * N);
    // Wider smoothing window at higher frequencies
    const octaves = Math.log2(freq / 20);
    const smoothingWidth = Math.max(2, Math.min(12, Math.floor(octaves)));

    let sum = 0;
    let weightSum = 0;

    for (let j = -smoothingWidth; j <= smoothingWidth; j++) {
      if (i + j >= 0 && i + j < N / 2) {
        // Gaussian weighting
        const weight = Math.exp(
          -(j * j) / (2 * smoothingWidth * smoothingWidth),
        );
        sum += magnitudesInDb[i + j]! * weight;
        weightSum += weight;
      }
    }
    smoothedMagnitudes[i] = sum / weightSum;
  }

  const minDb = -120; // Fixed minimum dB instead of dynamic calculation
  plotFrequencyResponse(smoothedMagnitudes, sampleRate, minDb);
}

function plotFrequencyResponse(
  magnitudesInDb: number[],
  sampleRate: number,
  minDb: number,
) {
  const canvas = frequencyCanvas.value;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;

  // Clear with darker background
  ctx.fillStyle = 'rgb(32, 45, 66)';
  ctx.fillRect(0, 0, width, height);

  // Adjust the dB range
  const maxDisplayDb = 0; // Upper limit at 0 dB
  const minDisplayDb = Math.min(-120, minDb); // Lower limit extended to cover full range

  // Draw frequency grid
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 1;

  // Octave markers
  const frequencies = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  frequencies.forEach((freq) => {
    const x =
      (width * (Math.log2(freq) - Math.log2(20))) /
      (Math.log2(20000) - Math.log2(20));
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();

    // Optional: Add frequency labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = '10px Arial';
    ctx.fillText(`${freq} Hz`, x + 2, height - 5);
  });

  // dB markers every 10 dB
  for (let db = Math.ceil(minDisplayDb / 10) * 10; db <= 0; db += 10) {
    const y =
      height * (1 - (db - minDisplayDb) / (maxDisplayDb - minDisplayDb));
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();

    // Add dB labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = '10px Arial';
    ctx.fillText(`${db} dB`, 5, y - 2);
  }

  // Draw the frequency response with gradient
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#4CAF50'); // Green at the top
  gradient.addColorStop(1, '#1B5E20'); // Darker green at the bottom

  ctx.beginPath();
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 2;

  for (let i = 0; i < magnitudesInDb.length; i++) {
    const freq = (i * sampleRate) / (2 * magnitudesInDb.length);
    if (freq < 20 || freq > 20000) continue;

    const x =
      (width * (Math.log2(freq) - Math.log2(20))) /
      (Math.log2(20000) - Math.log2(20));

    const db = magnitudesInDb[i]!;
    const clampedDb = Math.max(minDisplayDb, Math.min(maxDisplayDb, db));
    const y =
      height * (1 - (clampedDb - minDisplayDb) / (maxDisplayDb - minDisplayDb));

    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
</script>

<style scoped>
.filter-card {
  width: 600px;
  margin: 0 auto;
}

.filter-container {
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
  border: 1px solid #ccc;
  background-color: rgb(200, 200, 200);
  border-radius: 4px;
}
</style> -->
