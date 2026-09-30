<template>
  <ScopeWall
    v-if="!glSupported"
    v-bind="props"
    @toggle-mute="emit('toggle-mute', $event)"
    @toggle-solo="emit('toggle-solo', $event)"
  />
  <div v-else class="glow-wall" data-testid="glow-scope-wall">
    <div
      ref="gridRef"
      class="glow-wall-grid"
      :style="{
        gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
      }"
    >
      <div
        v-for="index in props.trackCount"
        :key="`glow-scope-${index - 1}`"
        :ref="(el) => setCell(index - 1, el as HTMLElement | null)"
        class="glow-wall-cell"
        :class="{ muted: !props.isAudible(index - 1) }"
        :title="`Channel ${index} — click to mute, shift-click to solo`"
        data-testid="glow-wall-cell"
        @click="onCellClick($event, index - 1)"
      >
        <div class="glow-wall-label">{{ index }}</div>
      </div>
      <!-- One canvas over every cell; clicks fall through to the cells. -->
      <canvas ref="canvasRef" class="glow-wall-canvas"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ScopeWall from 'src/components/tracker/ScopeWall.vue';
import { registerAnimationCallback } from 'src/composables/useAnimationLoop';
import { ChannelScopeFeed } from 'src/components/tracker/channel-scope-feed';
import { scopeWallGrid } from 'src/components/tracker/scope-wall-layout';
import {
  scopeFullScale,
  scopeMidrange,
  scopePolyline,
  scopeTriggerStart,
  scopeVisiblePoints,
} from 'src/components/tracker/scope-trace';
import { flatPolyline, needleColumns, needleSegments } from 'src/components/tracker/glow-scope-geometry';
import {
  GlowScopeRenderer,
  readScopeColor,
  readScopeColor2,
  webgl2Available,
  type GlowRenderCell,
} from 'src/components/tracker/glow-scope-renderer';

/**
 * The scope wall drawn by one WebGL2 shader instead of a canvas per channel.
 *
 * Same props, same grid and same mute/solo cells as `ScopeWall`; the traces
 * are cut from the same sources the same way (a per-track analyser tap, or the
 * AHX worklet's snapshot) and only the drawing differs: an antialiased line
 * with a glow, rendered for every channel in a single instanced draw call.
 * Falls back to the plain wall where WebGL2 is not available.
 */
interface Props {
  trackCount: number;
  audioNodes: Record<number, AudioNode | null>;
  audioContext: AudioContext | null;
  scopeSource?: ((channel: number) => Int16Array | null) | null;
  analyserFullScale?: ((channel: number) => (() => number | null) | null) | null;
  scopeGain?: number;
  isAudible?: (channel: number) => boolean;
  /** Dress each cell as a CRT screen (the CRT view). */
  crt?: boolean;
  /** Bloom post-process over thin lines (the Glow 2 view). */
  bloom?: boolean;
  /** Mirrored tapered needles instead of a line (the Spikes view; also blooms). */
  needles?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  scopeSource: null,
  analyserFullScale: null,
  scopeGain: 1,
  isAudible: () => true,
  crt: false,
  bloom: false,
  needles: false,
});

const emit = defineEmits<{
  (e: 'toggle-mute', channel: number): void;
  (e: 'toggle-solo', channel: number): void;
}>();

/** Needle spacing and the shortest needle, CSS pixels. */
const NEEDLE_SPACING = 8;
/** Peaks exaggerated and a slow fall, per channel (see `NeedleShape`). */
const NEEDLE_CURVE = 1.9;
const NEEDLE_DECAY = 0.9;
const needleHolds: Float32Array[] = [];
const NEEDLE_MIN_HALF = 1;
const NEEDLE_BLOOM = 1.15;
const GLOW_VIEW_HALO = { radius: 22, strength: 0.75 };
const MUTED_BRIGHTNESS = 0.25;

// WebGL only: the WebGL scopes setting does not apply here. Without a WebGL2
// context the plain wall stands in.
const glSupported = computed(() => webgl2Available());

const gridRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const cellElements: (HTMLElement | null)[] = [];

function setCell(channel: number, element: HTMLElement | null): void {
  cellElements[channel] = element;
}
const width = ref(0);
const height = ref(0);

const grid = computed(() => scopeWallGrid(props.trackCount, width.value, height.value));

function onCellClick(event: MouseEvent, channel: number): void {
  if (event.shiftKey) emit('toggle-solo', channel);
  else emit('toggle-mute', channel);
}

const feed = new ChannelScopeFeed(() => props);

// ---------------------------------------------------------------
// WebGL
// ---------------------------------------------------------------

let renderer: GlowScopeRenderer | null = null;
// One buffer per channel: the renderer reads them all after the loop, so a
// shared one would leave every cell drawing the last channel's trace.
const polylines: Float32Array[] = [];
const flats: Float32Array[] = [];
const needleBuffers: Float32Array[] = [];
let unregisterAnimation: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let pixelRatio = 1;
let canvasCssWidth = 0;
let canvasCssHeight = 0;

function measure(): void {
  const grid = gridRef.value;
  if (!grid) return;
  width.value = grid.clientWidth;
  height.value = grid.clientHeight;
  syncCanvasSize();
}

