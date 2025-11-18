<template>
  <div class="preset-toolbar">
    <!-- Left section: bank info + patch selector -->
    <div class="toolbar-section left-section">
      <div class="bank-chip">
        <span class="bank-name">{{ currentBankName }}</span>
        <span class="patch-count">{{ patches.length }} patches</span>
      </div>

      <q-select
        v-model="selectedPatchId"
        :options="patchOptions"
        dense
        outlined
        emit-value
        map-options
        options-dense
        placeholder="Select patch"
        class="patch-select"
        @update:model-value="handlePatchSelect"
      >
        <template #no-option>
          <q-item>
            <q-item-section class="text-grey">No patches</q-item-section>
          </q-item>
        </template>
      </q-select>

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
      <q-btn
        label="Save"
        color="primary"
        dense
        @click="handleSavePatch"
        :disable="!patchName || !currentPatchId"
      />
      <q-btn
        label="New"
        color="secondary"
        dense
        @click="handleNewPatch"
      />
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
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { useQuasar } from 'quasar';

const store = useAudioSystemStore();
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
const pasteDialogOpen = ref(false);
const pasteText = ref('');
const pasteType = ref<'patch' | 'bank'>('patch');

// Computed properties
const currentBankName = computed(() => {
  return store.currentBank?.metadata.name || 'No Bank';
});

const patches = computed(() => {
  return store.getAllPatches();
});

const patchOptions = computed(() => {
  return patches.value.map((patch) => ({
    label: patch.metadata.name,
    value: patch.metadata.id,
  }));
});

const currentPatchId = computed(() => store.currentPatchId);
const hasBank = computed(() => store.currentBank !== null);

// Watch for changes to current patch and keep local selection/name in sync
watch(
  currentPatchId,
  (newId) => {
    if (newId) {
      selectedPatchId.value = newId;
      const patch = patches.value.find((p) => p.metadata.id === newId);
      patchName.value = patch?.metadata.name || '';
    } else {
      selectedPatchId.value = null;
      patchName.value = '';
    }
  },
  { immediate: true },
);

// Handlers
const handlePatchSelect = async (patchId: string | null) => {
  selectedPatchId.value = patchId;
  if (!patchId) return;

  try {
    const success = await store.loadPatch(patchId);
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

const handleLoadPatch = async () => {
  if (!selectedPatchId.value) return;

  try {
    const success = await store.loadPatch(selectedPatchId.value);
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
    const patch = await store.updateCurrentPatch(patchName.value.trim());
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

const handleNewPatch = async () => {
  try {
    // Reset the current synth state back to default values
    // so the new patch starts from a clean baseline.
    store.resetCurrentStateToDefaults();

    const patch = await store.saveCurrentPatch('New Patch');
    if (patch) {
      notify({
        type: 'positive',
        message: `New patch "${patch.metadata.name}" created`,
        timeout: 2000,
      });
      patchName.value = patch.metadata.name;
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

const handleCopyPatch = () => {
  const json = store.exportCurrentPatchAsJSON();
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
  const json = store.exportCurrentBankAsJSON();
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
      success = await store.importPatchFromJSON(pasteText.value);
    } else {
      success = await store.importBankFromJSON(pasteText.value);
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

  const patch = patches.value.find((p) => p.metadata.id === selectedPatchId.value);
  const patchName = patch?.metadata.name || 'this patch';

  $q.dialog({
    title: 'Confirm Delete',
    message: `Are you sure you want to delete "${patchName}"?`,
    cancel: true,
    persistent: true,
  }).onOk(() => {
    if (selectedPatchId.value) {
      const success = store.deletePatch(selectedPatchId.value);
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
    store.createNewBank(bankName);
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
  background-color: #2a2a2a;
  border-bottom: 1px solid #444;
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
  background-color: #3a3a3a;
}

.bank-name {
  font-weight: bold;
  font-size: 12px;
  color: #fff;
}

.patch-count {
  font-size: 12px;
  color: #999;
}

.patch-select {
  min-width: 160px;
}

.patch-name-input {
  flex: 1;
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
