<template>
  <q-page class="tracker-page" :class="{ 'edit-mode-active': isEditMode }">
    <div
      ref="trackerContainer"
      class="tracker-container"
      :class="{ 'edit-mode': isEditMode }"
      tabindex="0"
      @keydown="onKeyDown"
    >
      <div v-if="isLoadingSong" class="song-loading-overlay">
        <div class="song-loading-dialog">
          <div class="spinner" aria-hidden="true"></div>
          <div class="song-loading-text">Loading song…</div>
          <div class="song-loading-subtext">
            Preparing instruments and assets
          </div>
        </div>
      </div>

      <div class="tracker-toolbar">
        <div class="toolbar-section toolbar-left">
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
            @click="handleNewSong"
            :disabled="isLoadingSong"
          >
            New Song
          </button>
          <button
            type="button"
            class="song-button ghost"
            @click="handleLoadSongFile"
            :disabled="isLoadingSong"
          >
            Load Song
          </button>
          <button
            type="button"
            class="song-button"
            @click="handleSaveSongFile"
            :disabled="isLoadingSong"
          >
            Save Song
          </button>
          <label class="toggle toolbar-toggle">
            <input
              v-model="autoScroll"
              type="checkbox"
              @change="blurAndRefocusTracker"
            />
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
        <SequenceEditor
          class="top-panel"
          :sequence="sequence"
          :patterns="patterns"
          :current-pattern-id="currentPatternId"
          :current-sequence-index="currentSequenceIndex"
          :is-playing="isPlaying"
          @select-pattern="trackerStore.setCurrentPatternId"
          @add-pattern-to-sequence="handleAddPatternToSequence"
          @remove-pattern-from-sequence="handleRemovePatternFromSequence"
          @create-pattern="handleCreatePattern"
          @move-sequence-item="handleMoveSequenceItem"
          @rename-pattern="handleRenamePattern"
          @request-refocus="refocusTracker"
        />
        <div class="summary-card top-panel">
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
                @blur="refocusTracker"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              />
            </div>
            <div class="field">
              <label for="song-author">Author</label>
              <input
                id="song-author"
                v-model="currentSong.author"
                type="text"
                placeholder="Unknown"
                @blur="refocusTracker"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              />
            </div>
            <div class="field">
              <label for="song-bpm">BPM</label>
              <input
                id="song-bpm"
                class="bpm-input"
                v-model.number="currentSong.bpm"
                type="number"
                min="20"
                max="300"
                placeholder="120"
                @blur="refocusTracker"
                @keydown.enter="($event.target as HTMLInputElement).blur()"
              />
            </div>
          </div>
          <div class="stats-inline">
            <span class="stat-inline"
              ><span class="stat-label">Patterns:</span>
              {{ patterns.length }}</span
            >
            <span class="stat-inline"
              ><span class="stat-label">Rows:</span> {{ rowsCount }}</span
            >
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
                  @blur="refocusTracker"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
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
                  @change="
                    (event) =>
                      setStepSizeInput(
                        Number((event.target as HTMLInputElement).value),
                      )
                  "
                  @blur="refocusTracker"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
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
                  @change="
                    (event) =>
                      setBaseOctaveInput(
                        Number((event.target as HTMLInputElement).value),
                      )
                  "
                  @blur="refocusTracker"
                  @keydown.enter="($event.target as HTMLInputElement).blur()"
                />
                <div class="control-hint">Shift+PgUp/PgDn</div>
              </div>
            </div>
          </div>
          <div class="transport-controls">
            <button
              type="button"
              class="transport-icon-btn"
              :class="{ active: playbackMode === 'pattern' && isPlaying }"
              title="Play Pattern (Space)"
              :disabled="isLoadingSong"
              @click="handlePlayPattern"
            >
              <q-icon name="replay" size="20px" />
            </button>
            <button
              type="button"
              class="transport-icon-btn"
              :class="{ active: playbackMode === 'song' && isPlaying }"
              title="Play Song"
              :disabled="isLoadingSong"
              @click="handlePlaySong"
            >
              <q-icon name="play_arrow" size="20px" />
            </button>
            <button
              type="button"
              class="transport-icon-btn"
              title="Pause"
              :disabled="isLoadingSong"
              @click="handlePause"
            >
              <q-icon name="pause" size="20px" />
            </button>
            <button
              type="button"
              class="transport-icon-btn"
              title="Stop"
              :disabled="isLoadingSong"
              @click="handleStop"
            >
              <q-icon name="stop" size="20px" />
            </button>
            <div class="volume-control">
              <q-icon name="volume_up" size="14px" class="volume-icon" />
              <input
                type="range"
                class="volume-slider"
                :value="userSettings.masterVolume"
                :style="{
                  '--volume-percent': `${userSettings.masterVolume * 100}%`,
                }"
                min="0"
                max="1"
                step="0.01"
                @input="onMasterVolumeChange"
                @change="blurAndRefocusTracker"
                @pointerup="blurAndRefocusTracker"
                @mousedown.stop
                @click.stop
                title="Master Volume"
              />
            </div>
          </div>
        </div>

        <div class="instrument-panel top-panel">
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
                empty: !slot.patchId,
              }"
              :title="slot.patchId ? `Bank: ${slot.bankName}` : ''"
              @click="setActiveInstrument(slot.slot)"
            >
              <div class="slot-number">
                #{{ formatInstrumentId(slot.slot) }}
              </div>
              <div
                class="patch-name"
                @dblclick.stop="beginInstrumentRename(slot)"
              >
                <input
                  v-if="instrumentNameEditSlot === slot.slot"
                  :ref="(el) => setInstrumentNameInputRef(slot.slot, el)"
                  v-model="instrumentNameDraft"
                  type="text"
                  class="instrument-name-input"
                  @keydown.enter.prevent="
                    commitInstrumentRename(slot.slot);
                    refocusTracker();
                  "
                  @keydown.esc.prevent="
                    cancelInstrumentRename();
                    refocusTracker();
                  "
                  @blur="
                    commitInstrumentRename(slot.slot);
                    refocusTracker();
                  "
                />
                <span v-else>{{ getInstrumentDisplayName(slot) }}</span>
              </div>
              <PatchPicker
                :model-value="slot.patchId ?? null"
                :patches="availablePatches"
                placeholder="Select patch"
                @select="
                  (p) => {
                    onPatchSelect(slot.slot, p.id);
                    refocusTracker();
                  }
                "
                @close="refocusTracker"
                @click.stop
              />
              <div
                class="instrument-volume"
                @click.stop
                @mousedown.stop
                @pointerup="blurAndRefocusTracker"
              >
                <AudioKnobComponent
                  :model-value="slot.volume ?? 1.0"
                  label=""
                  :min="0"
                  :max="2"
                  :decimals="2"
                  scale="mini"
                  :unitFunc="formatGainAsDb"
                  @update:model-value="onSlotVolumeChange(slot.slot, $event)"
                />
              </div>
              <div class="instrument-actions">
                <button
                  type="button"
                  class="icon-action-button"
                  title="New patch"
                  @click.stop="
                    createNewSongPatch(slot.slot);
                    refocusTracker();
                  "
                >
                  <q-icon name="add" size="16px" />
                </button>
                <button
                  type="button"
                  class="icon-action-button"
                  title="Edit patch"
                  :disabled="!slot.patchId"
                  @click.stop="editSlotPatch(slot.slot)"
                >
                  <q-icon name="edit" size="16px" />
                </button>
                <button
                  type="button"
                  class="icon-action-button danger"
                  title="Clear instrument"
                  :disabled="!slot.patchId"
                  @click.stop="
                    clearInstrument(slot.slot);
                    refocusTracker();
                  "
                >
                  <q-icon name="close" size="16px" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        v-if="userSettings.showWaveformVisualizers"
        ref="visualizerRowRef"
        class="visualizer-row"
        :style="{
          paddingLeft: `${visualizerPadding.left}px`,
          paddingRight: `${visualizerPadding.right}px`,
        }"
      >
        <div class="visualizer-spacer"></div>
        <div
          ref="visualizerTracksRef"
          class="visualizer-tracks visualizer-fade"
          :class="{ ready: visualizerReady }"
        >
          <div
            v-for="(track, index) in currentPattern?.tracks"
            :key="`viz-${track.id}`"
            class="visualizer-cell"
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

      <div class="pattern-area-wrapper">
        <TrackerSpectrumAnalyzer
          v-if="userSettings.showSpectrumAnalyzer"
          :node="masterOutputNode"
          :is-playing="isPlaying"
        />
        <div
          ref="patternAreaRef"
          class="pattern-area"
          @scroll.passive="onPatternAreaScroll"
        >
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
            :playback-mode="playbackMode"
            :scroll-top="patternAreaScrollTop"
            :container-height="patternAreaHeight"
            @rowSelected="setActiveRow"
            @cellSelected="setActiveCell"
            @startSelection="onPatternStartSelection"
            @hoverSelection="onPatternHoverSelection"
          />
        </div>
      </div>
    </div>
    <div v-if="showExportModal" class="export-modal">
      <div class="export-dialog">
        <div class="export-title">Exporting song</div>
        <div class="export-status">{{ exportStatusText }}</div>
        <div class="export-progress">
          <div class="export-progress-bar">
            <div
              class="export-progress-fill"
              :style="{ width: `${exportProgressPercent}%` }"
            ></div>
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
          {{
            exportStage === 'done' || exportStage === 'error' ? 'Close' : 'Hide'
          }}
        </button>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import TrackerPattern from 'src/components/tracker/TrackerPattern.vue';
