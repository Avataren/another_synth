<template>
  <ScopeWall
    v-if="!glSupported"
    :track-count="0"
    :audio-nodes="{}"
    :audio-context="props.audioContext"
  />
  <div v-else class="eq-wall" data-testid="equalizer-wall">
    <div ref="areaRef" class="eq-wall-area">
      <canvas ref="canvasRef" class="eq-wall-canvas"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ScopeWall from 'src/components/tracker/ScopeWall.vue';
import { registerAnimationCallback } from 'src/composables/useAnimationLoop';
import { ChannelScopeFeed } from 'src/components/tracker/channel-scope-feed';
import {
  GlowScopeRenderer,
  readScopeColor,
  webgl2Available,
  type GlowRenderCell,
} from 'src/components/tracker/glow-scope-renderer';
import {
  ledBarCapacity,
  ledBarSegments,
  spectrumBands,
  type LedBarLayout,
} from 'src/components/tracker/glow-scope-geometry';
import {
  scopeFullScale,
  scopeMidrange,
  scopePolyline,
  scopeTriggerStart,
  scopeVisiblePoints,
} from 'src/components/tracker/scope-trace';

/**
 * A neon spectrum analyser with the channels' waveforms drawn across it: LED
 * bars for the master output's spectrum (a rainbow, peak markers, a reflection
 * on the floor), and one thin glowing line per channel over the top, all under
 * one bloom. WebGL only; without WebGL2 an empty plain wall stands in.
 */
interface Props {
  trackCount: number;
  audioNodes: Record<number, AudioNode | null>;
  audioContext: AudioContext | null;
  /** The final mix the bars analyse, or null while nothing is loaded. */
  masterNode: AudioNode | null;
  scopeSource?: ((channel: number) => Int16Array | null) | null;
  analyserFullScale?: ((channel: number) => (() => number | null) | null) | null;
  scopeGain?: number;
}

const props = withDefaults(defineProps<Props>(), {
  scopeSource: null,
  analyserFullScale: null,
  scopeGain: 1,
});

const FFT_SIZE = 8192;
const MIN_HZ = 35;
const MAX_HZ = 16000;
const MIN_DB = -95;
const MAX_DB = -12;
/** dB per octave added above 1 kHz, and the response curve (quiet bands stay low). */
const TILT_DB = 3;
const LEVEL_CURVE = 1.8;
/** Bar slot width target, CSS pixels. */
const BAR_SLOT = 26;
/** Per frame: how fast a bar falls, and how fast its peak marker does. */
const BAR_FALL = 0.88;
const PEAK_FALL = 0.012;
/** Channel lines swing this fraction of the area's half-height at full scale... */
const WAVE_SWING = 0.3;
/** ...about this fraction of the height from the top, so they cross the bars. */
const WAVE_CENTER = 0.42;
const WAVE_BRIGHTNESS = 0.85;
const BLOOM = 1.0;

const glSupported = computed(() => webgl2Available());
const areaRef = ref<HTMLElement | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);

const feed = new ChannelScopeFeed(() => props);

let renderer: GlowScopeRenderer | null = null;
let unregisterAnimation: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
let pixelRatio = 1;
let cssWidth = 0;
let cssHeight = 0;

let analyser: AnalyserNode | null = null;
let connected: AudioNode | null = null;
let freqDb = new Float32Array(FFT_SIZE / 2);
const MAX_BANDS = 64;
const raw = new Float32Array(MAX_BANDS);
const levels = new Float32Array(MAX_BANDS);
const peaks = new Float32Array(MAX_BANDS);
let barSegments = new Float32Array(0);
let barWeights = new Float32Array(0);
const polylines: Float32Array[] = [];

function disconnectTap(): void {
  if (connected && analyser) {
    try {
      connected.disconnect(analyser);
    } catch {
      // Already disconnected.
    }
  }
  analyser?.disconnect();
  analyser = connected = null;
}

