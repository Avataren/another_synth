<template>
  <q-card class="oscillator-card">
    <q-card-section class="bg-primary text-white">
      <div class="text-h6">Oscilloscope</div>
    </q-card-section>
    <q-separator />
    <q-card-section class="oscilloscope-container">
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

const attachOscilloscope = (audioNode: AudioNode) => {
  if (!analyser) {
    const audioContext = audioNode.context;
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
  }

  audioNode.connect(analyser);

  if (audioNode.numberOfOutputs > 0) {
    analyser.connect(audioNode.context.destination);
  }

  startVisualization();
};

const startVisualization = () => {
  if (!canvasRef.value || !analyser || !dataArray) return;

  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const bufferLength = analyser.frequencyBinCount;
  // Create a local reference that TypeScript can track
  const localDataArray = dataArray;

  const draw = () => {
    if (!ctx || !analyser || !localDataArray) return;

    animationFrameId = requestAnimationFrame(draw);

    analyser.getByteTimeDomainData(localDataArray);

    ctx.fillStyle = 'rgb(32, 45, 66)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgb(160, 190, 225)';
    ctx.beginPath();

    const sliceWidth = (canvas.width * 1.0) / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      // Using the local reference that TypeScript can verify is not null
      // @ts-expect-error: We've already checked that dataArray exists
      const v = localDataArray[i] / 128.0;
      const y = (v * canvas.height) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
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
    attachOscilloscope(props.node);
  }
});

onUnmounted(() => {
  cleanup();
});

watch(node, (newNode, _oldNode) => {
  cleanup();
  if (newNode) {
    attachOscilloscope(newNode);
  }
});
</script>

<style scoped>
.oscilloscope-container {
  width: 600px;
  height: 200px;
  margin: 0 auto;
  canvas {
    width: 100%;
    height: 100%;
    border: none;
  }
}
.oscillator-card {
  width: 600px;
  margin: 0 auto;
}

canvas {
  border: 1px solid #ccc;
  background-color: rgb(200, 200, 200);
}
</style>
