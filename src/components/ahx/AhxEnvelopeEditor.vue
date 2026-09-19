<template>
  <div ref="root" class="ahx-env" :class="{ 'ahx-env--dragging': dragging }" data-testid="ahx-envelope-editor">
    <svg
      class="ahx-env__svg"
      data-testid="ahx-envelope"
      :viewBox="`0 0 ${width} ${height}`"
      :width="width"
      :height="height"
      role="img"
      :aria-label="summary"
    >
      <defs>
        <pattern id="ahx-env-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" class="ahx-env__hatch" />
        </pattern>
      </defs>

      <!-- Stage bands, labelled A D S R along the top -->
      <g v-for="band in bands" :key="band.node">
        <rect
          :x="band.x"
          :y="M.top"
          :width="band.w"
          :height="plotH"
          class="ahx-env__band"
          :class="{ 'ahx-env__band--odd': band.odd }"
        />
        <text v-if="band.w >= 12" :x="band.x + band.w / 2" :y="M.top - 6" class="ahx-env__stage" text-anchor="middle">
          {{ band.node }}
        </text>
      </g>

      <!-- Grid and axes: volume 0..64 up, frames since the note began along -->
      <g class="ahx-env__grid">
        <template v-for="v in levelTicks" :key="`y${v}`">
          <line :x1="M.left" :x2="M.left + plotW" :y1="yOf(v)" :y2="yOf(v)" :class="{ 'ahx-env__zero': v === 0 }" />
          <text :x="M.left - 5" :y="yOf(v) + 3" text-anchor="end" class="ahx-env__tick">{{ v }}</text>
        </template>
        <template v-for="t in frameTicks" :key="`x${t}`">
          <line :x1="xOf(t)" :x2="xOf(t)" :y1="M.top" :y2="M.top + plotH" class="ahx-env__vgrid" />
          <text :x="xOf(t)" :y="M.top + plotH + 12" text-anchor="middle" class="ahx-env__tick">{{ t }}</text>
        </template>
        <text :x="M.left + plotW" :y="height - 4" text-anchor="end" class="ahx-env__unit">frames since note-on (1 frame = 1 replay tick)</text>
        <text :x="4" :y="M.top - 6" class="ahx-env__unit">level</text>
      </g>

      <!-- The instrument's volume scales the whole envelope: a ceiling and the scaled curve -->
      <g v-if="volume < 64">
        <polyline :points="scaledPoints" class="ahx-env__scaled" />
      </g>
      <line :x1="M.left" :x2="M.left + plotW" :y1="yOf(volume)" :y2="yOf(volume)" class="ahx-env__ceiling" data-testid="ahx-envelope-ceiling" />
      <text :x="M.left + plotW - 3" :y="yOf(volume) - 4" text-anchor="end" class="ahx-env__ceiling-label">volume {{ volume }}</text>

      <!-- The ideal envelope (the numbers at face value), dotted, only where the engine plays something else -->
      <polyline v-if="sim.differs" :points="idealPoints" class="ahx-env__ideal" data-testid="ahx-envelope-ideal" />
      <!-- The engine's own curve -->
      <polyline :points="enginePoints" class="ahx-env__line" data-testid="ahx-envelope-line" />

      <!-- Hard cut: a forced ramp (or mute) ending where the next note arrives -->
      <g v-if="cutOn" data-testid="ahx-envelope-hardcut">
        <rect :x="xOf(cutBefore)" :y="M.top" :width="Math.max(0, xOf(nextNote) - xOf(cutBefore))" :height="plotH" fill="url(#ahx-env-hatch)" />
        <polyline v-if="hardCutRelease" :points="cutPoints" class="ahx-env__cut" />
        <line v-else :x1="xOf(cutBefore)" :x2="xOf(cutBefore)" :y1="yOf(cutLevel)" :y2="yOf(0)" class="ahx-env__cut" />
        <line :x1="xOf(nextNote)" :x2="xOf(nextNote)" :y1="M.top" :y2="M.top + plotH" class="ahx-env__next" />
      </g>
    </svg>

    <button
      v-for="node in AHX_ENVELOPE_NODES"
      :key="node"
      type="button"
      role="slider"
      class="ahx-env__node"
      :class="[`ahx-env__node--${node}`, { 'ahx-env__node--active': activeNode === node }]"
      :style="nodeStyle(node)"
      :data-testid="`ahx-env-node-${node}`"
      :aria-label="`${ahxNodeName(node)} node`"
      :aria-valuemin="0"
      :aria-valuemax="255"
      :aria-valuenow="envelope[ahxNodeFramesField(node)]"
      :aria-valuetext="ahxNodeValueText(envelope, node)"
      :title="`${ahxNodeValueText(envelope, node)}. Drag, or use the arrow keys (Shift for bigger steps). Double-click to type.`"
      @pointerdown="onNodeDown(node, $event)"
      @keydown="onNodeKey(node, $event)"
      @dblclick="emit('focus-field', `ahx-env-${ahxNodeFramesField(node)}`)"
    />

    <template v-if="cutOn">
      <button
        type="button"
        role="slider"
        class="ahx-env__marker ahx-env__marker--next"
        data-testid="ahx-env-marker-next"
        aria-label="Next note arrives here (preview only, not saved)"
        :aria-valuemin="hardCutFrames"
        :aria-valuemax="1100"
        :aria-valuenow="nextNote"
        :aria-valuetext="`Next note arrives at frame ${nextNote}`"
        :style="{ left: `${xOf(nextNote)}px`, top: `${M.top}px` }"
        title="Where the next note arrives, for previewing the hard cut. Not saved."
        @pointerdown="onMarkerDown('next', $event)"
        @keydown="onMarkerKey('next', $event)"
      />
      <button
        type="button"
        role="slider"
        class="ahx-env__marker ahx-env__marker--lead"
        data-testid="ahx-env-marker-lead"
        aria-label="Hard cut lead in frames"
        :aria-valuemin="1"
        :aria-valuemax="7"
        :aria-valuenow="hardCutFrames"
        :aria-valuetext="`The hard cut starts ${hardCutFrames} frames before the next note`"
        :style="{ left: `${xOf(cutBefore)}px`, top: `${M.top + plotH - 14}px` }"
        title="How many frames before the next note the hard cut starts (hard cut frames)."
        @pointerdown="onMarkerDown('lead', $event)"
        @keydown="onMarkerKey('lead', $event)"
      />
    </template>

    <p v-if="hardCutFrames > 0" class="ahx-env__legend" data-testid="ahx-envelope-hardcut-note">
      <template v-if="hardCutRelease">
        Hard cut: when the next note on this channel arrives, the release is forced to the release level over the
        last {{ hardCutFrames }} {{ hardCutFrames === 1 ? 'frame' : 'frames' }} before it (hatched).
      </template>
      <template v-else>
        Hard cut is off for the release: the note is muted {{ hardCutFrames }}
        {{ hardCutFrames === 1 ? 'frame' : 'frames' }} before the next note instead of ramping.
      </template>
      Only songs have a next note; the audition keys never hard-cut.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AhxEnvelope } from '@another-synth/tracker-playback';
