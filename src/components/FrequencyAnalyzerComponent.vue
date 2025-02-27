<template>
  <q-card class="frequency-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Frequency Analyzer</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="frequency-container">
      <canvas ref="canvasRef"></canvas>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch, onUnmounted } from 'vue';

interface Props {
  node: AudioNode | null;
}

const props = withDefaults(defineProps<Props>(), { node: null });
const node = computed(() => props.node);
const canvasRef = ref<HTMLCanvasElement | null>(null);
let analyser: AnalyserNode | null = null;
let animationFrameId: number | null = null;
let dataArray: Uint8Array | null = null;

const attachAnalyzer = (audioNode: AudioNode) => {
  if (!analyser) {
    const audioContext = audioNode.context;
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024; // Smaller FFT size for frequency data
    analyser.smoothingTimeConstant = 0.8; // Smooth transitions
    dataArray = new Uint8Array(analyser.frequencyBinCount);
  }

  audioNode.connect(analyser);

  if (audioNode.numberOfOutputs > 0) {
    //analyser.connect(audioNode.context.destination);
  }

  startVisualization();
};

const startVisualization = () => {
  if (!canvasRef.value || !analyser || !dataArray) return;

  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Set canvas size to match display size
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const bufferLength = analyser.frequencyBinCount;
  const localDataArray = dataArray;

  const draw = () => {
    if (!ctx || !analyser || !localDataArray) return;

    animationFrameId = requestAnimationFrame(draw);

    analyser.getByteFrequencyData(localDataArray);

    ctx.fillStyle = 'rgb(32, 45, 66)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 2.5;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      // @ts-expect-error: We've already checked that dataArray exists
      const barHeight = (localDataArray[i] / 255) * canvas.height;

      // Create gradient for bars
      const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
      gradient.addColorStop(0, 'rgb(160, 190, 225)');
      gradient.addColorStop(1, 'rgb(100, 140, 200)');

      ctx.fillStyle = gradient;
      ctx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);

      x += barWidth;
    }

    // Draw frequency grid lines
    ctx.strokeStyle = 'rgba(160, 190, 225, 0.1)';
    ctx.lineWidth = 1;

    // Horizontal lines
    for (let i = 0; i < canvas.height; i += canvas.height / 8) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(canvas.width, i);
      ctx.stroke();
    }

    // Vertical lines
    for (let i = 0; i < canvas.width; i += canvas.width / 16) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, canvas.height);
      ctx.stroke();
    }
  };

  draw();
};

const cleanup = () => {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  if (analyser) {
    analyser.disconnect();
    analyser = null;
  }

  dataArray = null;
};

onMounted(() => {
  if (props.node) {
    attachAnalyzer(props.node);
  }
});

onUnmounted(() => {
  cleanup();
});

watch(node, (newNode, _oldNode) => {
  cleanup();
  if (newNode) {
    attachAnalyzer(newNode);
  }
});
</script>

<style scoped>
.frequency-container {
  width: 600px;
  height: 200px;
  margin: 0 auto;
  canvas {
    width: 100%;
    height: 100%;
    border: none;
  }
}

.frequency-card {
  width: 600px;
  margin: 0 auto;
}
</style>