function connectTap(): void {
  const node = props.masterNode;
  if (node === connected) return;
  disconnectTap();
  if (!node) return;
  analyser = (props.audioContext ?? node.context).createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.6;
  analyser.minDecibels = -100;
  analyser.maxDecibels = -10;
  freqDb = new Float32Array(analyser.frequencyBinCount);
  node.connect(analyser);
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

  // --- the bars ---
  connectTap();
  const bands = Math.max(12, Math.min(MAX_BANDS, Math.floor(cssWidth / BAR_SLOT)));
  if (analyser) {
    analyser.getFloatFrequencyData(freqDb);
    spectrumBands(
      freqDb,
      analyser.context.sampleRate / analyser.fftSize,
      bands,
      MIN_HZ,
      MAX_HZ,
      MIN_DB,
      MAX_DB,
      raw,
      TILT_DB,
      LEVEL_CURVE,
    );
  } else {
    raw.fill(0);
  }
  for (let b = 0; b < bands; b++) {
    const now = raw[b] ?? 0;
    const fallen = (levels[b] ?? 0) * BAR_FALL;
    levels[b] = now > fallen ? now : fallen;
    const peak = Math.max(levels[b] ?? 0, (peaks[b] ?? 0) - PEAK_FALL);
    peaks[b] = peak;
  }

  const baseline = cssHeight * 0.72;
  const barsHeight = baseline - cssHeight * 0.08;
  const ledHeight = Math.max(5, Math.min(14, Math.round(barsHeight / 26)));
  const layout: LedBarLayout = {
    width: cssWidth,
    height: cssHeight,
    baseline,
    barsHeight,
    ledHeight,
    barWidthFraction: 0.74,
    unlitBrightness: 0,
    peakBrightness: 0.55,
    reflection: 0.32,
  };
  const capacity = ledBarCapacity(bands, layout);
  if (barSegments.length < capacity * 4) {
    barSegments = new Float32Array(capacity * 4);
    barWeights = new Float32Array(capacity);
  }
  const barCount = ledBarSegments(levels, peaks, bands, layout, barSegments, barWeights);

  const full = {
    x: 0,
    y: 0,
    width: cssWidth * pixelRatio,
    height: cssHeight * pixelRatio,
  };
  const cells: GlowRenderCell[] = [
    {
      ...full,
      brightness: 1,
      style: 'bars',
      segments: true,
      polyline: barSegments,
      weights: barWeights,
      count: barCount,
    },
  ];

  // --- the channel lines ---
  for (let channel = 0; channel < props.trackCount; channel++) {
    const trace = feed.trace(channel, cssWidth);
    if (!trace || trace.data.length < 4) continue;
    const wanted = scopeVisiblePoints(trace.data.length);
    let polyline = polylines[channel];
    if (!polyline || polyline.length < wanted * 2) {
      polyline = new Float32Array(wanted * 2);
      polylines[channel] = polyline;
    }
    const center = trace.centered ? scopeMidrange(trace.data) : 0;
    const count = scopePolyline(
      trace.data,
      scopeTriggerStart(trace.data, center),
      wanted,
      cssWidth,
      cssHeight,
      scopeFullScale(trace.fullScale, trace.gain) / WAVE_SWING,
      polyline,
      center,
    );
    const lift = (0.5 - WAVE_CENTER) * cssHeight;
    for (let k = 0; k < count; k++) polyline[2 * k + 1] = (polyline[2 * k + 1] ?? 0) - lift;
    cells.push({
      ...full,
      brightness: WAVE_BRIGHTNESS,
      style: 'trace',
      polyline,
      count,
    });
  }

  renderer.render(cells, {
    pixelRatio,
    crt: false,
    bloom: true,
    bloomStrength: BLOOM,
    barHalfHeight: Math.max(1.2, ledHeight / 2 - 1.2),
    timeMs: time,
  });
}

function readTheme(): void {
  if (!renderer) return;
  // The channel lines are the theme colour pushed towards white, like hot wire.
  const [r, g, b] = readScopeColor();
  renderer.color = [r + (1 - r) * 0.55, g + (1 - g) * 0.55, b + (1 - b) * 0.55];
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
  feed.releaseAll();
}

onMounted(start);
watch(glSupported, async () => {
  stop();
  await nextTick();
  start();
});
watch(
  () => props.trackCount,
  (count) => feed.releaseFrom(count),
);
watch(
  () => props.scopeSource,
  (source) => {
    if (source) feed.releaseAll();
  },
);
onBeforeUnmount(stop);
</script>

<style scoped>
/* Takes whatever the page leaves: the box is measured, not sized. */
.eq-wall {
  flex: 1;
  min-height: 0;
  min-width: 0;
  position: relative;
}

.eq-wall-area {
  position: absolute;
  inset: 0 18px 18px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.55);
}

.eq-wall-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
</style>
