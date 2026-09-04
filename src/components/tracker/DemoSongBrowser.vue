<template>
  <div v-if="modelValue" class="demo-modal" @click.self="close">
    <div class="demo-dialog">
      <div class="demo-header">
        <div class="demo-title">{{ title }}</div>
        <button type="button" class="demo-close" @click="close">×</button>
      </div>

      <div v-if="loading" class="demo-status">Loading…</div>

      <div v-else-if="error" class="demo-status demo-error">
        {{ error }}
      </div>

      <template v-else>
        <div class="demo-tabs">
          <button
            v-for="collection in collections"
            :key="collection.id"
            type="button"
            class="demo-tab"
            :class="{ active: collection.id === activeCollectionId }"
            @click="activeCollectionId = collection.id"
          >
            {{ collection.name }}
            <span class="demo-tab-count">{{ collection.songs.length }}</span>
          </button>
        </div>

        <div class="demo-filter">
          <input
            v-model="filterText"
            class="demo-filter-input"
            type="text"
            placeholder="Filter songs…"
            enterkeyhint="search"
            autocomplete="off"
          />
          <span v-if="filterText" class="demo-filter-count">
            {{ visibleSongs.length }} / {{ activeSongs.length }}
          </span>
          <button
            v-if="filterText"
            type="button"
            class="demo-filter-clear"
            title="Clear the filter"
            @click="filterText = ''"
          >
            ×
          </button>
        </div>

        <div class="demo-list">
          <button
            v-for="song in visibleSongs"
            :key="song.file"
            type="button"
            class="demo-song"
            :disabled="busyFile !== null || (isAddMode && isQueued(song))"
            :class="{ busy: busyFile === song.file, queued: isQueued(song) }"
            @click="select(song)"
          >
            <span class="demo-song-title">{{ song.title }}</span>
            <span class="demo-song-meta">
              <span v-if="isAddMode && isQueued(song)" class="demo-song-queued"
                >queued</span
              >
              {{ song.format }} · {{ song.channels }}ch ·
              {{ formatSize(song.bytes) }}
            </span>
          </button>

          <div
            v-if="filterText && visibleSongs.length === 0"
            class="demo-status demo-no-match"
          >
            No songs match “{{ filterText.trim() }}”.
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  useDemoManifest,
  DEMO_BASE_URL,
  type DemoSong,
} from 'src/composables/useDemoManifest';
import { filterSongsIndexed } from 'src/composables/song-filter';

/**
 * Browser for the demo modules published alongside the app.
 *
 * Two modes. In `load` it replaces the song in the tracker and closes, which
 * is what the Demos button has always done. In `add` it stays open and hands
 * each pick to the jukebox playlist, so a run of songs can be queued without
 * reopening the dialog once per song.
 */
export type DemoBrowserMode = 'load' | 'add';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** Directory the manifest and modules are served from. */
    baseUrl?: string;
    mode?: DemoBrowserMode;
    /** In `add` mode, the files already queued, shown as such. */
    queuedFiles?: ReadonlySet<string>;
  }>(),
  { mode: 'load' },
);

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  select: [url: string, song: DemoSong];
}>();

const base = computed(() => props.baseUrl ?? DEMO_BASE_URL);
const { collections, loading, error, load } = useDemoManifest(base.value);

const activeCollectionId = ref<string | null>(null);
const busyFile = ref<string | null>(null);

const isAddMode = computed(() => props.mode === 'add');
const title = computed(() =>
  isAddMode.value ? 'Add to playlist' : 'Demo songs',
);

const activeSongs = computed(() => {
  const collection = collections.value.find(
    (c) => c.id === activeCollectionId.value,
  );
  return collection?.songs ?? [];
});

/** Session-scoped search text; narrows the active collection, view-only. */
const filterText = ref('');

const visibleSongs = computed(() =>
  filterSongsIndexed(
    activeSongs.value,
    filterText.value,
    (song) => song.title,
    (song) => song.file,
  ).map(({ item }) => item),
);

function isQueued(song: DemoSong): boolean {
  return props.queuedFiles?.has(song.file) ?? false;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

async function loadManifest() {
  await load();
  activeCollectionId.value ??= collections.value[0]?.id ?? null;
}

function select(song: DemoSong) {
  // In add mode the pick is cheap and the dialog stays open, so nothing is
  // marked busy -- the queued tick is the feedback instead.
  if (!isAddMode.value) busyFile.value = song.file;
  try {
    emit('select', `${base.value}/${song.file}`, song);
  } finally {
    if (!isAddMode.value) busyFile.value = null;
  }
}

function close() {
  emit('update:modelValue', false);
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) void loadManifest();
  },
  { immediate: true },
);
</script>

<style scoped>
.demo-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}

.demo-dialog {
  background: var(--panel-background, #0b111a);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  padding: 18px 20px;
  width: min(560px, 92vw);
  max-height: min(70vh, 640px);
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
}

.demo-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.demo-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary, #fff);
}

.demo-close {
  background: none;
  border: none;
  color: var(--text-secondary, rgba(255, 255, 255, 0.7));
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}

.demo-close:hover {
  color: var(--text-primary, #fff);
}

.demo-status {
  color: var(--text-secondary, rgba(255, 255, 255, 0.85));
  padding: 12px 0;
}

.demo-error {
  color: var(--negative, #ff8a8a);
}

.demo-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.demo-tab {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.8));
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
}

.demo-tab.active {
  background: rgba(77, 242, 197, 0.16);
  border-color: rgba(77, 242, 197, 0.5);
  color: var(--text-primary, #fff);
}

.demo-tab-count {
  opacity: 0.6;
  margin-left: 6px;
  font-size: 11px;
}

.demo-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}

.demo-filter-input {
  flex: 1;
  min-width: 0;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 6px;
  color: var(--text-primary, #fff);
  font-size: 16px; /* 16px+: mobile browsers zoom smaller inputs */
  padding: 7px 10px;
}

.demo-filter-input::placeholder {
  color: var(--text-secondary, rgba(255, 255, 255, 0.45));
}

.demo-filter-input:focus {
  outline: none;
  border-color: rgba(77, 242, 197, 0.5);
}

.demo-filter-count {
  flex-shrink: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary, rgba(255, 255, 255, 0.55));
  white-space: nowrap;
}

.demo-filter-clear {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-secondary, rgba(255, 255, 255, 0.6));
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 0 4px;
}

.demo-filter-clear:hover {
  color: var(--text-primary, #fff);
}

.demo-no-match {
  text-align: center;
}

.demo-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.demo-song {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  text-align: left;
  color: var(--text-primary, #fff);
}

.demo-song:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.08);
  border-color: var(--panel-border, rgba(255, 255, 255, 0.12));
}

.demo-song:disabled {
  cursor: default;
  opacity: 0.5;
}

.demo-song.busy {
  opacity: 1;
  border-color: rgba(77, 242, 197, 0.5);
}

.demo-song.queued {
  opacity: 0.55;
}

.demo-song-queued {
  color: rgba(77, 242, 197, 0.9);
  margin-right: 6px;
}

.demo-song-title {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.demo-song-meta {
  font-size: 11px;
  color: var(--text-secondary, rgba(255, 255, 255, 0.55));
  white-space: nowrap;
}
</style>
