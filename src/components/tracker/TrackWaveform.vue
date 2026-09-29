<template>
  <div class="track-waveform">
    <canvas ref="canvasRef"></canvas>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { registerAnimationCallback } from 'src/composables/useAnimationLoop';
import { AHX_SCOPE_FULL_SCALE } from 'src/audio/worklets/ahx-core';
import {
  scopePolyline,
  scopeFullScale,
  scopeMidrange,
  scopeTriggerStart,
  scopeVisiblePoints,
  scopeAnalyserSize,
} from 'src/components/tracker/scope-trace';

interface Props {
  audioNode: AudioNode | null;
  audioContext: AudioContext | null;
  /**
   * Draws `scopeChannel`'s waveform from here instead of tapping `audioNode`:
   * the AHX/HVL engine mixes its voices inside one worklet, so there is no
   * per-track node to analyse. Returns the newest snapshot (`i16`, oldest
   * first) or `null` while nothing plays, which draws a flat line.
   */
  scopeSource?: ((channel: number) => Int16Array | null) | null;
  scopeChannel?: number;
  /**
   * Draws `audioNode` as a triggered oscilloscope instead of the plain
   * analyser trace: a still waveform drawn around its midrange (the source
   * is DC-blocked), with a swing of twice this value (read every frame;
   * `null` falls back to 1.0) spanning the height, less a little headroom
   * (`ANALYSER_SCOPE_HEADROOM`). For a source whose voices
   * run well below full scale, like a SID voice tap at its share of the
   * chip's mix (`getSidVoiceFullScale`).
   */
  analyserFullScale?: (() => number | null) | null;
  /** Fixed display gain for both scope paths (1, 2 or 4; clipped at the edge). */
  scopeGain?: number;
}

const props = defineProps<Props>();

/**
 * Analyser window of the triggered scope of a source with a known full scale
 * (SID, OPL; as AHX_SCOPE_WINDOW_FRAMES). The plain trace of a sampled format
 * sizes its own to the cell (`scopeAnalyserSize`).
 */
const SCOPE_FFT_SIZE = 2048;
/**
 * Headroom over `analyserFullScale` in the triggered scope. A DC blocker lets
 * a slow pulse droop between edges, so each edge overshoots its full swing:
 * up to 1.11x measured on GoatTracker demos. 1.15 keeps those in the scope.
 */
const ANALYSER_SCOPE_HEADROOM = 1.15;

const canvasRef = ref<HTMLCanvasElement | null>(null);
let analyser: AnalyserNode | null = null;
let floatData: Float32Array | null = null;
let unregisterAnimation: (() => void) | null = null;
let currentConnectedNode: AudioNode | null = null;

/** Trace stroke width in CSS pixels. */
const TRACE_LINE_WIDTH = 2.5;
/**
 * The glow under the trace: the same path stroked wider and faint first, so
 * the sharp line sits in a soft halo like a phosphor scope's.
 */
const GLOW_LINE_WIDTH = 7;
const GLOW_ALPHA = 0.2;

// Cached canvas dimensions (CSS pixels) - only update on resize. The bitmap is
// `pixelRatio` times that, so a HiDPI screen gets a sharp line instead of an
// upscaled one; drawing stays in CSS pixels through the context transform.
let canvasWidth = 0;
let canvasHeight = 0;
let pixelRatio = 1;

// Cached theme colors - updated only when theme changes
// The waveform draws in the theme's complement, like the spectrum strips it
// sits with (see theme-palette.ts); fallback is the default theme's.
let cachedWaveformColor = 'rgb(254, 65, 116)';
let cachedBgColor = '#0b111a';
let themeObserver: MutationObserver | null = null;
// The box can change size without the window doing so (a flex band reflowing).
let resizeObserver: ResizeObserver | null = null;

