import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import { usePatchStore } from './patch-store';
import type AudioSystem from 'src/audio/AudioSystem';
import { getSharedAudioSystem } from 'src/audio/shared-audio-system';
import InstrumentV2 from 'src/audio/instrument-v2';
import type { PooledInstrument } from 'src/audio/pooled-instrument-factory';
import { AudioSyncManager } from 'src/audio/sync-manager';
import type { PortId } from 'app/public/wasm/audio_processor';
import type {
  ModulationTransformation,
  WasmModulationType,
} from 'app/public/wasm/audio_processor';

interface InstrumentStoreState {
  audioSystem: AudioSystem | null;
  destinationNode: AudioNode | null;
  currentInstrument: InstrumentV2 | PooledInstrument | null;
  /** The original/default instrument for standalone patch editing */
  defaultInstrument: InstrumentV2 | PooledInstrument | null;
  /** Whether we're currently using an external instrument (from song bank) */
  usingExternalInstrument: boolean;
  syncManager: AudioSyncManager | null;
  wasmMemory: WebAssembly.Memory;
  macros: number[];
  instrumentGain: number;
}

interface InstrumentStoreActions {
  initializeAudioSystem(): void;
  setupAudio(): Promise<void>;
  waitForInstrumentReady(timeoutMs?: number): Promise<boolean>;
  setMacro(macroIndex: number, value: number): void;
  applyMacrosToInstrument(): void;
  connectMacroRoute(payload: {
    macroIndex: number;
    targetId: string;
    targetPort: PortId;
    amount: number;
    modulationType: WasmModulationType;
    modulationTransformation: ModulationTransformation;
  }): void;
  setMacros(values: number[]): void;
  setInstrumentGain(gain: number): void;
  /** Swap currentInstrument to an external instrument (e.g., from song bank for live editing) */
  useExternalInstrument(instrument: InstrumentV2 | PooledInstrument): void;
  /** Restore the default instrument after live editing */
  restoreDefaultInstrument(): void;
}

export const useInstrumentStore = defineStore<
  'instrumentStore',
  InstrumentStoreState,
  Record<string, never>,
  InstrumentStoreActions
>('instrumentStore', {
  state: (): InstrumentStoreState => ({
    audioSystem: null,
    destinationNode: null,
    currentInstrument: null,
    defaultInstrument: null,
    usingExternalInstrument: false,
    syncManager: null,
    wasmMemory: new WebAssembly.Memory({
      initial: 256,
      maximum: 1024,
      shared: true,
    }),
    macros: [0, 0, 0, 0],
    instrumentGain: 1.0,
  }),
  actions: {
    initializeAudioSystem() {
      if (!this.audioSystem) {
        this.audioSystem = getSharedAudioSystem();
      }
    },
    async setupAudio() {
      if (!this.audioSystem) {
        console.error('AudioSystem not initialized');
        return;
      }

      if (!this.currentInstrument) {
        const instrument = markRaw(
          new InstrumentV2(
            this.audioSystem.destinationNode,
            this.audioSystem.audioContext,
            this.wasmMemory,
          ),
        );
        this.currentInstrument = instrument;
        this.defaultInstrument = instrument;
        // Visualizers and component controls should tap the instrument output, not the global mixer
        this.destinationNode = instrument.outputNode;
        this.applyMacrosToInstrument();
      }

      if (!this.syncManager) {
        this.syncManager = markRaw(
          new AudioSyncManager(
            () => this.currentInstrument as InstrumentV2 | null,
          ),
        );
        try {
          await this.syncManager.start();
        } catch (error) {
          console.error('Failed to start AudioSyncManager:', error);
        }
      }
    },
    async waitForInstrumentReady(timeoutMs = 8000): Promise<boolean> {
      const pollInterval = 50;
      const deadline = Date.now() + timeoutMs;

      // While the context is suspended the render thread never runs, so
      // polling isReady is pure burn. Wait for the context to reach
      // `running` first -- bounded by the SAME overall cap, never reset:
      // other callers (prepareStateForNewPatch, every applyPatchObject)
      // must keep a hard bound even when the context never resumes. Once
      // running, the remaining budget applies to the original poll loop.
      const audioSystem = this.audioSystem;
      const context = audioSystem?.audioContext;
      if (context && context.state === 'closed') {
        console.warn('AudioContext is closed; instrument cannot become ready');
        return false;
      }
      if (audioSystem && context && context.state !== 'running') {
        await Promise.race([
          audioSystem.whenRunning(),
          new Promise<void>((resolve) =>
            setTimeout(resolve, Math.max(0, deadline - Date.now())),
          ),
        ]);
      }

      while (!this.currentInstrument || !this.currentInstrument.isReady) {
        if (Date.now() > deadline) {
          console.warn('Timed out waiting for instrument readiness');
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      return true;
    },

    setMacro(macroIndex: number, value: number) {
      const clampedIndex = Math.max(
        0,
        Math.min(this.macros.length - 1, macroIndex),
      );
      const clampedValue = Math.min(1, Math.max(0, value));

      const next = [...this.macros];
      next[clampedIndex] = clampedValue;
      this.macros = next;
      usePatchStore().notifyPatchChanged();

      if (this.currentInstrument) {
        this.currentInstrument.setMacro(clampedIndex, clampedValue);
      }
    },

    applyMacrosToInstrument() {
      if (!this.currentInstrument) return;
      this.macros.forEach((value, index) => {
        this.currentInstrument?.setMacro(index, value);
      });
    },

    connectMacroRoute(payload: {
      macroIndex: number;
      targetId: string;
      targetPort: PortId;
      amount: number;
      modulationType: WasmModulationType;
      modulationTransformation: ModulationTransformation;
    }) {
      if (!this.currentInstrument) return;
      this.currentInstrument.connectMacroRoute(payload);
    },

    setMacros(values: number[]) {
      this.macros = values
        .slice(0, this.macros.length)
        .map((v) => Math.min(1, Math.max(0, v)));
      usePatchStore().notifyPatchChanged();
      this.applyMacrosToInstrument();
    },

    setInstrumentGain(gain: number) {
      const clamped = Math.max(0, Math.min(2, gain)); // Allow up to 2x gain
      this.instrumentGain = clamped;
      usePatchStore().notifyPatchChanged();
      if (this.currentInstrument) {
        this.currentInstrument.setOutputGain(clamped);
      }
    },

    useExternalInstrument(instrument: InstrumentV2 | PooledInstrument) {
      // Store the current instrument as default if we haven't already
      if (!this.usingExternalInstrument && this.currentInstrument) {
        this.defaultInstrument = this.currentInstrument;
      }
      // Swap to the external instrument
      this.currentInstrument = markRaw(instrument);
      this.usingExternalInstrument = true;
      // Update destination node to the external instrument's output
      this.destinationNode = instrument.outputNode;
    },

    restoreDefaultInstrument() {
      if (!this.defaultInstrument) return;
      // Force the current instrument back to the default for standalone editing
      if (
        this.currentInstrument !== this.defaultInstrument ||
        this.usingExternalInstrument
      ) {
        this.currentInstrument = this.defaultInstrument;
        this.usingExternalInstrument = false;
        this.destinationNode = this.defaultInstrument.outputNode;
        // Re-kick the deferred boot-time session init: on a suspended-context
        // boot it may have skipped (an external song instrument was active)
        // or failed. Already-initialized sessions converge on the same
        // exactly-once promise, so this is a no-op after a successful init.
        void usePatchStore().initializeSessionOnce();
      }
    },
  },
});
