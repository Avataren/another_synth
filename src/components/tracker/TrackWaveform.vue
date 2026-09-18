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
  scopeTriggerStart,
  scopeVisiblePoints,
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
  /** Fixed display gain for the scope path (1, 2 or 4; clipped at the edge). */
  scopeGain?: number;
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
// The waveform draws in the theme's complement, like the spectrum strips it
// sits with (see theme-palette.ts); fallback is the default theme's.
let cachedWaveformColor = 'rgb(254, 65, 116)';
let cachedBgColor = '#0b111a';
let themeObserver: MutationObserver | null = null;

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
  // A scope source needs no analyser; the node path needs both.
  if (!canvasRef.value || (!props.scopeSource && (!analyser || !dataArray))) return;

  const canvas = canvasRef.value;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Initial size measurement
  updateCanvasSize();

  // Store references for the draw callback
  const localAnalyser = analyser;
  const localDataArray = dataArray;
  // Reused every frame by the scope path.
  let polyline = new Float32Array(0);

  const drawScope = (source: (channel: number) => Int16Array | null) => {
    const data = source(props.scopeChannel ?? 0);
    ctx.strokeStyle = cachedWaveformColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (!data || data.length < 4) {
      ctx.moveTo(0, canvasHeight / 2);
      ctx.lineTo(canvasWidth, canvasHeight / 2);
    } else {
      const count = scopeVisiblePoints(data.length);
      if (polyline.length < count * 2) polyline = new Float32Array(count * 2);
      const n = scopePolyline(
        data,
        scopeTriggerStart(data),
        count,
        canvasWidth,
        canvasHeight,
        scopeFullScale(AHX_SCOPE_FULL_SCALE, props.scopeGain),
        polyline,
      );
      for (let k = 0; k < n; k++) {
        const x = polyline[2 * k] ?? 0;
        const y = polyline[2 * k + 1] ?? 0;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  };

  const draw = () => {
    const source = props.scopeSource ?? null;
    if (!ctx || canvasWidth === 0) return;
    if (!source && (!localAnalyser || !localDataArray)) return;

    if (!source) localAnalyser!.getByteTimeDomainData(localDataArray!);

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
      drawScope(source);
      return;
    }
    const analyserData = localDataArray!;

    // Draw waveform
    ctx.strokeStyle = cachedWaveformColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const sliceWidth = canvasWidth / analyserData.length;
    let x = 0;

    for (let i = 0; i < analyserData.length; i++) {
      const sample = analyserData[i] ?? 128;
      // Convert from 0-255 range to -1 to +1 range (128 is center/silence)
      const v = (sample - 128) / 128.0;
      // Map to canvas: 0 is top, canvasHeight is bottom, center is canvasHeight/2
      // v=-1 should be at bottom (canvasHeight), v=+1 should be at top (0)
      const y = canvasHeight / 2 - (v * canvasHeight / 2);

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
  if (props.scopeSource) {
    startVisualization();
  } else if (props.audioContext) {
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