import SequenceEditor from 'src/components/tracker/SequenceEditor.vue';
import TrackWaveform from 'src/components/tracker/TrackWaveform.vue';
import TrackerSpectrumAnalyzer from 'src/components/tracker/TrackerSpectrumAnalyzer.vue';
import AudioKnobComponent from 'src/components/AudioKnobComponent.vue';
import PatchPicker from 'src/components/PatchPicker.vue';
import { useTrackerPlaybackStore } from 'src/stores/tracker-playback-store';
import { parseTrackerNoteSymbol } from 'src/audio/tracker/note-utils';
import { useTrackerStore, TOTAL_PAGES } from 'src/stores/tracker-store';
import { usePatchStore } from 'src/stores/patch-store';
import { useKeyboardStore } from 'src/stores/keyboard-store';
import { useTrackerKeyboard } from 'src/composables/keyboard/useTrackerKeyboard';
import type { TrackerKeyboardContext } from 'src/composables/keyboard/types';
import { useTrackerExport } from 'src/composables/useTrackerExport';
import type { TrackerExportContext } from 'src/composables/useTrackerExport';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';
import { useTrackerSelection } from 'src/composables/useTrackerSelection';
import type { TrackerSelectionContext } from 'src/composables/useTrackerSelection';
import { useTrackerEditing } from 'src/composables/useTrackerEditing';
import type { TrackerEditingContext } from 'src/composables/useTrackerEditing';
import { useTrackerFileIO } from 'src/composables/useTrackerFileIO';
import type { TrackerFileIOContext } from 'src/composables/useTrackerFileIO';
import { useTrackerNavigation } from 'src/composables/useTrackerNavigation';
import type { TrackerNavigationContext } from 'src/composables/useTrackerNavigation';
import { useTrackerInstruments } from 'src/composables/useTrackerInstruments';
import type { TrackerInstrumentsContext } from 'src/composables/useTrackerInstruments';
import { useTrackerSongBuilder } from 'src/composables/useTrackerSongBuilder';
import type { TrackerSongBuilderContext } from 'src/composables/useTrackerSongBuilder';
import { useTrackerAudioStore } from 'src/stores/tracker-audio-store';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import { storeToRefs } from 'pinia';

const router = useRouter();
const $q = useQuasar();
const userSettingsStore = useUserSettingsStore();
const { settings: userSettings } = storeToRefs(userSettingsStore);
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
  songPatches,
} = storeToRefs(trackerStore);
const currentPattern = computed(() => trackerStore.currentPattern);
const currentPageSlots = computed(() => trackerStore.currentPageSlots);

// Signature of instrument slots for audio sync - only watch properties that matter
const slotSignatures = computed(() =>
  instrumentSlots.value
    .map((s) => `${s.slot}:${s.patchId ?? ''}:${s.bankId ?? ''}`)
    .join('|'),
);
const patchStore = usePatchStore();
const playbackStore = useTrackerPlaybackStore();
const activeRow = ref(0);
const activeTrack = ref(0);
const activeColumn = ref(0);
const activeMacroNibble = ref(0);
const isEditMode = ref(false);
const isFullscreen = ref(false);
const columnsPerTrack = 5;
const trackerContainer = ref<HTMLDivElement | null>(null);
const patternAreaRef = ref<HTMLDivElement | null>(null);
const patternAreaScrollTop = ref(0);
const patternAreaHeight = ref(600);
const rowsCount = computed(() => Math.max(patternRows.value ?? 64, 1));
const trackerAudioStore = useTrackerAudioStore();
const songBank = trackerAudioStore.songBank;

