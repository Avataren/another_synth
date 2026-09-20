<template>
  <div
    v-if="open"
    class="song-export-backdrop"
    data-testid="song-export-dialog"
    @click.self="emit('close')"
    @keydown="onKeydown"
  >
    <div
      ref="dialogEl"
      class="song-export-dialog"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      :aria-labelledby="headingId"
    >
      <h2 :id="headingId" class="song-export-heading">Export song file</h2>
      <ul class="song-export-list">
        <li
          v-for="row in rows"
          :key="row.exporter.id"
          class="song-export-row"
          :class="{ 'is-disabled': row.state.state !== 'enabled' }"
          :data-testid="`song-export-row-${row.exporter.id}`"
        >
          <div class="song-export-row-head">
            <span class="song-export-label">{{ row.exporter.label }}</span>
            <span class="song-export-ext">{{ row.exporter.extension }}</span>
            <button
              type="button"
              class="song-export-download"
              :data-testid="`song-export-download-${row.exporter.id}`"
              :disabled="row.state.state !== 'enabled'"
              :aria-disabled="row.state.state !== 'enabled'"
              @click="download(row.exporter)"
            >
              Download
            </button>
          </div>
          <p
            v-if="row.exporter.description"
            class="song-export-description"
            :data-testid="`song-export-description-${row.exporter.id}`"
          >
            {{ row.exporter.description }}
          </p>
          <p
            v-if="row.state.reason"
            class="song-export-reason"
            :data-testid="`song-export-reason-${row.exporter.id}`"
          >
            {{ row.state.reason }}
          </p>
          <template v-else>
            <p
              v-for="(line, index) in row.warnings"
              :key="index"
              class="song-export-warning"
              :data-testid="`song-export-warning-${row.exporter.id}`"
            >
              {{ line }}
            </p>
            <p class="song-export-filename" :data-testid="`song-export-filename-${row.exporter.id}`">
              Saves as: {{ row.fileName }}
            </p>
          </template>
        </li>
      </ul>
      <p v-if="status" class="song-export-status" role="status" data-testid="song-export-status">
        {{ status }}
      </p>
      <p v-if="error" class="song-export-error" role="alert" data-testid="song-export-error">
        {{ error }}
      </p>
      <button
        type="button"
        class="song-export-close"
        data-testid="song-export-close"
        @click="emit('close')"
      >
        Close
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from 'vue';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { downloadBytes } from 'src/audio/tracker/song-export/download';
import { exportFileName } from 'src/audio/tracker/song-export/file-name';
import { describeSongExporter, SONG_EXPORTERS } from 'src/audio/tracker/song-export/registry';
import { SongExportError, type SongExporter } from 'src/audio/tracker/song-export/types';

interface Props {
  open: boolean;
  /** The song as it is now: called when the dialog opens and again on every download. */
  getSong: () => TrackerSongFile;
  exporters?: readonly SongExporter[];
}

const props = withDefaults(defineProps<Props>(), { exporters: () => SONG_EXPORTERS });
const emit = defineEmits<{ (event: 'close'): void }>();

const headingId = 'song-export-heading';
const dialogEl = ref<HTMLElement | null>(null);
// Shallow: the AHX source bytes are attached to the song file object itself
// (`ahx-source` keys on its identity), which a reactive proxy would not be.
const song = shallowRef<TrackerSongFile | null>(null);
const status = ref('');
const error = ref('');
let opener: HTMLElement | null = null;

const rows = computed(() => {
  const current = song.value;
  if (!current) return [];
  const title = current.data.currentSong.title;
  return props.exporters.map((exporter) => {
    const state = describeSongExporter(exporter, current);
    return {
      exporter,
      state,
      warnings: state.state === 'enabled' ? (exporter.warnings?.(current) ?? []) : [],
      fileName: exportFileName(title, exporter.extension),
    };
  });
});

const focusables = (): HTMLElement[] =>
  Array.from(dialogEl.value?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? []);

watch(
  () => props.open,
  async (open) => {
    if (!open) {
      opener?.focus?.();
      opener = null;
      return;
    }
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    status.value = '';
    error.value = '';
    song.value = props.getSong();
    await nextTick();
    (dialogEl.value?.querySelector<HTMLElement>('.song-export-download:not([disabled])') ??
      dialogEl.value?.querySelector<HTMLElement>('.song-export-close'))?.focus();
  },
  { immediate: true },
);

function download(exporter: SongExporter): void {
  status.value = '';
  error.value = '';
  try {
    const fresh = props.getSong();
    song.value = fresh;
    const state = describeSongExporter(exporter, fresh);
    if (state.state !== 'enabled') throw new SongExportError(state.reason ?? "This song can't be exported.");
    const bytes = exporter.serialize(fresh);
    const fileName = exportFileName(fresh.data.currentSong.title, exporter.extension);
    downloadBytes(bytes, fileName, exporter.mimeType);
    status.value = `Download started: ${fileName}`;
  } catch (caught) {
    error.value = caught instanceof SongExportError ? caught.message : `Export failed: ${(caught as Error).message}`;
  }
}

/** Esc closes; Tab stays inside; no key reaches the tracker's shortcuts underneath. */
function onKeydown(event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
    return;
  }
  if (event.key !== 'Tab') return;
  const items = focusables();
  const first = items[0];
  const last = items[items.length - 1];
  if (!first || !last) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialogEl.value?.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialogEl.value?.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
</script>

<style scoped>
.song-export-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2500;
}

.song-export-dialog {
  background: var(--panel-background, #0b111a);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  padding: 18px 20px;
  width: min(520px, 92vw);
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.4);
  color: var(--text-secondary, rgba(255, 255, 255, 0.85));
}

.song-export-heading {
  margin: 0 0 12px;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary, #fff);
}

.song-export-list {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.song-export-row {
  padding: 10px 12px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
}

.song-export-row.is-disabled {
  opacity: 0.7;
}

.song-export-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.song-export-label {
  font-weight: 600;
  color: var(--text-primary, #fff);
}

.song-export-ext {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}

.song-export-download {
  margin-left: auto;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--tracker-accent-primary, #4df2c5);
  background: transparent;
  color: var(--tracker-accent-primary, #4df2c5);
  cursor: pointer;
}

.song-export-download:disabled {
  border-color: var(--panel-border, rgba(255, 255, 255, 0.2));
  color: inherit;
  opacity: 0.5;
  cursor: not-allowed;
}

.song-export-description,
.song-export-reason,
.song-export-warning,
.song-export-filename {
  margin: 6px 0 0;
  font-size: 13px;
}

.song-export-reason {
  color: #ffd28a;
}

.song-export-warning {
  color: #ffd28a;
}

.song-export-filename {
  font-variant-numeric: tabular-nums;
  opacity: 0.8;
}

.song-export-status {
  margin: 0 0 10px;
  color: var(--tracker-accent-primary, #4df2c5);
}

.song-export-error {
  margin: 0 0 10px;
  color: #ff9db5;
}

.song-export-close {
  width: 100%;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.2));
  background: transparent;
  color: var(--text-primary, #fff);
  cursor: pointer;
}
</style>
