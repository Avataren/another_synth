<template>
  <q-page class="tracker-page">
    <div ref="trackerContainer" class="tracker-container" tabindex="0" @keydown="onKeyDown">
      <div class="top-grid">
        <div class="summary-card">
          <div class="summary-header">
            <div class="eyebrow">Tracker</div>
          </div>
          <div class="song-meta">
            <div class="field">
              <label for="song-title">Song title</label>
              <input
                id="song-title"
                v-model="currentSong.title"
                type="text"
                placeholder="Untitled song"
              />
            </div>
            <div class="field">
              <label for="song-author">Author</label>
              <input
                id="song-author"
                v-model="currentSong.author"
                type="text"
                placeholder="Unknown"
              />
            </div>
            <div class="field">
              <label for="song-bpm">BPM</label>
              <input
                id="song-bpm"
                v-model.number="currentSong.bpm"
                type="number"
                min="20"
                max="300"
                placeholder="120"
              />
            </div>
          </div>
          <div class="stats">
            <div class="stat-chip">
              <div class="stat-label">Tracks</div>
              <div class="stat-value">{{ tracks.length }}</div>
            </div>
            <div class="stat-chip">
              <div class="stat-label">Rows</div>
              <div class="stat-value">{{ rowsCount }}</div>
            </div>
            <div class="stat-chip">
              <div class="stat-label">Current row</div>
              <div class="stat-value">{{ activeRowDisplay }}</div>
            </div>
          </div>
          <div class="pattern-controls">
            <div class="control-label">Pattern length</div>
            <div class="control-field">
              <input
                class="length-input"
                type="number"
                :min="1"
                :max="256"
                :value="rowsCount"
                @change="onPatternLengthInput($event)"
              />
              <div class="control-hint">Rows</div>
            </div>
          </div>
          <div class="pattern-controls">
            <div class="control-label">Step size</div>
            <div class="control-field">
              <input
                class="length-input"
                type="number"
                :min="1"
                :max="64"
                :value="stepSize"
                @change="(event) => setStepSizeInput(Number((event.target as HTMLInputElement).value))"
              />
              <div class="control-hint">Rows per edit</div>
            </div>
          </div>
          <div class="pattern-controls">
            <label class="toggle">
              <input v-model="autoScroll" type="checkbox" />
              <span>Auto-scroll active row</span>
            </label>
          </div>
          <div class="transport transport-bottom">
            <button type="button" class="transport-button play" @click="handlePlay">
              Play
            </button>
            <button type="button" class="transport-button pause" @click="handlePause">
              Pause
            </button>
            <button type="button" class="transport-button stop" @click="handleStop">
              Stop
            </button>
          </div>
        </div>

        <div class="instrument-panel">
          <div class="panel-header">
            <div class="panel-title">Instruments</div>
            <div class="page-tabs">
              <button
                v-for="page in TOTAL_PAGES"
                :key="page"
                type="button"
                class="page-tab"
                :class="{ active: currentInstrumentPage === page - 1 }"
                @click="trackerStore.setInstrumentPage(page - 1)"
              >
                {{ page }}
              </button>
            </div>
          </div>
          <div class="instrument-list">
            <div
              v-for="slot in currentPageSlots"
              :key="slot.slot"
              class="instrument-row"
              :class="{
                active: activeInstrumentId === formatInstrumentId(slot.slot),
                empty: !slot.patchId
              }"
              @click="setActiveInstrument(slot.slot)"
            >
              <div class="slot-number">#{{ formatInstrumentId(slot.slot) }}</div>
              <div class="instrument-meta">
                <div class="patch-name">{{ slot.patchName || '—' }}</div>
                <div v-if="slot.patchId" class="patch-meta">
                  <span>Bank: <strong>{{ slot.bankName }}</strong></span>
                  <span class="dot">•</span>
                  <span>Instrument: <strong>{{ slot.instrumentName }}</strong></span>
                </div>
                <div v-else class="patch-meta">
                  <span class="empty-hint">No patch assigned</span>
                </div>
              </div>
              <div class="instrument-actions">
                <select
                  class="patch-select"
                  :value="slot.patchId ?? ''"
                  @change="onPatchSelect(slot.slot, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">Select patch</option>
                  <option
                    v-for="option in availablePatches"
                    :key="option.id"
                    :value="option.id"
                  >
                    {{ option.name }} ({{ option.bankName }})
                  </option>
                </select>
                <button
                  v-if="slot.patchId"
                  type="button"
                  class="action-button edit"
                  @click.stop="editSlotPatch(slot.slot)"
                >
                  Edit
                </button>
                <button
                  v-if="slot.patchId"
                  type="button"
                  class="action-button ghost"
                  @click.stop="clearInstrument(slot.slot)"
                >
                  Clear
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <TrackerPattern
        :tracks="tracks"
        :rows="rowsCount"
        :selected-row="activeRow"
        :playback-row="playbackRow"
        :active-track="activeTrack"
        :active-column="activeColumn"
        :auto-scroll="autoScroll"
        @rowSelected="setActiveRow"
        @cellSelected="setActiveCell"
      />
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import TrackerPattern from 'src/components/tracker/TrackerPattern.vue';
import type { TrackerEntryData, TrackerTrackData } from 'src/components/tracker/tracker-types';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type {
  Pattern as PlaybackPattern,
  Song as PlaybackSong,
  Step as PlaybackStep
} from '../../packages/tracker-playback/src/types';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type { SongBankSlot } from 'src/audio/tracker/song-bank';
import type { Patch } from 'src/audio/types/preset-types';
import { parseTrackerNoteSymbol, parseTrackerVolume } from 'src/audio/tracker/note-utils';
import { useTrackerStore, TOTAL_PAGES } from 'src/stores/tracker-store';
import { storeToRefs } from 'pinia';

