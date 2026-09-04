<template>
  <div class="bug-report-panel">
    <div class="br-header">
      <span class="br-title">Bug report</span>
      <button
        type="button"
        class="br-close"
        title="Hide the bug-report tool"
        @click="$emit('close')"
      >
        ×
      </button>
    </div>

    <!--
      A caller-fixed range (e.g. mapped from a pattern selection) replaces
      the mark buttons: the range came from a selection, not from the clock.
    -->
    <div v-if="presetStart" class="br-marks br-marks-preset">
      <div class="br-mark-line">
        start: order {{ presetStart.order }} row {{ presetStart.row }} (0-based)
      </div>
      <div v-if="presetEnd" class="br-mark-line">
        end: order {{ presetEnd.order }} row {{ presetEnd.row }} (0-based)
      </div>
    </div>
    <template v-else>
      <div class="br-row">
        <button
          type="button"
          class="br-btn"
          :class="{ marked: startPosition !== null }"
          title="Capture the playback position where the problem starts"
          @click="markStart"
        >
          Mark start
        </button>
        <button
          type="button"
          class="br-btn"
          :class="{ marked: endPosition !== null }"
          title="Capture the playback position where the problem ends"
          @click="markEnd"
        >
          Mark end
        </button>
        <button
          v-if="startPosition !== null || endPosition !== null"
          type="button"
          class="br-btn ghost"
          title="Forget both marks"
          @click="clearMarks"
        >
          Clear marks
        </button>
      </div>

      <div class="br-marks">
        <div v-if="startPosition" class="br-mark-line">
          start: order {{ startPosition.order }} row {{ startPosition.row }} (0-based)
        </div>
        <div v-if="endPosition" class="br-mark-line">
          end: order {{ endPosition.order }} row {{ endPosition.row }} (0-based)
        </div>
        <div v-if="!startPosition && !endPosition" class="br-marks-empty">
          No marks — the report will use the current position as a single point.
        </div>
      </div>
    </template>

    <label class="br-label" for="bug-report-heard">What you hear</label>
    <textarea
      id="bug-report-heard"
      v-model="heard"
      class="br-input"
      rows="2"
      placeholder="e.g. buzz on the strings every second bar"
    ></textarea>

    <label class="br-label" for="bug-report-expected">What you expected</label>
    <textarea
      id="bug-report-expected"
      v-model="expected"
      class="br-input"
      rows="2"
      placeholder="e.g. clean string sound, like the original S3M"
    ></textarea>

    <div class="br-row">
      <button
        type="button"
        class="br-btn primary"
        :disabled="!hasSong"
        :title="hasSong ? 'Build the report and copy it to the clipboard' : 'Load a song first'"
        @click="copyReport"
      >
        Copy report
      </button>
      <span v-if="copied" class="br-confirmation">copied ✓</span>
      <span v-else-if="copyError" class="br-error">{{ copyError }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  buildBugReport,
  scanRangeForReport,
  type BugReportInstrument,
  type BugReportPosition,
} from 'src/composables/bug-report';
import type { BugReportPreset } from 'src/composables/bug-report-context';
import type { BugReportSongIdentity } from 'src/composables/bug-report';
import { getLoadedSongHash } from 'src/composables/song-identity';
import { useJukeboxStore } from 'src/stores/jukebox-store';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';
import { useTrackerStore } from 'src/stores/tracker-store';

/**
 * Everything a caller can pre-fill before the dialog opens; the shape is
 * owned by bug-report-context so every entry point shares it.
 */
const props = defineProps<{ preset?: BugReportPreset | null }>();

defineEmits<{ close: [] }>();

const jukebox = useJukeboxStore();
const playback = useTrackerPlaybackStore();
const trackerStore = useTrackerStore();

const startPosition = ref<BugReportPosition | null>(null);
const endPosition = ref<BugReportPosition | null>(null);
const heard = ref('');
const expected = ref('');
const copied = ref(false);
const copyError = ref('');

const hasSong = computed(
  () => props.preset?.songIdentity != null || jukebox.current !== null,
);

/** A caller-fixed range start; its presence swaps the mark buttons out. */
const presetStart = computed(() => props.preset?.startPosition ?? null);
const presetEnd = computed(() => props.preset?.endPosition ?? null);

/**
 * The latest playback position, fed by the playback store's position
 * listener. Pressing a mark captures it without racing the scheduler.
 */
let lastPosition: BugReportPosition | null = null;
let unsubscribePosition: (() => void) | null = null;

onMounted(() => {
  unsubscribePosition = playback.onPosition((row, patternId) => {
    lastPosition = {
      order: Math.max(0, playback.currentSequenceIndex),
      row,
      ...(patternId !== undefined ? { patternId } : {}),
    };
  });
});

onBeforeUnmount(() => {
  unsubscribePosition?.();
  unsubscribePosition = null;
});

function currentPosition(): BugReportPosition {
  // While playing — or paused mid-play — the listener holds the newest
  // position. Before any event has arrived (never played yet), the store's
  // refs carry the same values.
  const observed = lastPosition;
  if (observed) return observed;
  const order = Math.max(0, playback.currentSequenceIndex);
  const patternId = trackerStore.sequence[order];
  return {
    order,
    row: playback.playbackRow,
    ...(patternId !== undefined ? { patternId } : {}),
  };
}