// Handle pattern area scroll for virtual scrolling
// Throttle scroll updates using requestAnimationFrame for better performance
let scrollRafId: number | null = null;
function onPatternAreaScroll(event: Event) {
  if (scrollRafId !== null) return;

  scrollRafId = requestAnimationFrame(() => {
    const target = event.target as HTMLElement;
    patternAreaScrollTop.value = target.scrollTop;
    scrollRafId = null;
  });
}

// Update pattern area height on mount and resize
function updatePatternAreaHeight() {
  if (patternAreaRef.value) {
    patternAreaHeight.value = patternAreaRef.value.clientHeight;
  }
}

// Set up selection composable
const selectionContext: TrackerSelectionContext = {
  activeRow,
  activeTrack,
  isEditMode,
  rowsCount,
  currentPattern,
  pushHistory: () => trackerStore.pushHistory(),
  parseTrackerNoteSymbol,
  midiToTrackerNote,
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
  pasteFromClipboard,
  // Track operations
  copyTrack,
  cutTrack,
  pasteTrack,
  transposeTrack,
  // Pattern operations
  copyPattern,
  cutPattern,
  pastePattern,
  transposePattern,
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
  // Allow hex digits for all positions
  if (/^[0-9A-F]$/.test(clean[0] ?? '')) chars[0] = clean[0] as string;
  if (/^[0-9A-F]$/.test(clean[1] ?? '')) chars[1] = clean[1] as string;
  if (/^[0-9A-F]$/.test(clean[2] ?? '')) chars[2] = clean[2] as string;
  return chars;
}

function midiToTrackerNote(midi: number): string {
  const names = [
    'C-',
    'C#',
    'D-',
    'D#',
    'E-',
    'F-',
    'F#',
    'G-',
    'G#',
    'A-',
    'A#',
    'B-',
  ];
  const octave = Math.floor(midi / 12) - 1;
  const name = names[midi % 12] ?? 'C-';
  return `${name}${octave}`;
}

// Mute/solo state from playback store
const {
  mutedTracks,
  soloedTracks,
  isPlaying,
  isPaused,
  playbackRow,
  playbackMode,
  autoScroll,
  currentSequenceIndex,
} = storeToRefs(playbackStore);

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
    if (!playbackStore.isTrackAudible(activeTrack.value)) return;

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
const masterOutputNode = computed(() => songBank.output);
const DEFAULT_BASE_OCTAVE = trackerStore.baseOctave;
const baseOctave = ref(trackerStore.baseOctave);
const trackCount = computed(() => currentPattern.value?.tracks.length ?? 0);
type TrackerPatternInstance = InstanceType<typeof TrackerPattern> & {
  tracksWrapperRef?: { value: HTMLElement | null };
};
const trackerPatternRef = ref<TrackerPatternInstance | null>(null);
const visualizerRowRef = ref<HTMLDivElement | null>(null);
const visualizerTracksRef = ref<HTMLDivElement | null>(null);
const patternTracksWrapper = ref<HTMLElement | null>(null);
const visualizerPadding = ref({ left: 18, right: 18 });
const VISUALIZER_PADDING_BIAS = 25;
let teardownVisualizerScrollSync: (() => void) | null = null;
let isSyncingVisualizerScroll = false;

function toggleEditMode() {
  isEditMode.value = !isEditMode.value;
}

function toggleFullscreen() {
  isFullscreen.value = !isFullscreen.value;
}

/**
 * Return focus to the tracker container so keyboard shortcuts work.
 * Called after interacting with form elements like selects.
 */
function refocusTracker() {
  // Use nextTick to ensure this happens after the current event completes
  void nextTick(() => {
    trackerContainer.value?.focus();
  });
}

function blurAndRefocusTracker(event?: Event) {
  const target = event?.target as HTMLElement | null;
  target?.blur();
  refocusTracker();
}

function resolvePatternTracksWrapper(): HTMLElement | null {
  return (
    trackerPatternRef.value?.tracksWrapperRef?.value ??
    patternTracksWrapper.value ??
    null
  );
}

function updateVisualizerPadding() {
  const rowEl = visualizerRowRef.value;
  const patternEl =
    (trackerPatternRef.value?.$el as HTMLElement | undefined) ?? null;
  if (!rowEl || !patternEl) return;

  const rowRect = rowEl.getBoundingClientRect();
  const patternRect = patternEl.getBoundingClientRect();

  if (rowRect.width === 0) return;

  const left = Math.max(
    0,
    patternRect.left - rowRect.left + VISUALIZER_PADDING_BIAS,
  );
  const right = Math.max(
    0,
    rowRect.right - patternRect.right - VISUALIZER_PADDING_BIAS,
  );

  visualizerPadding.value = { left, right };
}

function syncVisualizerScroll(scrollLeft: number) {
  const patternWrapper = resolvePatternTracksWrapper();
  const visualizer = visualizerTracksRef.value;
  if (!patternWrapper || !visualizer) return;

  patternTracksWrapper.value = patternWrapper;
  const maxScroll = Math.max(
    0,
    patternWrapper.scrollWidth - patternWrapper.clientWidth,
  );
  const clamped = Math.min(scrollLeft, maxScroll);

  if (isSyncingVisualizerScroll) return;
  isSyncingVisualizerScroll = true;

  if (patternWrapper.scrollLeft !== clamped) {
    patternWrapper.scrollLeft = clamped;
  }

  if (visualizer.scrollLeft !== clamped) {
    visualizer.scrollLeft = clamped;
  }

  requestAnimationFrame(() => {
    isSyncingVisualizerScroll = false;
  });
}

function setupVisualizerScrollSync() {
  teardownVisualizerScrollSync?.();

  const patternWrapper = resolvePatternTracksWrapper();
  const visualizer = visualizerTracksRef.value;
  patternTracksWrapper.value = patternWrapper;

  if (!patternWrapper || !visualizer) return;

  const handlePatternScroll = () =>
    syncVisualizerScroll(patternWrapper.scrollLeft);
  const handleVisualizerScroll = () =>
    syncVisualizerScroll(visualizer.scrollLeft);

  patternWrapper.addEventListener('scroll', handlePatternScroll, {
    passive: true,
  });
  visualizer.addEventListener('scroll', handleVisualizerScroll, {
    passive: true,
  });

  teardownVisualizerScrollSync = () => {
    patternWrapper.removeEventListener('scroll', handlePatternScroll);
    visualizer.removeEventListener('scroll', handleVisualizerScroll);
  };

  syncVisualizerScroll(patternWrapper.scrollLeft);
}

