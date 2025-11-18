<template>
  <q-card class="preset-manager-card">
    <audio-card-header
      title="Presets"
      :isMinimized="isMinimized"
      @minimizeClicked="isMinimized = !isMinimized"
    />

    <q-separator />

    <q-card-section v-show="!isMinimized" class="preset-container">
      <!-- Current Bank Info -->
      <div class="bank-info">
        <div class="bank-name">
          {{ currentBankName }}
        </div>
        <div class="patch-count">{{ patches.length }} patches</div>
      </div>

      <!-- Patch Selection -->
      <div class="patch-selector-group">
        <q-select
          v-model="selectedPatchId"
          :options="patchOptions"
          label="Select Patch"
          outlined
          dense
          emit-value
          map-options
          @update:model-value="handlePatchSelect"
          class="patch-select"
        >
          <template v-slot:no-option>
            <q-item>
              <q-item-section class="text-grey"> No patches </q-item-section>
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

      <!-- Save Current State -->
      <div class="save-section">
        <q-input
          v-model="newPatchName"
          label="New Patch Name"
          outlined
          dense
          @keyup.enter="handleSavePatch"
          class="patch-name-input"
        />
        <q-btn
          label="Save Current"
          color="primary"
          @click="handleSavePatch"
          :disable="!newPatchName"
          class="save-btn"
        />
      </div>

      <!-- Import/Export Actions -->
      <div class="import-export-section">
        <q-separator />
        <div class="section-title">Import / Export</div>

        <!-- Export Buttons -->
        <div class="button-row">
          <q-btn
            label="Copy Patch JSON"
            outline
            color="secondary"
            @click="handleCopyPatch"
            :disable="!currentPatchId"
            class="action-btn"
          />
          <q-btn
            label="Copy Bank JSON"
            outline
            color="secondary"
            @click="handleCopyBank"
            :disable="!hasBank"
            class="action-btn"
          />
        </div>

        <!-- Import Buttons -->
        <div class="button-row">
          <q-btn
            label="Paste Patch JSON"
            outline
            color="accent"
            @click="showPasteDialog('patch')"
            class="action-btn"
          />
          <q-btn
            label="Paste Bank JSON"
            outline
            color="accent"
            @click="showPasteDialog('bank')"
            class="action-btn"
          />
        </div>

        <!-- Delete Patch -->
        <div class="button-row">
          <q-btn
            label="Delete Patch"
            outline
            color="negative"
            @click="handleDeletePatch"
            :disable="!selectedPatchId"
            class="action-btn"
          />
          <q-btn
            label="New Bank"
            outline
            color="info"
            @click="handleNewBank"
            class="action-btn"
          />
        </div>
      </div>
    </q-card-section>

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
  </q-card>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { useQuasar } from 'quasar';
import AudioCardHeader from './AudioCardHeader.vue';

const store = useAudioSystemStore();
const $q = useQuasar();

// Local state
const isMinimized = ref(false);
const selectedPatchId = ref<string | null>(null);
const newPatchName = ref('');
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

// Watch for changes to current patch
watch(currentPatchId, (newId) => {
  if (newId && !selectedPatchId.value) {
    selectedPatchId.value = newId;
  }
});

// Initialize selected patch if there's a current one
if (currentPatchId.value) {
  selectedPatchId.value = currentPatchId.value;
}

// Handlers
const handlePatchSelect = (patchId: string | null) => {
  // Just update selection, don't auto-load
  selectedPatchId.value = patchId;
};

const handleLoadPatch = async () => {
  if (!selectedPatchId.value) return;

  try {
    const success = await store.loadPatch(selectedPatchId.value);
    if (success) {
      $q.notify({
        type: 'positive',
        message: 'Patch loaded successfully',
        timeout: 2000,
      });
    } else {
      $q.notify({
        type: 'negative',
        message: 'Failed to load patch',
        timeout: 2000,
      });
    }
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: `Error loading patch: ${error}`,
      timeout: 3000,
    });
  }
};

const handleSavePatch = async () => {
  if (!newPatchName.value.trim()) return;

  try {
    const patch = await store.saveCurrentPatch(newPatchName.value.trim());
    if (patch) {
      $q.notify({
        type: 'positive',
        message: `Patch "${patch.metadata.name}" saved`,
        timeout: 2000,
      });
      selectedPatchId.value = patch.metadata.id;
      newPatchName.value = '';
    } else {
      $q.notify({
        type: 'negative',
        message: 'Failed to save patch',
        timeout: 2000,
      });
    }
  } catch (error) {
    $q.notify({
      type: 'negative',
      message: `Error saving patch: ${error}`,
      timeout: 3000,
    });
  }
};

const handleCopyPatch = () => {
  const json = store.exportCurrentPatchAsJSON();
  if (json) {
    navigator.clipboard.writeText(json).then(() => {
      $q.notify({
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
      $q.notify({
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
      $q.notify({
        type: 'positive',
        message: `${pasteType.value === 'patch' ? 'Patch' : 'Bank'} imported successfully`,
        timeout: 2000,
      });
      pasteDialogOpen.value = false;
      pasteText.value = '';
    } else {
      $q.notify({
        type: 'negative',
        message: 'Import failed. Check console for details.',
        timeout: 3000,
      });
    }
  } catch (error) {
    $q.notify({
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
        $q.notify({
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
    $q.notify({
      type: 'positive',
      message: `Bank "${bankName}" created`,
      timeout: 2000,
    });
  });
};
</script>

<style scoped>
.preset-manager-card {
  background-color: #1e1e1e;
  border: 1px solid #333;
  min-width: 300px;
}

.preset-container {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.bank-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background-color: #2a2a2a;
  border-radius: 4px;
}

.bank-name {
  font-weight: bold;
  font-size: 14px;
  color: #fff;
}

.patch-count {
  font-size: 12px;
  color: #999;
}

.patch-selector-group {
  display: flex;
  gap: 8px;
  align-items: center;
}

.patch-select {
  flex: 1;
}

.save-section {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}

.patch-name-input {
  flex: 1;
}

.save-btn {
  margin-top: 2px;
}

.import-export-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-title {
  font-weight: bold;
  font-size: 12px;
  color: #999;
  text-transform: uppercase;
  margin-top: 8px;
}

.button-row {
  display: flex;
  gap: 8px;
}

.action-btn {
  flex: 1;
  font-size: 11px;
}
</style>
