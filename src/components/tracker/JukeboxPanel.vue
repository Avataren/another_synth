<template>
  <div class="jukebox-panel">
    <div class="jukebox-body">
      <div class="panel-header">
        <div class="panel-title">
          Jukebox
          <span class="playlist-count">{{ entries.length }}</span>
        </div>
        <button
          type="button"
          class="jukebox-close"
          title="Close the jukebox"
          @click="$emit('close')"
        >
          ×
        </button>
      </div>

      <div class="now-playing" :class="{ idle: !current }">
        <div class="now-playing-label">
          {{ isPlaying ? 'Now playing' : 'Up next' }}
        </div>
        <div class="now-playing-title" :title="current?.title ?? ''">
          {{ current?.title ?? 'Nothing queued' }}
        </div>
        <div v-if="current" class="now-playing-meta">
          {{ current.format }} · {{ current.channels }}ch ·
          {{ formatSize(current.bytes) }}
        </div>
      </div>

      <div class="jukebox-transport">
        <button
          type="button"
          class="jukebox-btn"
          title="Previous song"
          :disabled="!hasEntries || busy"
          @click="$emit('previous')"
        >
          <q-icon name="skip_previous" size="18px" />
        </button>
        <button
          type="button"
          class="jukebox-btn primary"
          :title="isPlaying ? 'Pause' : 'Play'"
          :disabled="!hasEntries || busy"
          @click="$emit('toggle-play')"
        >
          <q-icon :name="isPlaying ? 'pause' : 'play_arrow'" size="18px" />
        </button>
        <button
          type="button"
          class="jukebox-btn"
          title="Next song"
          :disabled="!hasEntries || busy"
          @click="$emit('next')"
        >
          <q-icon name="skip_next" size="18px" />
        </button>
        <button
          type="button"
          class="jukebox-btn"
          title="Shuffle the playlist"
          :disabled="entries.length < 2"
          @click="$emit('shuffle')"
        >
          <q-icon name="shuffle" size="18px" />
        </button>
        <button
          type="button"
          class="jukebox-btn"
          :class="{ active: repeat }"
          :title="repeat ? 'Repeat the playlist' : 'Stop after the last song'"
          @click="$emit('update:repeat', !repeat)"
        >
          <q-icon name="repeat" size="18px" />
        </button>
      </div>

      <div v-if="busy" class="jukebox-status">Loading song…</div>

      <div ref="listContainer" class="playlist">
        <div
          v-for="(entry, index) in entries"
          :key="entry.file"
          :ref="(el) => setRowRef(index, el)"
          class="playlist-item"
          :class="{ current: index === currentIndex }"
          :title="entry.title"
          @dblclick="$emit('play-index', index)"
        >
          <div class="playlist-index">
            <q-icon
              v-if="index === currentIndex && isPlaying"
              name="volume_up"
              size="13px"
            />
            <span v-else>{{ index + 1 }}</span>
          </div>
          <div class="playlist-body">
            <div class="playlist-title">{{ entry.title }}</div>
            <div class="playlist-meta">
              {{ entry.format }} · {{ entry.channels }}ch ·
              {{ formatSize(entry.bytes) }}
            </div>
          </div>
          <div class="playlist-actions">
            <button
              type="button"
              title="Play this song"
              :disabled="busy"
              @click.stop="$emit('play-index', index)"
            >
              ▶
            </button>
            <button
              type="button"
              title="Remove from the playlist"
              @click.stop="$emit('remove', index)"
            >
              ×
            </button>
          </div>
        </div>

        <div v-if="!hasEntries" class="playlist-empty">
          The playlist is empty. Add some demo songs to get going.
        </div>
      </div>

      <div class="jukebox-controls">
        <button type="button" class="jukebox-text-btn" @click="$emit('add')">
          + Add songs
        </button>
        <button
          type="button"
          class="jukebox-text-btn ghost"
          :disabled="!hasEntries"
          @click="$emit('refill')"
        >
          Refill all
        </button>
        <button
          type="button"
          class="jukebox-text-btn ghost"
          :disabled="!hasEntries"
          @click="$emit('clear')"
        >
          Clear
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch, type ComponentPublicInstance } from 'vue';
import type { JukeboxEntry } from 'src/stores/jukebox-store';

/**
 * The visible playlist.
 *
 * Purely presentational: it renders the queue and reports what the user did.
 * Loading a module needs the tracker page's instrument machinery, so the page
 * owns every one of these actions.
 */
const props = defineProps<{
  entries: JukeboxEntry[];
  currentIndex: number;
  current: JukeboxEntry | null;
  hasEntries: boolean;
  isPlaying: boolean;
  repeat: boolean;
  /** A song is being fetched and its instruments rebuilt. */
  busy: boolean;
}>();