function refreshVisualizerAlignment() {
  if (!userSettings.value.showWaveformVisualizers) {
    teardownVisualizerScrollSync?.();
    visualizerPadding.value = { left: 18, right: 18 };
    return;
  }
  void nextTick(() => {
    updateVisualizerPadding();
    setupVisualizerScrollSync();
  });
}

const visualizerReady = ref(false);

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
  Backslash: 81,
};
const formatInstrumentId = (slotNumber: number) =>
  slotNumber.toString().padStart(2, '0');
const normalizeInstrumentId = (instrumentId?: string) => {
  if (!instrumentId) return undefined;
  const numeric = Number(instrumentId);
  if (Number.isFinite(numeric)) {
    return formatInstrumentId(numeric);
  }
  return instrumentId;
};

function applyBaseOctave(midi: number): number {
  const offset = (baseOctave.value - DEFAULT_BASE_OCTAVE) * 12;
  const adjusted = midi + offset;
  return Math.max(0, Math.min(127, Math.round(adjusted)));
}

function hasPatchForInstrument(instrumentId: string): boolean {
  return instrumentSlots.value.some(
    (slot) => formatInstrumentId(slot.slot) === instrumentId && !!slot.patchId,
  );
}

// Set up navigation composable
const navigationContext: TrackerNavigationContext = {
  activeRow,
  activeTrack,
  activeColumn,
  activeMacroNibble,
  rowsCount,
  currentPattern,
  columnsPerTrack,
  clearSelection,
};

const {
  setActiveRow,
  setActiveCell,
  moveRow,
  moveColumn,
  jumpToNextTrack,
  jumpToPrevTrack,
} = useTrackerNavigation(navigationContext);

// Set up editing composable
const editingContext: TrackerEditingContext = {
  activeRow,
  activeTrack,
  activeColumn,
  activeMacroNibble,
  isEditMode,
  stepSize,
  baseOctave,
  defaultBaseOctave: DEFAULT_BASE_OCTAVE,
  activeInstrumentId,
  rowsCount,
  currentPattern,
  instrumentSlots,
  songBank,
  pushHistory: () => trackerStore.pushHistory(),
  moveRow,
  formatInstrumentId,
  normalizeInstrumentId,
  normalizeVolumeChars,
  normalizeMacroChars,
  midiToTrackerNote,
  onNotePreview: (trackIndex: number, instrumentId: string) => {
    setTrackAudioNodeForInstrumentRef?.(trackIndex, instrumentId);
    markTrackNotePlayedRef?.(trackIndex);
  },
};

const {
  ensureActiveInstrument,
  setActiveInstrument,
  handleNoteEntry,
  handleVolumeInput,
  handleMacroInput,
  clearInstrumentField,
  clearVolumeNibble,
  clearVolumeField,
  clearMacroNibble,
  clearMacroField,
  insertNoteOff,
  clearStep,
  deleteRowAndShiftUp,
  insertRowAndShiftDown,
} = useTrackerEditing(editingContext);

// Set up instruments composable (needs to be after playback and editing composables)
// We'll declare it later after playback is set up

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

function setPatternRows(count: number) {
  const clamped = Math.max(1, Math.min(256, Math.round(count)));
  trackerStore.pushHistory();
  patternRows.value = clamped;
  setActiveRow(activeRow.value);
  playbackStore.setLength(clamped);
}

function onPatternLengthInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const value = Number(input.value);
  if (Number.isFinite(value)) {
    setPatternRows(value);
  }
}

function handleGlobalMouseUp() {
  if (isMouseSelecting.value) {
    isMouseSelecting.value = false;
  }
}

// Set up song builder composable (must be before playback)
const songBuilderContext: TrackerSongBuilderContext = {
  currentSong,
  patterns,
  sequence,
  currentPatternId,
  currentPattern,
  patternRows,
  instrumentSlots,
  songPatches,
  songBank,
  normalizeInstrumentId,
  formatInstrumentId,
};

const {
  buildPlaybackSong,
  syncSongBankFromSlots: syncSongBankFromSlotsBase,
  resolveInstrumentForTrack,
} = useTrackerSongBuilder(songBuilderContext);

// Will be assigned after playback composable is set up
let updateTrackAudioNodesRef: (() => void) | null = null;
let markTrackNotePlayedRef: ((trackIndex: number) => void) | null = null;
let setTrackAudioNodeForInstrumentRef:
  | ((trackIndex: number, instrumentId?: string) => void)
  | null = null;

// Wrapper that also updates track audio nodes and applies volumes
async function syncSongBankFromSlots() {
  await syncSongBankFromSlotsBase();
  if (updateTrackAudioNodesRef) {
    updateTrackAudioNodesRef();
  }
  // Apply stored volumes to each instrument in the song bank
  for (const slot of trackerStore.instrumentSlots) {
    if (slot.patchId) {
      const instrumentId = formatInstrumentId(slot.slot);
      const volume = slot.volume ?? 1.0;
      songBank.setInstrumentOutputGain(instrumentId, volume);
    }
  }
}

// Track audio nodes for visualization (simplified from old composable)
const trackAudioNodes = ref<Record<number, AudioNode | null>>({});
const tracksWithActiveNotes = ref<Set<number>>(new Set());

function setTrackAudioNodeForInstrument(
  trackIndex: number,
  instrumentId?: string,
) {
  const normalized = normalizeInstrumentId(instrumentId);
  const node = normalized ? songBank.getInstrumentOutput(normalized) : null;
  if (trackAudioNodes.value[trackIndex] === node) return;
  trackAudioNodes.value = {
    ...trackAudioNodes.value,
    [trackIndex]: node,
  };
}

function updateTrackAudioNodes() {
  const nodes: Record<number, AudioNode | null> = {};
  const tracks = (currentPattern.value?.tracks ?? []) as TrackerTrackData[];
  for (let i = 0; i < tracks.length; i++) {
    // Only show waveform for tracks that have notes with an instrument in this pattern
    // During playback, setTrackAudioNodeForInstrument will update nodes when notes play
    // This allows sound from previous patterns to continue showing on the visualizer
    const resolvedId = resolveInstrumentForTrack(tracks[i], i);
    if (resolvedId) {
      nodes[i] = songBank.getInstrumentOutput(resolvedId);
    } else if (isPlaying.value || isPaused.value) {
      // During playback, preserve existing node assignment (might be from previous pattern)
      nodes[i] = trackAudioNodes.value[i] ?? null;
    } else {
      // When stopped, clear nodes for tracks without notes
      nodes[i] = null;
    }
  }
  trackAudioNodes.value = nodes;
}