function markStart(): void {
  startPosition.value = currentPosition();
  copied.value = false;
  copyError.value = '';
}

function markEnd(): void {
  endPosition.value = currentPosition();
  copied.value = false;
  copyError.value = '';
}

function clearMarks(): void {
  startPosition.value = null;
  endPosition.value = null;
}

/** The one instrument in the range, when the range uses exactly one. */
function instrumentForRange(instrumentIds: string[]): BugReportInstrument {
  // The scan already canonicalizes ids to the zero-padded form; pass that
  // through untouched rather than re-deriving from Number(), which would
  // mangle name-form instrument refs into NaN.
  const id = instrumentIds[0] as string;
  const slotNumber = Number(id);
  const slot = Number.isFinite(slotNumber)
    ? trackerStore.instrumentSlots.find((candidate) => candidate.slot === slotNumber)
    : undefined;
  const name = slot?.instrumentName?.trim();
  const instrument: BugReportInstrument = { id };
  if (name) instrument.name = name;
  return instrument;
}

async function copyReport(): Promise<void> {
  copied.value = false;
  copyError.value = '';

  // The fixed range wins; without one the marks (or the live position) do.
  const start = presetStart.value ?? startPosition.value ?? currentPosition();
  const end = presetStart.value
    ? props.preset?.endPosition
    : endPosition.value ?? undefined;
  const scan = scanRangeForReport(
    trackerStore.sequence,
    trackerStore.patterns,
    start,
    end,
  );

  // Preset identity wins; the fallback is the v1 jukebox wiring: with no
  // file hash the loaded song is not a module file, so its filename is
  // unknown — the jukebox entry would be a stale leftover. The song's own
  // title is what identifies it then.
  const sha256 = props.preset?.songIdentity?.sha256 ?? getLoadedSongHash();
  const fallbackIdentity: BugReportSongIdentity = {
    name: sha256 !== null ? jukebox.current?.file ?? '' : trackerStore.currentSong.title,
    ...(jukebox.current?.format ? { formatLabel: jukebox.current.format } : {}),
    ...(sha256 !== null ? { sha256 } : {}),
  };
  const songIdentity = props.preset?.songIdentity ?? fallbackIdentity;

  // The caller's channels (e.g. the selected columns) override the scan.
  const channels = props.preset?.channels ?? scan.channels;

  const report = buildBugReport({
    songIdentity,
    title: trackerStore.currentSong.title,
    build: `v${__APP_VERSION__} (${__APP_GIT_HASH__})`,
    startPosition: start,
    ...(end !== undefined ? { endPosition: end } : {}),
    ...(channels.length > 0 ? { channels } : {}),
    ...(scan.instrumentIds.length === 1
      ? { instrument: instrumentForRange(scan.instrumentIds) }
      : {}),
    heard: heard.value,
    expected: expected.value,
  });

  try {
    await navigator.clipboard.writeText(report);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (error) {
    copyError.value = `copy failed (${error instanceof Error ? error.message : 'unknown'})`;
  }
}
</script>

<style scoped>
.bug-report-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--panel-background, #101823);
  border: 1px solid rgba(77, 242, 197, 0.3);
  border-radius: 10px;
  padding: 10px 12px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
}

.br-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.br-title {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary, rgba(255, 255, 255, 0.7));
}

.br-close {
  background: none;
  border: none;
  color: var(--text-secondary, rgba(255, 255, 255, 0.6));
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}

.br-close:hover {
  color: var(--text-primary, #fff);
}

.br-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.br-btn {
  flex: 1;
  background: var(--button-background, rgba(255, 255, 255, 0.08));
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: var(--text-primary, #fff);
  font-size: 11px;
  padding: 5px 6px;
  cursor: pointer;
  white-space: nowrap;
}

.br-btn:hover:not(:disabled) {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.16));
}

.br-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.br-btn.marked {
  background: rgba(77, 242, 197, 0.16);
  border-color: rgba(77, 242, 197, 0.5);
}

.br-btn.primary {
  background: rgba(77, 242, 197, 0.16);
  border-color: rgba(77, 242, 197, 0.5);
}

.br-btn.ghost {
  background: transparent;
  color: var(--text-secondary, rgba(255, 255, 255, 0.7));
}

.br-marks {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--tracker-accent-primary, #4df2c5);
  min-height: 14px;
}

.br-marks-empty {
  color: var(--text-secondary, rgba(255, 255, 255, 0.45));
}

.br-label {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary, rgba(255, 255, 255, 0.5));
}

.br-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: var(--text-primary, #fff);
  font-size: 16px; /* 16px+: mobile browsers zoom smaller inputs */
  padding: 4px 8px;
}

.br-input::placeholder {
  color: var(--text-secondary, rgba(255, 255, 255, 0.45));
}

.br-input:focus {
  outline: none;
  border-color: var(--tracker-accent-primary, #4df2c5);
}

.br-confirmation {
  font-size: 11px;
  color: var(--tracker-accent-primary, #4df2c5);
}

.br-error {
  font-size: 11px;
  color: #ff7a7a;
}
</style>
