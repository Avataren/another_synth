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
  isTrackActive: boolean;
}

const props = defineProps<Props>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
let analyser: AnalyserNode | null = null;
let dataArray: Uint8Array | null = null;
let unregisterAnimation: (() => void) | null = null;
let currentConnectedNode: AudioNode | null = null;

// Cached canvas dimensions - only update on resize
let canvasWidth = 0;
let canvasHeight = 0;

// Cached theme colors - updated only when theme changes
let cachedWaveformColor = 'rgb(77, 242, 197)';
let cachedBgColor = '#0b111a';
let themeObserver: MutationObserver | null = null;

function updateCachedColors() {
  const style = getComputedStyle(document.documentElement);
  cachedWaveformColor = style.getPropertyValue('--tracker-accent-primary').trim() || 'rgb(77, 242, 197)';
  cachedBgColor = style.getPropertyValue('--app-background').trim() || '#0b111a';
}

function setupThemeObserver() {
  if (themeObserver) return;

  themeObserver = new MutationObserver(() => {
    updateCachedColors();
  });

  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class']
  });
}

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

function disconnectCurrentNode() {
  if (currentConnectedNode && analyser) {
    try {
      currentConnectedNode.disconnect(analyser);
    } catch {
      // Node may have already been disconnected
    }
    currentConnectedNode = null;
  }
}

function setupAnalyser() {
  if (!props.audioContext) return;

  // Create analyser if we don't have one yet
  if (!analyser) {
    analyser = props.audioContext.createAnalyser();
    analyser.fftSize = 256;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
  }

  // Disconnect if track is not active or node changed
  if (currentConnectedNode && (!props.isTrackActive || currentConnectedNode !== props.audioNode)) {
    disconnectCurrentNode();
  }

  // Only connect if track is active and we have a node
  if (props.isTrackActive && props.audioNode && props.audioNode !== currentConnectedNode) {
    props.audioNode.connect(analyser);
    currentConnectedNode = props.audioNode;
  }

  // Start visualization if not already running
  if (!unregisterAnimation) {
    startVisualization();
  }
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

    // Clear and draw background
    ctx.fillStyle = cachedBgColor;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Draw center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, canvasHeight / 2);
    ctx.lineTo(canvasWidth, canvasHeight / 2);
    ctx.stroke();

    // Draw waveform
    ctx.strokeStyle = cachedWaveformColor;
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

  disconnectCurrentNode();

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
  updateCachedColors();
  setupThemeObserver();
  if (props.audioContext) {
    setupAnalyser();
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  if (themeObserver) {
    themeObserver.disconnect();
    themeObserver = null;
  }
  cleanup();
});

watch(
  () => props.audioNode,
  () => setupAnalyser()
);

watch(
  () => props.isTrackActive,
  () => setupAnalyser()
);
</script>

<style scoped>
.track-waveform {
  width: 100%;
  height: 56px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
  background: var(--app-background, #0b111a);
}

canvas {
  width: 100%;
  height: 100%;
  display: block;
}
</style>
