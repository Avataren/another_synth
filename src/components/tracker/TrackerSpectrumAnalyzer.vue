<template>
  <div class="spectrum-root">
    <canvas ref="leftCanvasRef" class="spectrum-canvas spectrum-canvas--left"></canvas>
    <canvas ref="rightCanvasRef" class="spectrum-canvas spectrum-canvas--right"></canvas>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { registerAnimationCallback } from 'src/composables/useAnimationLoop';

interface Props {
  /** Master mix output. Used as the analysis source for the "one channel
   *  per side" fallback mode (anything other than exactly 4 tracks). */
  node: AudioNode | null;
  /** Per-track output nodes, indexed by track index. When there are exactly
   *  4 (the classic Amiga MOD channel count), each track gets its own bar
   *  group -- see resolveChannelPanNorm in mod-import.ts, whose LRRL
   *  convention this mirrors: tracks 0 & 3 render in the left strip,
   *  tracks 1 & 2 in the right strip. */
  trackNodes?: (AudioNode | null)[];
  isPlaying: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  node: null,
  trackNodes: () => [],
  isPlaying: false
});

const leftCanvasRef = ref<HTMLCanvasElement | null>(null);
const rightCanvasRef = ref<HTMLCanvasElement | null>(null);

interface ChannelAnalyzer {
  analyser: AnalyserNode;
  dataArray: Uint8Array;
  smoothed: Float32Array;
  peaks: Float32Array;
  sourceNode: AudioNode | null;
}

/** One side's canvas, and the 1-2 channels drawn into it. Every channel on
 *  a side mirrors bass toward that side's inner edge (the one touching the
 *  pattern area) and treble toward the outer screen edge, so activity
 *  visually "points at" the tracker regardless of which side it's on. */
interface Side {
  canvasRef: typeof leftCanvasRef;
  /** Which edge of the canvas is nearest the tracker: bars grow away from
   *  it. -1 = inner edge is the canvas's right edge (bars grow left);
   *  +1 = inner edge is the canvas's left edge (bars grow right). */
  innerEdgeDirection: -1 | 1;
  channels: ChannelAnalyzer[];
  canvasWidth: number;
  canvasHeight: number;
  displayWidth: number;
  displayHeight: number;
  dpr: number;
  unregisterAnimation: (() => void) | null;
  resizeObserver: ResizeObserver | null;
}

type Mode = 'none' | 'quad' | 'stereo';

let currentMode: Mode = 'none';
let splitter: ChannelSplitterNode | null = null;
let connectedMasterNode: AudioNode | null = null;

const smoothingFactor = 0.7;
const peakDecay = 0.995;

let cachedColors: { primary: { r: number; g: number; b: number }; secondary: { r: number; g: number; b: number } } | null = null;
let themeObserver: MutationObserver | null = null;
let barColors: Array<{ r: number; g: number; b: number }> = [];
const MAX_BARS_PER_CHANNEL = 80;

const left: Side = {
  canvasRef: leftCanvasRef,
  innerEdgeDirection: -1,
  channels: [],
  canvasWidth: 0,
  canvasHeight: 0,
  displayWidth: 0,
  displayHeight: 0,
  dpr: 1,
  unregisterAnimation: null,
  resizeObserver: null,
};
const right: Side = {
  canvasRef: rightCanvasRef,
  innerEdgeDirection: 1,
  channels: [],
  canvasWidth: 0,
  canvasHeight: 0,
  displayWidth: 0,
  displayHeight: 0,
  dpr: 1,
  unregisterAnimation: null,
  resizeObserver: null,
};
const sides = [left, right];

function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--tracker-accent-primary').trim() || 'rgb(77, 242, 197)';
  const secondary = style.getPropertyValue('--tracker-accent-secondary').trim() || 'rgb(88, 176, 255)';

  const parseColor = (color: string) => {
    const match = color.match(/\d+/g);
    if (match && match.length >= 3) {
      return { r: parseInt(match[0]!), g: parseInt(match[1]!), b: parseInt(match[2]!) };
    }
    return { r: 77, g: 242, b: 197 };
  };

  return { primary: parseColor(accent), secondary: parseColor(secondary) };
}

function updateCachedColors() {
  cachedColors = getThemeColors();
  barColors = [];
  for (let i = 0; i < MAX_BARS_PER_CHANNEL; i++) {
    const t = i / MAX_BARS_PER_CHANNEL;
    barColors.push({
      r: Math.round(cachedColors.primary.r * (1 - t) + cachedColors.secondary.r * t),
      g: Math.round(cachedColors.primary.g * (1 - t) + cachedColors.secondary.g * t),
      b: Math.round(cachedColors.primary.b * (1 - t) + cachedColors.secondary.b * t)
    });
  }
}

