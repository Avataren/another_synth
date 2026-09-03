<template>
  <q-page class="jukebox-page" :class="{ 'is-mobile': isMobileLayout }">
    <div v-if="restoring" class="jukebox-overlay">
      <div class="jukebox-overlay-card">
        <div class="spinner" aria-hidden="true"></div>
        <div class="overlay-text">Restoring your song…</div>
      </div>
    </div>

    <!--
      One row of controls, and no more: everything below it is the part worth
      looking at. Transport, what is playing and where it is all live on this
      line; the playlist itself slides in beside the visualizers.
    -->
    <div class="jukebox-bar">
      <button
        type="button"
        class="bar-btn"
        title="Back to the tracker"
        @click="leaveToTracker"
      >
        <q-icon name="arrow_back" size="18px" />
      </button>

      <div class="transport">
        <button
          type="button"
          class="bar-btn"
          title="Previous song"
          :disabled="!jukebox.hasEntries || isBusy"
          @click="player.step(-1)"
        >
          <q-icon name="skip_previous" size="20px" />
        </button>
        <button
          type="button"
          class="bar-btn primary"
          :title="isPlaying ? 'Pause' : 'Play'"
          :disabled="!jukebox.hasEntries || isBusy"
          @click="player.togglePlayback()"
        >
          <q-icon :name="isPlaying ? 'pause' : 'play_arrow'" size="20px" />
        </button>
        <button
          type="button"
          class="bar-btn"
          title="Next song"
          :disabled="!jukebox.hasEntries || isBusy"
          @click="player.step(1)"
        >
          <q-icon name="skip_next" size="20px" />
        </button>
        <button
          type="button"
          class="bar-btn"
          title="Shuffle the playlist"
          :disabled="jukebox.entries.length < 2"
          @click="player.shuffle()"
        >
          <q-icon name="shuffle" size="18px" />
        </button>
        <button
          type="button"
          class="bar-btn"
          :class="{ active: jukebox.repeat }"
          :title="
            jukebox.repeat ? 'Repeat the playlist' : 'Stop after the last song'
          "
          @click="jukebox.setRepeat(!jukebox.repeat)"
        >
          <q-icon name="repeat" size="18px" />
        </button>
      </div>

      <div class="now-playing" :title="nowPlayingTitle">
        <div class="now-playing-title">
          {{ nowPlayingTitle }}
          <span v-if="isBusy" class="loading-tag">loading…</span>
        </div>
        <div class="now-playing-meta">{{ nowPlayingMeta }}</div>
      </div>

      <div class="position">
        <span title="Pattern of the sequence">
          <span class="position-key">PTN</span>
          <span class="position-value">{{ patternLabel }}</span>
        </span>
        <span title="Row of the pattern">
          <span class="position-key">ROW</span>
          <span class="position-value">{{ rowLabel }}</span>
        </span>
        <span v-if="jukebox.hasEntries" title="Place in the playlist">
          <span class="position-key">SONG</span>
          <span class="position-value">
            {{ jukebox.currentIndex + 1 }}/{{ jukebox.entries.length }}
          </span>
        </span>
      </div>

      <div class="volume-control" title="Master volume">
        <q-icon name="volume_up" size="14px" />
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
        />
      </div>

      <label class="bar-toggle" title="Scroll one row per playback step instead of paging">
        <input v-model="userSettings.granularPlaybackScroll" type="checkbox" />
        <span>Row scroll</span>
      </label>

      <button
        type="button"
        class="bar-btn"
        :class="{ active: showPlaylist }"
        title="Show the playlist"
        @click="showPlaylist = !showPlaylist"
      >
        <q-icon name="queue_music" size="20px" />
      </button>
    </div>

    <div class="jukebox-body">
      <div class="stage">
        <div v-if="trackCount > 0 && !isMobileLayout" class="scope-row">
          <div
            v-for="index in trackCount"
            :key="`scope-${index - 1}`"
            class="scope-cell"
            :class="{ muted: !playbackStore.isTrackAudible(index - 1) }"
            :title="`Channel ${index} — click to mute`"
            @click="toggleMute(index - 1)"
          >
            <TrackWaveform
              :audio-node="trackAudioNodes[index - 1] ?? null"
              :audio-context="audioContext"
            />
            <div class="scope-label">{{ index }}</div>
          </div>
        </div>

        <div class="pattern-area-wrapper">
          <TrackerSpectrumAnalyzer
            v-if="spectrumAnalyzerVisible"
            :node="masterOutputNode"
            :track-nodes="spectrumTrackNodes"
            :is-playing="isPlaying"
          />
          <div
            ref="patternAreaRef"
            class="pattern-area"
            @scroll.passive="onPatternAreaScroll"
          >
            <PatternCanvas
              v-if="canvasRenderer && !canvasRendererFailed"
              :tracks="currentPattern?.tracks ?? []"
              :rows="rowsCount"
              :selected-row="playbackRow"
              :playback-row="playbackRow"
              :active-track="-1"
              :active-column="-1"
              :active-macro-nibble="0"
              :selection-rect="null"
              :auto-scroll="true"
              :is-playing="isPlaying"
              playback-mode="song"
              :scroll-top="patternAreaScrollTop"
              :scroll-left="patternAreaScrollLeft"
              :container-width="patternAreaWidth"
              :container-height="patternAreaHeight"
              :is-mouse-selecting="false"
              :show-extra-effect-column="
                userSettings.showTrackerExtraEffectColumn
              "
              :reserve-side-gutter="spectrumAnalyzerVisible"
              :granular-scroll="userSettings.granularPlaybackScroll"
              :upcoming-pattern="upcomingPattern"
              @scroll="onCanvasScroll"
              @renderer-error="onCanvasRendererError"
            />
            <TrackerPattern
              v-else
              :tracks="currentPattern?.tracks ?? []"
              :rows="rowsCount"
              :selected-row="playbackRow"
              :playback-row="playbackRow"
              :active-track="-1"
              :active-column="-1"
              :active-macro-nibble="0"
              :selection-rect="null"
              :auto-scroll="true"
              :is-playing="isPlaying"
              playback-mode="song"
              :scroll-top="patternAreaScrollTop"
              :container-height="patternAreaHeight"
              :is-mouse-selecting="false"
              :show-extra-effect-column="
                userSettings.showTrackerExtraEffectColumn
              "
              :reserve-side-gutter="spectrumAnalyzerVisible"
              :upcoming-pattern="upcomingPattern"
            />
          </div>
        </div>
      </div>

      <div v-if="showPlaylist" class="playlist-dock">
        <JukeboxPanel
          :entries="jukebox.entries"
          :current-index="jukebox.currentIndex"
          :current="jukebox.current"
          :has-entries="jukebox.hasEntries"
          :is-playing="isPlaying"
          :repeat="jukebox.repeat"
          :busy="isBusy"
          @next="player.step(1)"
          @previous="player.step(-1)"
          @toggle-play="player.togglePlayback()"
          @shuffle="player.shuffle()"
          @play-index="player.playIndex($event)"
          @remove="player.remove($event)"
          @add="showDemoBrowser = true"
          @refill="player.refill()"
          @clear="player.clear()"
          @close="showPlaylist = false"
          @update:repeat="jukebox.setRepeat($event)"
        />
      </div>
    </div>

    <DemoSongBrowser
      v-model="showDemoBrowser"
      mode="add"
      :queued-files="queuedFiles"
      @select="(_url, song) => player.addSong(song)"
    />
  </q-page>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useQuasar } from 'quasar';
