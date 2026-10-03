<template>
  <div class="xm-env" :data-testid="`xm-env-${kind}`">
    <div class="xm-env__bar">
      <label class="xm-env__check">
        <input type="checkbox" :checked="envelope.enabled" :data-testid="`xm-env-${kind}-on`" @change="onToggle('enabled', $event)" />
        On
      </label>
      <label class="xm-env__check" :class="{ 'xm-env__dim': !envelope.enabled }">
        <input type="checkbox" :checked="envelope.sustainEnabled" :disabled="!envelope.enabled" :data-testid="`xm-env-${kind}-sustain`" @change="onToggle('sustainEnabled', $event)" />
        Sustain
      </label>
      <label class="xm-env__check" :class="{ 'xm-env__dim': !envelope.enabled }">
        <input type="checkbox" :checked="envelope.loopEnabled" :disabled="!envelope.enabled" :data-testid="`xm-env-${kind}-loop`" @change="onToggle('loopEnabled', $event)" />
        Loop
      </label>
      <select class="xm-env__preset" :value="''" :data-testid="`xm-env-${kind}-preset`" @change="onPreset">
        <option value="" disabled>Preset…</option>
        <option v-for="p in presets" :key="p.id" :value="p.id">{{ p.label }}</option>
      </select>
    </div>

    <svg
      ref="svgEl"
      class="xm-env__svg"
      :viewBox="`-10 -10 ${W + 20} ${H + 20}`"
      role="img"
      :aria-label="`${kind} envelope, ${envelope.points.length} points`"
      @pointerdown="onPlotDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
    >
      <g class="xm-env__grid">
        <line v-for="v in [0, 16, 32, 48, 64]" :key="`y${v}`" :x1="0" :x2="W" :y1="yOf(v)" :y2="yOf(v)" :class="{ 'xm-env__mid': v === 32 && kind === 'panning' }" />
        <line v-for="f in [0, 81, 162, 243, 324]" :key="`x${f}`" :x1="xOf(f)" :x2="xOf(f)" :y1="0" :y2="H" />
      </g>
      <template v-if="envelope.enabled && envelope.points.length > 0">
        <line v-if="envelope.sustainEnabled && sustainPoint" :x1="xOf(sustainPoint.frame)" :x2="xOf(sustainPoint.frame)" :y1="0" :y2="H" class="xm-env__sustain" />
        <template v-if="envelope.loopEnabled && loopStartPoint && loopEndPoint">
          <rect :x="xOf(loopStartPoint.frame)" :y="0" :width="Math.max(0, xOf(loopEndPoint.frame) - xOf(loopStartPoint.frame))" :height="H" class="xm-env__loop" />
        </template>
        <polyline :points="line" class="xm-env__line" />
        <circle
          v-for="(p, i) in envelope.points"
          :key="i"
          :cx="xOf(p.frame)"
          :cy="yOf(p.value)"
          r="6"
          class="xm-env__point"
          :class="{ 'xm-env__point--active': i === dragging }"
          :data-testid="`xm-env-${kind}-point`"
          @pointerdown.stop="onPointDown($event, i)"
          @dblclick.stop="emit('update:envelope', removePoint(envelope, i))"
          @contextmenu.prevent.stop="emit('update:envelope', removePoint(envelope, i))"
        />
      </template>
    </svg>
    <div v-if="envelope.enabled" class="xm-env__fields">
      <AhxNumberField v-if="envelope.sustainEnabled" label="Sustain point" :model-value="envelope.sustainPoint + 1" :min="1" :max="Math.max(1, envelope.points.length)" :testid="`xm-env-${kind}-sustain-point`" @update:model-value="(v: number) => patch({ sustainPoint: v - 1 })" />
      <template v-if="envelope.loopEnabled">
        <AhxNumberField label="Loop from" :model-value="envelope.loopStart + 1" :min="1" :max="Math.max(1, envelope.points.length)" :testid="`xm-env-${kind}-loop-start`" @update:model-value="(v: number) => patch({ loopStart: v - 1 })" />
        <AhxNumberField label="Loop to" :model-value="envelope.loopEnd + 1" :min="1" :max="Math.max(1, envelope.points.length)" :testid="`xm-env-${kind}-loop-end`" @update:model-value="(v: number) => patch({ loopEnd: v - 1 })" />
      </template>
      <span class="xm-env__hint">Click to add a point, drag to move, double-click to remove ({{ envelope.points.length }}/{{ XM_MAX_ENVELOPE_POINTS }}).</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { XM_MAX_ENVELOPE_POINTS, type XmEnvelope } from '@another-synth/tracker-playback';
import AhxNumberField from 'src/components/ahx/AhxNumberField.vue';
import {
  XM_ENVELOPE_MAX_FRAME,
  XM_ENVELOPE_MAX_VALUE,
  XM_PANNING_PRESETS,
  XM_VOLUME_PRESETS,
  addPoint,
  applyEnvelopePreset,
  defaultEnvelope,
  envelopeWith,
  movePoint,
  removePoint,
} from 'src/audio/tracker/xm-sample-ops';