function setupThemeObserver() {
  if (themeObserver) return;
  themeObserver = new MutationObserver(() => updateCachedColors());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class']
  });
}

/** Measures the actual rendered pattern grid (`.tracker-pattern`, centered
 *  within `.pattern-area-wrapper`) and sizes each side's canvas to exactly
 *  the real empty gutter beside it -- not a guessed percentage, which
 *  either wastes most of a wide monitor's space or overlaps the grid on a
 *  narrower one depending on track count. Falls back to a conservative
 *  fixed share if the grid element can't be found for some reason. */
function applyGutterWidths() {
  const wrapper = leftCanvasRef.value?.closest('.pattern-area-wrapper') as HTMLElement | null;
  if (!wrapper) return;
  const wrapperRect = wrapper.getBoundingClientRect();
  const grid = wrapper.querySelector('.tracker-pattern') as HTMLElement | null;
  const gap = 12; // breathing room between the strip and the grid

  let leftWidth: number;
  let rightWidth: number;
  if (grid) {
    const gridRect = grid.getBoundingClientRect();
    leftWidth = Math.max(0, gridRect.left - wrapperRect.left - gap);
    rightWidth = Math.max(0, wrapperRect.right - gridRect.right - gap);
  } else {
    leftWidth = wrapperRect.width * 0.15;
    rightWidth = leftWidth;
  }

  if (leftCanvasRef.value) leftCanvasRef.value.style.width = `${leftWidth}px`;
  if (rightCanvasRef.value) rightCanvasRef.value.style.width = `${rightWidth}px`;
}

function updateCanvasSize(side: Side) {
  const canvas = side.canvasRef.value;
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  side.dpr = window.devicePixelRatio || 1;
  const nextWidth = Math.max(1, Math.floor(rect.width * side.dpr));
  const nextHeight = Math.max(1, Math.floor(rect.height * side.dpr));

  if (side.canvasWidth !== nextWidth || side.canvasHeight !== nextHeight) {
    side.canvasWidth = nextWidth;
    side.canvasHeight = nextHeight;
    side.displayWidth = rect.width;
    side.displayHeight = rect.height;
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(side.dpr, side.dpr);
  }
}

function createChannelAnalyzer(audioContext: BaseAudioContext): ChannelAnalyzer {
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.75;
  return {
    analyser,
    dataArray: new Uint8Array(analyser.frequencyBinCount),
    smoothed: new Float32Array(analyser.frequencyBinCount),
    peaks: new Float32Array(analyser.frequencyBinCount),
    sourceNode: null,
  };
}

function connectChannel(channel: ChannelAnalyzer, sourceNode: AudioNode | null) {
  if (channel.sourceNode === sourceNode) return;
  if (channel.sourceNode) {
    try {
      channel.sourceNode.disconnect(channel.analyser);
    } catch {
      // Node may have already been disconnected
    }
  }
  channel.sourceNode = sourceNode;
  if (sourceNode) sourceNode.connect(channel.analyser);
}

function disconnectChannel(channel: ChannelAnalyzer) {
  connectChannel(channel, null);
  channel.analyser.disconnect();
}

function teardownGraph() {
  sides.forEach((side) => {
    side.channels.forEach(disconnectChannel);
    side.channels = [];
  });
  currentMode = 'none';

  if (connectedMasterNode && splitter) {
    try {
      connectedMasterNode.disconnect(splitter);
    } catch {
      // Node may have already been disconnected
    }
  }
  connectedMasterNode = null;
  if (splitter) {
    splitter.disconnect();
    splitter = null;
  }
}

function resolveMode(): Mode {
  // Once already in quad mode, stay there as long as there are still 4
  // tracks -- don't bounce out to 'stereo' (tearing down/rebuilding the
  // whole graph) just because every trackNode is momentarily null at a
  // pattern boundary (the instrument that was playing is still alive).
  if (props.trackNodes.length === 4) {
    if (currentMode === 'quad') return 'quad';
    if (props.trackNodes.some((n) => n)) return 'quad';
  }
  if (props.node) return 'stereo';
  return 'none';
}

/** Ensures the analyser graph matches the current props. Only tears down
 *  and recreates AnalyserNodes when the *mode* changes; otherwise just
 *  reconnects whichever individual channel sources changed. */
