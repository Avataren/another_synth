<template>
  <ScopeWall
    v-if="!glSupported"
    :track-count="0"
    :audio-nodes="{}"
    :audio-context="props.audioContext"
  />
  <div v-else ref="boxRef" class="stereo-wall" data-testid="stereo-spikes-wall">
    <div ref="areaRef" class="stereo-wall-area">
      <canvas ref="canvasRef" class="stereo-wall-canvas"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ScopeWall from 'src/components/tracker/ScopeWall.vue';
import { registerAnimationCallback } from 'src/composables/useAnimationLoop';
import {
  GlowScopeRenderer,
  readScopeColor,
  readScopeColor2,
  webgl2Available,
} from 'src/components/tracker/glow-scope-renderer';
import { needleColumns, stereoNeedleSegments } from 'src/components/tracker/glow-scope-geometry';
import { scopeTriggerStart } from 'src/components/tracker/scope-trace';

/**
 * The Spikes look for the master output alone, filling the whole area: the
 * left channel is the top half of every needle and the right channel the
 * bottom, so the stereo image can be read off the shape. WebGL only; without
 * WebGL2 the (empty) plain wall stands in.
 */
interface Props {
  /** The final mix, or null while nothing is loaded. */
  audioNode: AudioNode | null;
  audioContext: AudioContext | null;
}

const props = defineProps<Props>();

/** Analyser window; half of it is drawn, from a rising zero crossing. */
const FFT_SIZE = 4096;
/** Peak level that reaches the edge: the mix mostly sits well below full scale. */
const FULL_SCALE = 0.4;
const NEEDLE_SPACING = 8;
/** Exaggerates peaks so a few needles tower over the rest; and how fast they fall. */
const NEEDLE_SHAPE = { curve: 1.6, decay: 0.9, hold: new Float32Array(2048) };
const NEEDLE_MIN_HALF = 1;
const NEEDLE_BLOOM = 1.15;

const glSupported = computed(() => webgl2Available());
const boxRef = ref<HTMLElement | null>(null);
const areaRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

let renderer: GlowScopeRenderer | null = null;
let unregisterAnimation: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let pixelRatio = 1;
let cssWidth = 0;
let cssHeight = 0;

let splitter: ChannelSplitterNode | null = null;
let analyserL: AnalyserNode | null = null;
let analyserR: AnalyserNode | null = null;
let connected: AudioNode | null = null;
let dataL = new Float32Array(FFT_SIZE);
let dataR = new Float32Array(FFT_SIZE);
let mono = new Float32Array(FFT_SIZE);
let segments = new Float32Array(0);

function disconnectTap(): void {
  if (connected && splitter) {
    try {
      connected.disconnect(splitter);
    } catch {
      // Already disconnected.
    }
  }
  splitter?.disconnect();
  analyserL?.disconnect();
  analyserR?.disconnect();
  splitter = analyserL = analyserR = connected = null;
}

/** Splits the master into two analysers, or drops them when there is no node. */
function connectTap(): void {
  const node = props.audioNode;
  if (node === connected) return;
  disconnectTap();
  if (!node) return;
  const context = props.audioContext ?? node.context;
  splitter = context.createChannelSplitter(2);
  analyserL = context.createAnalyser();
  analyserR = context.createAnalyser();
  analyserL.fftSize = FFT_SIZE;
  analyserR.fftSize = FFT_SIZE;
  analyserL.smoothingTimeConstant = 0;
  analyserR.smoothingTimeConstant = 0;
  node.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);
  connected = node;
}

function syncCanvasSize(): void {
  const canvas = canvasRef.value;
  const area = areaRef.value;
  if (!canvas || !area) return;
  pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  cssWidth = area.clientWidth;
  cssHeight = area.clientHeight;
  const w = Math.max(1, Math.round(cssWidth * pixelRatio));
  const h = Math.max(1, Math.round(cssHeight * pixelRatio));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function draw(time: number): void {
  const canvas = canvasRef.value;
  const area = areaRef.value;
  if (!canvas || !area || !renderer) return;
  if (
    area.clientWidth !== cssWidth ||
    area.clientHeight !== cssHeight ||
    (window.devicePixelRatio || 1) !== pixelRatio
  ) {
    syncCanvasSize();
  }
  if (cssWidth === 0 || cssHeight === 0) return;

  connectTap();
  const wanted = needleColumns(cssWidth, NEEDLE_SPACING);
  if (segments.length < wanted * 4) segments = new Float32Array(wanted * 4);

  let count: number;
  if (analyserL && analyserR) {
    analyserL.getFloatTimeDomainData(dataL);
    analyserR.getFloatTimeDomainData(dataR);
    // Hold the picture still by triggering on the mono sum.
    for (let i = 0; i < mono.length; i++) mono[i] = ((dataL[i] ?? 0) + (dataR[i] ?? 0)) * 0.5;
    const start = scopeTriggerStart(mono, 0);
    count = stereoNeedleSegments(
      dataL,
      dataR,
      start,
      mono.length >> 1,
      cssWidth,
      cssHeight,
      NEEDLE_SPACING,
      NEEDLE_MIN_HALF,
      FULL_SCALE,
      segments,
      NEEDLE_SHAPE,
    );
  } else {
    // Nothing to listen to: the dotted line of silence.
    dataL.fill(0);
    dataR.fill(0);
    count = stereoNeedleSegments(
      dataL,
      dataR,
      0,
      dataL.length >> 1,
      cssWidth,
      cssHeight,
      NEEDLE_SPACING,
      NEEDLE_MIN_HALF,
      FULL_SCALE,
      segments,
      NEEDLE_SHAPE,
    );
  }

  renderer.render(
    [
      {
        segments: true,
        x: 0,
        y: 0,
        width: cssWidth * pixelRatio,
        height: cssHeight * pixelRatio,
        brightness: 1,
        polyline: segments,
        count,
      },
    ],
    {
      pixelRatio,
      crt: false,
      bloom: true,
      bloomStrength: NEEDLE_BLOOM,
      style: 'needles',
      timeMs: time,
    },
  );
}

function readTheme(): void {
  if (!renderer) return;
  renderer.color = readScopeColor();
  renderer.color2 = readScopeColor2();
}

function start(): void {
  const canvas = canvasRef.value;
  if (renderer || !canvas || !glSupported.value) return;
  const created = new GlowScopeRenderer(canvas);
  if (!created.ok) {
    created.dispose();
    return;
  }
  renderer = created;
  readTheme();
  syncCanvasSize();
  if (typeof ResizeObserver !== 'undefined' && areaRef.value) {
    resizeObserver = new ResizeObserver(syncCanvasSize);
    resizeObserver.observe(areaRef.value);
  }
  themeObserver = new MutationObserver(readTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
  unregisterAnimation = registerAnimationCallback(draw);
}

function stop(): void {
  unregisterAnimation?.();
  unregisterAnimation = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  themeObserver?.disconnect();
  themeObserver = null;
  renderer?.dispose();
  renderer = null;
  disconnectTap();
}

onMounted(start);
watch(glSupported, async () => {
  stop();
  await nextTick();
  start();
});
onBeforeUnmount(stop);
</script>

<style scoped>
/* Takes whatever the page leaves: the box is measured, not sized. */
.stereo-wall {
  flex: 1;
  min-height: 0;
  min-width: 0;
  position: relative;
}

.stereo-wall-area {
  position: absolute;
  inset: 0 18px 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
}

.stereo-wall-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