function syncCanvasSize(): void {
  const canvas = canvasRef.value;
  const element = gridRef.value;
  if (!canvas || !element) return;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvasCssWidth = element.clientWidth;
  canvasCssHeight = element.clientHeight;
  pixelRatio = ratio;
  const w = Math.max(1, Math.round(canvasCssWidth * ratio));
  const h = Math.max(1, Math.round(canvasCssHeight * ratio));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}

function draw(time: number): void {
  const canvas = canvasRef.value;
  const gridElement = gridRef.value;
  if (!canvas || !renderer || !gridElement) return;
  // The grid can resize without the observer firing yet (first layout).
  if (
    gridElement.clientWidth !== canvasCssWidth ||
    gridElement.clientHeight !== canvasCssHeight ||
    (window.devicePixelRatio || 1) !== pixelRatio
  ) {
    syncCanvasSize();
  }
  if (canvasCssWidth === 0 || canvasCssHeight === 0) return;

  const originRect = gridElement.getBoundingClientRect();
  const cells: GlowRenderCell[] = [];

  for (let channel = 0; channel < props.trackCount; channel++) {
    const element = cellElements[channel];
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;

    const trace = feed.trace(channel, rect.width);
    let count: number;
    let points: ArrayLike<number>;
    if (trace && trace.data.length >= 4) {
      const wanted = scopeVisiblePoints(trace.data.length);
      let polyline = polylines[channel];
      if (!polyline || polyline.length < wanted * 2) {
        polyline = new Float32Array(wanted * 2);
        polylines[channel] = polyline;
      }
      const center = trace.centered ? scopeMidrange(trace.data) : 0;
      count = scopePolyline(
        trace.data,
        scopeTriggerStart(trace.data, center),
        wanted,
        rect.width,
        rect.height,
        scopeFullScale(trace.fullScale, trace.gain),
        polyline,
        center,
      );
      points = polyline;
    } else {
      const flat = (flats[channel] ??= new Float32Array(4));
      count = flatPolyline(rect.width, rect.height, flat);
      points = flat;
    }
    let segments = false;
    if (props.needles) {
      const columns = needleColumns(rect.width, NEEDLE_SPACING);
      let buffer = needleBuffers[channel];
      if (!buffer || buffer.length < columns * 4) {
        buffer = new Float32Array(columns * 4);
        needleBuffers[channel] = buffer;
      }
      count = needleSegments(
        points,
        count,
        rect.width,
        rect.height,
        NEEDLE_SPACING,
        NEEDLE_MIN_HALF,
        buffer,
        {
          curve: NEEDLE_CURVE,
          decay: NEEDLE_DECAY,
          hold: (needleHolds[channel] ??= new Float32Array(1024)),
        },
      );
      points = buffer;
      segments = true;
    }
    cells.push({
      segments,
      x: (rect.left - originRect.left) * pixelRatio,
      y: (rect.top - originRect.top) * pixelRatio,
      width: rect.width * pixelRatio,
      height: rect.height * pixelRatio,
      brightness: props.isAudible(channel) ? 1 : MUTED_BRIGHTNESS,
      polyline: points,
      count,
    });
  }

  renderer.render(cells, {
    pixelRatio,
    crt: props.crt,
    bloom: props.bloom || props.needles,
    bloomStrength: props.needles ? NEEDLE_BLOOM : undefined,
    style: props.needles ? 'needles' : 'trace',
    // The Glow view is about the halo; the CRT view keeps it subtle under the screen effects.
    glow: props.crt || props.bloom || props.needles ? undefined : GLOW_VIEW_HALO,
    timeMs: time,
  });
}

function readTheme(): void {
  if (!renderer) return;
  renderer.color = readScopeColor();
  renderer.color2 = readScopeColor2();
}

/** Builds the renderer on the canvas, once it exists, and starts drawing. */
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
  measure();
  if (typeof ResizeObserver !== 'undefined' && gridRef.value) {
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(gridRef.value);
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
  feed.releaseAll();
}

onMounted(start);

// The setting can flip while the wall is up: the canvas comes or goes with it.
watch(glSupported, async () => {
  stop();
  await nextTick();
  start();
});

// A track count change re-renders the cells; the taps of channels that no
// longer exist would otherwise stay wired to the graph.
watch(
  () => props.trackCount,
  (count) => {
    feed.releaseFrom(count);
  },
);
// With a scope source (AHX) no tap is wanted at all.
watch(
  () => props.scopeSource,
  (source) => {
    if (source) feed.releaseAll();
  },
);

onBeforeUnmount(stop);
</script>

<style scoped>
.glow-wall {
  flex: 1;
  min-height: 0;
  min-width: 0;
  position: relative;
}

.glow-wall-grid {
  position: absolute;
  inset: 0 18px 18px;
  display: grid;
  gap: 6px;
}

.glow-wall-cell {
  position: relative;
  min-width: 0;
  min-height: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
  cursor: pointer;
}

/* The glow lives on the canvas over the cells; a muted cell dims its frame. */
.glow-wall-cell.muted {
  border-color: rgba(255, 255, 255, 0.03);
}

.glow-wall-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.glow-wall-label {
  position: absolute;
  z-index: 1;
  left: 6px;
  top: 4px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary, rgba(255, 255, 255, 0.45));
  pointer-events: none;
}
</style>
