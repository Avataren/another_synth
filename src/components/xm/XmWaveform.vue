<template>
  <div class="xm-wave" :class="{ 'xm-wave--draw': draw }" data-testid="xm-waveform">
    <canvas
      ref="canvasEl"
      class="xm-wave__canvas"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    />
    <span v-if="length === 0" class="xm-wave__empty">No sample</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

interface Props {
  data: Float32Array;
  loopStart: number;
  loopLength: number;
  /** Dragging draws sample values instead of moving the loop. */
  draw?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (event: 'update:loop', start: number, length: number): void;
  (event: 'update:data', data: Float32Array): void;
}>();

const canvasEl = ref<HTMLCanvasElement | null>(null);
const length = computed(() => props.data.length);
const looping = computed(() => props.loopLength >= 2);
let drag: 'start' | 'end' | 'new' | null = null;
let anchor = 0;
let drawing: Float32Array | null = null;
let lastFrame = -1;
let lastValue = 0;
let resizeObserver: ResizeObserver | null = null;

const HANDLE_PX = 8;

function css(name: string, fallback: string): string {
  const el = canvasEl.value;
  return (el && getComputedStyle(el).getPropertyValue(name).trim()) || fallback;
}

function render(): void {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  const mid = h / 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.stroke();
  const n = length.value;
  if (n === 0) return;

  if (looping.value) {
    const x0 = (props.loopStart / n) * w;
    const x1 = ((props.loopStart + props.loopLength) / n) * w;
    ctx.fillStyle = 'rgba(94,194,232,0.14)';
    ctx.fillRect(x0, 0, x1 - x0, h);
    ctx.fillStyle = css('--tracker-accent-secondary', '#5ec2e8');
    ctx.fillRect(x0, 0, 2 * dpr, h);
    ctx.fillRect(x1 - 2 * dpr, 0, 2 * dpr, h);
  }

  ctx.strokeStyle = css('--tracker-accent', '#9ad7ff');
  ctx.lineWidth = Math.max(1, dpr);
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const a = Math.floor((x / w) * n);
    const b = Math.max(a + 1, Math.floor(((x + 1) / w) * n));
    let lo = 1;
    let hi = -1;
    for (let i = a; i < b && i < n; i++) {
      const v = props.data[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    ctx.moveTo(x + 0.5, mid - hi * mid);
    ctx.lineTo(x + 0.5, mid - lo * mid + 1);
  }
  ctx.stroke();
}

function frameAt(event: PointerEvent): number {
  const rect = canvasEl.value!.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  return Math.round(frac * length.value);
}

function pxPerFrame(): number {
  return (canvasEl.value?.clientWidth ?? 1) / Math.max(1, length.value);
}

function paint(event: PointerEvent): void {
  if (!drawing) return;
  const rect = canvasEl.value!.getBoundingClientRect();
  const n = drawing.length;
  const frame = Math.max(0, Math.min(n - 1, Math.floor(((event.clientX - rect.left) / Math.max(1, rect.width)) * n)));
  const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)));
  const value = Math.max(-1, Math.min(1, (0.5 - y) * 2));
  // Fill the frames the pointer skipped so a fast stroke leaves no gaps.
  const from = lastFrame < 0 ? frame : lastFrame;
  const step = frame >= from ? 1 : -1;
  for (let f = from; f !== frame + step; f += step) {
    const t = frame === from ? 1 : (f - from) / (frame - from);
    drawing[f] = lastFrame < 0 ? value : lastValue + (value - lastValue) * t;
  }
  lastFrame = frame;
  lastValue = value;
  emit('update:data', Float32Array.from(drawing));
}

function onDown(event: PointerEvent): void {
  if (length.value < 4) return;
  canvasEl.value?.setPointerCapture(event.pointerId);
  if (props.draw) {
    drawing = Float32Array.from(props.data);
    lastFrame = -1;
    paint(event);
    return;
  }
  const at = frameAt(event);
  const px = HANDLE_PX / pxPerFrame();
  if (looping.value && Math.abs(at - props.loopStart) <= px) drag = 'start';
  else if (looping.value && Math.abs(at - (props.loopStart + props.loopLength)) <= px) drag = 'end';
  else {
    drag = 'new';
    anchor = at;
  }
}

function onMove(event: PointerEvent): void {
  if (drawing) {
    paint(event);
    return;
  }
  if (!drag) return;
  const at = frameAt(event);
  const end = props.loopStart + props.loopLength;
  if (drag === 'start') emit('update:loop', at, end - at);
  else if (drag === 'end') emit('update:loop', props.loopStart, at - props.loopStart);
  else emit('update:loop', Math.min(anchor, at), Math.abs(at - anchor));
}

function onUp(event: PointerEvent): void {
  drag = null;
  drawing = null;
  canvasEl.value?.releasePointerCapture?.(event.pointerId);
}

watch(() => [props.data, props.loopStart, props.loopLength], render);
onMounted(() => {
  render();
  if (canvasEl.value && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(canvasEl.value);
  }
});
onBeforeUnmount(() => resizeObserver?.disconnect());
</script>

<style scoped>
.xm-wave {
  position: relative;
  height: 220px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
}

.xm-wave__canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: col-resize;
}

.xm-wave--draw .xm-wave__canvas {
  cursor: crosshair;
  touch-action: none;
}

.xm-wave__empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.5;
  pointer-events: none;
}
</style>