function clearTrackAudioNodes() {
  const tracks = (currentPattern.value?.tracks ?? []) as TrackerTrackData[];
  const nodes: Record<number, AudioNode | null> = {};
  for (let i = 0; i < tracks.length; i++) {
    nodes[i] = null;
  }
  trackAudioNodes.value = nodes;
}

function markTrackNotePlayed(trackIndex: number) {
  if (!tracksWithActiveNotes.value.has(trackIndex)) {
    tracksWithActiveNotes.value = new Set([
      ...tracksWithActiveNotes.value,
      trackIndex,
    ]);
  }
}

function clearActiveNoteTracks() {
  tracksWithActiveNotes.value = new Set();
}

// Playback handlers that delegate to the store
async function handlePlayPattern() {
  clearActiveNoteTracks();
  clearTrackAudioNodes();
  const song = buildPlaybackSong('pattern');
  await playbackStore.play(song, 'pattern', activeRow.value);
}

async function handlePlaySong() {
  clearActiveNoteTracks();
  clearTrackAudioNodes();
  const song = buildPlaybackSong('song');
  await playbackStore.play(song, 'song', activeRow.value);
}

function handlePause() {
  activeRow.value = playbackRow.value;
  playbackStore.pause();
}

function handleStop() {
  playbackStore.stop();
  activeRow.value = 0;
  clearActiveNoteTracks();
  // Don't clear track audio nodes - allow sounds to fade out visually
}

function togglePatternPlayback() {
  if (isPlaying.value && playbackMode.value === 'pattern') {
    handlePause();
    return;
  }
  void handlePlayPattern();
}

function toggleMute(trackIndex: number) {
  playbackStore.toggleMute(trackIndex, trackCount.value);
}

function toggleSolo(trackIndex: number) {
  playbackStore.toggleSolo(trackIndex, trackCount.value);
}

function sanitizeMuteSoloState(trackTotal = trackCount.value) {
  playbackStore.sanitizeMuteSoloState(trackTotal);
}

async function initializePlayback(
  mode: 'pattern' | 'song' = playbackMode.value,
  skipIfPlaying: boolean = false,
): Promise<boolean> {
  updateTrackAudioNodes();
  const song = buildPlaybackSong(mode);
  return await playbackStore.loadSong(song, mode, skipIfPlaying);
}

// Assign the refs so wrappers can use them
updateTrackAudioNodesRef = updateTrackAudioNodes;
markTrackNotePlayedRef = markTrackNotePlayed;
setTrackAudioNodeForInstrumentRef = setTrackAudioNodeForInstrument;

// Set up instruments composable
const instrumentsContext: TrackerInstrumentsContext = {
  trackerStore,
  patchStore,
  router,
  instrumentSlots,
  songPatches,
  activeTrack,
  currentPattern,
  formatInstrumentId,
  ensureActiveInstrument,
  setActiveInstrument,
  syncSongBankFromSlots,
  sanitizeMuteSoloState,
  updateTrackAudioNodes,
  trackCount,
};

const {
  instrumentNameEditSlot,
  instrumentNameDraft,
  availablePatches,
  getInstrumentDisplayName,
  setInstrumentNameInputRef,
  beginInstrumentRename,
  cancelInstrumentRename,
  commitInstrumentRename,
  onPatchSelect,
  clearInstrument,
  createNewSongPatch,
  editSlotPatch,
  loadSystemBankOptions,
  addTrack,
  removeTrack,
} = useTrackerInstruments(instrumentsContext);

// Instrument volume (mixer) controls
const formatGainAsDb = (value: number): string => {
  if (value <= 0) return '-inf dB';
  const db = 20 * Math.log10(value);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
};

const onSlotVolumeChange = (slotNumber: number, volume: number) => {
  trackerStore.setSlotVolume(slotNumber, volume);
  // Apply to song bank immediately
  const instrumentId = formatInstrumentId(slotNumber);
  songBank.setInstrumentOutputGain(instrumentId, volume);
};

// Master volume control
const onMasterVolumeChange = (event: Event) => {
  const volume = parseFloat((event.target as HTMLInputElement).value);
  userSettingsStore.updateSetting('masterVolume', volume);
  songBank.setMasterVolume(volume);
};

// Flag to prevent watcher interference during explicit file load
const isLoadingSong = ref(false);

// Set up file I/O composable
const fileIOContext: TrackerFileIOContext = {
  trackerStore,
  songBank,
  currentSong,
  playbackMode,
  isLoadingSong,
  ensureActiveInstrument,
  syncSongBankFromSlots,
  initializePlayback,
  stopPlayback: () => {
    playbackStore.stop();
    clearTrackAudioNodes();
  },
};

const { handleSaveSongFile, handleLoadSongFile } =
  useTrackerFileIO(fileIOContext);

// New Song with confirmation
function handleNewSong() {
  $q.dialog({
    title: 'New Song',
    message:
      'Are you sure you want to start a new song? All unsaved changes will be lost.',
    cancel: {
      label: 'Cancel',
      flat: true,
    },
    ok: {
      label: 'New Song',
      color: 'negative',
    },
    persistent: true,
  }).onOk(() => {
    // Stop any playback first
    handleStop();
    // Reset the store to a fresh state
    trackerStore.resetToNewSong();
    // Resync the song bank with empty instruments
    syncSongBankFromSlots();
  });
}

// Set up keyboard command system
const keyboardContext: TrackerKeyboardContext = {
  // Current state
  activeRow,
  activeTrack,
  activeColumn,
  activeMacroNibble,
  isEditMode,
  isFullscreen,
  get rowsCount() {
    return rowsCount.value;
  },
  get trackCount() {
    return trackCount.value;
  },

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
  clearInstrumentField,
  clearVolumeNibble,
  clearVolumeField,
  clearMacroNibble,
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

  // Step size
  stepSize,
  setStepSizeInput,

  // Store actions
  undo: () => trackerStore.undo(),
  redo: () => trackerStore.redo(),

  // Track/Pattern operations
  copyTrack,
  cutTrack,
  pasteTrack,
  copyPattern,
  cutPattern,
  pastePattern,
  transposeTrack,
  transposePattern,

  // Note mapping
  noteKeyMap,
};

const { handleKeyDown: onKeyDown } = useTrackerKeyboard(keyboardContext);

// Set up export composable
const exportContext: TrackerExportContext = {
  getPlaybackEngine: () => playbackStore.engine,
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
  initializePlayback,
};