interface BankPatchOption {
  id: string;
  name: string;
  bankId: string;
  bankName: string;
  source: 'system' | 'user';
}

interface RawPatchMeta {
  id?: string;
  name?: string;
}

interface RawPatch {
  metadata?: RawPatchMeta;
}

interface RawBank {
  metadata?: { id?: string; name?: string };
  patches?: RawPatch[];
}

const router = useRouter();
const trackerStore = useTrackerStore();
trackerStore.initializeIfNeeded();
const { currentSong, patternRows, stepSize, tracks, instrumentSlots, activeInstrumentId, currentInstrumentPage, songPatches } =
  storeToRefs(trackerStore);
const currentPageSlots = computed(() => trackerStore.currentPageSlots);
const activeRow = ref(0);
const activeTrack = ref(0);
const activeColumn = ref(0);
const columnsPerTrack = 4;
const trackerContainer = ref<HTMLDivElement | null>(null);
const availablePatches = ref<BankPatchOption[]>([]);
/** Library of available patches from system bank (for dropdown) */
const bankPatchLibrary = ref<Record<string, Patch>>({});
const rowsCount = computed(() => Math.max(patternRows.value ?? 64, 1));
const songBank = new TrackerSongBank();
const playbackEngine = new PlaybackEngine({
  instrumentResolver: (instrumentId) => songBank.prepareInstrument(instrumentId),
  noteHandler: (event) => {
    if (event.type === 'noteOn') {
      if (event.instrumentId === undefined || event.midi === undefined) return;
      const velocity = Number.isFinite(event.velocity) ? (event.velocity as number) : 100;
      songBank.noteOn(event.instrumentId, event.midi, velocity);
      return;
    }

    if (event.instrumentId === undefined) return;
    songBank.noteOff(event.instrumentId, event.midi);
  }
});
let unsubscribePosition: (() => void) | null = null;
const autoScroll = ref(true);
const playbackRow = ref(0);

const activeRowDisplay = computed(() => activeRow.value.toString(16).toUpperCase().padStart(2, '0'));

