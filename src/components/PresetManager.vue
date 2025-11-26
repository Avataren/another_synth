<template>
  <div class="preset-toolbar">
    <!-- Left section: bank info + patch selector -->
    <div class="toolbar-section left-section">
      <div class="bank-chip">
        <span class="bank-name">{{ currentBankName }}</span>
        <span class="patch-count">{{ patches.length }} patches</span>
      </div>

      <PatchPicker
        v-model="selectedPatchId"
        :placeholder="patches.length === 0 ? 'No patches' : 'Select patch'"
        @select="handlePatchPickerSelect"
      />

      <q-btn
        icon="refresh"
        flat
        round
        dense
        @click="handleLoadPatch"
        :disable="!selectedPatchId"
        title="Load selected patch"
      />
    </div>

    <!-- Middle section: save / new patch -->
    <div class="toolbar-section middle-section">
      <q-input
        v-model="patchName"
        dense
        outlined
        placeholder="Patch name"
        @keyup.enter="handleSavePatch"
        class="patch-name-input"
      />
      <q-input
        v-model="patchCategory"
        dense
        outlined
        placeholder="Category (e.g., FM/Lead)"
        @keyup.enter="handleSavePatch"
        class="patch-category-input"
      />
      <q-select
        v-model="voiceCountSelection"
        :options="voiceOptions"
        dense
        outlined
        label="Voices"
        emit-value
        map-options
        class="voice-count-select"
        @update:model-value="handleVoiceCountChange"
      />
      <q-btn
        label="Save"
        color="primary"
        dense
        @click="handleSavePatch"
        :disable="!patchName || !currentPatchId"
      />
      <q-btn
        label="Clone"
        color="accent"
        dense
        @click="handleClonePatch"
        :disable="!currentPatchId"
        title="Clone current patch with a new ID"
      />
      <q-btn label="New" color="secondary" dense @click="handleNewPatch" />
    </div>

    <!-- Right section: import / export / bank actions -->
    <div class="toolbar-section right-section">
      <q-btn
        label="Copy Patch"
        outline
        color="secondary"
        dense
        @click="handleCopyPatch"
        :disable="!currentPatchId"
      />
      <q-btn
        label="Copy Bank"
        outline
        color="secondary"
        dense
        @click="handleCopyBank"
        :disable="!hasBank"
      />
      <q-btn
        label="Download Patch"
        outline
        color="secondary"
        dense
        @click="handleDownloadPatch"
        :disable="!currentPatchId"
      />
      <q-btn
        label="Download Bank"
        outline
        color="secondary"
        dense
        @click="handleDownloadBank"
        :disable="!hasBank"
      />
      <q-btn
        label="Paste Patch"
        outline
        color="accent"
        dense
        @click="showPasteDialog('patch')"
      />
      <q-btn
        label="Paste Bank"
        outline
        color="accent"
        dense
        @click="showPasteDialog('bank')"
      />
      <q-btn
        label="Delete"
        outline
        color="negative"
        dense
        @click="handleDeletePatch"
        :disable="!selectedPatchId"
      />
      <q-btn
        label="New Bank"
        outline
        color="positive"
        dense
        @click="handleNewBank"
      />
    </div>

    <!-- Paste Dialog -->
    <q-dialog v-model="pasteDialogOpen">
      <q-card style="min-width: 400px">
        <q-card-section>
          <div class="text-h6">
            Paste {{ pasteType === 'patch' ? 'Patch' : 'Bank' }} JSON
          </div>
        </q-card-section>

        <q-card-section>
          <q-input
            v-model="pasteText"
            type="textarea"
            outlined
            rows="10"
            label="Paste JSON here"
            autofocus
          />
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat label="Cancel" color="primary" v-close-popup />
          <q-btn
            flat
            label="Import"
            color="primary"
            @click="handlePasteImport"
            :disable="!pasteText"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { usePatchStore } from 'src/stores/patch-store';
import { useLayoutStore } from 'src/stores/layout-store';
import { useQuasar } from 'quasar';
import { normalizePatchCategory } from 'src/utils/patch-category';
import PatchPicker from 'src/components/PatchPicker.vue';