const {
  isExporting,
  showExportModal,
  exportStage,
  exportError,
  exportStatusText,
  exportProgressPercent,
  exportSongToMp3,
} = useTrackerExport(exportContext);

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

function handleWindowResize() {
  updatePatternAreaHeight();
  refreshVisualizerAlignment();
}

onMounted(async () => {
  trackerContainer.value?.focus();
  // Skip song bank sync if playback is active (returning from instrument editor)
  // The song bank already has the correct instruments loaded
  await loadSystemBankOptions({ skipSync: isPlaying.value || isPaused.value });
  ensureActiveInstrument();
  // Apply master volume from user settings
  songBank.setMasterVolume(userSettings.value.masterVolume);
  // Skip reloading song if playback is already active (returning to page while playing)
  void initializePlayback(playbackMode.value, true);
  keyboardStore.setupGlobalKeyboardListeners();
  keyboardStore.syncMidiSetting(userSettings.value.enableMidi);
  window.addEventListener('mouseup', handleGlobalMouseUp);
  window.addEventListener('resize', handleWindowResize);
  handleWindowResize();
  visualizerReady.value = false;
  await nextTick();
  refreshVisualizerAlignment();
  await nextTick();
  visualizerReady.value = true;
  visualizerReady.value = false;
  await nextTick();
  refreshVisualizerAlignment();
  visualizerReady.value = true;

  // Re-register the track audio node setter since it was cleared on unmount
  playbackStore.setTrackAudioNodeSetter(
    (trackIndex: number, instrumentId: string | undefined) => {
      setTrackAudioNodeForInstrument(trackIndex, instrumentId);
      markTrackNotePlayedRef?.(trackIndex);
    },
  );
});

watch(
  () => userSettings.value.enableMidi,
  (enabled) => {
    keyboardStore.syncMidiSetting(enabled);
  },
);

// Debounced BPM watcher to avoid excessive updates during slider dragging
let bpmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => currentSong.value.bpm,
  (bpm) => {
    if (bpmDebounceTimer) clearTimeout(bpmDebounceTimer);
    bpmDebounceTimer = setTimeout(() => {
      playbackStore.setBpm(bpm);
    }, 50);
  },
  { immediate: true },
);

watch(
  () => rowsCount.value,
  (rows) => playbackStore.setLength(rows),
  { immediate: true },
);

// Update pattern area height when fullscreen mode changes
watch(isFullscreen, async () => {
  await nextTick();
  updatePatternAreaHeight();
  refreshVisualizerAlignment();
});

watch(
  () => baseOctave.value,
  (oct) => trackerStore.setBaseOctave(oct),
  { immediate: true },
);

watch(
  () => currentPatternId.value,
  () => {
    updateTrackAudioNodes();
    refreshVisualizerAlignment();
  },
);

watch(trackCount, () => refreshVisualizerAlignment());

watch(
  () => userSettings.value.showWaveformVisualizers,
  async (show) => {
    if (show) {
      visualizerReady.value = false;
      await nextTick();
      refreshVisualizerAlignment();
      await nextTick();
      visualizerReady.value = true;
    } else {
      visualizerReady.value = false;
      teardownVisualizerScrollSync?.();
    }
  },
);

// Watch only the properties that matter for audio sync (slot, patchId, bankId)
// This prevents unnecessary audio rebuilds when editing instrument names
watch(slotSignatures, async () => {
  // Skip sync if explicit file load is in progress - handleLoadSongFile handles everything
  if (isLoadingSong.value) {
    return;
  }

  // Skip sync if playback is active - the song bank already has the correct state
  // This prevents interruption when returning from instrument editor
  if (isPlaying.value || isPaused.value) {
    updateTrackAudioNodes();
    return;
  }

  // Ensure audio context is resumed before creating instruments
  // This provides the required user gesture for browsers' autoplay policy
  await songBank.ensureAudioContextRunning();
  await syncSongBankFromSlots();
  updateTrackAudioNodes();
  // Skip reloading song if playback is active to preserve position
  void initializePlayback(playbackMode.value, true);
});

onBeforeUnmount(() => {
  // Clear the track audio node setter so the store doesn't try to call into unmounted component
  playbackStore.setTrackAudioNodeSetter(null);
  // Don't stop playback - it continues when navigating away
  // Don't dispose the songBank - it's a singleton managed by trackerAudioStore
  keyboardStore.cleanup();
  keyboardStore.clearAllNotes();
  keyboardStore.cleanupMidiListeners();
  window.removeEventListener('mouseup', handleGlobalMouseUp);
  window.removeEventListener('resize', handleWindowResize);
  teardownVisualizerScrollSync?.();
  // Cancel pending scroll RAF
  if (scrollRafId !== null) {
    cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  }
});
</script>

<style scoped>
.tracker-page {
  height: var(--q-page-container-height, 100vh);
  background: var(--app-background, #0b111a);
  box-sizing: border-box;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.tracker-page.edit-mode-active {
  box-shadow: 0 0 0 2px rgba(255, 90, 90, 0.9) inset;
}

.song-loading-overlay {
  position: absolute;
  inset: 0;
  background: rgba(10, 10, 20, 0.65);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}

.song-loading-dialog {
  background: #0f172a;
  border: 1px solid #223150;
  border-radius: 12px;
  padding: 20px 24px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
  min-width: 240px;
  text-align: center;
  color: #e2e8f0;
}

.song-loading-text {
  font-weight: 600;
  margin-top: 12px;
}

.song-loading-subtext {
  font-size: 12px;
  opacity: 0.8;
  margin-top: 4px;
}

.song-loading-dialog .spinner {
  width: 36px;
  height: 36px;
  margin: 0 auto;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.2);
  border-top-color: #5eead4;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
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
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.18));
  background: var(--button-background, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, #e8f3ff);
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  contain: layout style paint;
}

.toolbar-icon-button.active {
  background: var(--tracker-active-bg, rgba(112, 194, 255, 0.25));
  border-color: var(--tracker-accent-primary, rgba(112, 194, 255, 0.75));
  color: var(--text-primary, #fff);
}

.toolbar-icon-button:hover {
  border-color: var(--tracker-accent-primary, rgba(112, 194, 255, 0.9));
}

.top-grid {
  display: grid;
  grid-template-columns: 1fr 1.5fr 1fr;
  gap: 14px;
  padding: 0 18px;
  flex-shrink: 0;
  max-width: 1600px;
  margin: 0 auto;
  width: 100%;
  contain: layout style;
}

.top-panel {
  min-height: 220px;
  display: flex;
  flex-direction: column;
}

.pattern-area-wrapper {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.pattern-area {
  position: relative;
  z-index: 1;
  height: 100%;
  overflow-y: auto;
  overflow-x: auto;
  padding: 0 18px 18px;
  text-align: center;
  contain: layout style;
  /* Optimize scrolling performance */
  -webkit-overflow-scrolling: touch;
  scroll-behavior: auto;
  overscroll-behavior: contain;
}

.pattern-area :deep(.tracker-pattern) {
  display: inline-flex;
  text-align: left;
}

.pattern-area::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.pattern-area::-webkit-scrollbar-thumb {
  background: var(--button-background, rgba(255, 255, 255, 0.12));
  border-radius: 999px;
}

.pattern-area::-webkit-scrollbar-thumb:hover {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.18));
}