const noteKeyMap: Record<string, number> = {
  KeyZ: 48,
  KeyS: 49,
  KeyX: 50,
  KeyD: 51,
  KeyC: 52,
  KeyV: 53,
  KeyG: 54,
  KeyB: 55,
  KeyH: 56,
  KeyN: 57,
  KeyJ: 58,
  KeyM: 59,
  Comma: 60,
  KeyL: 61,
  Period: 62,
  Semicolon: 63,
  Slash: 64,
  KeyQ: 60,
  Digit2: 61,
  KeyW: 62,
  Digit3: 63,
  KeyE: 64,
  KeyR: 65,
  Digit5: 66,
  KeyT: 67,
  Digit6: 68,
  KeyY: 69,
  Digit7: 70,
  KeyU: 71,
  KeyI: 72,
  Digit9: 73,
  KeyO: 74,
  Digit0: 75,
  KeyP: 76,
  BracketLeft: 77,
  Equal: 78,
  BracketRight: 79,
  Backslash: 81
};
const formatInstrumentId = (slotNumber: number) => slotNumber.toString().padStart(2, '0');
const normalizeInstrumentId = (instrumentId?: string) => {
  if (!instrumentId) return undefined;
  const numeric = Number(instrumentId);
  if (Number.isFinite(numeric)) {
    return formatInstrumentId(numeric);
  }
  return instrumentId;
};

function setActiveRow(row: number) {
  const count = rowsCount.value;
  const clamped = Math.min(count - 1, Math.max(0, row));
  activeRow.value = clamped;
}

function setActiveCell(payload: { row: number; column: number; trackIndex: number }) {
  activeRow.value = payload.row;
  activeTrack.value = payload.trackIndex;
  activeColumn.value = payload.column;
}

function moveRow(delta: number) {
  setActiveRow(activeRow.value + delta);
}

function moveColumn(delta: number) {
  const nextColumn = activeColumn.value + delta;
  if (nextColumn < 0) {
    activeTrack.value = (activeTrack.value - 1 + tracks.value.length) % tracks.value.length;
    activeColumn.value = columnsPerTrack - 1;
    return;
  }

  if (nextColumn >= columnsPerTrack) {
    activeTrack.value = (activeTrack.value + 1) % tracks.value.length;
    activeColumn.value = 0;
    return;
  }

  activeColumn.value = nextColumn;
}

function jumpToNextTrack() {
  activeTrack.value = (activeTrack.value + 1) % tracks.value.length;
  activeColumn.value = 0;
}

function jumpToPrevTrack() {
  activeTrack.value = (activeTrack.value - 1 + tracks.value.length) % tracks.value.length;
  activeColumn.value = 0;
}

function setStepSizeInput(value: number) {
  if (!Number.isFinite(value)) return;
  const clamped = Math.max(1, Math.min(64, Math.round(value)));
  stepSize.value = clamped;
}

function advanceRowByStep() {
  moveRow(stepSize.value);
}

function ensureActiveInstrument() {
  if (activeInstrumentId.value) {
    const exists = instrumentSlots.value.some(
      (slot) => slot.patchId && formatInstrumentId(slot.slot) === activeInstrumentId.value
    );
    if (exists) return;
  }
  const firstWithPatch = instrumentSlots.value.find((slot) => slot.patchId);
  activeInstrumentId.value = firstWithPatch ? formatInstrumentId(firstWithPatch.slot) : null;
}

function setActiveInstrument(slotNumber: number) {
  activeInstrumentId.value = formatInstrumentId(slotNumber);
}

function updateEntryAt(
  row: number,
  trackIndex: number,
  mutator: (entry: TrackerEntryData) => TrackerEntryData
) {
  tracks.value = tracks.value.map((track, idx) => {
    if (idx !== trackIndex) return track;

    const existing = track.entries.find((e) => e.row === row);
    const baseInstrument =
      activeInstrumentId.value ??
      normalizeInstrumentId(existing?.instrument) ??
      formatInstrumentId(idx + 1);
    const draft: TrackerEntryData = existing
      ? { ...existing, instrument: existing.instrument ?? baseInstrument }
      : { row, instrument: baseInstrument };

    const mutated = mutator(draft);
    const filtered = track.entries.filter((e) => e.row !== row);
    filtered.push(mutated);
    filtered.sort((a, b) => a.row - b.row);

    return { ...track, entries: filtered };
  });
}

function insertNoteOff() {
  updateEntryAt(activeRow.value, activeTrack.value, (entry) => ({
    ...entry,
    note: '--'
  }));
  advanceRowByStep();
}