import TrackerPattern from 'src/components/tracker/TrackerPattern.vue';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import { selectUpcomingPattern } from 'src/components/tracker/pattern-buffering';
import TrackerSpectrumAnalyzer from 'src/components/tracker/TrackerSpectrumAnalyzer.vue';
import TrackWaveform from 'src/components/tracker/TrackWaveform.vue';
import JukeboxPanel from 'src/components/tracker/JukeboxPanel.vue';
import DemoSongBrowser from 'src/components/tracker/DemoSongBrowser.vue';
import { useTrackerSongHost } from 'src/composables/useTrackerSongHost';
import { useJukeboxPlayer } from 'src/composables/useJukeboxPlayer';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import { useMobileLayout } from 'src/composables/useMobileLayout';
import type { TrackerSongFile } from 'src/stores/tracker-store';

/**
 * The jukebox: the demo collection played end to end, on its own page.
 *
 * It shares the one audio engine and the one tracker store with the editor --
 * there is only one of each -- so the song it plays would otherwise land on
 * top of whatever the user was working on. The way out is a snapshot: the
 * editor's song is serialised on the way in and put back on the way out, so
 * playing the collection leaves the editor exactly as it was found.
 */

const router = useRouter();
const $q = useQuasar();
const userSettingsStore = useUserSettingsStore();
const { settings: userSettings } = storeToRefs(userSettingsStore);