import { useAhxDrag, type AhxDragPoint } from 'src/composables/useAhxDrag';
import { simulateAhxEnvelope, ahxEnvelopeLength } from 'src/audio/tracker/ahx-envelope-sim';
import {
  AHX_ENVELOPE_NODES,
  ahxAxisFrames,
  ahxNodeDragPatch,
  ahxNodeFramesField,
  ahxNodeIsHorizontalOnly,
  ahxNodeKeyPatch,
  ahxNodeName,
  ahxNodePosition,
  ahxNodeStart,
  ahxNodeValueText,
  ahxTicks,
  type AhxEnvelopeNode,
} from 'src/audio/tracker/ahx-envelope-nodes';

interface Props {
  envelope: AhxEnvelope;
  /** The instrument's `volume`: it scales the envelope (`voice.rs:649`). */
  volume: number;
  hardCutRelease: boolean;
  hardCutFrames: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  /** One drag step or key press: the fields to set, together (one commit). */
  (event: 'change', patch: Partial<AhxEnvelope>): void;
  (event: 'hard-cut-frames', value: number): void;
  /** Double-click on a node: focus the typed field with this test id. */
  (event: 'focus-field', testid: string): void;
}>();

// ---- size: an SVG whose viewBox is the measured CSS size, never stretched ----
const root = ref<HTMLElement | null>(null);
const width = ref(480);
const height = ref(160);
let observer: ResizeObserver | null = null;