function clearStep() {
  tracks.value = tracks.value.map((track, idx) => {
    if (idx !== activeTrack.value) return track;
    return {
      ...track,
      entries: track.entries.filter((e) => e.row !== activeRow.value)
    };
  });
  advanceRowByStep();
}

function deleteRowAndShiftUp() {
  const currentRow = activeRow.value;
  const maxRow = rowsCount.value - 1;

  tracks.value = tracks.value.map((track, idx) => {
    if (idx !== activeTrack.value) return track;

    // Remove entries at current row, shift entries below up by one
    const newEntries = track.entries
      .filter((e) => e.row !== currentRow)
      .map((e) => {
        if (e.row > currentRow) {
          return { ...e, row: e.row - 1 };
        }
        return e;
      })
      .filter((e) => e.row <= maxRow);

    return { ...track, entries: newEntries };
  });
}

function insertRowAndShiftDown() {
  const currentRow = activeRow.value;
  const maxRow = rowsCount.value - 1;

  tracks.value = tracks.value.map((track, idx) => {
    if (idx !== activeTrack.value) return track;

    // Shift entries at and below current row down by one
    const newEntries = track.entries
      .map((e) => {
        if (e.row >= currentRow) {
          return { ...e, row: e.row + 1 };
        }
        return e;
      })
      .filter((e) => e.row <= maxRow);

    return { ...track, entries: newEntries };
  });
}

function hasPatchForInstrument(instrumentId: string): boolean {
  return instrumentSlots.value.some(
    (slot) => formatInstrumentId(slot.slot) === instrumentId && !!slot.patchId
  );
}

async function previewNote(instrumentId: string, midi: number, velocity = 100) {
  if (!hasPatchForInstrument(instrumentId)) return;
  await songBank.prepareInstrument(instrumentId);
  songBank.noteOn(instrumentId, midi, velocity);
  window.setTimeout(() => {
    songBank.noteOff(instrumentId, midi);
  }, 250);
}

function midiToTrackerNote(midi: number): string {
  const names = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
  const octave = Math.floor(midi / 12) - 1;
  const name = names[midi % 12] ?? 'C-';
  return `${name}${octave}`;
}

function handleNoteEntry(midi: number) {
  // Only enter notes when on the note column (column 0)
  if (activeColumn.value !== 0) return;

  const instrumentId =
    activeInstrumentId.value ?? formatInstrumentId(activeTrack.value + 1);
  updateEntryAt(activeRow.value, activeTrack.value, (entry) => ({
    ...entry,
    note: midiToTrackerNote(midi),
    instrument: instrumentId
  }));
  void previewNote(instrumentId, midi);
  advanceRowByStep();
}

function setPatternRows(count: number) {
  const clamped = Math.max(1, Math.min(256, Math.round(count)));
  patternRows.value = clamped;
  setActiveRow(activeRow.value);
  playbackEngine.setLength(clamped);
}

function onPatternLengthInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (Number.isFinite(value)) {
    setPatternRows(value);
  }
}

function resolveTrackInstrumentId(track: TrackerTrackData, trackIndex: number): string | undefined {
  const entryInstrument = normalizeInstrumentId(
    track.entries.find((entry) => entry.instrument)?.instrument
  );
  if (entryInstrument) {
    return entryInstrument;
  }
  if (activeInstrumentId.value) {
    return activeInstrumentId.value;
  }
  const slot = instrumentSlots.value[trackIndex];
  return slot?.patchId ? formatInstrumentId(slot.slot) : undefined;
}

function buildPlaybackStep(
  entry: TrackerEntryData,
  fallbackInstrumentId: string | undefined
): PlaybackStep | null {
  const instrumentId = normalizeInstrumentId(entry.instrument) ?? fallbackInstrumentId;
  const { midi, isNoteOff } = parseTrackerNoteSymbol(entry.note);
  const velocity = parseTrackerVolume(entry.volume);

  if (!instrumentId) return null;
  if (!isNoteOff && midi === undefined) return null;

  const step: PlaybackStep = {
    row: entry.row,
    instrumentId,
    isNoteOff
  };

  if (midi !== undefined) {
    step.midi = midi;
  }

  if (entry.note) {
    step.note = entry.note;
  }

  if (velocity !== undefined) {
    step.velocity = velocity;
  }

  return step;
}

