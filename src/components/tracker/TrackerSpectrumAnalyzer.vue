<template>
  <canvas ref="canvasRef" class="spectrum-canvas"></canvas>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { registerAnimationCallback } from 'src/composables/useAnimationLoop';

interface Props {
  node: AudioNode | null;
  isPlaying: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  node: null,
  isPlaying: false
});

const canvasRef = ref<HTMLCanvasElement | null>(null);
let analyser: AnalyserNode | null = null;
let unregisterAnimation: (() => void) | null = null;
let dataArray: Uint8Array | null = null;
let connectedNode: AudioNode | null = null;

// Smoothed values for more fluid animation
let smoothedData: Float32Array | null = null;
const smoothingFactor = 0.7;

// Peak hold values for visual effect
let peakData: Float32Array | null = null;
const peakDecay = 0.995;

// Cached canvas dimensions - only update on resize
let canvasWidth = 0;
let canvasHeight = 0;
let displayWidth = 0;
let displayHeight = 0;
let dpr = 1;

// Cached theme colors - updated only when theme changes
let cachedColors: { primary: { r: number; g: number; b: number }; secondary: { r: number; g: number; b: number } } | null = null;
let themeObserver: MutationObserver | null = null;

// Pre-calculated bar colors for each position (updated when theme changes)
let barColors: Array<{ r: number; g: number; b: number }> = [];
const MAX_BARS = 128;

function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--tracker-accent-primary').trim() || 'rgb(77, 242, 197)';
  const secondary = style.getPropertyValue('--tracker-accent-secondary').trim() || 'rgb(88, 176, 255)';

  // Parse RGB values
  const parseColor = (color: string) => {
    const match = color.match(/\d+/g);
    if (match && match.length >= 3) {
      return { r: parseInt(match[0]!), g: parseInt(match[1]!), b: parseInt(match[2]!) };
    }
    return { r: 77, g: 242, b: 197 };
  };

  return {
    primary: parseColor(accent),
    secondary: parseColor(secondary)
  };
}

function updateCachedColors() {
  cachedColors = getThemeColors();
  // Pre-calculate interpolated colors for each bar position
  barColors = [];
  for (let i = 0; i < MAX_BARS; i++) {
    const t = i / MAX_BARS;
    barColors.push({
      r: Math.round(cachedColors.primary.r * (1 - t) + cachedColors.secondary.r * t),
      g: Math.round(cachedColors.primary.g * (1 - t) + cachedColors.secondary.g * t),
      b: Math.round(cachedColors.primary.b * (1 - t) + cachedColors.secondary.b * t)
    });
  }
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
  if (!canvas) return false;

  const rect = canvas.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  const nextWidth = Math.max(1, Math.floor(rect.width * dpr));
  const nextHeight = Math.max(1, Math.floor(rect.height * dpr));

  if (canvasWidth !== nextWidth || canvasHeight !== nextHeight) {
    canvasWidth = nextWidth;
    canvasHeight = nextHeight;
    displayWidth = rect.width;
    displayHeight = rect.height;
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
    }
    return true;
  }
  return false;
}

function disconnectSourceNode() {
  if (connectedNode && analyser) {
    try {
      connectedNode.disconnect(analyser);
    } catch {
      // Node may have already been disconnected
    }
    connectedNode = null;
  }
}

function attachAnalyzer(audioNode: AudioNode) {
  if (!analyser) {
    const audioContext = audioNode.context;
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;
    dataArray = new Uint8Array(analyser.frequencyBinCount);
    smoothedData = new Float32Array(analyser.frequencyBinCount);
    peakData = new Float32Array(analyser.frequencyBinCount);
  }

  // Disconnect previous node if different
  if (connectedNode && connectedNode !== audioNode) {
    disconnectSourceNode();
  }

  if (audioNode !== connectedNode) {
    audioNode.connect(analyser);
    connectedNode = audioNode;
  }

  startVisualization();
}

