<template>
  <div class="scope-wall" data-testid="scope-wall">
    <div
      ref="gridRef"
      class="scope-wall-grid"
      :style="{
        gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${grid.rows}, minmax(0, 1fr))`,
      }"
    >
      <div
        v-for="index in props.trackCount"
        :key="`wall-scope-${index - 1}`"
        class="scope-wall-cell"
        :class="{ muted: !props.isAudible(index - 1) }"
        :title="`Channel ${index} — click to mute, shift-click to solo`"
        data-testid="scope-wall-cell"
        @click="onCellClick($event, index - 1)"
      >
        <TrackWaveform
          :audio-node="props.audioNodes[index - 1] ?? null"
          :audio-context="props.audioContext"
          :scope-source="props.scopeSource"
          :analyser-full-scale="props.analyserFullScale?.(index - 1) ?? null"
          :scope-channel="index - 1"
          :scope-gain="props.scopeGain"
        />
        <div class="scope-wall-label">{{ index }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import TrackWaveform from 'src/components/tracker/TrackWaveform.vue';
import { scopeWallGrid } from 'src/components/tracker/scope-wall-layout';

/**
 * One oscilloscope per channel, tiled to fill the box it is given.
 *
 * The scopes are the same `TrackWaveform` the channel row uses, fed the same
 * way (a per-track tap, or the AHX worklet's per-voice snapshot); this only
 * decides the grid. It takes no position on where the taps come from, so the
 * tracker and the jukebox hand it what they already hand their scope row.
 */
interface Props {
  trackCount: number;
  audioNodes: Record<number, AudioNode | null>;
  audioContext: AudioContext | null;
  /** The AHX/HVL per-voice snapshot source; see `TrackWaveform`. */
  scopeSource?: ((channel: number) => Int16Array | null) | null;
  /** The triggered-scope scale of one channel (SID, OPL), or null for the plain trace. */
  analyserFullScale?: ((channel: number) => (() => number | null) | null) | null;
  scopeGain?: number;
  isAudible?: (channel: number) => boolean;
}

const props = withDefaults(defineProps<Props>(), {
  scopeSource: null,
  analyserFullScale: null,
  scopeGain: 1,
  isAudible: () => true,
});

const emit = defineEmits<{
  (e: 'toggle-mute', channel: number): void;
  (e: 'toggle-solo', channel: number): void;
}>();

const gridRef = ref<HTMLElement | null>(null);
const width = ref(0);
const height = ref(0);
let resizeObserver: ResizeObserver | null = null;

const grid = computed(() => scopeWallGrid(props.trackCount, width.value, height.value));

function measure(): void {
  const element = gridRef.value;
  if (!element) return;
  width.value = element.clientWidth;
  height.value = element.clientHeight;
}

function onCellClick(event: MouseEvent, channel: number): void {
  if (event.shiftKey) emit('toggle-solo', channel);
  else emit('toggle-mute', channel);
}

onMounted(() => {
  measure();
  if (typeof ResizeObserver !== 'undefined' && gridRef.value) {
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(gridRef.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<style scoped>
/* Takes whatever the page leaves: the box is measured, not sized. */
.scope-wall {
  flex: 1;
  min-height: 0;
  min-width: 0;
  position: relative;
}

.scope-wall-grid {
  position: absolute;
  inset: 0 18px 18px;
  display: grid;
  gap: 6px;
}

.scope-wall-cell {
  position: relative;
  min-width: 0;
  min-height: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.25);
  cursor: pointer;
}

.scope-wall-cell.muted {
  opacity: 0.25;
}

/* The scope's own 56px box and frame give way to the cell. */
.scope-wall-cell :deep(.track-waveform) {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
  background: transparent;
}

.scope-wall-label {
  position: absolute;
  left: 6px;
  top: 4px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary, rgba(255, 255, 255, 0.45));
  pointer-events: none;
}
</style>
