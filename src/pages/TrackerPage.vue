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
            <button type="button" class="action-button add" @click="addInstrumentSlot">
              Add instrument
            </button>
          </div>
        <div class="instrument-list">
          <div
            v-if="visibleSlots.length === 0"
            class="empty-state"
          >
            No instruments assigned yet. Add one to link a patch.
          </div>
          <div
            v-for="slot in visibleSlots"
            :key="slot.slot"
            class="instrument-row"
            :class="{ active: activeInstrumentId === formatInstrumentId(slot.slot) }"
            @click="setActiveInstrument(slot.slot)"
          >
            <div class="slot-number">#{{ formatInstrumentId(slot.slot) }}</div>
            <div class="instrument-meta">
              <div class="patch-name">{{ slot.patchName }}</div>
              <div class="patch-meta">
                  <span>Bank: <strong>{{ slot.bankName }}</strong></span>
                  <span class="dot">•</span>
                  <span>Instrument: <strong>{{ slot.instrumentName }}</strong></span>
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
                  type="button"
                  class="action-button ghost"
                  @click="clearInstrument(slot.slot)"
                >
                  Clear
                </button>
                <button
                  type="button"
                  class="action-button ghost danger"
                  @click="removeInstrument(slot.slot)"
                >
                  Remove
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
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
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

interface InstrumentSlot {
  slot: number;
  bankId?: string | undefined;
  bankName: string;
  patchId?: string | undefined;
  patchName: string;
  instrumentName: string;
  empty?: boolean;
  source?: 'system' | 'user' | undefined;
}

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

interface PatternMetadata {
  rows: number;
}

class SongMetadata {
  title: string;
  author: string;
  bpm: number;

  constructor(title = 'Untitled song', author = 'Unknown', bpm = 120) {
    this.title = title;
    this.author = author;
    this.bpm = bpm;
  }
}

const patternMeta = ref<PatternMetadata>({ rows: 64 });
const currentSong = reactive(new SongMetadata());
const activeRow = ref(0);
const activeTrack = ref(0);
const activeColumn = ref(0);
const columnsPerTrack = 4;
const trackerContainer = ref<HTMLDivElement | null>(null);
const availablePatches = ref<BankPatchOption[]>([]);
const patchLibrary = ref<Record<string, Patch>>({});
const visibleSlots = computed(() => instrumentSlots.value.filter((slot) => !slot.empty));
const rowsCount = computed(() => Math.max(patternMeta.value.rows ?? 64, 1));
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

const tracks = ref<TrackerTrackData[]>([
  {
    id: 'T01',
    name: 'Track 1',
    color: '#4df2c5',
    entries: [
      { row: 0, note: 'C-2', instrument: '01', volume: '7F' },
      { row: 4, note: 'C-2', instrument: '01', volume: '7F' },
      { row: 8, note: 'C-2', instrument: '01', volume: '7F' },
      { row: 12, note: 'C-2', instrument: '01', volume: '7F' }
    ]
  },
  {
    id: 'T02',
    name: 'Track 2',
    color: '#9da6ff',
    entries: [
      { row: 4, note: 'D-2', instrument: '02', volume: '70' },
      { row: 12, note: 'D-2', instrument: '02', volume: '70' }
    ]
  },
  {
    id: 'T03',
    name: 'Track 3',
    color: '#ffde7b',
    entries: [
      { row: 2, note: 'F#2', instrument: '03', volume: '60' },
      { row: 6, note: 'F#2', instrument: '03', volume: '60' },
      { row: 10, note: 'F#2', instrument: '03', volume: '60' },
      { row: 14, note: 'F#2', instrument: '03', volume: '60' }
    ]
  },
  {
    id: 'T04',
    name: 'Track 4',
    color: '#70c2ff',
    entries: [
      { row: 0, note: 'C-3', instrument: '04', volume: '68', effect: 'GLD' },
      { row: 4, note: 'G-2', instrument: '04', volume: '64' },
      { row: 8, note: 'A-2', instrument: '04', volume: '64', effect: 'SLD' },
      { row: 12, note: 'G-2', instrument: '04', volume: '64' }
    ]
  },
  {
    id: 'T05',
    name: 'Track 5',
    color: '#ff9db5',
    entries: [
      { row: 2, note: 'E-4', instrument: '05', volume: '70', effect: 'VIB' },
      { row: 6, note: 'G-4', instrument: '05', volume: '70' },
      { row: 10, note: 'B-3', instrument: '05', volume: '70' },
      { row: 14, note: 'A-3', instrument: '05', volume: '70', effect: 'SLD' }
    ]
  },
  {
    id: 'T06',
    name: 'Track 6',
    color: '#8ef5c5',
    entries: [
      { row: 0, note: 'C-4', instrument: '06', volume: '50' },
      { row: 8, note: 'F-3', instrument: '06', volume: '50' }
    ]
  },
  {
    id: 'T07',
    name: 'Track 7',
    color: '#ffa95e',
    entries: [
      { row: 7, note: 'G-5', instrument: '07', volume: '40', effect: 'ECO' },
      { row: 15, note: 'C-5', instrument: '07', volume: '40', effect: 'ECO' }
    ]
  },
  {
    id: 'T08',
    name: 'Track 8',
    color: '#b08bff',
    entries: [
      { row: 3, note: 'A#2', instrument: '08', volume: '55' },
      { row: 11, note: 'G#2', instrument: '08', volume: '55' }
    ]
  }
]);

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
const instrumentSlots = ref<InstrumentSlot[]>([]);
const formatInstrumentId = (slotNumber: number) => slotNumber.toString().padStart(2, '0');
const normalizeInstrumentId = (instrumentId?: string) => {
  if (!instrumentId) return undefined;
  const numeric = Number(instrumentId);
  if (Number.isFinite(numeric)) {
    return formatInstrumentId(numeric);
  }
  return instrumentId;
};
const activeInstrumentId = ref<string | null>(null);

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
}

