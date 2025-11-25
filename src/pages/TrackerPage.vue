<template>
  <q-page class="tracker-page" :class="{ 'edit-mode-active': isEditMode }">
    <div
      ref="trackerContainer"
      class="tracker-container"
      :class="{ 'edit-mode': isEditMode }"
      tabindex="0"
      @keydown="onKeyDown"
    >
      <div class="tracker-toolbar">
        <div class="toolbar-section toolbar-left">
          <button
            type="button"
            class="transport-button play"
            :class="{ active: playbackMode === 'pattern' && isPlaying }"
            title="Spacebar"
            @click="handlePlayPattern"
          >
            Play Pattern
          </button>
          <button
            type="button"
            class="transport-button play alt"
            :class="{ active: playbackMode === 'song' && isPlaying }"
            @click="handlePlaySong"
          >
            Play Song
          </button>
          <button type="button" class="transport-button pause" @click="handlePause">
            Pause
          </button>
          <button type="button" class="transport-button stop" @click="handleStop">
            Stop
          </button>
          <button
            type="button"
            class="transport-button ghost"
            :disabled="isExporting"
            @click="exportSongToMp3"
          >
            {{ isExporting ? 'Exporting…' : 'Export MP3' }}
          </button>
        </div>
        <div class="toolbar-section toolbar-middle">
          <button
            type="button"
            class="song-button"
            @click="addTrack"
            :disabled="trackCount >= 32"
          >
            + Track
          </button>
          <button
            type="button"
            class="song-button ghost"
            @click="removeTrack"
            :disabled="trackCount <= 1"
          >
            - Track
          </button>
        </div>
        <div class="toolbar-section toolbar-right">
          <button
            type="button"
            class="song-button ghost"
            @click="handleLoadSongFile"
          >
            Load Song
          </button>
          <button
            type="button"
            class="song-button"
            @click="handleSaveSongFile"
          >
            Save Song
          </button>
          <label class="toggle toolbar-toggle">
            <input v-model="autoScroll" type="checkbox" />
            <span>Auto-scroll</span>
          </label>
          <button
            type="button"
            class="edit-mode-toggle toolbar-edit-toggle"
            :class="{ active: isEditMode }"
            @click="toggleEditMode"
          >
            Edit (F2)
          </button>
          <button
            type="button"
            class="toolbar-icon-button"
            :class="{ active: isFullscreen }"
            :title="isFullscreen ? 'Exit full screen' : 'Full screen pattern'"
            @click="toggleFullscreen"
          >
            ⛶
          </button>
        </div>
      </div>

      <div class="top-grid" v-show="!isFullscreen">
        <div class="info-grid">
          <SequenceEditor
            :sequence="sequence"
            :patterns="patterns"
            :current-pattern-id="currentPatternId"
            @select-pattern="trackerStore.setCurrentPatternId"
            @add-pattern-to-sequence="handleAddPatternToSequence"
            @remove-pattern-from-sequence="handleRemovePatternFromSequence"
            @create-pattern="handleCreatePattern"
            @move-sequence-item="handleMoveSequenceItem"
            @rename-pattern="handleRenamePattern"
          />
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
            <div class="stats-inline">
              <span class="stat-inline"><span class="stat-label">Patterns:</span> {{ patterns.length }}</span>
              <span class="stat-inline"><span class="stat-label">Rows:</span> {{ rowsCount }}</span>
            </div>
            <div class="pattern-row-inline">
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
            </div>
            <div class="pattern-row-inline">
              <div class="pattern-controls">
                <div class="control-label">Base octave</div>
                <div class="control-field">
                  <input
                    class="length-input"
                    type="number"
                    :min="0"
                    :max="8"
                    :value="baseOctave"
                    @change="(event) => setBaseOctaveInput(Number((event.target as HTMLInputElement).value))"
                  />
                  <div class="control-hint">Shift+PgUp/PgDn</div>
                </div>
              </div>
            </div>
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
              :title="slot.patchId ? `Bank: ${slot.bankName}` : ''"
              @click="setActiveInstrument(slot.slot)"
            >
              <div class="slot-number">#{{ formatInstrumentId(slot.slot) }}</div>
              <div class="patch-name" @dblclick.stop="beginInstrumentRename(slot)">
                <input
                  v-if="instrumentNameEditSlot === slot.slot"
                  :ref="(el) => setInstrumentNameInputRef(slot.slot, el)"
                  v-model="instrumentNameDraft"
                  type="text"
                  class="instrument-name-input"
                  @keydown.enter.prevent="commitInstrumentRename(slot.slot)"
                  @keydown.esc.prevent="cancelInstrumentRename"
                  @blur="commitInstrumentRename(slot.slot)"
                />
                <span v-else>{{ getInstrumentDisplayName(slot) }}</span>
              </div>
              <div class="instrument-actions">
                <button
                  type="button"
                  class="action-button new"
                  @click.stop="createNewSongPatch(slot.slot)"
                >
                  New
                </button>
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
                  class="action-button edit"
                  @click.stop="editSlotPatch(slot.slot)"
                  >
                  Edit
                </button>
                <button
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

  <div class="visualizer-row">
        <div class="visualizer-spacer" :style="{ width: `${visualizerSpacerWidth}px` }"></div>
        <div
          class="visualizer-tracks"
          :style="{ gap: `${visualizerTrackGap}px` }"
        >
          <div
            v-for="(track, index) in currentPattern?.tracks"
            :key="`viz-${track.id}`"
            class="visualizer-cell"
            :style="{
              width: `${visualizerTrackWidth}px`,
              minWidth: `${visualizerTrackWidth}px`
            }"
          >
            <div class="visualizer-controls">
              <button
                type="button"
                class="track-btn solo-btn"
                :class="{ active: soloedTracks.has(index) }"
                @click="toggleSolo(index)"
                title="Solo"
              >
                S
              </button>
              <button
                type="button"
                class="track-btn mute-btn"
                :class="{ active: mutedTracks.has(index) }"
                @click="toggleMute(index)"
                title="Mute"
              >
                M
              </button>
            </div>
            <TrackWaveform
              :audio-node="trackAudioNodes[index] ?? null"
              :audio-context="audioContext"
            />
          </div>
        </div>
      </div>

      <div class="pattern-area">
        <TrackerPattern
          ref="trackerPatternRef"
          :tracks="currentPattern?.tracks ?? []"
          :rows="rowsCount"
          :selected-row="activeRow"
          :playback-row="playbackRow"
          :active-track="activeTrack"
          :active-column="activeColumn"
          :active-macro-nibble="activeMacroNibble"
          :selection-rect="selectionRect"
          :auto-scroll="autoScroll"
          :is-playing="isPlaying"
          @rowSelected="setActiveRow"
          @cellSelected="setActiveCell"
          @startSelection="onPatternStartSelection"
          @hoverSelection="onPatternHoverSelection"
        />
      </div>
    </div>
    <div v-if="showExportModal" class="export-modal">
      <div class="export-dialog">
        <div class="export-title">Exporting song</div>
        <div class="export-status">{{ exportStatusText }}</div>
        <div class="export-progress">
          <div class="export-progress-bar">
            <div class="export-progress-fill" :style="{ width: `${exportProgressPercent}%` }"></div>
          </div>
          <div class="export-progress-value">{{ exportProgressPercent }}%</div>
        </div>
        <div v-if="exportError" class="export-error">{{ exportError }}</div>
        <button
          type="button"
          class="export-close"
          :disabled="exportStage === 'recording' || exportStage === 'encoding'"
          @click="showExportModal = false"
        >
          {{ exportStage === 'done' || exportStage === 'error' ? 'Close' : 'Hide' }}
        </button>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';
