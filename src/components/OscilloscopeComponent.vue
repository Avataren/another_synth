<template>
  <q-card flat class="oscillator-card">
    <!-- <q-card-section class="bg-primary text-white">
      <div class="text-h6">Oscilloscope</div>
    </q-card-section> -->
    <!-- <q-separator /> -->
    <q-card-section class="oscilloscope-container">
      <div class="channel">
        <div class="channel-label">Left</div>
        <canvas ref="leftCanvasRef"></canvas>
      </div>
      <div class="channel">
        <div class="channel-label">Right</div>
        <canvas ref="rightCanvasRef"></canvas>
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
    if (canvas.width !== rect.width) {
      canvas.width = rect.width;
    }
    if (canvas.height !== rect.height) {
      canvas.height = rect.height;
    }
  };

  const drawChannel = (
    canvas: HTMLCanvasElement,
    analyser: AnalyserNode,
    buffer: Uint8Array,
  ) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ensureCanvasResolution(canvas);

    analyser.getByteTimeDomainData(buffer);
    const bufferLength = analyser.frequencyBinCount;

    ctx.fillStyle = 'rgb(32, 45, 66)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgb(160, 190, 225)';
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
  };

  const draw = () => {
    if (!leftAnalyser || !rightAnalyser || !leftCanvas || !rightCanvas) return;

    const leftBuffer = leftDataArray;
    const rightBuffer = rightDataArray;
    if (!leftBuffer || !rightBuffer) return;

    animationFrameId = requestAnimationFrame(draw);

    drawChannel(leftCanvas, leftAnalyser, leftBuffer);
    drawChannel(rightCanvas, rightAnalyser, rightBuffer);
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
  gap: 0.25rem;
  flex: 1 1 0;
}

.channel-label {
  font-size: 12px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #9fb2cc;
}

canvas {
  width: 100%;
  height: 120px;
  border: 1px solid #273140;
  background-color: rgb(20, 26, 36);
  border-radius: 8px;
}

@media (max-width: 900px) {
  .oscilloscope-container {
    flex-direction: column;
  }
}
</style>