function buildPlaybackPattern(): PlaybackPattern {
  return {
    id: 'pattern-1',
    length: rowsCount.value,
    tracks: tracks.value.map((track, trackIndex) => {
      const instrumentId = resolveTrackInstrumentId(track, trackIndex);
      const trackPayload: PlaybackPattern['tracks'][number] = {
        id: track.id,
        steps: track.entries
          .map((entry) => buildPlaybackStep(entry, instrumentId))
          .filter((step): step is PlaybackStep => step !== null)
      };

      if (instrumentId) {
        trackPayload.instrumentId = instrumentId;
      }

      return trackPayload;
    })
  };
}

function buildPlaybackSong(): PlaybackSong {
  return {
    title: currentSong.value.title,
    author: currentSong.value.author,
    bpm: currentSong.value.bpm,
    pattern: buildPlaybackPattern()
  };
}

async function syncSongBankFromSlots() {
  const slots: SongBankSlot[] = instrumentSlots.value
    .map((slot) => {
      if (!slot.patchId) return null;
      // Use song patches (patches are copied there when assigned)
      const patch = songPatches.value[slot.patchId];
      if (!patch) return null;
      return {
        instrumentId: formatInstrumentId(slot.slot),
        patch
      } satisfies SongBankSlot;
    })
    .filter(Boolean) as SongBankSlot[];

  await songBank.syncSlots(slots);
}

function initializePlayback() {
  // Save current position before reloading
  const currentPosition = playbackRow.value;
  const wasNotStopped = playbackEngine['state'] !== 'stopped';

  const song = buildPlaybackSong();
  playbackEngine.loadSong(song);
  playbackEngine.setLength(rowsCount.value);
  playbackEngine.setBpm(currentSong.value.bpm);

  // Restore position if we weren't stopped (e.g., paused while editing)
  if (wasNotStopped) {
    playbackEngine.seek(currentPosition);
    playbackRow.value = currentPosition;
  }

  unsubscribePosition?.();
  unsubscribePosition = playbackEngine.on('position', (pos) => {
    playbackRow.value = ((pos.row % rowsCount.value) + rowsCount.value) % rowsCount.value;
  });
}

async function handlePlay() {
  playbackEngine.setBpm(currentSong.value.bpm);
  playbackEngine.setLength(rowsCount.value);
  // Always start from the currently selected row
  playbackEngine.seek(activeRow.value);
  await syncSongBankFromSlots();
  await playbackEngine.play();
}

function handlePause() {
  // Set the active row to the current playback position
  activeRow.value = playbackRow.value;
  playbackEngine.pause();
  songBank.allNotesOff();
}

function handleStop() {
  playbackEngine.stop();
  playbackRow.value = 0;
  songBank.allNotesOff();
}

function togglePlayPause() {
  if (playbackEngine['state'] === 'playing') {
    handlePause();
  } else {
    void handlePlay();
  }
}