import { useRouter } from 'vue-router';
import JSZip from 'jszip';
import type { JSZipObject } from 'jszip';
import TrackerPattern from 'src/components/tracker/TrackerPattern.vue';
import SequenceEditor from 'src/components/tracker/SequenceEditor.vue';
import TrackWaveform from 'src/components/tracker/TrackWaveform.vue';
import type { TrackerEntryData, TrackerTrackData } from 'src/components/tracker/tracker-types';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type {
  Pattern as PlaybackPattern,
  Song as PlaybackSong,
  Step as PlaybackStep,
  ScheduledNoteEvent
} from '../../packages/tracker-playback/src/types';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type { SongBankSlot } from 'src/audio/tracker/song-bank';
import type { Patch } from 'src/audio/types/preset-types';
import { createDefaultPatchMetadata, createEmptySynthState } from 'src/audio/types/preset-types';
import { parseTrackerNoteSymbol, parseTrackerVolume } from 'src/audio/tracker/note-utils';
import { useTrackerStore, TOTAL_PAGES } from 'src/stores/tracker-store';
import type { InstrumentSlot } from 'src/stores/tracker-store';
import { usePatchStore } from 'src/stores/patch-store';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { useKeyboardStore } from 'src/stores/keyboard-store';
import { useTrackerKeyboard } from 'src/composables/keyboard/useTrackerKeyboard';
import type { TrackerKeyboardContext } from 'src/composables/keyboard/types';
import { useTrackerExport } from 'src/composables/useTrackerExport';
import type { TrackerExportContext, PlaybackMode } from 'src/composables/useTrackerExport';
import { useTrackerPlayback } from 'src/composables/useTrackerPlayback';
import type { TrackerPlaybackContext } from 'src/composables/useTrackerPlayback';
import { useTrackerSelection } from 'src/composables/useTrackerSelection';
import type { TrackerSelectionContext } from 'src/composables/useTrackerSelection';

// Minimal File System Access API typings for browsers without lib.dom additions
type FileSystemWriteChunkType = BufferSource | Blob | string;
interface FileSystemWritableFileStream extends WritableStream<FileSystemWriteChunkType> {
  write(data: FileSystemWriteChunkType): Promise<void>;
  close(): Promise<void>;
}
interface FileSystemFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
}
interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
}
interface OpenFilePickerOptions {
  multiple?: boolean;
  types?: FilePickerAcceptType[];
}
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
const keyboardStore = useKeyboardStore();
const {
  currentSong,
  patternRows,
  stepSize,
  patterns,
  sequence,
  currentPatternId,
  instrumentSlots,
  activeInstrumentId,
  currentInstrumentPage,
  songPatches
} = storeToRefs(trackerStore);
const currentPattern = computed(() => trackerStore.currentPattern);
const currentPageSlots = computed(() => trackerStore.currentPageSlots);
const patchStore = usePatchStore();
const activeRow = ref(0);
const activeTrack = ref(0);
const activeColumn = ref(0);
const activeMacroNibble = ref(0);
const isEditMode = ref(false);
const isFullscreen = ref(false);
const columnsPerTrack = 5;
const trackerContainer = ref<HTMLDivElement | null>(null);
const availablePatches = ref<BankPatchOption[]>([]);
/** Library of available patches from system bank (for dropdown) */
const bankPatchLibrary = ref<Record<string, Patch>>({});
const rowsCount = computed(() => Math.max(patternRows.value ?? 64, 1));
const songBank = new TrackerSongBank();
const slotCreationPromises = new Map<number, Promise<void>>();
const instrumentNameEditSlot = ref<number | null>(null);
const instrumentNameDraft = ref('');
const instrumentNameInputRefs = ref<Record<number, HTMLInputElement | null>>({});

// Set up selection composable
const selectionContext: TrackerSelectionContext = {
  activeRow,
  activeTrack,
  isEditMode,
  rowsCount,
  currentPattern,
  pushHistory: () => trackerStore.pushHistory(),
  parseTrackerNoteSymbol,
  midiToTrackerNote
};

const {
  selectionAnchor,
  selectionEnd,
  isMouseSelecting,
  selectionRect,
  clearSelection,
  startSelectionAtCursor,
  onPatternStartSelection,
  onPatternHoverSelection,
  transposeSelection,
  copySelectionToClipboard,
  pasteFromClipboard
} = useTrackerSelection(selectionContext);

function normalizeVolumeChars(vol?: string): [string, string] {
  const clean = (vol ?? '').toUpperCase();
  const chars: [string, string] = ['.', '.'];
  if (/^[0-9A-F]$/.test(clean[0] ?? '')) chars[0] = clean[0] as string;
  if (/^[0-9A-F]$/.test(clean[1] ?? '')) chars[1] = clean[1] as string;
  return chars;
}

function normalizeMacroChars(macro?: string): [string, string, string] {
  const clean = (macro ?? '').toUpperCase();
  const chars: [string, string, string] = ['.', '.', '.'];
  if (/^[0-3]$/.test(clean[0] ?? '')) chars[0] = clean[0] as string;
  if (/^[0-9A-F]$/.test(clean[1] ?? '')) chars[1] = clean[1] as string;
  if (/^[0-9A-F]$/.test(clean[2] ?? '')) chars[2] = clean[2] as string;
  return chars;
}

function getInstrumentDisplayName(slot: InstrumentSlot): string {
  return slot.instrumentName || slot.patchName || '—';
}

function setInstrumentNameInputRef(
  slotNumber: number,
  el: Element | ComponentPublicInstance | null
) {
  instrumentNameInputRefs.value[slotNumber] = el as HTMLInputElement | null;
}