function syncGraph() {
  const mode = resolveMode();

  if (mode !== currentMode) {
    teardownGraph();
    currentMode = mode;

    if (mode === 'quad') {
      const audioContext = props.trackNodes.find((n) => n)?.context;
      if (!audioContext) {
        currentMode = 'none';
        return;
      }
      // Tracks 0 & 3 (left-panned in the classic Amiga LRRL layout) go in
      // the left strip; 1 & 2 (right-panned) go in the right strip.
      left.channels = [createChannelAnalyzer(audioContext), createChannelAnalyzer(audioContext)];
      right.channels = [createChannelAnalyzer(audioContext), createChannelAnalyzer(audioContext)];
    } else if (mode === 'stereo' && props.node) {
      buildStereoGraph(props.node);
    }
  } else if (mode === 'stereo' && props.node && props.node !== connectedMasterNode) {
    teardownGraph();
    currentMode = 'stereo';
    buildStereoGraph(props.node);
  }

  if (mode === 'quad') {
    // [track0, track3] -> left.channels[0], left.channels[1]
    // [track1, track2] -> right.channels[0], right.channels[1]
    const assignment: Array<[Side, number, number]> = [
      [left, 0, 0],
      [left, 1, 3],
      [right, 0, 1],
      [right, 1, 2],
    ];
    assignment.forEach(([side, channelIndex, track]) => {
      const channel = side.channels[channelIndex];
      const nextSource = props.trackNodes[track];
      // Ignore a transient null (pattern-boundary blip in the caller's own
      // node bookkeeping) rather than disconnecting -- the instrument that
      // was playing is still alive; only a genuinely different non-null
      // source should trigger a reconnect.
      if (channel && nextSource) connectChannel(channel, nextSource);
    });
  }

  sides.forEach((side) => updateAnimationState(side));
}

function buildStereoGraph(sourceNode: AudioNode) {
  const audioContext = sourceNode.context;
  splitter = audioContext.createChannelSplitter(2);
  sourceNode.connect(splitter);
  connectedMasterNode = sourceNode;

  const l = createChannelAnalyzer(audioContext);
  const r = createChannelAnalyzer(audioContext);
  splitter.connect(l.analyser, 0);
  splitter.connect(r.analyser, 1);
  left.channels = [l];
  right.channels = [r];
}

function updateChannelData(channel: ChannelAnalyzer, numBars: number) {
  channel.analyser.getByteFrequencyData(channel.dataArray);
  const bufferLength = channel.analyser.frequencyBinCount;
  for (let i = 0; i < numBars; i++) {
    const logIndex = Math.pow(i / numBars, 1.5) * (bufferLength * 0.7);
    const dataIndex = Math.min(Math.floor(logIndex), bufferLength - 1);

    const rawValue = channel.dataArray[dataIndex]! / 255;
    channel.smoothed[i] = channel.smoothed[i]! * smoothingFactor + rawValue * (1 - smoothingFactor);

    if (channel.smoothed[i]! > channel.peaks[i]!) {
      channel.peaks[i] = channel.smoothed[i]!;
    } else {
      channel.peaks[i] = channel.peaks[i]! * peakDecay;
    }
  }
}

/** Draws one channel across the *entire* width of its side's canvas.
 *  Every channel on a side shares the same inner-edge anchor (the edge
 *  facing the tracker) and the same bar count/width, computed from the
 *  full strip width -- so bass always starts at dead center (right where
 *  the strip meets the pattern area) and fans out toward the screen edge
 *  as frequency increases, using all the available room. When a side has
 *  more than one channel they're drawn on top of each other (canvas
 *  compositing blends the semi-transparent gradients), rather than each
 *  getting a cramped sub-column of the strip. */
function drawChannel(
  ctx: CanvasRenderingContext2D,
  side: Side,
  channel: ChannelAnalyzer,
  numBars: number,
  barWidth: number,
) {
  const innerX = side.innerEdgeDirection === -1 ? side.displayWidth : 0;
  const barGap = 2;

  // Most of the log-mapped bands past the first few are high frequencies
  // that sit near-silent for long stretches of typical tracker/chiptune
  // material. A tiny floor there reads as "empty" -- give every bar a
  // substantial guaranteed minimum size so the whole strip always looks
  // populated, with real signal adding on top of that baseline rather
  // than being the only thing that's visible at all.
  const minBarHeightPx = side.displayHeight * 0.04;

  for (let i = 0; i < numBars; i++) {
    const barHeight = Math.max(minBarHeightPx, channel.smoothed[i]! * side.displayHeight * 0.9);
    const peakHeight = channel.peaks[i]! * side.displayHeight * 0.9;

    const x =
      side.innerEdgeDirection === -1
        ? innerX - (i + 1) * barWidth
        : innerX + i * barWidth;
    const y = side.displayHeight - barHeight;

    const { r, g, b } = barColors[i] ?? barColors[0]!;

    const gradient = ctx.createLinearGradient(x, side.displayHeight, x, y);
    const baseOpacity = 0.45 + channel.smoothed[i]! * 0.45;
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${baseOpacity})`);
    gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${baseOpacity * 0.75})`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.05)`);

    ctx.fillStyle = gradient;
    ctx.fillRect(x + barGap / 2, y, barWidth - barGap, barHeight);

    if (peakHeight > 2 && channel.peaks[i]! > 0.05) {
      const peakY = side.displayHeight - peakHeight;
      const peakOpacity = Math.min(0.9, 0.35 + channel.peaks[i]! * 0.65);
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${peakOpacity})`;
      ctx.fillRect(x + barGap / 2, peakY, barWidth - barGap, 3);
    }
  }
}

