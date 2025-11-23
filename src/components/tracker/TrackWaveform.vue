<template>
  <div class="track-waveform">
    <canvas ref="canvasRef"></canvas>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';

interface Props {
  audioNode: AudioNode | null;
  audioContext: AudioContext | null;
}

const WAVEFORM_COLOR = '#4df2c5';
const props = defineProps<Props>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
let analyser: AnalyserNode | null = null;
let dataArray: Uint8Array | null = null;
let animationFrameId: number | null = null;

function setupAnalyser() {
  cleanup();

  if (!props.audioNode || !props.audioContext) return;

  analyser = props.audioContext.createAnalyser();
  analyser.fftSize = 256;
  dataArray = new Uint8Array(analyser.frequencyBinCount);

  props.audioNode.connect(analyser);
  startVisualization();
}

function startVisualization() {
  if (!canvasRef.value || !analyser || !dataArray) return;

  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const draw = () => {
    if (!analyser || !dataArray || !ctx) return;

    animationFrameId = requestAnimationFrame(draw);

    // Ensure canvas resolution matches display size
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      canvas.width = rect.width;
      canvas.height = rect.height;
    }

    analyser.getByteTimeDomainData(dataArray);

    // Clear with transparent background
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw background
    ctx.fillStyle = 'rgba(12, 16, 24, 0.6)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();

    // Draw waveform
    ctx.strokeStyle = WAVEFORM_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const sliceWidth = canvas.width / dataArray.length;
    let x = 0;

    for (let i = 0; i < dataArray.length; i++) {
      const sample = dataArray[i] ?? 128;
      const v = sample / 128.0;
      const y = (v * canvas.height) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    ctx.stroke();
  };

  draw();
}

function cleanup() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  if (analyser) {
    analyser.disconnect();
    analyser = null;
  }

  dataArray = null;
}

onMounted(() => {
  if (props.audioNode && props.audioContext) {
    setupAnalyser();
  }
});

onUnmounted(() => {
  cleanup();
});

watch(
  () => props.audioNode,
  () => setupAnalyser()
);
</script>

<style scoped>
.track-waveform {
  width: 100%;
  height: 56px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(12, 16, 24, 0.6);
}

canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