function beginInstrumentRename(slot: InstrumentSlot) {
  instrumentNameEditSlot.value = slot.slot;
  instrumentNameDraft.value = getInstrumentDisplayName(slot).replace(/^—$/, '');
  void nextTick(() => {
    const input = instrumentNameInputRefs.value[slot.slot];
    if (input) {
      input.focus();
      input.select();
    }
  });
}

function cancelInstrumentRename() {
  instrumentNameEditSlot.value = null;
}

function commitInstrumentRename(slotNumber: number) {
  if (instrumentNameEditSlot.value !== slotNumber) {
    return;
  }
  trackerStore.pushHistory();
  trackerStore.setInstrumentName(slotNumber, instrumentNameDraft.value);
  instrumentNameEditSlot.value = null;
}

function parseMacroField(macro?: string): { index: number; value: number } | undefined {
  const chars = normalizeMacroChars(macro);
  if (chars[0] === '.') return undefined;
  const macroIndex = parseInt(chars[0], 16);
  if (!Number.isFinite(macroIndex) || macroIndex < 0 || macroIndex > 3) return undefined;
  const valueHex = `${chars[1] === '.' ? '0' : chars[1]}${chars[2] === '.' ? '0' : chars[2]}`;
  const raw = Number.parseInt(valueHex, 16);
  if (!Number.isFinite(raw)) return undefined;
  const clamped = Math.max(0, Math.min(255, raw));
  return { index: macroIndex, value: clamped / 255 };
}

// Mute/solo state must exist before PlaybackEngine creation
const mutedTracks = ref<Set<number>>(new Set());
const soloedTracks = ref<Set<number>>(new Set());

function isTrackAudible(trackIndex: number): boolean {
  const hasSolo = soloedTracks.value.size > 0;
  const isSoloed = soloedTracks.value.has(trackIndex);
  const isMuted = mutedTracks.value.has(trackIndex);
  return hasSolo ? isSoloed : !isMuted;
}

const playbackEngine = new PlaybackEngine({
  instrumentResolver: (instrumentId) => songBank.prepareInstrument(instrumentId),
  audioContext: songBank.audioContext,
  scheduledAutomationHandler: (instrumentId, gain, time) => {
    songBank.setInstrumentGain(instrumentId, gain, time);
  },
  automationHandler: (instrumentId, gain) => {
    songBank.setInstrumentGain(instrumentId, gain);
  },
  scheduledMacroHandler: (instrumentId, macroIndex, value, time) => {
    songBank.setInstrumentMacro(instrumentId, macroIndex, value, time);
  },
  macroHandler: (instrumentId, macroIndex, value) => {
    songBank.setInstrumentMacro(instrumentId, macroIndex, value);
  },
  scheduledNoteHandler: (event: ScheduledNoteEvent) => {
    // Check mute/solo state for this track
    if (!isTrackAudible(event.trackIndex)) return;

    if (event.type === 'noteOn') {
      setTrackAudioNodeForInstrument(event.trackIndex, event.instrumentId);
      if (event.instrumentId === undefined || event.midi === undefined) return;
      const velocity = Number.isFinite(event.velocity) ? (event.velocity as number) : 100;
      songBank.noteOnAtTime(event.instrumentId, event.midi, velocity, event.time, event.trackIndex);
      return;
    }

    if (event.instrumentId === undefined) return;
    songBank.noteOffAtTime(event.instrumentId, event.midi, event.time, event.trackIndex);
  },
  // Keep legacy handler for preview notes (not used for playback anymore)
  noteHandler: (event) => {
    if (!isTrackAudible(event.trackIndex)) return;

    if (event.type === 'noteOn') {
      setTrackAudioNodeForInstrument(event.trackIndex, event.instrumentId);
      if (event.instrumentId === undefined || event.midi === undefined) return;
      const velocity = Number.isFinite(event.velocity) ? (event.velocity as number) : 100;
      songBank.noteOn(event.instrumentId, event.midi, velocity, event.trackIndex);
      return;
    }

    if (event.instrumentId === undefined) return;
    songBank.noteOff(event.instrumentId, event.midi, event.trackIndex);
  }
});

watch(
  () => keyboardStore.latestEvent,
  (event) => {
    if (!event) return;
    if (isEditMode.value) return;

    const instrumentId =
      activeInstrumentId.value ?? formatInstrumentId(activeTrack.value + 1);
    if (!instrumentId) return;

    const adjustedMidi = applyBaseOctave(event.note);
    const midi = adjustedMidi;

    if (!Number.isFinite(midi)) return;
    if (!isTrackAudible(activeTrack.value)) return;

    void (async () => {
      if (!hasPatchForInstrument(instrumentId)) return;
      await songBank.ensureAudioContextRunning();
      await songBank.prepareInstrument(instrumentId);
      if (event.velocity <= 0.0001) {
        songBank.previewNoteOff(instrumentId, midi);
      } else {
        songBank.previewNoteOn(instrumentId, midi, event.velocity);
      }
    })();
  },
);

// Playback functionality will be initialized after all dependencies are set up

const audioContext = computed(() => songBank.audioContext);
const DEFAULT_BASE_OCTAVE = trackerStore.baseOctave;
const baseOctave = ref(trackerStore.baseOctave);
const trackCount = computed(() => currentPattern.value?.tracks.length ?? 0);
const trackerPatternRef = ref<InstanceType<typeof TrackerPattern> | null>(null);
const visualizerTrackWidth = ref(180);
const visualizerTrackGap = ref(10);
const visualizerSpacerWidth = ref(108);

async function measureVisualizerLayout() {
  await nextTick();
  const host = trackerPatternRef.value?.$el as HTMLElement | undefined;
  if (!host) return;
  const trackEl = host.querySelector('.tracker-track') as HTMLElement | null;
  const tracksWrapper = host.querySelector('.tracks-wrapper') as HTMLElement | null;
  if (tracksWrapper) {
    const hostRect = host.getBoundingClientRect();
    const wrapperRect = tracksWrapper.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(tracksWrapper).gap || '10');
    if (Number.isFinite(gap)) {
      visualizerTrackGap.value = gap;
    }
    const trackStart = wrapperRect.left - hostRect.left;
    if (Number.isFinite(trackStart) && trackStart >= 0) {
      visualizerSpacerWidth.value = trackStart;
    }
  }
  if (trackEl) {
    visualizerTrackWidth.value = trackEl.getBoundingClientRect().width;
  }
}

function toggleEditMode() {
  isEditMode.value = !isEditMode.value;
}

function toggleFullscreen() {
  isFullscreen.value = !isFullscreen.value;
}

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

function setActiveCell(payload: { row: number; column: number; trackIndex: number; macroNibble?: number }) {
  activeRow.value = payload.row;
  activeTrack.value = payload.trackIndex;
  activeColumn.value = payload.column;
  activeMacroNibble.value = payload.macroNibble ?? 0;
  // Clear selection when clicking on a specific cell
  clearSelection();
}

