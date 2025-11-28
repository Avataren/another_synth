import { ref, nextTick, type Ref, type ComponentPublicInstance } from 'vue';
import type { Router } from 'vue-router';
import type { Patch } from 'src/audio/types/preset-types';
import { createDefaultPatchMetadata, createEmptySynthState } from 'src/audio/types/preset-types';
import type { InstrumentSlot, useTrackerStore } from 'src/stores/tracker-store';
import type { usePatchStore } from 'src/stores/patch-store';

/**
 * Patch option from a bank
 */
export interface BankPatchOption {
  id: string;
  name: string;
  bankId: string;
  bankName: string;
  category?: string;
  source: 'system' | 'user';
}

/**
 * Raw bank JSON structure
 */
interface RawPatchMeta {
  id?: string;
  name?: string;
  category?: string;
}

interface RawPatch {
  metadata?: RawPatchMeta;
}

interface RawBank {
  metadata?: { id?: string; name?: string };
  patches?: RawPatch[];
}

/**
 * Dependencies required by the instruments composable
 */
export interface TrackerInstrumentsContext {
  // Stores
  trackerStore: ReturnType<typeof useTrackerStore>;
  patchStore: ReturnType<typeof usePatchStore>;
  router: Router;

  // State refs
  instrumentSlots: Ref<InstrumentSlot[]>;
  songPatches: Ref<Record<string, Patch>>;
  activeTrack: Ref<number>;
  currentPattern: Ref<{ tracks: unknown[] } | undefined>;

  // Functions
  formatInstrumentId: (slotNumber: number) => string;
  ensureActiveInstrument: () => void;
  setActiveInstrument: (slotNumber: number) => void;
  syncSongBankFromSlots: () => Promise<void>;
  sanitizeMuteSoloState: () => void;
  updateTrackAudioNodes: () => void;

  // Track count
  trackCount: Ref<number>;
}

/**
 * Composable for managing tracker instruments and slots
 *
 * Handles:
 * - Instrument naming and renaming
 * - Patch selection and assignment
 * - Creating new song patches
 * - Editing slot patches
 * - Loading system bank patches
 * - Track management (add/remove)
 *
 * @param context - Instruments context with all dependencies
 */