const host = useTrackerSongHost();
const {
  trackAudioNodes,
  spectrumTrackNodes,
  audioContext,
  masterOutputNode,
  currentPattern,
  trackCount,
} = host;
const player = useJukeboxPlayer(host);
const { jukebox, isBusy, queuedFiles } = player;
const playbackStore = host.playbackStore;
const { isPlaying, playbackRow, currentSequenceIndex } =
  storeToRefs(playbackStore);

const trackerStore = host.trackerStore;
const rowsCount = computed(() => trackerStore.currentPatternRows);

/**
 * The pattern the sequencer plays after the current one, for the grid's
 * playback double-buffer. Guard rules in pattern-buffering.ts; same feed as
 * the tracker page so jukebox pattern switches get the same no-blank swap.
 */
const upcomingPattern = computed(() =>
  selectUpcomingPattern(
    isPlaying.value,
    currentSequenceIndex.value,
    trackerStore.sequence,
    (id) => {
      const next = trackerStore.patterns.find((p) => p.id === id);
      if (!next) return null;
      return { id: next.id, tracks: next.tracks, rows: trackerStore.rowsForPattern(next.id) };
    },
  ),
);

const showPlaylist = ref(false);
const showDemoBrowser = ref(false);
const restoring = ref(false);

// ---------------------------------------------------------------
// The editor's song, kept safe for the duration
// ---------------------------------------------------------------

/**
 * The song the editor had loaded when the jukebox opened, in the same form a
 * saved file takes -- which is the one form known to round-trip, since it is
 * what Save and Load already use.
 */
const editorSong: TrackerSongFile = trackerStore.serializeSong();
/** Undo history is not part of a song file, so it is carried across by hand. */
const editorUndo = trackerStore.undoStack.slice();
const editorRedo = trackerStore.redoStack.slice();
let restored = false;

/** Put the editor's song back, exactly once. */
async function restoreEditorSong(): Promise<void> {
  if (restored) return;
  restored = true;
  restoring.value = true;
  try {
    player.stop();
    // Wait out any song still loading, so it cannot land on top of this one.
    await player.dispose();
    playbackStore.stop();
    await host.applySongFile(editorSong);
    trackerStore.undoStack = editorUndo;
    trackerStore.redoStack = editorRedo;
  } catch (error) {
    console.error('[Jukebox] Could not restore the editor song', error);
  } finally {
    restoring.value = false;
  }
}

// Restoring is awaited before the route changes, so the tracker page mounts
// onto the song it had rather than racing the rebuild for it.
onBeforeRouteLeave(async () => {
  await restoreEditorSong();
});

function leaveToTracker(): void {
  void router.push('/tracker');
}

// ---------------------------------------------------------------
// Display
// ---------------------------------------------------------------

const nowPlayingTitle = computed(
  () => jukebox.current?.title ?? 'Nothing queued',
);

const nowPlayingMeta = computed(() => {
  const entry = jukebox.current;
  if (!entry) return 'Add some demo songs to get going';
  const size =
    entry.bytes >= 1024 * 1024
      ? `${(entry.bytes / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(entry.bytes / 1024)} KB`;
  return `${entry.format} · ${entry.channels}ch · ${size}`;
});

const patternLabel = computed(() => {
  const pattern = String(currentSequenceIndex.value + 1).padStart(2, '0');
  const total = String(trackerStore.sequence.length).padStart(2, '0');
  return `${pattern}/${total}`;
});

const rowLabel = computed(() => String(playbackRow.value).padStart(2, '0'));

function onMasterVolumeChange(event: Event): void {
  const volume = parseFloat((event.target as HTMLInputElement).value);
  userSettingsStore.updateSetting('masterVolume', volume);
  host.songBank.setUserMasterVolume(volume);
}

function toggleMute(trackIndex: number): void {
  playbackStore.toggleMute(trackIndex, trackCount.value);
}

// ---------------------------------------------------------------
// The pattern view, which virtualises against its own scroll box
// ---------------------------------------------------------------

const patternAreaRef = ref<HTMLDivElement | null>(null);
const patternAreaScrollTop = ref(0);
const patternAreaScrollLeft = ref(0);
const patternAreaWidth = ref(0);
const patternAreaHeight = ref(600);

/**
 * The phone layout: no per-channel scopes and no analyser (they are the
 * page's whole GPU budget, and the song host stops the bank building the
 * per-track taps that feed them), the control bar on one scrolling line,
 * and the playlist as a full-screen sheet rather than a 300px dock.
 */
const isMobileLayout = useMobileLayout();
const spectrumAnalyzerVisible = computed(
  () => userSettings.value.showSpectrumAnalyzer && !isMobileLayout.value,
);