function moveRow(delta: number) {
  setActiveRow(activeRow.value + delta);
  activeMacroNibble.value = 0;
}

function moveColumn(delta: number) {
  if (!currentPattern.value) return;
  if (activeColumn.value === 4 && delta !== 0) {
    const nextNibble = activeMacroNibble.value + delta;
    if (nextNibble >= 0 && nextNibble <= 2) {
      activeMacroNibble.value = nextNibble;
      return;
    }
  }

  const nextColumn = activeColumn.value + delta;
  if (nextColumn < 0) {
    activeTrack.value =
      (activeTrack.value - 1 + currentPattern.value.tracks.length) %
      currentPattern.value.tracks.length;
    activeColumn.value = columnsPerTrack - 1;
    activeMacroNibble.value = 0;
    return;
  }

  if (nextColumn >= columnsPerTrack) {
    activeTrack.value = (activeTrack.value + 1) % currentPattern.value.tracks.length;
    activeColumn.value = 0;
    activeMacroNibble.value = 0;
    return;
  }

  activeColumn.value = nextColumn;
  if (activeColumn.value !== 4) {
    activeMacroNibble.value = 0;
  }
}

function jumpToNextTrack() {
  if (!currentPattern.value) return;
  activeTrack.value = (activeTrack.value + 1) % currentPattern.value.tracks.length;
  activeColumn.value = 0;
}

function jumpToPrevTrack() {
  if (!currentPattern.value) return;
  activeTrack.value =
    (activeTrack.value - 1 + currentPattern.value.tracks.length) %
    currentPattern.value.tracks.length;
  activeColumn.value = 0;
}

function setStepSizeInput(value: number) {
  if (!Number.isFinite(value)) return;
  const clamped = Math.max(1, Math.min(64, Math.round(value)));
  trackerStore.pushHistory();
  stepSize.value = clamped;
}

function setBaseOctaveInput(value: number) {
  if (!Number.isFinite(value)) return;
  const clamped = Math.max(0, Math.min(8, Math.round(value)));
  baseOctave.value = clamped;
  trackerStore.setBaseOctave(clamped);
}

function addTrack() {
  trackerStore.pushHistory();
  const added = trackerStore.addTrack();
  if (added) {
    activeTrack.value = Math.min(
      activeTrack.value,
      (currentPattern.value?.tracks.length ?? 1) - 1
    );
    sanitizeMuteSoloState();
    updateTrackAudioNodes();
    void measureVisualizerLayout();
  }
}

function removeTrack() {
  if (trackCount.value <= 1) return;
  trackerStore.pushHistory();
  const removed = trackerStore.removeTrack(activeTrack.value);
  if (removed) {
    sanitizeMuteSoloState();
    activeTrack.value = Math.min(
      activeTrack.value,
      (currentPattern.value?.tracks.length ?? 1) - 1
    );
    updateTrackAudioNodes();
    void measureVisualizerLayout();
  }
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
  if (!currentPattern.value) return;
  const tracks = currentPattern.value.tracks;
  const track = tracks[trackIndex];
  if (!track) return;

  const existing = track.entries.find((e) => e.row === row);
  const baseInstrument =
    activeInstrumentId.value ??
    normalizeInstrumentId(existing?.instrument) ??
    formatInstrumentId(trackIndex + 1);
  const draft: TrackerEntryData = existing
    ? { ...existing, instrument: existing.instrument ?? baseInstrument }
    : { row, instrument: baseInstrument };

  const mutated = mutator(draft);
  const filtered = track.entries.filter((e) => e.row !== row);
  filtered.push(mutated);
  filtered.sort((a, b) => a.row - b.row);

  track.entries = filtered;
}

function insertNoteOff() {
  if (!isEditMode.value) return;
  trackerStore.pushHistory();
  updateEntryAt(activeRow.value, activeTrack.value, (entry) => ({
    ...entry,
    note: '###'
  }));
  advanceRowByStep();
}

function clearStep() {
  if (!isEditMode.value) return;
  if (!currentPattern.value) return;
  trackerStore.pushHistory();
  const track = currentPattern.value.tracks[activeTrack.value];
  if (!track) return;
  track.entries = track.entries.filter((e) => e.row !== activeRow.value);
  advanceRowByStep();
}

function deleteRowAndShiftUp() {
  if (!isEditMode.value) return;
  if (!currentPattern.value) return;
  trackerStore.pushHistory();
  const track = currentPattern.value.tracks[activeTrack.value];
  if (!track) return;

  const currentRow = activeRow.value;
  const maxRow = rowsCount.value - 1;

  // Remove entries at current row, shift entries below up by one
  track.entries = track.entries
    .filter((e) => e.row !== currentRow)
    .map((e) => {
      if (e.row > currentRow) {
        return { ...e, row: e.row - 1 };
      }
      return e;
    })
    .filter((e) => e.row <= maxRow);
}

