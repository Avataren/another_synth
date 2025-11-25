<template>
  <q-card flat class="oscillator-card">
    <!-- <q-card-section class="bg-primary text-white">
      <div class="text-h6">Oscilloscope</div>
    </q-card-section> -->
    <!-- <q-separator /> -->
  <q-card-section class="oscilloscope-container">
    <div class="channel">
      <canvas ref="leftCanvasRef" data-label="Left"></canvas>
    </div>
    <div class="channel">
      <canvas ref="rightCanvasRef" data-label="Right"></canvas>
    </div>
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
const leftCanvasRef = ref<HTMLCanvasElement | null>(null);
const rightCanvasRef = ref<HTMLCanvasElement | null>(null);

// Theme color caching
let cachedBgColor = '#0b111a';
let cachedAccentColor = 'rgb(77, 242, 197)';
let cachedTextColor = 'rgba(255, 255, 255, 0.6)';
let oscThemeObserver: MutationObserver | null = null;

function updateOscThemeColors() {
  const style = getComputedStyle(document.documentElement);
  cachedBgColor = style.getPropertyValue('--app-background').trim() || '#0b111a';
  cachedAccentColor = style.getPropertyValue('--tracker-accent-primary').trim() || 'rgb(77, 242, 197)';
  cachedTextColor = style.getPropertyValue('--text-muted').trim() || 'rgba(255, 255, 255, 0.6)';
}

let splitter: ChannelSplitterNode | null = null;
let leftAnalyser: AnalyserNode | null = null;
let rightAnalyser: AnalyserNode | null = null;
let animationFrameId: number | null = null;
let leftDataArray: Uint8Array | null = null;
let rightDataArray: Uint8Array | null = null;

const attachOscilloscope = (audioNode: AudioNode) => {
  const audioContext = audioNode.context;

  if (!leftAnalyser || !rightAnalyser || !splitter) {
    splitter = audioContext.createChannelSplitter(2);

    const createAnalyser = () => {
      const a = audioContext.createAnalyser();
      a.fftSize = 2048;
      return a;
    };

    leftAnalyser = createAnalyser();
    rightAnalyser = createAnalyser();

    leftDataArray = new Uint8Array(leftAnalyser.frequencyBinCount);
    rightDataArray = new Uint8Array(rightAnalyser.frequencyBinCount);
  }

  audioNode.connect(splitter);
  splitter.connect(leftAnalyser, 0);
  splitter.connect(rightAnalyser, 1);

  startVisualization();
};

const startVisualization = () => {
  if (
    !leftCanvasRef.value ||
    !rightCanvasRef.value ||
    !leftAnalyser ||
    !rightAnalyser ||
    !leftDataArray ||
    !rightDataArray
  )
    return;

  const leftCanvas = leftCanvasRef.value;
  const rightCanvas = rightCanvasRef.value;

  const ensureCanvasResolution = (canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.floor(rect.width));
    const nextHeight = Math.max(1, Math.floor(rect.height));
    if (canvas.width !== nextWidth) {
      canvas.width = nextWidth;
    }
    if (canvas.height !== nextHeight) {
      canvas.height = nextHeight;
    }
  };

  const drawChannel = (
    canvas: HTMLCanvasElement,
    analyser: AnalyserNode,
    buffer: Uint8Array,
    label: string,
  ) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ensureCanvasResolution(canvas);

    analyser.getByteTimeDomainData(buffer);
    const bufferLength = analyser.frequencyBinCount;

    ctx.fillStyle = cachedBgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = cachedAccentColor;
    ctx.beginPath();

    const sliceWidth = canvas.width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const sample = buffer[i] ?? 128;
      const v = sample / 128.0;
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

    // Draw label in the corner
    ctx.fillStyle = cachedTextColor;
    ctx.font = '11px sans-serif';
    ctx.fillText(label, 8, 14);
  };

  const draw = () => {
    if (!leftAnalyser || !rightAnalyser || !leftCanvas || !rightCanvas) return;

    const leftBuffer = leftDataArray;
    const rightBuffer = rightDataArray;
    if (!leftBuffer || !rightBuffer) return;

    animationFrameId = requestAnimationFrame(draw);

    drawChannel(leftCanvas, leftAnalyser, leftBuffer, leftCanvas.dataset.label || 'Left');
    drawChannel(rightCanvas, rightAnalyser, rightBuffer, rightCanvas.dataset.label || 'Right');
  };

  draw();
};

const cleanup = () => {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  if (splitter) {
    splitter.disconnect();
    splitter = null;
  }

  if (leftAnalyser) {
    leftAnalyser.disconnect();
    leftAnalyser = null;
  }

  if (rightAnalyser) {
    rightAnalyser.disconnect();
    rightAnalyser = null;
  }

  leftDataArray = null;
  rightDataArray = null;
};

onMounted(() => {
  // Initialize theme colors
  updateOscThemeColors();

  // Watch for theme changes
  oscThemeObserver = new MutationObserver(() => {
    updateOscThemeColors();
  });
  oscThemeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  if (props.node) {
    attachOscilloscope(props.node);
  }
});

onUnmounted(() => {
  cleanup();
  oscThemeObserver?.disconnect();
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
  width: 100%;
  max-width: var(--node-width, 640px);
  margin: 0 auto;
  display: flex;
  flex-direction: row;
  gap: 0.75rem;
}

.channel {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
}

canvas {
  width: 100%;
  height: 120px;
  border: 1px solid var(--panel-border);
  background-color: var(--app-background);
  border-radius: 8px;
}

@media (max-width: 900px) {
  .oscilloscope-container {
    flex-direction: column;
  }
}
</style>
