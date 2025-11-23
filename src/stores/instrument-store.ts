import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import AudioSystem from 'src/audio/AudioSystem';
import InstrumentV2 from 'src/audio/instrument-v2';
import { AudioSyncManager } from 'src/audio/sync-manager';
import type { PortId } from 'app/public/wasm/audio_processor';

interface InstrumentStoreState {
  audioSystem: AudioSystem | null;
  destinationNode: AudioNode | null;
  currentInstrument: InstrumentV2 | null;
  syncManager: AudioSyncManager | null;
  wasmMemory: WebAssembly.Memory;
  macros: number[];
}

interface InstrumentStoreActions {
  initializeAudioSystem(): void;
  setupAudio(): Promise<void>;
  waitForInstrumentReady(timeoutMs?: number): Promise<boolean>;
  setMacro(macroIndex: number, value: number): void;
  applyMacrosToInstrument(): void;
  connectMacroRoute(payload: { macroIndex: number; targetId: string; targetPort: PortId; amount: number }): void;
}

export const useInstrumentStore = defineStore<'instrumentStore', InstrumentStoreState, Record<string, never>, InstrumentStoreActions>('instrumentStore', {
  state: (): InstrumentStoreState => ({
    audioSystem: null,
    destinationNode: null,
    currentInstrument: null,
    syncManager: null,
    wasmMemory: new WebAssembly.Memory({
      initial: 256,
      maximum: 1024,
      shared: true,
    }),
    macros: [0, 0, 0, 0],
  }),
  actions: {
    initializeAudioSystem() {
      if (!this.audioSystem) {
        this.audioSystem = markRaw(new AudioSystem());
      }
    },
    async setupAudio() {
      if (!this.audioSystem) {
        console.error('AudioSystem not initialized');
        return;
      }

      if (!this.currentInstrument) {
        this.currentInstrument = markRaw(new InstrumentV2(
          this.audioSystem.destinationNode,
          this.audioSystem.audioContext,
          this.wasmMemory,
        ));
        this.destinationNode = this.audioSystem.destinationNode;
        this.applyMacrosToInstrument();
      }

      if (!this.syncManager) {
        this.syncManager = markRaw(new AudioSyncManager(() => this.currentInstrument as InstrumentV2 | null));
        try {
          await this.syncManager.start();
        } catch (error) {
          console.error('Failed to start AudioSyncManager:', error);
        }
      }
    },
    async waitForInstrumentReady(timeoutMs = 8000): Promise<boolean> {
      const pollInterval = 50;
      const start = Date.now();

      while (!this.currentInstrument || !this.currentInstrument.isReady) {
        if (Date.now() - start > timeoutMs) {
          console.warn('Timed out waiting for instrument readiness');
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      return true;
    },

    setMacro(macroIndex: number, value: number) {
      const clampedIndex = Math.max(0, Math.min(this.macros.length - 1, macroIndex));
      const clampedValue = Math.min(1, Math.max(0, value));

      const next = [...this.macros];
      next[clampedIndex] = clampedValue;
      this.macros = next;

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

    connectMacroRoute(payload: { macroIndex: number; targetId: string; targetPort: PortId; amount: number }) {
      if (!this.currentInstrument) return;
      this.currentInstrument.connectMacroRoute(payload);
    },
  },
});