function insertRowAndShiftDown() {
  if (!isEditMode.value) return;
  if (!currentPattern.value) return;
  trackerStore.pushHistory();
  const track = currentPattern.value.tracks[activeTrack.value];
  if (!track) return;

  const currentRow = activeRow.value;
  const maxRow = rowsCount.value - 1;

  // Shift entries at and below current row down by one
  track.entries = track.entries
    .map((e) => {
      if (e.row >= currentRow) {
        return { ...e, row: e.row + 1 };
      }
      return e;
    })
    .filter((e) => e.row <= maxRow);
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

function applyBaseOctave(midi: number): number {
  const offset = (baseOctave.value - DEFAULT_BASE_OCTAVE) * 12;
  const adjusted = midi + offset;
  return Math.max(0, Math.min(127, Math.round(adjusted)));
}

function handleNoteEntry(midi: number) {
  // Only enter notes when on the note column (column 0)
  if (activeColumn.value !== 0) return;

  const instrumentId =
    activeInstrumentId.value ?? formatInstrumentId(activeTrack.value + 1);
  const adjustedMidi = applyBaseOctave(midi);

  if (!isEditMode.value) {
    void previewNote(instrumentId, adjustedMidi);
    return;
  }

  trackerStore.pushHistory();
  updateEntryAt(activeRow.value, activeTrack.value, (entry) => ({
    ...entry,
    note: midiToTrackerNote(adjustedMidi),
    instrument: instrumentId
  }));
  void previewNote(instrumentId, adjustedMidi);
  advanceRowByStep();
}

function handleVolumeInput(hexChar: string) {
  if (!isEditMode.value) return;
  trackerStore.pushHistory();
  const row = activeRow.value;
  const track = activeTrack.value;
  const nibbleIndex = activeColumn.value === 2 ? 0 : 1;
  updateEntryAt(row, track, (entry) => ({
    ...entry,
    volume: (() => {
      const chars = normalizeVolumeChars(entry.volume);
      if (chars[0] === '.') chars[0] = '0';
      if (chars[1] === '.') chars[1] = '0';
      chars[nibbleIndex] = hexChar;
      return chars.join('');
    })()
  }));
  advanceRowByStep();
  activeColumn.value = nibbleIndex === 0 ? 2 : 3;
}

function handleMacroInput(hexChar: string) {
  if (!isEditMode.value) return;
  if (activeColumn.value !== 4) return;
  trackerStore.pushHistory();
  const nibbleIndex = activeMacroNibble.value;
  // First digit must be 0-3 (macro index)
  if (nibbleIndex === 0 && !/^[0-3]$/.test(hexChar)) return;
  if (nibbleIndex > 0 && !/^[0-9A-F]$/.test(hexChar)) return;

  const row = activeRow.value;
  const track = activeTrack.value;
  updateEntryAt(row, track, (entry) => {
    const chars = normalizeMacroChars(entry.macro);
    chars[nibbleIndex] = hexChar;
    return {
      ...entry,
      macro: chars.join('')
    };
  });

  if (nibbleIndex < 2) {
    activeMacroNibble.value = nibbleIndex + 1;
  } else {
    activeMacroNibble.value = 0;
    advanceRowByStep();
  }
  activeColumn.value = 4;
}

function clearVolumeField() {
  if (!isEditMode.value) return;
  if (!currentPattern.value) return;
  if (activeColumn.value !== 2 && activeColumn.value !== 3) return;

  trackerStore.pushHistory();
  const track = currentPattern.value.tracks[activeTrack.value];
  if (!track) return;
  const idx = track.entries.findIndex((e) => e.row === activeRow.value);
  if (idx === -1) return;

  const entry = track.entries[idx];
  if (!entry) return;

  const updatedEntry = { ...entry } as TrackerEntryData & { volume?: string };
  delete updatedEntry.volume;

  track.entries = track.entries.map((e, i) => (i === idx ? updatedEntry : e));
}

function clearMacroField() {
  if (!isEditMode.value) return;
  if (!currentPattern.value) return;
  if (activeColumn.value !== 4) return;

  trackerStore.pushHistory();
  const track = currentPattern.value.tracks[activeTrack.value];
  if (!track) return;
  const idx = track.entries.findIndex((e) => e.row === activeRow.value);
  if (idx === -1) return;

  const entry = track.entries[idx];
  if (!entry) return;

  const updatedEntry = { ...entry } as TrackerEntryData & { macro?: string };
  delete updatedEntry.macro;

  track.entries = track.entries.map((e, i) => (i === idx ? updatedEntry : e));
  activeMacroNibble.value = 0;
}

function setPatternRows(count: number) {
  const clamped = Math.max(1, Math.min(256, Math.round(count)));
  trackerStore.pushHistory();
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

interface TrackPlaybackContext {
  instrumentId?: string;
  lastMidi?: number;
}

function buildPlaybackStepsForTrack(track: TrackerTrackData): PlaybackStep[] {
  const ctx: TrackPlaybackContext = {};
  const steps: PlaybackStep[] = [];

  const sortedEntries = [...track.entries].sort((a, b) => a.row - b.row);
  for (const entry of sortedEntries) {
    const instrumentId = normalizeInstrumentId(entry.instrument) ?? ctx.instrumentId;
    const { midi, isNoteOff } = parseTrackerNoteSymbol(entry.note);
    const volumeValue = parseTrackerVolume(entry.volume);
    const macroInfo = parseMacroField(entry.macro);

    if (!instrumentId && !macroInfo) continue;
    if (!isNoteOff && midi === undefined && volumeValue === undefined && !macroInfo) continue;

    const step: PlaybackStep = {
      row: entry.row,
      instrumentId: instrumentId ?? '',
      isNoteOff
    };

    if (midi !== undefined) {
      step.midi = midi;
      ctx.lastMidi = midi;
    } else if (isNoteOff && ctx.lastMidi !== undefined) {
      step.midi = ctx.lastMidi;
    }

    if (entry.note) {
      step.note = entry.note;
    }

    if (volumeValue !== undefined) {
      const scaledVelocity = Math.max(
        0,
        Math.min(127, Math.round((volumeValue / 255) * 127))
      );
      step.velocity = scaledVelocity;
    }

    if (macroInfo) {
      step.macroIndex = macroInfo.index;
      step.macroValue = macroInfo.value;
    }

    // Update context after building step
    if (instrumentId) {
      ctx.instrumentId = instrumentId;
    }

    steps.push(step);
  }

  return steps;
}

function buildPlaybackPatterns(): PlaybackPattern[] {
  return patterns.value.map(p => ({
    id: p.id,
    length: patternRows.value,
    tracks: p.tracks.map((track) => ({
      id: track.id,
      steps: buildPlaybackStepsForTrack(track)
    }))
  }));
}

function resolveSequenceForMode(mode: PlaybackMode): string[] {
  if (mode === 'pattern') {
    const targetId = currentPatternId.value ?? currentPattern.value?.id ?? patterns.value[0]?.id;
    return targetId ? [targetId] : [];
  }

  const validPatternIds = new Set(patterns.value.map((p) => p.id));
  const sanitizedSequence = sequence.value.filter((id) => validPatternIds.has(id));

  if (sanitizedSequence.length > 0) {
    return sanitizedSequence;
  }

  const fallback = currentPatternId.value ?? patterns.value[0]?.id;
  return fallback ? [fallback] : [];
}

function buildPlaybackSong(mode: PlaybackMode = playbackMode.value): PlaybackSong {
  return {
    title: currentSong.value.title,
    author: currentSong.value.author,
    bpm: currentSong.value.bpm,
    patterns: buildPlaybackPatterns(),
    sequence: resolveSequenceForMode(mode),
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
  updateTrackAudioNodes();
}

function resolveInstrumentForTrack(track: TrackerTrackData | undefined, _trackIndex: number) {
  if (!track) return undefined;
  const steps = buildPlaybackStepsForTrack(track);
  for (let i = steps.length - 1; i >= 0; i--) {
    const instrumentId = normalizeInstrumentId(steps[i]?.instrumentId);
    if (instrumentId) return instrumentId;
  }
  return undefined;
}

// Export composable - initialized after all dependencies are set up
// (see initialization near keyboard context setup)

function handleGlobalMouseUp() {
  if (isMouseSelecting.value) {
    isMouseSelecting.value = false;
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

// Set up playback composable
const playbackContext: TrackerPlaybackContext = {
  playbackEngine,
  songBank,
  rowsCount,
  trackCount,
  currentSong,
  currentPatternId,
  currentPattern,
  activeRow,
  mutedTracks,
  soloedTracks,
  buildPlaybackSong,
  syncSongBankFromSlots,
  setCurrentPatternId: (patternId: string) => trackerStore.setCurrentPatternId(patternId),
  normalizeInstrumentId,
  resolveInstrumentForTrack
};

const {
  isPlaying,
  playbackRow,
  playbackMode,
  autoScroll,
  trackAudioNodes,
  toggleMute,
  toggleSolo,
  sanitizeMuteSoloState,
  setTrackAudioNodeForInstrument,
  updateTrackAudioNodes,
  initializePlayback,
  handlePlayPattern,
  handlePlaySong,
  handlePause,
  handleStop,
  togglePatternPlayback,
  cleanup: cleanupPlayback
} = useTrackerPlayback(playbackContext);

// Set up keyboard command system
const keyboardContext: TrackerKeyboardContext = {
  // Current state
  activeRow,
  activeTrack,
  activeColumn,
  activeMacroNibble,
  isEditMode,
  isFullscreen,
  get rowsCount() { return rowsCount.value; },
  get trackCount() { return trackCount.value; },

  // Selection
  selectionAnchor,
  selectionEnd,
  clearSelection,
  startSelectionAtCursor,
  copySelectionToClipboard,
  pasteFromClipboard,
  transposeSelection,

  // Navigation
  setActiveRow,
  moveRow,
  moveColumn,
  jumpToNextTrack,
  jumpToPrevTrack,

  // Editing
  handleNoteEntry,
  handleVolumeInput,
  handleMacroInput,
  clearStep,
  clearVolumeField,
  clearMacroField,
  insertNoteOff,
  insertRowAndShiftDown,
  deleteRowAndShiftUp,
  ensureActiveInstrument,

  // Playback
  togglePatternPlayback,

  // UI
  toggleEditMode,
  toggleFullscreen,

  // Octave
  baseOctave,
  setBaseOctaveInput,

  // Store actions
  undo: () => trackerStore.undo(),
  redo: () => trackerStore.redo(),

  // Note mapping
  noteKeyMap
};

const { handleKeyDown: onKeyDown } = useTrackerKeyboard(keyboardContext);

// Set up export composable
const exportContext: TrackerExportContext = {
  playbackEngine,
  songBank,
  rowsCount,
  currentSong,
  sequence,
  patterns,
  currentPatternId,
  currentPattern,
  playbackMode,
  activeRow,
  playbackRow,
  syncSongBankFromSlots,
  initializePlayback
};

const {
  isExporting,
  showExportModal,
  exportStage,
  exportError,
  exportStatusText,
  exportProgressPercent,
  exportSongToMp3
} = useTrackerExport(exportContext);

function onPatchSelect(slotNumber: number, patchId: string) {
  if (!patchId) {
    trackerStore.pushHistory();
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
  trackerStore.pushHistory();
  trackerStore.assignPatchToSlot(slotNumber, patch, option.bankName);
  setActiveInstrument(slotNumber);
  ensureActiveInstrument();
}

function clearInstrument(slotNumber: number) {
  trackerStore.pushHistory();
  trackerStore.clearSlot(slotNumber);
  ensureActiveInstrument();
}

async function buildSongPatch(slotNumber: number): Promise<Patch | null> {
  const patchName = `Instrument ${formatInstrumentId(slotNumber)}`;
  const baseMeta = createDefaultPatchMetadata(patchName);

  const cloneWithMeta = (source: Patch | null | undefined): Patch | null => {
    if (!source) return null;
    const cloned = JSON.parse(JSON.stringify(source)) as Patch;
    cloned.metadata = { ...(cloned.metadata || {}), ...baseMeta, name: baseMeta.name };
    return cloned;
  };

  const template = typeof patchStore.fetchDefaultPatchTemplate === 'function'
    ? await patchStore.fetchDefaultPatchTemplate()
    : null;
  const fromTemplate = cloneWithMeta(template);
  if (fromTemplate) return fromTemplate;

  const serialized = await patchStore.serializePatch(patchName);
  if (serialized) return serialized;

  return null;
}

async function createNewSongPatch(slotNumber: number) {
  try {
    const creation = (async (): Promise<void> => {
      const patch = await buildSongPatch(slotNumber) ?? {
        metadata: createDefaultPatchMetadata(`Instrument ${formatInstrumentId(slotNumber)}`),
        synthState: createEmptySynthState(),
        audioAssets: {}
      };

      trackerStore.pushHistory();
      trackerStore.assignPatchToSlot(slotNumber, patch, 'Song');
      setActiveInstrument(slotNumber);
      ensureActiveInstrument();
      await nextTick();
      await syncSongBankFromSlots();
    })();

    slotCreationPromises.set(slotNumber, creation);
    await creation;
    slotCreationPromises.delete(slotNumber);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to create new song patch', error);
  }
}

  async function editSlotPatch(slotNumber: number) {
  const pending = slotCreationPromises.get(slotNumber);
  if (pending) {
    await pending.catch(() => undefined);
  }
  const slot = instrumentSlots.value.find(s => s.slot === slotNumber);
  if (!slot?.patchId) return;
  const patch = songPatches.value[slot.patchId];
  if (patch) {
    await patchStore.applyPatchObject(patch, { setCurrentPatchId: true });
  }

  // Mark which slot we're editing
  trackerStore.startEditingSlot(slotNumber);

  // Navigate to synth page with query param
  void router.push({
    path: '/patch',
    query: { editSongPatch: slotNumber.toString() }
    });
  }

  function handleCreatePattern() {
  trackerStore.pushHistory();
  const newPatternId = trackerStore.createPattern();
  trackerStore.addPatternToSequence(newPatternId);
  trackerStore.setCurrentPatternId(newPatternId);
}

function handleAddPatternToSequence(patternId: string) {
  trackerStore.pushHistory();
  trackerStore.addPatternToSequence(patternId);
}

function handleRemovePatternFromSequence(index: number) {
  trackerStore.pushHistory();
  trackerStore.removePatternFromSequence(index);
}

function handleMoveSequenceItem(fromIndex: number, toIndex: number) {
  trackerStore.pushHistory();
  trackerStore.moveSequenceItem(fromIndex, toIndex);
}

function handleRenamePattern(patternId: string, name: string) {
  trackerStore.pushHistory();
  trackerStore.setPatternName(patternId, name);
}

async function promptSaveFile(contents: Blob, suggestedName: string) {
  const anyWindow = window as typeof window & {
    showSaveFilePicker?: (
      options?: SaveFilePickerOptions
    ) => Promise<FileSystemFileHandle>;
  };

  if (anyWindow.showSaveFilePicker) {
    const handle = await anyWindow.showSaveFilePicker({
      suggestedName,
      types: [
        {
          description: 'Chord Mod Song',
          accept: { 'application/octet-stream': ['.cmod'] }
        }
      ]
    });
    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();
    return;
  }

  const url = URL.createObjectURL(contents);
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedName;
  link.click();
  URL.revokeObjectURL(url);
}

async function promptOpenFile(): Promise<ArrayBuffer | null> {
  const anyWindow = window as typeof window & {
    showOpenFilePicker?: (
      options?: OpenFilePickerOptions
    ) => Promise<FileSystemFileHandle[]>;
  };

  if (anyWindow.showOpenFilePicker) {
    const [handle] =
      (await anyWindow.showOpenFilePicker({
        types: [
          {
            description: 'Chord Mod Song',
            accept: { 'application/json': ['.cmod', '.json'] }
          }
        ],
        multiple: false
      })) ?? [];
    if (!handle) return null;
    const file = await handle.getFile();
    return await file.arrayBuffer();
  }

  return await new Promise<ArrayBuffer | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.cmod,application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(file);
    };
    input.click();
  });
}

async function handleSaveSongFile() {
  try {
    const songFile = trackerStore.serializeSong();
    const json = JSON.stringify(songFile, null, 2);
    const safeTitle = (currentSong.value.title || 'song').replace(/[^a-z0-9-_]+/gi, '_');
    const zip = new JSZip();
    zip.file('song.json', json);
    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
    await promptSaveFile(zipBlob, `${safeTitle || 'song'}.cmod`);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to save song', error);
  }
}

async function handleLoadSongFile() {
  try {
    const data = await promptOpenFile();
    if (!data) return;

    const buffer = new Uint8Array(data);
    let text: string;

    if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      const zip = await JSZip.loadAsync(buffer);
      const fileNames = Object.keys(zip.files);
      if (fileNames.length === 0) {
        throw new Error('Song archive is empty');
      }
      const preferredJsonName = fileNames.find((name) =>
        name.toLowerCase().endsWith('.json')
      );
      const jsonName = preferredJsonName ?? fileNames[0];
      if (!jsonName) {
        throw new Error('No JSON filename found in song archive');
      }
      const zipFile = zip.file(jsonName) as JSZipObject | null;
      if (!zipFile) {
        throw new Error('No JSON file found in song archive');
      }
      text = await zipFile.async('string');
    } else {
      const decoder = new TextDecoder('utf-8');
      text = decoder.decode(buffer);
    }

    const parsed = JSON.parse(text) as TrackerSongFile;
    trackerStore.loadSongFile(parsed);
    ensureActiveInstrument();
    await syncSongBankFromSlots();
    void initializePlayback(playbackMode.value);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load song', error);
  }
}

onMounted(async () => {
  trackerContainer.value?.focus();
  await loadSystemBankOptions();
  ensureActiveInstrument();
  void initializePlayback(playbackMode.value);
  void measureVisualizerLayout();
  keyboardStore.setupGlobalKeyboardListeners();
  keyboardStore.setupMidiListeners();
  window.addEventListener('mouseup', handleGlobalMouseUp);
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
  () => baseOctave.value,
  (oct) => trackerStore.setBaseOctave(oct),
  { immediate: true }
);

watch(
  () => currentPatternId.value,
  () => updateTrackAudioNodes()
);

watch(
  () => instrumentSlots.value,
  async () => {
    // Ensure audio context is resumed before creating instruments
    // This provides the required user gesture for browsers' autoplay policy
    await songBank.ensureAudioContextRunning();
    await syncSongBankFromSlots();
    void initializePlayback(playbackMode.value);
    void measureVisualizerLayout();
  },
  { deep: true }
);

onBeforeUnmount(() => {
  cleanupPlayback();
  playbackEngine.stop();
  songBank.cancelAllScheduled();
  songBank.dispose();
  keyboardStore.cleanup();
  keyboardStore.clearAllNotes();
  keyboardStore.cleanupMidiListeners();
  window.removeEventListener('mouseup', handleGlobalMouseUp);
});
</script>

<style scoped>
.tracker-page {
  height: var(--q-page-container-height, 100vh);
  background: radial-gradient(120% 140% at 20% 20%, rgba(80, 170, 255, 0.1), transparent),
    radial-gradient(120% 120% at 80% 10%, rgba(255, 147, 204, 0.1), transparent),
    linear-gradient(135deg, #0c111b, #0b0f18 55%, #0d1320);
  box-sizing: border-box;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.tracker-page.edit-mode-active {
  box-shadow: 0 0 0 2px rgba(255, 90, 90, 0.9) inset;
}

.tracker-container {
  width: 100%;
  max-width: none;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
  outline: none;
  flex: 1;
  min-height: 0;
  padding: 18px 0;
}

.tracker-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 18px 4px;
  flex-wrap: wrap;
}

.toolbar-section {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.toolbar-left {
  flex: 2;
}

.toolbar-middle {
  flex: 0 0 auto;
}

.toolbar-right {
  flex: 1;
  justify-content: flex-end;
}

.toolbar-right,
.toolbar-middle,
.toolbar-left {
  display: flex;
}

.tracker-toolbar .transport-button {
  min-width: auto;
  padding: 6px 10px;
}

.tracker-toolbar .song-button {
  flex: 0 0 auto;
  padding: 6px 10px;
}

.toolbar-toggle {
  font-size: 11px;
}

.toolbar-edit-toggle {
  padding: 4px 10px;
}

.toolbar-icon-button {
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.06);
  color: #e8f3ff;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, color 120ms ease;
}

.toolbar-icon-button.active {
  background: rgba(112, 194, 255, 0.25);
  border-color: rgba(112, 194, 255, 0.75);
  color: #fff;
}

.toolbar-icon-button:hover {
  border-color: rgba(112, 194, 255, 0.9);
}

.top-grid {
  display: grid;
  grid-template-columns: 1.1fr 1fr;
  gap: 14px;
  padding: 0 18px;
  flex-shrink: 0;
}

.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.pattern-area {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: auto;
  padding: 0 18px 18px;
}

.visualizer-row {
  display: flex;
  padding: 0 18px 0;
  flex-shrink: 0;
}

.visualizer-spacer {
  width: calc(18px + 78px + 12px);
  flex-shrink: 0;
}

.visualizer-tracks {
  display: flex;
  gap: var(--tracker-track-gap, 10px);
  overflow-x: auto;
  padding-bottom: 4px;
}

.visualizer-cell {
  width: var(--tracker-track-width, 180px);
  min-width: var(--tracker-track-width, 180px);
  flex-shrink: 0;
  position: relative;
}

.visualizer-cell :deep(.track-waveform) {
  width: 100%;
}

.visualizer-controls {
  position: absolute;
  top: 6px;
  left: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 2;
}

.track-btn {
  width: 20px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.05);
  color: #9fb3d3;
  font-size: 9px;
  font-weight: 700;
  cursor: pointer;
  transition: all 100ms ease;
  padding: 0;
  line-height: 1;
}

.track-btn:hover {
  border-color: rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.1);
}

.solo-btn.active {
  background: rgba(255, 200, 50, 0.7);
  border-color: rgba(255, 200, 50, 0.9);
  color: #1a1a1a;
}

.mute-btn.active {
  background: rgba(255, 80, 80, 0.7);
  border-color: rgba(255, 80, 80, 0.9);
  color: #1a1a1a;
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
  padding: 10px 12px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  flex-wrap: wrap;
}

.transport-bottom {
  justify-content: center;
  margin-top: auto;
  padding-top: 6px;
}

.transport-button {
  padding: 8px 12px;
  min-width: 120px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: #eaf6ff;
  font-weight: 700;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
  display: inline-flex;
  justify-content: center;
  align-items: center;
}

.transport-button:hover {
  border-color: rgba(77, 242, 197, 0.45);
}

.transport-button.play {
  background: rgba(77, 242, 197, 0.14);
  color: #f7fcff;
  border-color: rgba(77, 242, 197, 0.5);
  box-shadow: 0 4px 14px rgba(77, 242, 197, 0.18);
}

.transport-button.play.alt {
  background: rgba(132, 173, 255, 0.14);
  color: #f7fcff;
  border-color: rgba(160, 196, 255, 0.45);
  box-shadow: 0 4px 14px rgba(112, 194, 255, 0.18);
}

.transport-button.stop {
  background: rgba(255, 99, 128, 0.18);
  border-color: rgba(255, 99, 128, 0.3);
}

.transport-button.ghost {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.15);
  color: #fff;
}

.transport-button.active {
  box-shadow: 0 0 0 2px rgba(77, 242, 197, 0.35), 0 8px 20px rgba(0, 0, 0, 0.35);
  transform: translateY(-1px);
}

.song-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.song-meta .field {
  flex: 1;
  min-width: 120px;
}

.stats-inline {
  display: flex;
  gap: 16px;
  color: #cfe4ff;
  font-size: 13px;
}

.track-buttons {
  display: flex;
  gap: 6px;
}

.track-buttons .song-button {
  flex: 0 0 auto;
  white-space: nowrap;
  padding: 6px 12px;
}

.stat-inline {
  display: flex;
  gap: 6px;
  align-items: center;
}

.stat-inline .stat-label {
  color: #9fb3d3;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field label {
  color: #9fb3d3;
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 700;
}

.field input {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 6px 10px;
  color: #e8f3ff;
  font-weight: 600;
  font-size: 13px;
}

.field input::placeholder {
  color: rgba(255, 255, 255, 0.5);
}


.pattern-controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.edit-mode-controls .control-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.edit-mode-toggle {
  padding: 6px 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 90, 90, 0.45);
  background: rgba(255, 90, 90, 0.12);
  color: #ffb3b3;
  font-weight: 700;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.edit-mode-toggle.active {
  background: rgba(255, 90, 90, 0.24);
  border-color: rgba(255, 120, 120, 0.9);
  color: #ffe5e5;
}

.edit-mode-toggle:hover {
  border-color: rgba(255, 140, 140, 0.95);
}

.pattern-row-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

.tracks-inline .track-buttons {
  justify-content: flex-start;
  gap: 8px;
  align-items: center;
}

.track-buttons .song-button.wide {
  min-width: 120px;
}

.control-label {
  color: #9fb3d3;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 700;
}

.song-file-controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.song-file-buttons {
  display: flex;
  gap: 8px;
}

.song-button {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #e8f3ff;
  font-weight: 700;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}

.song-button:hover {
  border-color: rgba(77, 242, 197, 0.4);
}

.song-button.ghost {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.12);
}