function updateCachedColors() {
  const style = getComputedStyle(document.documentElement);
  cachedWaveformColor =
    style.getPropertyValue('--tracker-accent-complement').trim() || 'rgb(254, 65, 116)';
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
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  if (rect.width !== canvasWidth || rect.height !== canvasHeight || ratio !== pixelRatio) {
    canvasWidth = rect.width;
    canvasHeight = rect.height;
    pixelRatio = ratio;
    canvas.width = Math.round(canvasWidth * ratio);
    canvas.height = Math.round(canvasHeight * ratio);
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
  // Without a context given, the node's own (an editor's preview voice).
  const context = props.audioContext ?? props.audioNode?.context ?? null;
  if (!context) return;

  // Create analyser if we don't have one yet
  if (!analyser) {
    analyser = context.createAnalyser();
    analyser.fftSize = SCOPE_FFT_SIZE;
  }

  // Always disconnect the current node first when the prop changes
  // This ensures we don't keep showing audio from a previous connection
  if (currentConnectedNode && currentConnectedNode !== props.audioNode) {
    disconnectCurrentNode();
  }

  // Connect to audio node if we have one and not already connected
  if (props.audioNode && props.audioNode !== currentConnectedNode) {
    props.audioNode.connect(analyser);
    currentConnectedNode = props.audioNode;
  }

  // Start visualization if not already running
  if (!unregisterAnimation) {
    startVisualization();
  }
}

function startVisualization() {
  // A scope source needs no analyser; the node path does.
  if (!canvasRef.value || (!props.scopeSource && !analyser)) return;

  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Initial size measurement
  updateCanvasSize();

  // Store references for the draw callback
  const localAnalyser = analyser;
  // Reused every frame by the scope path.
  let polyline = new Float32Array(0);

  // `centered`: draw around the window's midrange (a DC-blocked source).
  // `gain`: the display gain; the sampled formats' plain trace takes none.
  const drawScope = (
    data: ArrayLike<number> | null,
    fullScale: number,
    centered = false,
    gain: number | undefined = props.scopeGain,
  ) => {
    ctx.beginPath();
    if (!data || data.length < 4) {
      ctx.moveTo(0, canvasHeight / 2);
      ctx.lineTo(canvasWidth, canvasHeight / 2);
    } else {
      const count = scopeVisiblePoints(data.length);
      const center = centered ? scopeMidrange(data) : 0;
      if (polyline.length < count * 2) polyline = new Float32Array(count * 2);
      const n = scopePolyline(
        data,
        scopeTriggerStart(data, center),
        count,
        canvasWidth,
        canvasHeight,
        scopeFullScale(fullScale, gain),
        polyline,
        center,
      );
      for (let k = 0; k < n; k++) {
        const x = polyline[2 * k] ?? 0;
        const y = polyline[2 * k + 1] ?? 0;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    // Glow first, then the line itself over it.
    ctx.strokeStyle = cachedWaveformColor;
    ctx.globalAlpha = GLOW_ALPHA;
    ctx.lineWidth = GLOW_LINE_WIDTH;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = TRACE_LINE_WIDTH;
    ctx.stroke();
  };

  const draw = () => {
    const source = props.scopeSource ?? null;
    const analyserFullScale = props.analyserFullScale ?? null;
    if (!ctx || canvasWidth === 0) return;
    if (!source && !localAnalyser) return;

    // Both analyser paths read floats through the triggered scope; only the
    // window differs (fixed for a known full scale, one point per pixel else).
    if (!source && localAnalyser) {
      const size = analyserFullScale ? SCOPE_FFT_SIZE : scopeAnalyserSize(canvasWidth);
      if (localAnalyser.fftSize !== size) localAnalyser.fftSize = size;
      if (floatData?.length !== size) floatData = new Float32Array(size);
      localAnalyser.getFloatTimeDomainData(floatData);
    }

    // Resizing the bitmap resets the transform, so set it every frame: the
    // rest of the draw works in CSS pixels. Round joins and caps keep the
    // thicker line from spiking at sharp corners of the trace.
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

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

    if (source) {
      drawScope(source(props.scopeChannel ?? 0), AHX_SCOPE_FULL_SCALE);
      return;
    }
    if (analyserFullScale) {
      const fullScale = analyserFullScale();
      drawScope(floatData, (fullScale && fullScale > 0 ? fullScale : 1) * ANALYSER_SCOPE_HEADROOM, true);
      return;
    }
    // A sampled format's track: full scale is 1.0, drawn about zero, with no
    // display gain (that setting is for the AHX/HVL scopes).
    drawScope(floatData, 1, false, 1);
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

  floatData = null;
  canvasWidth = 0;
  canvasHeight = 0;
}

function handleResize() {
  updateCanvasSize();
}

onMounted(() => {
  window.addEventListener('resize', handleResize);
  if (typeof ResizeObserver !== 'undefined' && canvasRef.value) {
    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(canvasRef.value);
  }
  updateCachedColors();
  setupThemeObserver();
  if (props.scopeSource) {
    startVisualization();
  } else {
    setupAnalyser();
  }
});

onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  resizeObserver?.disconnect();
  resizeObserver = null;
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

// A component instance can outlive a song: the visualizer row stays up when an
// AHX song replaces a MOD one (or back). Restart the draw loop in the new mode.
watch(
  () => props.scopeSource,
  () => {
    if (unregisterAnimation) {
      unregisterAnimation();
      unregisterAnimation = null;
    }
    if (props.scopeSource) startVisualization();
    else setupAnalyser();
  }
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
