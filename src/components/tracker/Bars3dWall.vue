<template>
  <ScopeWall
    v-if="!glSupported"
    :track-count="0"
    :audio-nodes="{}"
    :audio-context="props.audioContext"
  />
  <div v-else class="bars3d-wall" data-testid="bars3d-wall">
    <div ref="areaRef" class="bars3d-area">
      <canvas ref="canvasRef" class="bars3d-canvas"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ScopeWall from 'src/components/tracker/ScopeWall.vue';
import { registerAnimationCallback } from 'src/composables/useAnimationLoop';
import { Bars3dRenderer } from 'src/components/tracker/bars3d-renderer';
import { RaymarchRenderer } from 'src/components/tracker/raymarch-renderer';
import { webgl2Available } from 'src/components/tracker/glow-scope-renderer';
import { SpectrumFeed } from 'src/components/tracker/spectrum-feed';

/**
 * A 3D scene: glowing spectrum bars standing on a glossy floor, with a diffuse
 * reflection and bloom. Driven by the master output alone. WebGL only; without
 * WebGL2 an empty plain wall stands in.
 */
interface Props {
  /** The final mix, or null while nothing is loaded. */
  audioNode: AudioNode | null;
  audioContext: AudioContext | null;
  /** Trace the scene per pixel instead of rasterising it: prettier, and far heavier. */
  raymarched?: boolean;
}

const props = withDefaults(defineProps<Props>(), { raymarched: false });

/** Bars across the scene. */
const BANDS = 40;
/** Cap the resolution: the scene is soft, and it redraws every frame. */
const MAX_PIXEL_RATIO = 1.5;

const glSupported = computed(() => webgl2Available());
const areaRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

const spectrum = new SpectrumFeed({ curve: 1.5 });

let renderer: Bars3dRenderer | RaymarchRenderer | null = null;
let unregisterAnimation: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let cssWidth = 0;
let cssHeight = 0;
let pixelRatio = 1;

function syncCanvasSize(): void {
  const canvas = canvasRef.value;
  const area = areaRef.value;
  if (!canvas || !area) return;
  pixelRatio = Math.min(MAX_PIXEL_RATIO, Math.max(1, window.devicePixelRatio || 1));
  cssWidth = area.clientWidth;
  cssHeight = area.clientHeight;
  const w = Math.max(1, Math.round(cssWidth * pixelRatio));
  const h = Math.max(1, Math.round(cssHeight * pixelRatio));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function draw(time: number): void {
  const area = areaRef.value;
  if (!area || !renderer) return;
  if (area.clientWidth !== cssWidth || area.clientHeight !== cssHeight) syncCanvasSize();
  if (cssWidth === 0 || cssHeight === 0) return;
  spectrum.update(props.audioNode, props.audioContext, BANDS);
  renderer.render({
    levels: spectrum.levels,
    peaks: spectrum.peaks,
    bands: BANDS,
    timeMs: time,
  });
}

function start(): void {
  const canvas = canvasRef.value;
  if (renderer || !canvas || !glSupported.value) return;
  const created = props.raymarched ? new RaymarchRenderer(canvas) : new Bars3dRenderer(canvas);
  if (!created.ok) {
    created.dispose();
    return;
  }
  renderer = created;
  syncCanvasSize();
  if (typeof ResizeObserver !== 'undefined' && areaRef.value) {
    resizeObserver = new ResizeObserver(syncCanvasSize);
    resizeObserver.observe(areaRef.value);
  }
  unregisterAnimation = registerAnimationCallback(draw);
}

function stop(): void {
  unregisterAnimation?.();
  unregisterAnimation = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  renderer?.dispose();
  renderer = null;
  spectrum.dispose();
}

onMounted(start);
watch([glSupported, () => props.raymarched], async () => {
  stop();
  await nextTick();
  start();
});
onBeforeUnmount(stop);
</script>

<style scoped>
/* Takes whatever the page leaves: the box is measured, not sized. */
.bars3d-wall {
  flex: 1;
  min-height: 0;
  min-width: 0;
  position: relative;
}

.bars3d-area {
  position: absolute;
  inset: 0 18px 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  overflow: hidden;
  background: #020308;
}

.bars3d-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