function measure(): void {
  const w = root.value?.clientWidth ?? 0;
  if (w > 0) {
    width.value = Math.max(240, Math.round(w));
    height.value = w < 520 ? 140 : 160;
  }
}
onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    observer = new ResizeObserver(measure);
    observer.observe(root.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());

const M = { left: 30, right: 12, top: 20, bottom: 34 };
const plotW = computed(() => width.value - M.left - M.right);
const plotH = computed(() => height.value - M.top - M.bottom);

// ---- the simulation and the axes -----------------------------------------------
/** Where the hard cut lands: the "next note arrives" frame. UI-only, never saved. */
const nextNoteAt = ref<number | null>(null);
const cutOn = computed(() => props.hardCutFrames > 0);
const nextNote = computed(() => {
  const sustainEnd = props.envelope.aFrames + props.envelope.dFrames + props.envelope.sFrames;
  const at = nextNoteAt.value ?? sustainEnd + props.hardCutFrames;
  return Math.max(props.hardCutFrames, at);
});
const cutBefore = computed(() => nextNote.value - props.hardCutFrames);

const sim = computed(() => simulateAhxEnvelope(props.envelope, props.volume));
const cutSim = computed(() =>
  cutOn.value
    ? simulateAhxEnvelope(props.envelope, props.volume, {
        before: cutBefore.value,
        frames: props.hardCutFrames,
        release: props.hardCutRelease,
      })
    : null,
);

/** The scale a drag froze at pointer-down, so the graph does not rescale under the cursor. */
const frozen = ref<{ axis: number; yMin: number } | null>(null);
const liveScale = computed(() => {
  const total = Math.max(ahxEnvelopeLength(props.envelope), cutOn.value ? nextNote.value : 0);
  return { axis: ahxAxisFrames(total), yMin: sim.value.lowest < 0 ? -64 : 0 };
});
const scale = computed(() => frozen.value ?? liveScale.value);

const xOf = (frame: number): number => M.left + (frame / scale.value.axis) * plotW.value;
const yOf = (level: number): number => {
  const { yMin } = scale.value;
  return M.top + ((64 - level) / (64 - yMin)) * plotH.value;
};

const frameTicks = computed(() => ahxTicks(scale.value.axis));
const levelTicks = computed(() => (scale.value.yMin < 0 ? [-64, -48, -32, -16, 0, 16, 32, 48, 64] : [0, 16, 32, 48, 64]));

const clampLevel = (level: number): number => Math.min(64, Math.max(scale.value.yMin, level));
const pointsOf = (frames: Array<[number, number]>): string =>
  frames.map(([f, v]) => `${xOf(f).toFixed(1)},${yOf(clampLevel(v)).toFixed(1)}`).join(' ');

const enginePoints = computed(() => pointsOf(sim.value.samples.map((s) => [s.frame, s.level / 256])));
const scaledPoints = computed(() => pointsOf(sim.value.samples.map((s) => [s.frame, s.output])));
const idealPoints = computed(() => pointsOf(sim.value.ideal.map((p) => [p.frame, p.volume])));
const cutLevel = computed(() => (sim.value.samples[Math.min(cutBefore.value, sim.value.samples.length - 1)]?.level ?? 0) / 256);
const cutPoints = computed(() => {
  const samples = cutSim.value?.samples ?? [];
  return pointsOf(
    samples.filter((s) => s.frame >= cutBefore.value && s.frame <= nextNote.value).map((s) => [s.frame, s.level / 256]),
  );
});

const bands = computed(() => {
  const env = props.envelope;
  return AHX_ENVELOPE_NODES.map((node, i) => {
    const start = ahxNodeStart(env, node);
    const end = ahxNodePosition(env, node).frame;
    return { node, x: xOf(start), w: Math.max(0, xOf(end) - xOf(start)), odd: i % 2 === 1 };
  });
});