.pattern-area::-webkit-scrollbar-track {
  background: transparent;
}

.pattern-area::-webkit-scrollbar-corner {
  background: transparent;
}

.visualizer-row {
  display: grid;
  grid-template-columns: 78px 1fr;
  gap: 12px;
  padding: 0 36px 0;
  flex-shrink: 0;
  margin: 0 auto;
  width: 100%;
  overflow: hidden;
}

.visualizer-spacer {
  width: 78px;
  min-width: 78px;
  max-width: 78px;
  flex-shrink: 0;
}

.visualizer-tracks {
  --tracker-track-width: 180px;
  --tracker-track-gap: 10px;
  display: flex;
  gap: var(--tracker-track-gap);
  overflow-x: auto;
  width: 100%;
  position: relative;
  scrollbar-width: none;
}

.visualizer-tracks::-webkit-scrollbar {
  display: none;
}

.visualizer-fade {
  opacity: 0;
  transition: opacity 180ms ease;
}

.visualizer-fade.ready {
  opacity: 1;
}

.visualizer-cell {
  width: var(--tracker-track-width);
  min-width: var(--tracker-track-width);
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
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.15));
  background: var(--button-background, rgba(255, 255, 255, 0.05));
  color: var(--text-muted, #9fb3d3);
  font-size: 9px;
  font-weight: 700;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  contain: layout style paint;
}

.track-btn:hover {
  border-color: var(--panel-border, rgba(255, 255, 255, 0.3));
  background: var(--button-background-hover, rgba(255, 255, 255, 0.1));
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
  color: var(--tracker-accent-primary, #9cc7ff);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 700;
  margin-bottom: 4px;
}

.summary-card {
  background: var(--panel-background, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
  border-radius: 14px;
  padding: 10px 12px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  gap: 8px;
  contain: layout style paint;
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

.transport-controls {
  display: flex;
  justify-content: flex-start;
  gap: 8px;
  margin-top: auto;
  padding-top: 12px;
}

.transport-icon-btn {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.12));
  background: var(--button-background, rgba(255, 255, 255, 0.04));
  color: var(--text-secondary, #b8c9e0);
  cursor: pointer;
  display: flex;
  justify-content: center;
  align-items: center;
  contain: layout style paint;
}

.transport-icon-btn:hover {
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.45));
  color: var(--text-primary, #eaf6ff);
  background: var(--button-hover, rgba(255, 255, 255, 0.08));
}

.transport-icon-btn.active {
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.14));
  color: var(--tracker-accent-primary, #4df2c5);
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.5));
  box-shadow: 0 4px 14px rgba(77, 242, 197, 0.18);
}

.volume-control {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 10px;
  background: var(--input-background, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--input-border, rgba(255, 255, 255, 0.08));
  margin-top: 8px;
}

.volume-icon {
  color: var(--text-secondary, #b8c9e0);
  flex-shrink: 0;
}

.volume-slider {
  flex: 1;
  min-width: 100px;
  height: 4px;
  border-radius: 2px;
  background: var(--input-background, rgba(255, 255, 255, 0.1));
  outline: none;
  -webkit-appearance: none;
  appearance: none;
}

.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--tracker-accent-primary, #4df2c5);
  cursor: pointer;
  border: 2px solid var(--panel-background, #0c1018);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

.volume-slider::-webkit-slider-thumb:hover {
  background: var(--tracker-accent-primary, #5ffad0);
  box-shadow: 0 2px 8px rgba(77, 242, 197, 0.4);
}

.volume-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--tracker-accent-primary, #4df2c5);
  cursor: pointer;
  border: 2px solid var(--panel-background, #0c1018);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}

.volume-slider::-moz-range-thumb:hover {
  background: var(--tracker-accent-primary, #5ffad0);
  box-shadow: 0 2px 8px rgba(77, 242, 197, 0.4);
}

.volume-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(
    to right,
    var(--tracker-accent-primary, #4df2c5) 0%,
    var(--tracker-accent-primary, #4df2c5) var(--volume-percent, 75%),
    var(--input-background, rgba(255, 255, 255, 0.1)) var(--volume-percent, 75%),
    var(--input-background, rgba(255, 255, 255, 0.1)) 100%
  );
}

.volume-slider::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: var(--input-background, rgba(255, 255, 255, 0.1));
}

.volume-slider::-moz-range-progress {
  height: 4px;
  border-radius: 2px;
  background: var(--tracker-accent-primary, #4df2c5);
}

.volume-value {
  color: var(--text-primary, #e8f3ff);
  font-size: 12px;
  font-weight: 700;
  font-family: var(--font-tracker, monospace);
  min-width: 38px;
  text-align: right;
  flex-shrink: 0;
}

.transport-button {
  padding: 8px 12px;
  min-width: 120px;
  border-radius: 8px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.12));
  background: var(--button-background, rgba(255, 255, 255, 0.04));
  color: var(--text-primary, #eaf6ff);
  font-weight: 700;
  letter-spacing: 0.04em;
  cursor: pointer;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  contain: layout style paint;
}

.transport-button:hover {
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.45));
}

.transport-button.play {
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.14));
  color: var(--text-primary, #f7fcff);
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.5));
  box-shadow: 0 4px 14px rgba(77, 242, 197, 0.18);
}

.transport-button.play.alt {
  background: var(--tracker-active-bg, rgba(132, 173, 255, 0.14));
  color: var(--text-primary, #f7fcff);
  border-color: var(--tracker-accent-secondary, rgba(160, 196, 255, 0.45));
  box-shadow: 0 4px 14px rgba(112, 194, 255, 0.18);
}

.transport-button.stop {
  background: rgba(255, 99, 128, 0.18);
  border-color: rgba(255, 99, 128, 0.3);
}

.transport-button.ghost {
  background: transparent;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.15));
  color: var(--text-primary, #fff);
}

.transport-button.active {
  box-shadow:
    0 0 0 2px var(--tracker-selected-bg, rgba(77, 242, 197, 0.35)),
    0 8px 20px rgba(0, 0, 0, 0.35);
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
  color: var(--text-secondary, #cfe4ff);
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
  color: var(--text-muted, #9fb3d3);
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
  color: var(--text-muted, #9fb3d3);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 700;
}

.field input {
  background: var(--input-background, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--input-border, rgba(255, 255, 255, 0.08));
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--text-primary, #e8f3ff);
  font-weight: 600;
  font-size: 13px;
}

.field input::placeholder {
  color: var(--text-muted, rgba(255, 255, 255, 0.5));
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
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    color 120ms ease;
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
  color: var(--text-muted, #9fb3d3);
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
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.12));
  background: var(--button-background, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, #e8f3ff);
  font-weight: 700;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background-color 120ms ease;
}

.song-button:hover {
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.4));
}

.song-button.ghost {
  background: transparent;
  border-color: var(--panel-border, rgba(255, 255, 255, 0.12));
}

.control-field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--input-background, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--input-border, rgba(255, 255, 255, 0.08));
  border-radius: 10px;
  padding: 6px 8px;
  min-height: 40px;
}

