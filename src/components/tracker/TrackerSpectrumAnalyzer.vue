<template>
  <canvas ref="canvasRef" class="spectrum-canvas"></canvas>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';

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
let animationFrameId: number | null = null;
let dataArray: Uint8Array | null = null;

// Smoothed values for more fluid animation
let smoothedData: Float32Array | null = null;
const smoothingFactor = 0.7;

// Peak hold values for visual effect
let peakData: Float32Array | null = null;
let peakDecay = 0.995;

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

  audioNode.connect(analyser);
  startVisualization();
}

function startVisualization() {
  if (!canvasRef.value || !analyser || !dataArray || !smoothedData || !peakData) return;

  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const bufferLength = analyser.frequencyBinCount;
  const localDataArray = dataArray;
  const localSmoothed = smoothedData;
  const localPeaks = peakData;

  const draw = () => {
    if (!ctx || !analyser || !localDataArray || !localSmoothed || !localPeaks) return;

    animationFrameId = requestAnimationFrame(draw);

    // Keep canvas in sync with display size
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const nextWidth = Math.max(1, Math.floor(rect.width * dpr));
    const nextHeight = Math.max(1, Math.floor(rect.height * dpr));

    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      ctx.scale(dpr, dpr);
    }

    if (canvas.width === 0 || canvas.height === 0) return;

    const width = rect.width;
    const height = rect.height;

    analyser.getByteFrequencyData(localDataArray);

    // Clear with transparent background
    ctx.clearRect(0, 0, width, height);

    // Get theme colors
    const colors = getThemeColors();

    // Use logarithmic frequency scaling for better visual distribution
    const numBars = Math.min(128, Math.floor(width / 6));
    const barWidth = width / numBars;
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

      const barHeight = localSmoothed[i]! * height * 0.85;
      const peakHeight = localPeaks[i]! * height * 0.85;

      const x = i * barWidth;
      const y = height - barHeight;

      // Create gradient based on frequency position
      const gradient = ctx.createLinearGradient(x, height, x, y);
      const t = i / numBars;

      // Interpolate between primary and secondary colors
      const r = Math.round(colors.primary.r * (1 - t) + colors.secondary.r * t);
      const g = Math.round(colors.primary.g * (1 - t) + colors.secondary.g * t);
      const b = Math.round(colors.primary.b * (1 - t) + colors.secondary.b * t);

      // Opacity based on height for glow effect - transparent overlay
      const baseOpacity = 0.15 + localSmoothed[i]! * 0.35;
      gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${baseOpacity})`);
      gradient.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, ${baseOpacity * 0.6})`);
      gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

      ctx.fillStyle = gradient;
      ctx.fillRect(x + barGap / 2, y, barWidth - barGap, barHeight);

      // Draw peak line with subtle glow
      if (peakHeight > 2 && localPeaks[i]! > 0.05) {
        const peakY = height - peakHeight;
        const peakOpacity = Math.min(0.5, localPeaks[i]! * 0.6);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${peakOpacity})`;
        ctx.fillRect(x + barGap / 2, peakY, barWidth - barGap, 2);
      }
    }

    // Draw subtle reflection at the bottom
    const reflectionGradient = ctx.createLinearGradient(0, height, 0, height - 40);
    reflectionGradient.addColorStop(0, `rgba(${colors.primary.r}, ${colors.primary.g}, ${colors.primary.b}, 0.05)`);
    reflectionGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = reflectionGradient;
    ctx.fillRect(0, height - 40, width, 40);
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
  smoothedData = null;
  peakData = null;
}

onMounted(() => {
  if (props.node) {
    attachAnalyzer(props.node);
  }
});

onUnmounted(() => {
  cleanup();
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
