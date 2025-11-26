import { defineStore } from 'pinia';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type { Patch } from 'src/audio/types/preset-types';

// Singleton instance - lives outside Pinia to avoid reactivity issues with AudioContext
let songBankInstance: TrackerSongBank | null = null;

function getSongBank(): TrackerSongBank {
  if (!songBankInstance) {
    songBankInstance = new TrackerSongBank();
  }
  return songBankInstance;
}

/**
 * Store for tracker audio state that persists across page navigation.
 * This allows live patch editing while the song is playing, even when
 * navigating between the tracker and patch editor pages.
 */
export const useTrackerAudioStore = defineStore('trackerAudio', {
  state: () => ({
    /** Whether playback is currently active */
    isPlaying: false,
    /** Currently editing slot number (when on patch editor page) */
    editingSlotNumber: null as number | null
  }),

  getters: {
    /** Get the song bank instance (singleton) */
    songBank(): TrackerSongBank {
      return getSongBank();
    },

    audioContext(): AudioContext {
      return getSongBank().audioContext;
    },

    masterOutput(): AudioNode {
      return getSongBank().output;
    }
  },

  actions: {
    /**
     * Set playback state - called from TrackerPage
     */
    setPlaybackState(playing: boolean) {
      this.isPlaying = playing;
    },

    /**
     * Set the slot being edited - called when navigating to patch editor
     */
    setEditingSlot(slotNumber: number | null) {
      this.editingSlotNumber = slotNumber;
    },

    /**
     * Format slot number to instrument ID (e.g., 1 -> "01")
     */
    formatInstrumentId(slotNumber: number): string {
      return String(slotNumber).padStart(2, '0');
    },

    /**
     * Update a patch on a running instrument in real-time.
     * Returns true if the update was applied, false if the instrument wasn't active.
     */
    async updatePatchLive(slotNumber: number, patch: Patch): Promise<boolean> {
      if (!this.isPlaying) {
        return false;
      }

      const instrumentId = this.formatInstrumentId(slotNumber);
      const bank = getSongBank();
      if (!bank.hasActiveInstrument(instrumentId)) {
        return false;
      }

      return bank.updatePatchLive(instrumentId, patch);
    },

    /**
     * Check if an instrument is currently active
     */
    hasActiveInstrument(slotNumber: number): boolean {
      const instrumentId = this.formatInstrumentId(slotNumber);
      return getSongBank().hasActiveInstrument(instrumentId);
    },

    /**
     * Get the InstrumentV2 instance for a slot (for live editing)
     */
    getInstrumentForSlot(slotNumber: number) {
      const instrumentId = this.formatInstrumentId(slotNumber);
      return getSongBank().getInstrument(instrumentId);
    },

    /**
     * Update the stored patch data for a slot after live editing.
     * This keeps the song bank's stored patch in sync with the live instrument
     * WITHOUT reloading the instrument.
     *
     * Call this when saving live edits to ensure future prepareInstrument calls
     * don't overwrite the live changes.
     */
    updateStoredPatch(slotNumber: number, patch: Patch) {
      const instrumentId = this.formatInstrumentId(slotNumber);
      getSongBank().updateStoredPatch(instrumentId, patch);
    },

    /**
     * Dispose the song bank (call on app shutdown if needed)
     */
    dispose() {
      if (songBankInstance) {
        songBankInstance.dispose();
        songBankInstance = null;
      }
    }
  }
});