.length-input {
  width: 60px;
  background: var(--input-background, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  color: var(--text-primary, #e8f3ff);
  font-weight: 700;
  font-size: 14px;
  text-align: center;
  padding: 4px 8px;
  font-family: var(--font-tracker, monospace);
  /* Hide default spinner buttons */
  -moz-appearance: textfield;
  appearance: textfield;
}

.length-input::-webkit-outer-spin-button,
.length-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.length-input:focus {
  outline: none;
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.6));
  background: var(--input-background, rgba(255, 255, 255, 0.08));
}

.length-input:hover {
  border-color: var(--input-border, rgba(255, 255, 255, 0.2));
}

/* Style BPM input to match theme */
.bpm-input {
  -moz-appearance: textfield;
  appearance: textfield;
}

.bpm-input::-webkit-outer-spin-button,
.bpm-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.control-hint {
  color: var(--text-muted, #9fb3d3);
  font-size: 12px;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary, #cfe4ff);
  font-weight: 700;
}

.toggle input {
  accent-color: var(--tracker-accent-primary, #4df2c5);
}

.instrument-panel {
  background: var(--panel-background, rgba(21, 27, 39, 0.95));
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.08));
  border-radius: 14px;
  padding: 10px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.32);
  display: flex;
  flex-direction: column;
  contain: layout style paint;
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
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  background: var(--button-background, rgba(255, 255, 255, 0.04));
  color: var(--text-muted, #9fb3d3);
  font-weight: 700;
  font-size: 11px;
  cursor: pointer;
  transition: all 120ms ease;
}

.page-tab:hover {
  border-color: var(--panel-border, rgba(255, 255, 255, 0.2));
  color: var(--text-primary, #e8f3ff);
}

.page-tab.active {
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.15));
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.4));
  color: var(--tracker-accent-primary, #4df2c5);
}

.panel-title {
  color: var(--text-primary, #e8f3ff);
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

.instrument-list::-webkit-scrollbar {
  width: 6px;
}

.instrument-list::-webkit-scrollbar-thumb {
  background: var(--button-background, rgba(255, 255, 255, 0.12));
  border-radius: 999px;
}

.instrument-list::-webkit-scrollbar-thumb:hover {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.18));
}

.instrument-list::-webkit-scrollbar-track {
  background: transparent;
}

.instrument-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--panel-background-alt, rgba(255, 255, 255, 0.02));
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.05));
  cursor: pointer;
}

.instrument-row.active {
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.6));
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.08));
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
  color: var(--text-primary, #e8f3ff);
  font-weight: 600;
  font-size: 13px;
}
.instrument-name-input {
  width: 100%;
  font: inherit;
  color: var(--text-primary, #e8f3ff);
  background: var(--input-background, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--input-border, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  padding: 6px 8px;
}

.slot-number {
  font-family: var(--font-tracker);
  color: var(--text-muted, #9fb3d3);
  font-weight: 700;
  font-size: 11px;
  flex-shrink: 0;
}

.instrument-volume {
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.instrument-volume :deep(.knob-wrapper) {
  padding: 0;
}

.instrument-volume :deep(.value-display) {
  font-size: 9px;
  min-width: 28px;
  padding: 1px 2px;
}

.instrument-volume :deep(.knob-label) {
  display: none;
}

.instrument-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-shrink: 0;
  margin-left: auto;
}

.icon-action-button {
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 6px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  background: var(--button-background, rgba(255, 255, 255, 0.04));
  color: var(--text-secondary, #b8c9e0);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 120ms ease;
}

.icon-action-button:hover:not(:disabled) {
  border-color: var(--tracker-accent-primary, rgba(77, 242, 197, 0.5));
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.12));
  color: var(--text-primary, #e8f3ff);
}

.icon-action-button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.icon-action-button.danger:hover:not(:disabled) {
  border-color: rgba(255, 100, 100, 0.5);
  background: rgba(255, 100, 100, 0.12);
  color: #ff8080;
}

.patch-select {
  flex: 1;
  min-width: 100px;
  max-width: 180px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--input-border, rgba(255, 255, 255, 0.1));
  background: var(--input-background, rgba(255, 255, 255, 0.04));
  color: var(--text-primary, #e8f3ff);
  font-weight: 500;
  font-size: 11px;
}

.patch-select option {
  color: var(--tracker-cell-active-text, #0c1624);
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
  background: var(--panel-background, #0b111a);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  padding: 18px 20px;
  width: min(420px, 90vw);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
}

.export-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary, #fff);
  margin-bottom: 8px;
}

.export-status {
  color: var(--text-secondary, rgba(255, 255, 255, 0.85));
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
  background: var(--input-background, rgba(255, 255, 255, 0.08));
  overflow: hidden;
}

.export-progress-fill {
  height: 100%;
  background: linear-gradient(
    90deg,
    var(--tracker-accent-primary, #4df2c5),
    var(--tracker-accent-secondary, #7fe0ff)
  );
  transition: width 120ms linear;
}

.export-progress-value {
  width: 48px;
  text-align: right;
  color: var(--text-secondary, rgba(255, 255, 255, 0.8));
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
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.12));
  background: var(--button-background, rgba(255, 255, 255, 0.06));
  color: var(--text-primary, #fff);
}

@media (max-width: 900px) {
  .top-grid {
    grid-template-columns: 1fr;
  }
}
</style>