function clearStep() {
  tracks.value = tracks.value.map((track, idx) => {
    if (idx !== activeTrack.value) return track;
    return {
      ...track,
      entries: track.entries.filter((e) => e.row !== activeRow.value)
    };
  });
}

function midiToTrackerNote(midi: number): string {
  const names = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
  const octave = Math.floor(midi / 12) - 1;
  const name = names[midi % 12] ?? 'C-';
  return `${name}${octave}`;
}

function handleNoteEntry(midi: number) {
  const instrumentId =
    activeInstrumentId.value ?? formatInstrumentId(activeTrack.value + 1);
  updateEntryAt(activeRow.value, activeTrack.value, (entry) => ({
    ...entry,
    note: midiToTrackerNote(midi),
    instrument: instrumentId
  }));
  moveRow(1);
}

function setPatternRows(count: number) {
  const clamped = Math.max(1, Math.min(256, Math.round(count)));
  patternMeta.value.rows = clamped;
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
    title: currentSong.title,
    author: currentSong.author,
    bpm: currentSong.bpm,
    pattern: buildPlaybackPattern()
  };
}

async function syncSongBankFromSlots() {
  const slots: SongBankSlot[] = instrumentSlots.value
    .map((slot) => {
      if (!slot.patchId) return null;
      const patch = patchLibrary.value[slot.patchId];
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
  const song = buildPlaybackSong();
  playbackEngine.loadSong(song);
  playbackEngine.setLength(rowsCount.value);
  playbackEngine.setBpm(currentSong.bpm);

  unsubscribePosition?.();
  unsubscribePosition = playbackEngine.on('position', (pos) => {
    playbackRow.value = ((pos.row % rowsCount.value) + rowsCount.value) % rowsCount.value;
  });
}

async function handlePlay() {
  playbackEngine.setBpm(currentSong.bpm);
  playbackEngine.setLength(rowsCount.value);
  await syncSongBankFromSlots();
  await playbackEngine.play();
}

function handlePause() {
  playbackEngine.pause();
}

function handleStop() {
  playbackEngine.stop();
  playbackRow.value = 0;
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
    patchLibrary.value = patchMap;
    await syncSongBankFromSlots();
  } catch (error) {
    console.error('Failed to load system bank', error);
  }
}

function onKeyDown(event: KeyboardEvent) {
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
      if (playbackEngine['state'] === 'playing') {
        handleStop();
      } else {
        void handlePlay();
      }
      break;
    case 'Insert':
      event.preventDefault();
      insertNoteOff();
      break;
    case 'Delete':
      event.preventDefault();
      clearStep();
      break;
    default:
      break;
  }
}

function onPatchSelect(slotNumber: number, patchId: string) {
  const option = availablePatches.value.find((p) => p.id === patchId);
  instrumentSlots.value = instrumentSlots.value.map((slot) =>
    slot.slot === slotNumber
      ? option
        ? {
            ...slot,
            patchId: option.id,
            patchName: option.name,
            bankId: option.bankId,
            bankName: option.bankName,
            instrumentName: option.name,
            empty: false,
            source: option.source
          }
        : {
            ...slot,
            patchId: undefined,
            patchName: 'Empty',
            bankId: undefined,
            bankName: 'None',
            instrumentName: '—',
            empty: true,
            source: undefined
          }
      : slot
  );
  if (option) {
    setActiveInstrument(slotNumber);
  }
  ensureActiveInstrument();
}

function clearInstrument(slotNumber: number) {
  instrumentSlots.value = instrumentSlots.value.map((slot) =>
    slot.slot === slotNumber
      ? {
          ...slot,
          patchId: undefined,
          bankId: undefined,
          source: undefined,
          bankName: 'None',
          patchName: 'Empty',
          instrumentName: '—',
          empty: false
        }
      : slot
  );
  ensureActiveInstrument();
}

function addInstrumentSlot() {
  const used = new Set(instrumentSlots.value.map((slot) => slot.slot));
  let slotNumber = 1;
  while (used.has(slotNumber)) {
    slotNumber += 1;
  }

  instrumentSlots.value = [
    ...instrumentSlots.value,
    {
      slot: slotNumber,
      bankName: 'Select bank',
      patchName: 'Select patch',
      instrumentName: 'Pending',
      empty: false
    }
  ].sort((a, b) => a.slot - b.slot);
  ensureActiveInstrument();
}

function removeInstrument(slotNumber: number) {
  instrumentSlots.value = instrumentSlots.value.filter((slot) => slot.slot !== slotNumber);
  ensureActiveInstrument();
}

onMounted(async () => {
  trackerContainer.value?.focus();
  await loadSystemBankOptions();
  ensureActiveInstrument();
  initializePlayback();
});

watch(
  () => currentSong.bpm,
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
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.panel-title {
  color: #e8f3ff;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.panel-subtitle {
  color: #9fb3d3;
  font-size: 12px;
  letter-spacing: 0.04em;
}

.empty-state {
  color: #9fb3d3;
  font-size: 13px;
  padding: 10px 12px;
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
  opacity: 0.75;
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

.action-button.ghost {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.08);
}

.action-button.ghost:hover {
  border-color: rgba(255, 255, 255, 0.18);
}

.action-button.add {
  margin-left: auto;
}

.action-button.danger {
  border-color: rgba(255, 99, 128, 0.35);
  color: #ffc1d1;
}

.action-button.danger:hover {
  border-color: rgba(255, 99, 128, 0.7);
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