export function useTrackerInstruments(context: TrackerInstrumentsContext) {
  // State for instrument renaming
  const instrumentNameEditSlot = ref<number | null>(null);
  const instrumentNameDraft = ref('');
  const instrumentNameInputRefs = ref<Record<number, HTMLInputElement | null>>({});

  // State for available patches
  const availablePatches = ref<BankPatchOption[]>([]);
  const bankPatchLibrary = ref<Record<string, Patch>>({});

  // Track async slot creation operations
  const slotCreationPromises = new Map<number, Promise<void>>();

  /**
   * Get the display name for an instrument slot
   */
  function getInstrumentDisplayName(slot: InstrumentSlot): string {
    return slot.instrumentName || slot.patchName || '—';
  }

  /**
   * Set the ref for an instrument name input element
   */
  function setInstrumentNameInputRef(
    slotNumber: number,
    el: Element | ComponentPublicInstance | null
  ) {
    instrumentNameInputRefs.value[slotNumber] = el as HTMLInputElement | null;
  }

  /**
   * Begin editing an instrument name
   */
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

  /**
   * Cancel instrument renaming
   */
  function cancelInstrumentRename() {
    instrumentNameEditSlot.value = null;
  }

  /**
   * Commit the instrument rename
   */
  function commitInstrumentRename(slotNumber: number) {
    if (instrumentNameEditSlot.value !== slotNumber) {
      return;
    }
    context.trackerStore.pushHistory();
    context.trackerStore.setInstrumentName(slotNumber, instrumentNameDraft.value);
    instrumentNameEditSlot.value = null;
  }

  /**
   * Handle patch selection for a slot
   */
  async function onPatchSelect(slotNumber: number, patchId: string) {
    if (!patchId) {
      await clearInstrument(slotNumber);
      return;
    }

    const option = availablePatches.value.find((p) => p.id === patchId);
    if (!option) return;

    // Get the full patch from the bank library
    const patch = bankPatchLibrary.value[patchId];
    if (!patch) return;

    // Copy patch to song store
    context.trackerStore.pushHistory();
    context.trackerStore.assignPatchToSlot(slotNumber, patch, option.bankName);
    context.setActiveInstrument(slotNumber);
    context.ensureActiveInstrument();
    await context.syncSongBankFromSlots();
  }

  /**
   * Clear an instrument slot
   */
  async function clearInstrument(slotNumber: number) {
    context.trackerStore.pushHistory();
    context.trackerStore.clearSlot(slotNumber);
    context.ensureActiveInstrument();
    await context.syncSongBankFromSlots();
  }

  /**
   * Build a patch for a new song instrument
   */
  async function buildSongPatch(slotNumber: number): Promise<Patch | null> {
    const patchName = `Instrument ${context.formatInstrumentId(slotNumber)}`;
    const baseMeta = createDefaultPatchMetadata(patchName);

    const cloneWithMeta = (source: Patch | null | undefined): Patch | null => {
      if (!source) return null;
      const cloned = structuredClone(source) as Patch;
      cloned.metadata = { ...(cloned.metadata || {}), ...baseMeta, name: baseMeta.name };
      return cloned;
    };

    const template =
      typeof context.patchStore.fetchDefaultPatchTemplate === 'function'
        ? await context.patchStore.fetchDefaultPatchTemplate()
        : null;
    const fromTemplate = cloneWithMeta(template);
    if (fromTemplate) return fromTemplate;

    const serialized = await context.patchStore.serializePatch(patchName);
    if (serialized) return serialized;

    return null;
  }

  /**
   * Create a new song patch for a slot
   */
  async function createNewSongPatch(slotNumber: number) {
    try {
      const creation = (async (): Promise<void> => {
        const patch =
          (await buildSongPatch(slotNumber)) ?? {
            metadata: createDefaultPatchMetadata(
              `Instrument ${context.formatInstrumentId(slotNumber)}`
            ),
            synthState: createEmptySynthState(),
            audioAssets: {}
          };

        context.trackerStore.pushHistory();
        context.trackerStore.assignPatchToSlot(slotNumber, patch, 'Song');
        context.setActiveInstrument(slotNumber);
        context.ensureActiveInstrument();
        await nextTick();
        await context.syncSongBankFromSlots();
      })();

      slotCreationPromises.set(slotNumber, creation);
      await creation;
      slotCreationPromises.delete(slotNumber);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to create new song patch', error);
    }
  }

  /**
   * Edit a slot's patch in the synth editor
   */
  async function editSlotPatch(slotNumber: number) {
    const pending = slotCreationPromises.get(slotNumber);
    if (pending) {
      await pending.catch(() => undefined);
    }
    const slot = context.instrumentSlots.value.find((s) => s.slot === slotNumber);
    if (!slot?.patchId) return;

    // Navigate to dedicated song patch editor route
    void context.router.push({
      name: 'patch-instrument-editor',
      params: { slot: slotNumber.toString() }
    });
  }

  /**
   * Load available patches from the system bank
   * @param options.skipSync - Skip syncing song bank from slots (use when playback is active)
   */
  async function loadSystemBankOptions(options?: { skipSync?: boolean }) {
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
            category: meta.category,
            source: 'system' as const
          };
        })
        .filter(Boolean) as BankPatchOption[];
      bankPatchLibrary.value = patchMap;
      // Skip sync when playback is active - the song bank already has correct instruments
      if (!options?.skipSync) {
        await context.syncSongBankFromSlots();
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load system bank', error);
    }
  }

  /**
   * Add a new track to the pattern
   */
  function addTrack() {
    context.trackerStore.pushHistory();
    const added = context.trackerStore.addTrack();
    if (added) {
      context.activeTrack.value = Math.min(
        context.activeTrack.value,
        (context.currentPattern.value?.tracks.length ?? 1) - 1
      );
      context.sanitizeMuteSoloState();
      context.updateTrackAudioNodes();
    }
  }

  /**
   * Remove the active track from the pattern
   */
  function removeTrack() {
    if (context.trackCount.value <= 1) return;
    context.trackerStore.pushHistory();
    const removed = context.trackerStore.removeTrack(context.activeTrack.value);
    if (removed) {
      context.sanitizeMuteSoloState();
      context.activeTrack.value = Math.min(
        context.activeTrack.value,
        (context.currentPattern.value?.tracks.length ?? 1) - 1
      );
      context.updateTrackAudioNodes();
    }
  }

  return {
    // State
    instrumentNameEditSlot,
    instrumentNameDraft,
    instrumentNameInputRefs,
    availablePatches,
    bankPatchLibrary,

    // Functions
    getInstrumentDisplayName,
    setInstrumentNameInputRef,
    beginInstrumentRename,
    cancelInstrumentRename,
    commitInstrumentRename,
    onPatchSelect,
    clearInstrument,
    buildSongPatch,
    createNewSongPatch,
    editSlotPatch,
    loadSystemBankOptions,
    addTrack,
    removeTrack
  };
}