/**
 * Canvas renderer on until the page's own copy proves it cannot run here.
 *
 * The setting has no toggle any more -- the canvas grid is the pattern grid
 * -- but it is still read rather than hardcoded, so the DOM grid remains
 * reachable by editing the stored settings if it is ever needed again.
 */
const canvasRenderer = computed(() => userSettings.value.canvasPatternRenderer);
const canvasRendererFailed = ref(false);

/**
 * Latest scroll position reported by the canvas pattern renderer.
 *
 * The rAF callback reads this, not its closure: scroll events arrive in
 * bursts faster than frames, and a captured payload would keep writing a
 * stale position over newer ones. Adopting the newest value per frame is
 * what keeps the page state where the user actually scrolled.
 */
let pendingCanvasScroll: { top: number; left: number } | null = null;

function onCanvasScroll(payload: { top: number; left: number }): void {
  pendingCanvasScroll = payload;
  if (scrollRafId !== null) return;
  scrollRafId = requestAnimationFrame(() => {
    const pending = pendingCanvasScroll;
    pendingCanvasScroll = null;
    if (pending) {
      patternAreaScrollTop.value = pending.top;
      patternAreaScrollLeft.value = pending.left;
    }
    scrollRafId = null;
  });
}

/**
 * Fall back to the DOM grid, for this pattern.
 *
 * Neither persisted nor permanent: what the renderer reports is a property
 * of the pattern in front of it (one whose bitmap will not fit) rather than
 * of the machine, so the jukebox -- which plays a new song every few
 * minutes -- retries on every pattern change below. The notification is
 * once per page; the retry would otherwise make it once per pattern.
 */
function onCanvasRendererError(error: Error): void {
  canvasRendererFailed.value = true;
  if (!canvasFailureNotified) {
    canvasFailureNotified = true;
    $q.notify({
      type: 'negative',
      message: `Canvas pattern renderer failed — switched to the DOM grid. (${error.message})`,
    });
  }
}

let canvasFailureNotified = false;

watch([trackCount, rowsCount, () => currentPattern.value?.id], () => {
  if (canvasRendererFailed.value) canvasRendererFailed.value = false;
});

let scrollRafId: number | null = null;

function onPatternAreaScroll(event: Event): void {
  if (scrollRafId !== null) return;
  scrollRafId = requestAnimationFrame(() => {
    patternAreaScrollTop.value = (event.target as HTMLElement).scrollTop;
    scrollRafId = null;
  });
}

function updatePatternAreaHeight(): void {
  if (patternAreaRef.value) {
    patternAreaHeight.value = patternAreaRef.value.clientHeight;
    patternAreaWidth.value = patternAreaRef.value.clientWidth;
  }
}

// ---------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------

let teardownSongEnd: (() => void) | null = null;

onMounted(async () => {
  host.applyMasterVolume();
  host.claimTrackAudioNodeSetter();
  updatePatternAreaHeight();
  window.addEventListener('resize', updatePatternAreaHeight);
  // Advancing the playlist needs this page's song loading, so the handover
  // only runs while the jukebox is on screen.
  teardownSongEnd = playbackStore.onSongEnd(() => {
    if (!jukebox.active) return;
    void player.step(1);
  });
  await player.start();
});

onBeforeUnmount(() => {
  host.releaseTrackAudioNodeSetter();
  window.removeEventListener('resize', updatePatternAreaHeight);
  teardownSongEnd?.();
  teardownSongEnd = null;
  if (scrollRafId !== null) {
    cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  }
  // A close or a reload skips the route guard; the store is process-local, so
  // there is nothing to put back in that case, but a programmatic unmount
  // still has to leave the editor's song where it was.
  void restoreEditorSong();
});
</script>

<style scoped>
.jukebox-page {
  height: var(--q-page-container-height, 100vh);
  background: var(--app-background, #0b111a);
  box-sizing: border-box;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  color: var(--text-primary, #e8f3ff);
}

/* One slim row. Nothing here is allowed to grow taller than the buttons. */
.jukebox-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 44px;
  padding: 0 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.transport {
  display: flex;
  gap: 4px;
}

.bar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 30px;
  padding: 0 6px;
  background: var(--button-background, rgba(255, 255, 255, 0.08));
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: var(--text-primary, #fff);
  cursor: pointer;
}

.bar-btn:hover:not(:disabled) {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.16));
}

.bar-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.bar-btn.primary,
.bar-btn.active {
  background: rgba(77, 242, 197, 0.16);
  border-color: rgba(77, 242, 197, 0.5);
}

.bar-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: var(--button-background, rgba(255, 255, 255, 0.08));
  color: var(--text-primary, #fff);
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}