async function loadSystemBankOptions() {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}system-bank.json`, {
      cache: 'no-store'
    });
    if (!response.ok) return;
    const bank = (await response.json()) as RawBank;
    const bankName = bank?.metadata?.name ?? 'System Bank';
    const bankId = bank?.metadata?.id ?? 'system';
    const patches = Array.isArray(bank?.patches) ? bank.patches : [];
    const patchMap: Record<string, Patch> = {};
    availablePatches.value = patches
      .map((patch) => {
        const meta = patch?.metadata ?? {};
        if (!meta.id || !meta.name) return null;
        patchMap[meta.id as string] = patch as Patch;
        return {
          id: meta.id as string,
          name: meta.name as string,
          bankId,
          bankName,
          source: 'system' as const
        };
      })
      .filter(Boolean) as BankPatchOption[];
    bankPatchLibrary.value = patchMap;
    await syncSongBankFromSlots();
  } catch (error) {
    console.error('Failed to load system bank', error);
  }
}

function onKeyDown(event: KeyboardEvent) {
  // Don't process notes when typing in input fields
  const target = event.target as HTMLElement;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
    return;
  }

  const midiFromMap = noteKeyMap[event.code];
  if (midiFromMap !== undefined && !event.repeat) {
    event.preventDefault();
    ensureActiveInstrument();
    handleNoteEntry(midiFromMap);
    return;
  }

  switch (event.key) {
    case 'ArrowUp':
      event.preventDefault();
      moveRow(-1);
      break;
    case 'ArrowDown':
      event.preventDefault();
      moveRow(1);
      break;
    case 'ArrowLeft':
      event.preventDefault();
      moveColumn(-1);
      break;
    case 'ArrowRight':
      event.preventDefault();
      moveColumn(1);
      break;
    case 'Tab':
      event.preventDefault();
      if (event.shiftKey) {
        jumpToPrevTrack();
      } else {
        jumpToNextTrack();
      }
      break;
    case 'PageDown':
      event.preventDefault();
      moveRow(16);
      break;
    case 'PageUp':
      event.preventDefault();
      moveRow(-16);
      break;
    case ' ':
      event.preventDefault();
      togglePlayPause();
      break;
    case 'Insert':
      event.preventDefault();
      if (event.shiftKey) {
        insertRowAndShiftDown();
      } else {
        insertNoteOff();
      }
      break;
    case 'Delete':
      event.preventDefault();
      if (event.shiftKey) {
        deleteRowAndShiftUp();
      } else {
        clearStep();
      }
      break;
    default:
      break;
  }
}

function onPatchSelect(slotNumber: number, patchId: string) {
  if (!patchId) {
    trackerStore.clearSlot(slotNumber);
    ensureActiveInstrument();
    return;
  }

  const option = availablePatches.value.find((p) => p.id === patchId);
  if (!option) return;

  // Get the full patch from the bank library
  const patch = bankPatchLibrary.value[patchId];
  if (!patch) return;

  // Copy patch to song store
  trackerStore.assignPatchToSlot(slotNumber, patch, option.bankName);
  setActiveInstrument(slotNumber);
  ensureActiveInstrument();
}

function clearInstrument(slotNumber: number) {
  trackerStore.clearSlot(slotNumber);
  ensureActiveInstrument();
}

function editSlotPatch(slotNumber: number) {
  const slot = instrumentSlots.value.find(s => s.slot === slotNumber);
  if (!slot?.patchId) return;

  // Mark which slot we're editing
  trackerStore.startEditingSlot(slotNumber);

  // Navigate to synth page with query param
  void router.push({
    path: '/',
    query: { editSongPatch: slotNumber.toString() }
  });
}

onMounted(async () => {
  trackerContainer.value?.focus();
  await loadSystemBankOptions();
  ensureActiveInstrument();
  initializePlayback();
});

watch(
  () => currentSong.value.bpm,
  (bpm) => playbackEngine.setBpm(bpm),
  { immediate: true }
);

watch(
  () => rowsCount.value,
  (rows) => playbackEngine.setLength(rows),
  { immediate: true }
);

watch(
  () => tracks.value,
  () => initializePlayback(),
  { deep: true }
);

watch(
  () => instrumentSlots.value,
  () => {
    void syncSongBankFromSlots();
    initializePlayback();
  },
  { deep: true }
);

onBeforeUnmount(() => {
  unsubscribePosition?.();
  playbackEngine.stop();
  songBank.dispose();
});
</script>

<style scoped>
.tracker-page {
  min-height: var(--q-page-container-height, 100vh);
  background: radial-gradient(120% 140% at 20% 20%, rgba(80, 170, 255, 0.1), transparent),
    radial-gradient(120% 120% at 80% 10%, rgba(255, 147, 204, 0.1), transparent),
    linear-gradient(135deg, #0c111b, #0b0f18 55%, #0d1320);
  padding: 28px 0 36px;
  box-sizing: border-box;
}

.tracker-container {
  width: 100%;
  max-width: none;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
  outline: none;
}

.top-grid {
  display: grid;
  grid-template-columns: 1.1fr 1fr;
  gap: 14px;
  padding: 0 18px;
}

.eyebrow {
  color: #9cc7ff;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 700;
  margin-bottom: 4px;
}

.summary-card {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 12px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.summary-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.transport {
  display: inline-flex;
  gap: 8px;
  align-items: center;
}

.transport-bottom {
  justify-content: center;
  margin-top: auto;
  padding-top: 6px;
}

.transport-button {
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: #e8f3ff;
  font-weight: 700;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}

.transport-button:hover {
  border-color: rgba(77, 242, 197, 0.45);
}

.transport-button.play {
  background: linear-gradient(90deg, #4df2c5, #70c2ff);
  color: #0c1624;
  border-color: transparent;
}

.transport-button.stop {
  background: rgba(255, 99, 128, 0.18);
  border-color: rgba(255, 99, 128, 0.3);
}

.song-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field label {
  color: #9fb3d3;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 700;
}

.field input {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 10px 12px;
  color: #e8f3ff;
  font-weight: 600;
}

.field input::placeholder {
  color: rgba(255, 255, 255, 0.5);
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  max-width: 520px;
}

.stat-chip {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 10px 12px;
  color: #cfe4ff;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
}

.stat-label {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #9fb3d3;
}

.stat-value {
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.pattern-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.control-label {
  color: #9fb3d3;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 700;
}

.control-field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 6px 8px;
}

.length-input {
  width: 90px;
  background: transparent;
  border: none;
  color: #e8f3ff;
  font-weight: 700;
  font-size: 14px;
  text-align: right;
}

.length-input:focus {
  outline: none;
}

.control-hint {
  color: #9fb3d3;
  font-size: 12px;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #cfe4ff;
  font-weight: 700;
}

.toggle input {
  accent-color: #4df2c5;
}

.instrument-panel {
  background: linear-gradient(180deg, rgba(26, 32, 45, 0.9), rgba(16, 21, 33, 0.95));
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 12px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.32);
  height: 400px;
  display: flex;
  flex-direction: column;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.page-tabs {
  display: flex;
  gap: 4px;
}

.page-tab {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
  color: #9fb3d3;
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  transition: all 120ms ease;
}

.page-tab:hover {
  border-color: rgba(255, 255, 255, 0.2);
  color: #e8f3ff;
}

.page-tab.active {
  background: rgba(77, 242, 197, 0.15);
  border-color: rgba(77, 242, 197, 0.4);
  color: #4df2c5;
}

.panel-title {
  color: #e8f3ff;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.instrument-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  overflow-y: auto;
  padding-right: 6px;
}

.instrument-row {
  display: grid;
  grid-template-columns: 52px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
}

.instrument-row.active {
  border-color: rgba(77, 242, 197, 0.6);
  box-shadow: 0 0 0 1px rgba(77, 242, 197, 0.2);
}

.instrument-row.empty {
  opacity: 0.6;
  background: rgba(255, 255, 255, 0.01);
}

.empty-hint {
  color: #6b7a94;
  font-style: italic;
}

.slot-number {
  font-family: 'IBM Plex Mono', 'JetBrains Mono', monospace;
  color: #cfe4ff;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.instrument-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.patch-name {
  color: #e8f3ff;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.patch-meta {
  color: #9fb3d3;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.patch-meta strong {
  color: #cfe4ff;
}

.dot {
  color: rgba(255, 255, 255, 0.5);
}

.instrument-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.action-button {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(77, 242, 197, 0.12);
  color: #e8f3ff;
  font-weight: 700;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}

.action-button:hover {
  border-color: rgba(77, 242, 197, 0.45);
}

.action-button.edit {
  background: rgba(112, 194, 255, 0.15);
  border-color: rgba(112, 194, 255, 0.3);
}

.action-button.edit:hover {
  background: rgba(112, 194, 255, 0.25);
  border-color: rgba(112, 194, 255, 0.5);
}

.action-button.ghost {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.08);
}

.action-button.ghost:hover {
  border-color: rgba(255, 255, 255, 0.18);
}

.patch-select {
  min-width: 200px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: #e8f3ff;
  font-weight: 600;
}

.patch-select option {
  color: #0c1624;
}

@media (max-width: 900px) {
  .top-grid {
    grid-template-columns: 1fr;
  }
}
</style>
