<template>
  <div v-if="modelValue" class="demo-modal" @click.self="close">
    <div class="demo-dialog">
      <div class="demo-header">
        <div class="demo-title">Demo songs</div>
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

        <div class="demo-list">
          <button
            v-for="song in activeSongs"
            :key="song.file"
            type="button"
            class="demo-song"
            :disabled="busyFile !== null"
            :class="{ busy: busyFile === song.file }"
            @click="select(song)"
          >
            <span class="demo-song-title">{{ song.title }}</span>
            <span class="demo-song-meta">
              {{ song.format }} · {{ song.channels }}ch ·
              {{ formatSize(song.bytes) }}
            </span>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

/**
 * Browser for the demo modules published alongside the app.
 *
 * The manifest is fetched rather than imported, so a missing or unreachable
 * collection stays an expected state rather than a build error -- the modules
 * are third-party music served as plain files, and the app should still come
 * up without them.
 */
export interface DemoSong {
  /** Path relative to the manifest, e.g. "amiga/song.mod". */
  file: string;
  title: string;
  format: string;
  channels: number;
  bytes: number;
}

export interface DemoCollection {
  id: string;
  name: string;
  songs: DemoSong[];
}

const props = defineProps<{
  modelValue: boolean;
  /** Directory the manifest and modules are served from. */
  baseUrl?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  select: [url: string, song: DemoSong];
}>();

const collections = ref<DemoCollection[]>([]);
const activeCollectionId = ref<string | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const busyFile = ref<string | null>(null);
let loaded = false;

const base = computed(() => props.baseUrl ?? 'demos');

const activeSongs = computed(() => {
  const collection = collections.value.find(
    (c) => c.id === activeCollectionId.value,
  );
  return collection?.songs ?? [];
});

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

async function loadManifest() {
  if (loaded) return;
  loading.value = true;
  error.value = null;
  try {
    const response = await fetch(`${base.value}/index.json`);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    const manifest = (await response.json()) as {
      collections?: DemoCollection[];
    };
    collections.value = manifest.collections ?? [];
    activeCollectionId.value = collections.value[0]?.id ?? null;
    if (collections.value.length === 0) {
      error.value = 'No demo songs are published.';
    }
    loaded = true;
  } catch (err) {
    // The collection is published separately from the app, so a missing or
    // unreachable manifest is an expected state rather than a failure.
    error.value = `Demo songs are unavailable (${(err as Error).message}).`;
  } finally {
    loading.value = false;
  }
}

async function select(song: DemoSong) {
  busyFile.value = song.file;
  try {
    emit('select', `${base.value}/${song.file}`, song);
  } finally {
    busyFile.value = null;
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