function drawSide(side: Side) {
  const canvas = side.canvasRef.value;
  if (!canvas || side.channels.length === 0) return;
  updateCanvasSize(side);
  if (side.displayWidth === 0 || side.displayHeight === 0) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (!cachedColors) updateCachedColors();

  ctx.clearRect(0, 0, side.displayWidth, side.displayHeight);

  // One shared band count for the whole strip, sized to how much width is
  // actually available -- every channel on this side uses it, so they all
  // fan out from the same center point using the full strip.
  const numBars = Math.min(MAX_BARS_PER_CHANNEL, Math.floor(side.displayWidth / 8));
  if (numBars <= 0) return;
  const barWidth = side.displayWidth / numBars;

  side.channels.forEach((channel) => {
    updateChannelData(channel, numBars);
    drawChannel(ctx, side, channel, numBars, barWidth);
  });
}

function updateAnimationState(side: Side) {
  if (side.channels.length > 0) {
    if (!side.unregisterAnimation) {
      side.unregisterAnimation = registerAnimationCallback(() => drawSide(side));
    }
  } else if (side.unregisterAnimation) {
    side.unregisterAnimation();
    side.unregisterAnimation = null;
  }
}

function cleanup() {
  sides.forEach((side) => {
    if (side.unregisterAnimation) {
      side.unregisterAnimation();
      side.unregisterAnimation = null;
    }
    side.canvasWidth = 0;
    side.canvasHeight = 0;
    side.displayWidth = 0;
    side.displayHeight = 0;
  });
  teardownGraph();
}

let gridResizeObserver: ResizeObserver | null = null;

function remeasure() {
  applyGutterWidths();
  sides.forEach((side) => updateCanvasSize(side));
}

onMounted(() => {
  setupThemeObserver();
  updateCachedColors();

  sides.forEach((side) => {
    if (side.canvasRef.value && typeof ResizeObserver !== 'undefined') {
      side.resizeObserver = new ResizeObserver(() => updateCanvasSize(side));
      side.resizeObserver.observe(side.canvasRef.value);
    }
  });

  // Re-measure the gutter whenever the wrapper or the grid itself resizes
  // (e.g. window resize, or tracks added/removed changing the grid's own
  // width) -- not just when the canvas element's own box changes, since
  // that's a consequence of this measurement, not an independent trigger.
  if (typeof ResizeObserver !== 'undefined') {
    gridResizeObserver = new ResizeObserver(() => remeasure());
    const wrapper = leftCanvasRef.value?.closest('.pattern-area-wrapper');
    if (wrapper) gridResizeObserver.observe(wrapper);
    const grid = wrapper?.querySelector('.tracker-pattern');
    if (grid) gridResizeObserver.observe(grid);
  }

  // Wait two animation frames before the first real size measurement --
  // onMounted fires once this component's own DOM is attached, but the
  // ancestor pattern-area-wrapper (flex: 1; min-height: 0) may not have
  // its final flex-resolved box yet on a navigation-triggered mount.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      remeasure();
      syncGraph();
    });
  });
});

onUnmounted(() => {
  cleanup();
  sides.forEach((side) => {
    side.resizeObserver?.disconnect();
    side.resizeObserver = null;
  });
  gridResizeObserver?.disconnect();
  gridResizeObserver = null;
  if (themeObserver) {
    themeObserver.disconnect();
    themeObserver = null;
  }
});

watch(() => props.node, syncGraph);
watch(() => props.trackNodes, syncGraph);
</script>

<style scoped>
.spectrum-root {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 10;
}

.spectrum-canvas {
  position: absolute;
  top: 0;
  bottom: 0;
  /* Real width is set in JS (applyGutterWidths) from the actual measured
     gap beside the pattern grid -- this is just the fallback for the
     first paint before that measurement runs. */
  width: 15%;
  height: 100%;
}

.spectrum-canvas--left {
  left: 0;
}

.spectrum-canvas--right {
  right: 0;
}
</style>