interface Props {
  envelope: XmEnvelope;
  kind: 'volume' | 'panning';
}
const props = defineProps<Props>();
const emit = defineEmits<{
  (event: 'update:envelope', envelope: XmEnvelope, preset?: { fadeout?: number }): void;
}>();

const W = 648;
const H = 180;
const svgEl = ref<SVGSVGElement | null>(null);
const dragging = ref<number | null>(null);

const presets = computed(() => (props.kind === 'volume' ? XM_VOLUME_PRESETS : XM_PANNING_PRESETS));
const xOf = (frame: number): number => (frame / XM_ENVELOPE_MAX_FRAME) * W;
const yOf = (value: number): number => H - (value / XM_ENVELOPE_MAX_VALUE) * H;
const line = computed(() => props.envelope.points.map((p) => `${xOf(p.frame)},${yOf(p.value)}`).join(' '));
const sustainPoint = computed(() => props.envelope.points[props.envelope.sustainPoint]);
const loopStartPoint = computed(() => props.envelope.points[props.envelope.loopStart]);
const loopEndPoint = computed(() => props.envelope.points[props.envelope.loopEnd]);

function patch(change: Partial<XmEnvelope>): void {
  emit('update:envelope', envelopeWith(props.envelope, change));
}

function onToggle(key: 'enabled' | 'sustainEnabled' | 'loopEnabled', event: Event): void {
  const on = (event.target as HTMLInputElement).checked;
  // Turning an empty envelope on gives it something to drag.
  if (key === 'enabled' && on && props.envelope.points.length < 2) {
    emit('update:envelope', defaultEnvelope(props.kind));
    return;
  }
  patch({ [key]: on });
}

function onPreset(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const preset = presets.value.find((p) => p.id === select.value);
  select.value = '';
  if (!preset) return;
  emit('update:envelope', applyEnvelopePreset(props.envelope, preset), preset.fadeout !== undefined ? { fadeout: preset.fadeout } : undefined);
}

function pointer(event: PointerEvent): { frame: number; value: number } {
  const rect = svgEl.value!.getBoundingClientRect();
  // The viewBox has a 10-unit margin all round so edge points are not clipped.
  const fx = (((event.clientX - rect.left) / Math.max(1, rect.width)) * (W + 20) - 10) / W;
  const fy = (((event.clientY - rect.top) / Math.max(1, rect.height)) * (H + 20) - 10) / H;
  return { frame: fx * XM_ENVELOPE_MAX_FRAME, value: (1 - fy) * XM_ENVELOPE_MAX_VALUE };
}

function onPointDown(event: PointerEvent, index: number): void {
  svgEl.value?.setPointerCapture(event.pointerId);
  dragging.value = index;
}

function onPlotDown(event: PointerEvent): void {
  if (!props.envelope.enabled) return;
  const { frame, value } = pointer(event);
  const next = addPoint(props.envelope, frame, value);
  if (next === props.envelope) return;
  emit('update:envelope', next);
  svgEl.value?.setPointerCapture(event.pointerId);
  dragging.value = next.points.findIndex((p) => p.frame === Math.round(frame));
}

function onMove(event: PointerEvent): void {
  const index = dragging.value;
  if (index === null || index < 0) return;
  const { frame, value } = pointer(event);
  emit('update:envelope', movePoint(props.envelope, index, frame, value));
}

function onUp(event: PointerEvent): void {
  dragging.value = null;
  svgEl.value?.releasePointerCapture?.(event.pointerId);
}
</script>

<style scoped>
.xm-env {
  display: grid;
  gap: 8px;
}

.xm-env__bar,
.xm-env__fields {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.xm-env__check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.xm-env__dim {
  opacity: 0.5;
}

.xm-env__preset {
  padding: 3px 8px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.3);
  color: inherit;
}

.xm-env__svg {
  width: 100%;
  height: auto;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.25);
  touch-action: none;
  cursor: crosshair;
}

.xm-env__grid line {
  stroke: rgba(255, 255, 255, 0.08);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.xm-env__grid .xm-env__mid {
  stroke: rgba(255, 255, 255, 0.22);
}

.xm-env__line {
  fill: none;
  stroke: var(--tracker-accent, #9ad7ff);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.xm-env__point {
  fill: var(--tracker-accent, #9ad7ff);
  stroke: #0b111a;
  stroke-width: 2;
  cursor: grab;
}

.xm-env__point--active {
  fill: #fff;
  cursor: grabbing;
}

.xm-env__sustain {
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-dasharray: 4 4;
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.xm-env__loop {
  fill: rgba(94, 194, 232, 0.14);
}

.xm-env__hint {
  opacity: 0.55;
  font-size: 0.85em;
}
</style>