.control-field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 6px 8px;
  min-height: 40px;
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
  padding: 10px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.32);
  display: flex;
  flex-direction: column;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.page-tabs {
  display: flex;
  gap: 3px;
}

.page-tab {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
  color: #9fb3d3;
  font-weight: 700;
  font-size: 11px;
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
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.instrument-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  overflow-y: auto;
}

.instrument-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.05);
  cursor: pointer;
}

.instrument-row.active {
  border-color: rgba(77, 242, 197, 0.6);
  background: rgba(77, 242, 197, 0.08);
}

.instrument-row.empty {
  opacity: 0.5;
}

.instrument-row .patch-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: #e8f3ff;
  font-weight: 600;
  font-size: 13px;
}
.instrument-name-input {
  width: 100%;
  font: inherit;
  color: #e8f3ff;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 6px 8px;
}

.slot-number {
  font-family: 'IBM Plex Mono', 'JetBrains Mono', monospace;
  color: #9fb3d3;
  font-weight: 700;
  font-size: 11px;
  flex-shrink: 0;
}

.instrument-actions {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 0;
}

.action-button {
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(77, 242, 197, 0.12);
  color: #e8f3ff;
  font-weight: 600;
  font-size: 11px;
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

.action-button.new {
  background: rgba(77, 242, 197, 0.12);
  border-color: rgba(77, 242, 197, 0.35);
}

.action-button.new:hover {
  background: rgba(77, 242, 197, 0.2);
  border-color: rgba(77, 242, 197, 0.55);
}

.action-button.ghost {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.08);
}

.action-button.ghost:hover {
  border-color: rgba(255, 255, 255, 0.18);
}

.patch-select {
  min-width: 160px;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: #e8f3ff;
  font-weight: 600;
  font-size: 12px;
}

.patch-select option {
  color: #0c1624;
}

.export-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}

.export-dialog {
  background: #0b111a;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 18px 20px;
  width: min(420px, 90vw);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
}

.export-title {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 8px;
}

.export-status {
  color: rgba(255, 255, 255, 0.85);
  margin-bottom: 12px;
}

.export-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.export-progress-bar {
  flex: 1;
  height: 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.export-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #4df2c5, #7fe0ff);
  transition: width 120ms linear;
}

.export-progress-value {
  width: 48px;
  text-align: right;
  color: rgba(255, 255, 255, 0.8);
  font-variant-numeric: tabular-nums;
}

.export-error {
  color: #ff9db5;
  margin-bottom: 10px;
}

.export-close {
  width: 100%;
  margin-top: 6px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
}

@media (max-width: 900px) {
  .top-grid {
    grid-template-columns: 1fr;
  }
}
</style>