defineEmits<{
  next: [];
  previous: [];
  'toggle-play': [];
  shuffle: [];
  'play-index': [index: number];
  remove: [index: number];
  add: [];
  refill: [];
  clear: [];
  close: [];
  'update:repeat': [value: boolean];
}>();

const listContainer = ref<HTMLElement | null>(null);
const rowRefs = new Map<number, HTMLElement>();

function setRowRef(index: number, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLElement) rowRefs.set(index, el);
  else rowRefs.delete(index);
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// A long playlist scrolls the current song out of view as it advances, and the
// one thing the panel always has to show is what is playing now.
watch(
  () => props.currentIndex,
  async (index) => {
    await nextTick();
    rowRefs.get(index)?.scrollIntoView({ block: 'nearest' });
  },
);
</script>

<style scoped>
/*
 * The panel must not make the top row any taller than it already was -- every
 * pixel it adds comes straight off the pattern area below, which is the part
 * of the screen actually worth looking at.
 *
 * So the grid item itself holds nothing: its only child is taken out of flow,
 * which leaves the item with no content height to contribute. The row goes on
 * being sized by the panels that were always there, and the body stretches to
 * fill whatever that turns out to be, with the playlist scrolling inside it.
 */
.jukebox-panel {
  position: relative;
  min-height: 220px;
}

.jukebox-body {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 10px 12px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
  min-height: 0;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary, rgba(255, 255, 255, 0.7));
}

.playlist-count {
  margin-left: 6px;
  font-size: 11px;
  opacity: 0.6;
}

.jukebox-close {
  background: none;
  border: none;
  color: var(--text-secondary, rgba(255, 255, 255, 0.6));
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}

.jukebox-close:hover {
  color: var(--text-primary, #fff);
}

.now-playing {
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(77, 242, 197, 0.35);
  border-radius: 8px;
  padding: 6px 10px;
  min-width: 0;
}

.now-playing.idle {
  border-color: rgba(255, 255, 255, 0.08);
}

.now-playing-label {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-secondary, rgba(255, 255, 255, 0.5));
}

.now-playing-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, #fff);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-playing-meta {
  font-size: 11px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.55));
}

.jukebox-transport {
  display: flex;
  gap: 4px;
}

.jukebox-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--button-background, rgba(255, 255, 255, 0.08));
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  color: var(--text-primary, #fff);
  padding: 5px 0;
  cursor: pointer;
}

.jukebox-btn:hover:not(:disabled) {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.16));
}

.jukebox-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.jukebox-btn.primary,
.jukebox-btn.active {
  background: rgba(77, 242, 197, 0.16);
  border-color: rgba(77, 242, 197, 0.5);
}

.jukebox-status {
  font-size: 11px;
  color: var(--tracker-accent-primary, #4df2c5);
}

.playlist {
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
  /* The one part that gives: everything else in the panel is a fixed size, so
     the playlist takes whatever height is left and scrolls past it. */
  flex: 1 1 0;
  min-height: 0;
}

.playlist::-webkit-scrollbar {
  width: 6px;
}

.playlist::-webkit-scrollbar-thumb {
  background: var(--button-background, rgba(255, 255, 255, 0.12));
  border-radius: 999px;
}

.playlist::-webkit-scrollbar-track {
  background: transparent;
}

.playlist-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid transparent;
  cursor: default;
  min-width: 0;
}

.playlist-item:hover {
  background: rgba(0, 0, 0, 0.35);
}

.playlist-item.current {
  background: rgba(77, 242, 197, 0.12);
  border-color: var(--tracker-accent-primary, #4df2c5);
}

.playlist-index {
  width: 20px;
  flex-shrink: 0;
  text-align: right;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary, rgba(255, 255, 255, 0.45));
}

.playlist-item.current .playlist-index {
  color: var(--tracker-accent-primary, #4df2c5);
}

.playlist-body {
  flex: 1;
  min-width: 0;
}

.playlist-title {
  font-size: 12px;
  color: var(--text-primary, #fff);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playlist-meta {
  font-size: 10px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.45));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playlist-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
  opacity: 0;
}

.playlist-item:hover .playlist-actions,
.playlist-item.current .playlist-actions {
  opacity: 1;
}

.playlist-actions button {
  background: none;
  border: none;
  color: var(--text-secondary, rgba(255, 255, 255, 0.6));
  font-size: 12px;
  line-height: 1;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
}

.playlist-actions button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-primary, #fff);
}

.playlist-actions button:disabled {
  opacity: 0.3;
  cursor: default;
}

.playlist-empty {
  font-size: 11px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.45));
  padding: 12px 4px;
  text-align: center;
}

.jukebox-controls {
  display: flex;
  gap: 6px;
}

.jukebox-text-btn {
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

.jukebox-text-btn.ghost {
  background: transparent;
  color: var(--text-secondary, rgba(255, 255, 255, 0.7));
}

.jukebox-text-btn:hover:not(:disabled) {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.16));
  color: var(--text-primary, #fff);
}

.jukebox-text-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