.bar-toggle input {
  accent-color: var(--tracker-accent-primary, #4df2c5);
}

.now-playing {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 10px;
  overflow: hidden;
}

.now-playing-title {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.loading-tag {
  margin-left: 8px;
  font-size: 11px;
  font-weight: 400;
  color: var(--tracker-accent-primary, #4df2c5);
}

.now-playing-meta {
  font-size: 11px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.55));
  white-space: nowrap;
}

.position {
  display: flex;
  align-items: baseline;
  gap: 14px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.position-key {
  margin-right: 5px;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--text-secondary, rgba(255, 255, 255, 0.45));
}

.position-value {
  color: var(--tracker-accent-primary, #4df2c5);
}

.volume-control {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.6));
}

.volume-slider {
  width: 90px;
  height: 4px;
  appearance: none;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--tracker-accent-primary, #4df2c5) var(--volume-percent, 100%),
    rgba(255, 255, 255, 0.12) var(--volume-percent, 100%)
  );
  cursor: pointer;
}

.volume-slider::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--tracker-accent-primary, #4df2c5);
}

.jukebox-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 10px;
  padding: 10px 0 0;
}

.stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* One oscilloscope per channel, spread across the width. */
.scope-row {
  flex-shrink: 0;
  display: grid;
  grid-auto-columns: 1fr;
  grid-auto-flow: column;
  gap: 6px;
  padding: 0 18px;
  height: 84px;
}

.scope-cell {
  position: relative;
  min-width: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.25);
  cursor: pointer;
}

.scope-cell.muted {
  opacity: 0.25;
}

.scope-cell :deep(.track-waveform) {
  width: 100%;
  height: 100%;
  border: none;
  border-radius: 0;
  background: transparent;
}

.scope-label {
  position: absolute;
  left: 5px;
  top: 3px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary, rgba(255, 255, 255, 0.45));
  pointer-events: none;
}

.pattern-area-wrapper {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.pattern-area {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 18px 18px;
  text-align: center;
  contain: layout style;
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

.pattern-area::-webkit-scrollbar-track {
  background: transparent;
}

.playlist-dock {
  flex: 0 0 300px;
  min-height: 0;
  padding: 0 10px 10px 0;
}

/* -------------------------------------------------------------------
 * Phone layout (class-driven, from useMobileLayout -- see TrackerPage)
 * ------------------------------------------------------------------- */

/*
 * The bar keeps its one-row promise on a phone by scrolling sideways
 * instead of wrapping: eight controls plus the now-playing text and the
 * position readout became five stacked rows at 390px, which is more of the
 * screen than the pattern got.
 */
.jukebox-page.is-mobile .jukebox-bar {
  gap: 8px;
  padding: 0 8px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  touch-action: pan-x;
  -webkit-overflow-scrolling: touch;
}

.jukebox-page.is-mobile .jukebox-bar::-webkit-scrollbar {
  display: none;
}

.jukebox-page.is-mobile .jukebox-bar > * {
  flex: 0 0 auto;
}

/*
 * What is playing still earns its place -- it is the one thing the page is
 * for -- but it stops being elastic and its second line goes: the title
 * alone answers "what is this", and the meta line repeats what the position
 * readout already shows.
 */
.jukebox-page.is-mobile .now-playing {
  max-width: 42vw;
  min-width: 0;
}

.jukebox-page.is-mobile .now-playing-meta {
  display: none;
}

.jukebox-page.is-mobile .jukebox-body {
  padding: 6px 0 0;
}

.jukebox-page.is-mobile .pattern-area {
  padding: 0 4px 4px;
}

/*
 * The playlist takes the screen rather than a 300px column of it: at 390px
 * a dock leaves neither itself nor the pattern usable, and the playlist is
 * a thing you open, act on and dismiss.
 */
.jukebox-page.is-mobile .playlist-dock {
  position: fixed;
  inset: 44px 0 0;
  z-index: 2500;
  flex: none;
  padding: 8px;
  background: var(--app-background, #0b111a);
}

/* The panel sizes itself to its container, which here is the full dock. */
.playlist-dock :deep(.jukebox-panel) {
  height: 100%;
}

.jukebox-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4, 8, 14, 0.72);
}

.jukebox-overlay-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 24px;
  border-radius: 12px;
  background: var(--panel-background, #101823);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.overlay-text {
  font-size: 14px;
}

.spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.2);
  border-top-color: var(--tracker-accent-primary, #4df2c5);
  animation: jukebox-spin 0.8s linear infinite;
}

@keyframes jukebox-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