function startVisualization() {
  if (!canvasRef.value || !analyser || !dataArray || !smoothedData || !peakData) return;

  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Initial setup
  updateCanvasSize();
  if (!cachedColors) {
    updateCachedColors();
  }

  const bufferLength = analyser.frequencyBinCount;
  const localDataArray = dataArray;
  const localSmoothed = smoothedData;
  const localPeaks = peakData;

  const draw = () => {
    if (!ctx || !analyser || !localDataArray || !localSmoothed || !localPeaks) return;
    if (displayWidth === 0 || displayHeight === 0) return;

    analyser.getByteFrequencyData(localDataArray);

    // Clear with transparent background
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    // Use logarithmic frequency scaling for better visual distribution
    const numBars = Math.min(MAX_BARS, Math.floor(displayWidth / 6));
    const barWidth = displayWidth / numBars;
    const barGap = 1;

    for (let i = 0; i < numBars; i++) {
      // Logarithmic mapping of bar index to frequency bin
      const logIndex = Math.pow(i / numBars, 1.5) * (bufferLength * 0.7);
      const dataIndex = Math.min(Math.floor(logIndex), bufferLength - 1);

      // Smooth the value
      const rawValue = localDataArray[dataIndex]! / 255;
      localSmoothed[i] = localSmoothed[i]! * smoothingFactor + rawValue * (1 - smoothingFactor);

      // Update peaks
      if (localSmoothed[i]! > localPeaks[i]!) {
        localPeaks[i] = localSmoothed[i]!;
      } else {
        localPeaks[i] = localPeaks[i]! * peakDecay;
      }

      const barHeight = localSmoothed[i]! * displayHeight * 0.85;
      const peakHeight = localPeaks[i]! * displayHeight * 0.85;

      const x = i * barWidth;
      const y = displayHeight - barHeight;

      // Use pre-calculated colors
      const { r, g, b } = barColors[i] ?? barColors[0]!;

      // Create gradient based on frequency position
      const gradient = ctx.createLinearGradient(x, displayHeight, x, y);

      // Opacity based on height for glow effect - transparent overlay
      const baseOpacity = 0.15 + localSmoothed[i]! * 0.35;
      gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${baseOpacity})`);
      gradient.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, ${baseOpacity * 0.6})`);
      gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

      ctx.fillStyle = gradient;
      ctx.fillRect(x + barGap / 2, y, barWidth - barGap, barHeight);

      // Draw peak line with subtle glow
      if (peakHeight > 2 && localPeaks[i]! > 0.05) {
        const peakY = displayHeight - peakHeight;
        const peakOpacity = Math.min(0.5, localPeaks[i]! * 0.6);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${peakOpacity})`;
        ctx.fillRect(x + barGap / 2, peakY, barWidth - barGap, 2);
      }
    }

    // Draw subtle reflection at the bottom
    const colors = barColors[0]!;
    const reflectionGradient = ctx.createLinearGradient(0, displayHeight, 0, displayHeight - 40);
    reflectionGradient.addColorStop(0, `rgba(${colors.r}, ${colors.g}, ${colors.b}, 0.05)`);
    reflectionGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = reflectionGradient;
    ctx.fillRect(0, displayHeight - 40, displayWidth, 40);
  };

  // Register with shared animation loop
  unregisterAnimation = registerAnimationCallback(draw);
}

function cleanup() {
  if (unregisterAnimation) {
    unregisterAnimation();
    unregisterAnimation = null;
  }

  // Disconnect the source node from the analyser
  disconnectSourceNode();

  if (analyser) {
    analyser.disconnect();
    analyser = null;
  }

  dataArray = null;
  smoothedData = null;
  peakData = null;
  canvasWidth = 0;
  canvasHeight = 0;
  displayWidth = 0;
  displayHeight = 0;
}

function handleResize() {
  updateCanvasSize();
}

onMounted(() => {
  setupThemeObserver();
  updateCachedColors();
  window.addEventListener('resize', handleResize);
  if (props.node) {
    attachAnalyzer(props.node);
  }
});

onUnmounted(() => {
  cleanup();
  window.removeEventListener('resize', handleResize);
  if (themeObserver) {
    themeObserver.disconnect();
    themeObserver = null;
  }
});

watch(() => props.node, (newNode) => {
  cleanup();
  if (newNode) {
    attachAnalyzer(newNode);
  }
});
</script>

<style scoped>
.spectrum-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 10;
}
</style>