const summary = computed(() => {
  const e = props.envelope;
  return (
    `Volume envelope in frames: attack ${e.aFrames} to level ${e.aVolume}, decay ${e.dFrames} to level ${e.dVolume}, ` +
    `sustain ${e.sFrames}, release ${e.rFrames} to level ${e.rVolume}; instrument volume ${props.volume}.`
  );
});

// ---- nodes -----------------------------------------------------------------------
function nodeStyle(node: AhxEnvelopeNode): Record<string, string> {
  const { frame, level } = ahxNodePosition(props.envelope, node);
  const x = Math.min(width.value - M.right, xOf(frame));
  return { left: `${x}px`, top: `${yOf(level)}px` };
}

const activeNode = ref<AhxEnvelopeNode | null>(null);

interface NodeDragStart {
  node: AhxEnvelopeNode;
  frame: number;
  level: number;
  pxPerFrame: number;
  pxPerLevel: number;
  lastSent: string;
}
let nodeStart: NodeDragStart | null = null;

const nodeDrag = useAhxDrag({
  onDrag(point: AhxDragPoint) {
    const start = nodeStart;
    if (!start) return;
    const patch = ahxNodeDragPatch(
      props.envelope,
      start.node,
      start.frame + point.dx / start.pxPerFrame,
      // Pixels grow downwards, levels upwards. The sustain has no level of its own.
      ahxNodeIsHorizontalOnly(start.node) ? start.level : start.level - point.dy / start.pxPerLevel,
    );
    const key = JSON.stringify(patch);
    if (key === start.lastSent) return;
    start.lastSent = key;
    emit('change', patch);
  },
  onEnd() {
    nodeStart = null;
    activeNode.value = null;
    frozen.value = null; // refit to the envelope the drag ended on
  },
});

function onNodeDown(node: AhxEnvelopeNode, event: PointerEvent): void {
  if (event.button > 0) return;
  (event.currentTarget as HTMLElement).focus();
  const { frame, level } = ahxNodePosition(props.envelope, node);
  frozen.value = { ...liveScale.value };
  nodeStart = {
    node,
    frame,
    level,
    pxPerFrame: plotW.value / frozen.value.axis,
    pxPerLevel: plotH.value / (64 - frozen.value.yMin),
    lastSent: '',
  };
  activeNode.value = node;
  nodeDrag.begin(event);
}

function onNodeKey(node: AhxEnvelopeNode, event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const patch = ahxNodeKeyPatch(props.envelope, node, event.key, event.shiftKey);
  // A key the node does not use (Escape, Tab, up/down on the sustain) is left alone.
  if (!patch) return;
  event.preventDefault();
  event.stopPropagation();
  const env = props.envelope as unknown as Record<string, number>;
  const changed = Object.entries(patch).some(([field, value]) => env[field] !== value);
  if (changed) emit('change', patch);
}

// ---- hard-cut markers (preview only; the lead is saved as hardCutReleaseFrames) --
type MarkerKind = 'next' | 'lead';
interface MarkerStart {
  kind: MarkerKind;
  next: number;
  frames: number;
  pxPerFrame: number;
}
let markerStart: MarkerStart | null = null;

const markerDrag = useAhxDrag({
  onDrag(point: AhxDragPoint) {
    const start = markerStart;
    if (!start) return;
    const moved = Math.round(point.dx / start.pxPerFrame);
    if (start.kind === 'next') {
      nextNoteAt.value = Math.max(start.frames, start.next + moved);
    } else {
      // Dragging the ramp start left lengthens the lead.
      const frames = Math.min(7, Math.max(1, start.frames - moved));
      if (frames !== props.hardCutFrames) emit('hard-cut-frames', frames);
    }
  },
  onEnd() {
    markerStart = null;
    frozen.value = null;
  },
});

function onMarkerDown(kind: MarkerKind, event: PointerEvent): void {
  if (event.button > 0) return;
  (event.currentTarget as HTMLElement).focus();
  frozen.value = { ...liveScale.value };
  // Pin the arrival frame so changing the lead moves the ramp's start, not the arrival.
  nextNoteAt.value = nextNote.value;
  markerStart = { kind, next: nextNote.value, frames: props.hardCutFrames, pxPerFrame: plotW.value / frozen.value.axis };
  markerDrag.begin(event);
}

