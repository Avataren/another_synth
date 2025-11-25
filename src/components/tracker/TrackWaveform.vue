<template>
  <div class="track-waveform">
    <canvas ref="canvasRef"></canvas>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { registerAnimationCallback } from 'src/composables/useAnimationLoop';

interface Props {
  audioNode: AudioNode | null;
  audioContext: AudioContext | null;
}

const WAVEFORM_COLOR = '#4df2c5';
const props = defineProps<Props>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
let analyser: AnalyserNode | null = null;
let dataArray: Uint8Array | null = null;
let unregisterAnimation: (() => void) | null = null;

// Cached canvas dimensions - only update on resize
let canvasWidth = 0;
let canvasHeight = 0;

function updateCanvasSize() {
  const canvas = canvasRef.value;
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width !== canvasWidth || rect.height !== canvasHeight) {
    canvasWidth = rect.width;
    canvasHeight = rect.height;
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
  }
}

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

  // Initial size measurement
  updateCanvasSize();

  // Store references for the draw callback
  const localAnalyser = analyser;
  const localDataArray = dataArray;

  const draw = () => {
    if (!localAnalyser || !localDataArray || !ctx || canvasWidth === 0) return;

    localAnalyser.getByteTimeDomainData(localDataArray);

    // Clear with transparent background
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    // Draw background
    ctx.fillStyle = 'rgba(12, 16, 24, 0.6)';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Draw center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, canvasHeight / 2);
    ctx.lineTo(canvasWidth, canvasHeight / 2);
    ctx.stroke();

    // Draw waveform
    ctx.strokeStyle = WAVEFORM_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const sliceWidth = canvasWidth / localDataArray.length;
    let x = 0;

    for (let i = 0; i < localDataArray.length; i++) {
      const sample = localDataArray[i] ?? 128;
      const v = sample / 128.0;
      const y = (v * canvasHeight) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    ctx.stroke();
  };

  // Register with shared animation loop
  unregisterAnimation = registerAnimationCallback(draw);
}

function cleanup() {
  if (unregisterAnimation) {
    unregisterAnimation();
    unregisterAnimation = null;
  }

  if (analyser) {
    analyser.disconnect();
    analyser = null;
  }

  dataArray = null;
  canvasWidth = 0;
  canvasHeight = 0;
}

function handleResize() {
  updateCanvasSize();
}

onMounted(() => {
  window.addEventListener('resize', handleResize);
  if (props.audioNode && props.audioContext) {
    setupAnalyser();
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
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