const patchStore = usePatchStore();
const layoutStore = useLayoutStore();
const $q = useQuasar();

const notify = (options: {
  type: 'positive' | 'negative' | 'warning' | 'info';
  message: string;
  timeout?: number;
}) => {
  const anyQ = $q as unknown as { notify?: (opts: typeof options) => void };
  if (anyQ.notify && typeof anyQ.notify === 'function') {
    anyQ.notify(options);
  } else {
    // Fallback if Notify plugin is not available
    // eslint-disable-next-line no-console
    console.warn('Notify plugin not available', options);
  }
};

// Local state
const selectedPatchId = ref<string | null>(null);
const patchName = ref('');
const patchCategory = ref('');
const pasteDialogOpen = ref(false);
const pasteText = ref('');
const pasteType = ref<'patch' | 'bank'>('patch');
const voiceCountSelection = ref(1);

const clampVoiceCount = (value: number) =>
  Math.min(8, Math.max(1, Math.round(value || 1)));

const voiceOptions = computed(() =>
  Array.from({ length: 8 }, (_, idx) => {
    const count = idx + 1;
    return {
      label: `${count} voice${count === 1 ? '' : 's'}`,
      value: count,
    };
  }),
);

// Computed properties
const currentBankName = computed(() => {
  return patchStore.currentBank?.metadata.name || 'No Bank';
});

const patches = computed(() => {
  if (!patchStore.currentBank) return [];
  return patchStore.currentBank.patches;
});

const currentPatchId = computed(() => patchStore.currentPatchId);
const hasBank = computed(() => patchStore.currentBank !== null);

// Watch for changes to current patch and keep local selection/name in sync
watch(
  currentPatchId,
  (newId) => {
    if (newId) {
      selectedPatchId.value = newId;
      const patch = patches.value.find((p) => p.metadata.id === newId);
      patchName.value = patch?.metadata.name || '';
      patchCategory.value = patch?.metadata.category || '';
    } else {
      selectedPatchId.value = null;
      patchName.value = '';
      patchCategory.value = '';
    }
  },
  { immediate: true },
);

watch(
  () =>
    clampVoiceCount(
      layoutStore.synthLayout?.voiceCount ??
        layoutStore.synthLayout?.voices.length ??
        1,
    ),
  (val) => {
    voiceCountSelection.value = val;
  },
  { immediate: true },
);

// Handlers
const handlePatchPickerSelect = async (patch: { id: string; name: string }) => {
  await handlePatchSelect(patch.id);
};

const handlePatchSelect = async (patchId: string | null) => {
  selectedPatchId.value = patchId;
  if (!patchId) return;

  try {
    const success = await patchStore.loadPatch(patchId);
    if (success) {
      notify({
        type: 'positive',
        message: 'Patch loaded successfully',
        timeout: 2000,
      });
    } else {
      notify({
        type: 'negative',
        message: 'Failed to load patch',
        timeout: 2000,
      });
    }
  } catch (error) {
    notify({
      type: 'negative',
      message: `Error loading patch: ${error}`,
      timeout: 3000,
    });
  }
};

const handleVoiceCountChange = async (count: number) => {
  const clamped = clampVoiceCount(count);
  voiceCountSelection.value = clamped;

  const success = await patchStore.setVoiceCount(clamped);
  if (!success) {
    notify({
      type: 'negative',
      message: 'Failed to update voice count',
      timeout: 2000,
    });
  } else {
    notify({
      type: 'positive',
      message: `Voices set to ${clamped}`,
      timeout: 1500,
    });
  }
};

const handleLoadPatch = async () => {
  if (!selectedPatchId.value) return;

  try {
    const success = await patchStore.loadPatch(selectedPatchId.value);
    if (success) {
      notify({
        type: 'positive',
        message: 'Patch loaded successfully',
        timeout: 2000,
      });
    } else {
      notify({
        type: 'negative',
        message: 'Failed to load patch',
        timeout: 2000,
      });
    }
  } catch (error) {
    notify({
      type: 'negative',
      message: `Error loading patch: ${error}`,
      timeout: 3000,
    });
  }
};