function onMarkerKey(kind: MarkerKind, event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const step = event.shiftKey ? 8 : 1;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  event.stopPropagation();
  const dir = event.key === 'ArrowRight' ? 1 : -1;
  if (kind === 'next') {
    nextNoteAt.value = Math.max(props.hardCutFrames, nextNote.value + dir * step);
  } else {
    nextNoteAt.value = nextNote.value;
    const frames = Math.min(7, Math.max(1, props.hardCutFrames - dir * step));
    if (frames !== props.hardCutFrames) emit('hard-cut-frames', frames);
  }
}

const dragging = computed(() => nodeDrag.dragging.value || markerDrag.dragging.value);
</script>

<style scoped>
.ahx-env {
  position: relative;
  width: 100%;
  margin-bottom: 8px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 4px;
  user-select: none;
}

.ahx-env__svg {
  display: block;
  width: 100%;
}

.ahx-env__band {
  fill: rgba(255, 255, 255, 0.025);
}

.ahx-env__band--odd {
  fill: rgba(255, 255, 255, 0.05);
}

.ahx-env__stage {
  fill: currentColor;
  font-size: 10px;
  font-weight: 600;
  opacity: 0.7;
}

.ahx-env__grid line {
  stroke: rgba(255, 255, 255, 0.1);
  stroke-width: 1;
}

.ahx-env__grid .ahx-env__vgrid {
  stroke: rgba(255, 255, 255, 0.05);
}

.ahx-env__grid .ahx-env__zero {
  stroke: rgba(255, 255, 255, 0.3);
}

.ahx-env__tick,
.ahx-env__unit {
  fill: currentColor;
  font-size: 9px;
  opacity: 0.55;
}

.ahx-env__ceiling {
  stroke: #f0b25e;
  stroke-width: 1;
  stroke-dasharray: 4 3;
  opacity: 0.8;
}

.ahx-env__ceiling-label {
  fill: #f0b25e;
  font-size: 9px;
  opacity: 0.85;
}

.ahx-env__scaled {
  fill: none;
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-width: 1.5;
  opacity: 0.35;
}

.ahx-env__line {
  fill: none;
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-width: 2;
  stroke-linejoin: round;
}

.ahx-env__ideal {
  fill: none;
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-width: 1.5;
  stroke-dasharray: 2 4;
  opacity: 0.7;
}

.ahx-env__hatch {
  stroke: #f0b25e;
  stroke-width: 1;
  opacity: 0.35;
}

.ahx-env__cut {
  fill: none;
  stroke: #f0b25e;
  stroke-width: 2;
  stroke-dasharray: 5 3;
}

.ahx-env__next {
  stroke: #f0b25e;
  stroke-width: 1;
  stroke-dasharray: 3 3;
}

/* A 44 px hit area with a small visible handle inside it; touch-action only here, so the page still scrolls from the background. */
.ahx-env__node,
.ahx-env__marker {
  position: absolute;
  width: 44px;
  height: 44px;
  padding: 0;
  margin: -22px 0 0 -22px;
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.ahx-env__node::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  background: var(--app-background, #0b111a);
  border: 2px solid var(--tracker-accent-secondary, #5ec2e8);
  border-radius: 50%;
}

.ahx-env__node--S::before {
  border-radius: 2px;
  transform: rotate(45deg);
}

.ahx-env__node:hover::before,
.ahx-env__node--active::before,
.ahx-env__node:focus-visible::before {
  background: var(--tracker-accent-secondary, #5ec2e8);
}

.ahx-env__node:focus-visible,
.ahx-env__marker:focus-visible {
  outline: 2px solid var(--tracker-accent-primary, #f0b25e);
  outline-offset: -8px;
}

.ahx-env--dragging .ahx-env__node,
.ahx-env--dragging .ahx-env__marker {
  cursor: grabbing;
}

.ahx-env__marker {
  cursor: ew-resize;
  width: 28px;
  height: 28px;
  margin: -14px 0 0 -14px;
}

.ahx-env__marker::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  background: #f0b25e;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}

.ahx-env__marker--lead::before {
  clip-path: polygon(50% 0, 100% 100%, 0 100%);
}

.ahx-env__legend {
  margin: 0;
  padding: 4px 8px 6px;
  font-size: 0.75rem;
  opacity: 0.65;
}
</style>