const handleSavePatch = async () => {
  if (!patchName.value.trim() || !currentPatchId.value) return;

  try {
    const normalizedCategory = normalizePatchCategory(patchCategory.value);
    const patch = await patchStore.updateCurrentPatch(
      patchName.value.trim(),
      {
        category: normalizedCategory,
      },
    );
    if (patch) {
      notify({
        type: 'positive',
        message: `Patch "${patch.metadata.name}" saved`,
        timeout: 2000,
      });
    } else {
      notify({
        type: 'negative',
        message: 'Failed to save patch',
        timeout: 2000,
      });
    }
  } catch (error) {
    notify({
      type: 'negative',
      message: `Error saving patch: ${error}`,
      timeout: 3000,
    });
  }
};

const handleClonePatch = async () => {
  if (!currentPatchId.value) return;

  try {
    const clonedPatch = await patchStore.cloneCurrentPatch('Cloned');
    if (clonedPatch) {
      notify({
        type: 'positive',
        message: `Patch cloned as "${clonedPatch.metadata.name}"`,
        timeout: 2000,
      });
      // Update local name to match the cloned patch
      patchName.value = clonedPatch.metadata.name;
      patchCategory.value = clonedPatch.metadata.category || '';
    } else {
      notify({
        type: 'negative',
        message: 'Failed to clone patch',
        timeout: 2000,
      });
    }
  } catch (error) {
    notify({
      type: 'negative',
      message: `Error cloning patch: ${error}`,
      timeout: 3000,
    });
  }
};

const handleNewPatch = async () => {
  try {
    const patch = await patchStore.createNewPatchFromTemplate('New Patch');
    if (patch) {
      notify({
        type: 'positive',
        message: `New patch "${patch.metadata.name}" created`,
        timeout: 2000,
      });
      patchName.value = patch.metadata.name;
      patchCategory.value = patch.metadata.category || '';
    } else {
      notify({
        type: 'negative',
        message: 'Failed to create new patch',
        timeout: 2000,
      });
    }
  } catch (error) {
    notify({
      type: 'negative',
      message: `Error creating new patch: ${error}`,
      timeout: 3000,
    });
  }
};

const toSafeFileName = (name: string, fallback: string): string => {
  const base = (name || fallback).trim() || fallback;
  return base.replace(/[^a-z0-9\-_]+/gi, '_');
};

const downloadJsonFile = async (
  json: string,
  suggestedFilename: string,
): Promise<void> => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    // eslint-disable-next-line no-console
    console.warn('Download is only available in a browser environment');
    return;
  }

  const blob = new Blob([json], {
    type: 'application/json;charset=utf-8',
  });

  const anyWindow = window as unknown as {
    showSaveFilePicker?: (options: unknown) => Promise<{
      createWritable: () => Promise<WritableStreamDefaultWriter>;
    }>;
  };

  if (anyWindow.showSaveFilePicker) {
    try {
      const handle = await anyWindow.showSaveFilePicker({
        suggestedName: suggestedFilename,
        types: [
          {
            description: 'JSON Files',
            accept: {
              'application/json': ['.json'],
            },
          },
        ],
      });

      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === 'AbortError' || error.name === 'SecurityError')
      ) {
        return;
      }
      // eslint-disable-next-line no-console
      console.warn(
        'showSaveFilePicker failed, falling back to download link',
        error,
      );
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = suggestedFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const handleCopyPatch = () => {
  const json = patchStore.exportCurrentPatchAsJSON();
  if (json) {
    navigator.clipboard.writeText(json).then(() => {
      notify({
        type: 'positive',
        message: 'Patch JSON copied to clipboard',
        timeout: 2000,
      });
    });
  }
};

const handleCopyBank = () => {
  const json = patchStore.exportCurrentBankAsJSON();
  if (json) {
    navigator.clipboard.writeText(json).then(() => {
      notify({
        type: 'positive',
        message: 'Bank JSON copied to clipboard',
        timeout: 2000,
      });
    });
  }
};

const handleDownloadPatch = async () => {
  const json = patchStore.exportCurrentPatchAsJSON();
  if (!json) return;

  const name = patchStore.currentPatch?.metadata.name || 'patch';
  const filename = `${toSafeFileName(name, 'patch')}.json`;
  await downloadJsonFile(json, filename);
  notify({
    type: 'positive',
    message: 'Patch JSON download started',
    timeout: 2000,
  });
};

const handleDownloadBank = async () => {
  const json = patchStore.exportCurrentBankAsJSON();
  if (!json) return;

  const name = patchStore.currentBank?.metadata.name || 'bank';
  const filename = `${toSafeFileName(name, 'bank')}.json`;
  await downloadJsonFile(json, filename);
  notify({
    type: 'positive',
    message: 'Bank JSON download started',
    timeout: 2000,
  });
};

const showPasteDialog = (type: 'patch' | 'bank') => {
  pasteType.value = type;
  pasteText.value = '';
  pasteDialogOpen.value = true;
};

const handlePasteImport = async () => {
  if (!pasteText.value.trim()) return;

  try {
    let success = false;
    if (pasteType.value === 'patch') {
      success = await patchStore.importPatchFromJSON(pasteText.value);
    } else {
      success = await patchStore.importBankFromJSON(pasteText.value);
    }

    if (success) {
      notify({
        type: 'positive',
        message: `${pasteType.value === 'patch' ? 'Patch' : 'Bank'} imported successfully`,
        timeout: 2000,
      });
      pasteDialogOpen.value = false;
      pasteText.value = '';
    } else {
      notify({
        type: 'negative',
        message: 'Import failed. Check console for details.',
        timeout: 3000,
      });
    }
  } catch (error) {
    notify({
      type: 'negative',
      message: `Import error: ${error}`,
      timeout: 3000,
    });
  }
};

const handleDeletePatch = () => {
  if (!selectedPatchId.value) return;

  const patch = patches.value.find(
    (p) => p.metadata.id === selectedPatchId.value,
  );
  const patchName = patch?.metadata.name || 'this patch';

  $q.dialog({
    title: 'Confirm Delete',
    message: `Are you sure you want to delete "${patchName}"?`,
    cancel: true,
    persistent: true,
  }).onOk(() => {
    if (selectedPatchId.value) {
      const success = patchStore.deletePatch(selectedPatchId.value);
      if (success) {
        notify({
          type: 'positive',
          message: 'Patch deleted',
          timeout: 2000,
        });
        selectedPatchId.value = null;
      }
    }
  });
};

const handleNewBank = () => {
  $q.dialog({
    title: 'Create New Bank',
    message: 'Enter bank name:',
    prompt: {
      model: 'New Bank',
      type: 'text',
    },
    cancel: true,
    persistent: true,
  }).onOk((bankName: string) => {
    patchStore.createNewBank(bankName);
    notify({
      type: 'positive',
      message: `Bank "${bankName}" created`,
      timeout: 2000,
    });
  });
};
</script>

<style scoped>
.preset-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  background-color: var(--panel-background-alt);
  border-bottom: 1px solid var(--panel-border);
  box-sizing: border-box;
}

.toolbar-section {
  display: flex;
  align-items: center;
  gap: 8px;
}

.left-section {
  min-width: 280px;
}

.middle-section {
  flex: 1;
  min-width: 260px;
}

.right-section {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.bank-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 999px;
  background-color: var(--button-background);
}

.bank-name {
  font-weight: bold;
  font-size: 12px;
  color: var(--text-primary);
}

.patch-count {
  font-size: 12px;
  color: var(--text-muted);
}

.patch-name-input {
  flex: 1;
}

.patch-category-input {
  flex: 1;
  min-width: 200px;
}

.voice-count-select {
  width: 140px;
}

@media (max-width: 1200px) {
  .preset-toolbar {
    flex-wrap: wrap;
  }

  .right-section {
    justify-content: flex-start;
  }
}
</style>
