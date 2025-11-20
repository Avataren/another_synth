import { defineStore } from 'pinia';
import type { NodeConnectionUpdate } from 'src/audio/types/synth-layout';
import type { PortId } from 'app/public/wasm/audio_processor';
import {
  ModulationTransformation,
  WasmModulationType,
} from 'app/public/wasm/audio_processor';
import { useAudioSystemStore } from './audio-system-store';
import { useLayoutStore } from './layout-store';
import { useNodeStateStore } from './node-state-store';

function debounce<T extends (...args: unknown[]) => void>(
  func: T,
  wait: number,
): T {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return function (this: ThisParameterType<T>, ...args: Parameters<T>) {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  } as T;
}

export const useConnectionStore = defineStore('connectionStore', {
  state: () => ({
    updateQueue: [] as NodeConnectionUpdate[],
    isProcessing: false,
    lastUpdateError: null as Error | null,
  }),
  actions: {
    queueConnectionUpdate(connection: NodeConnectionUpdate) {
      this.updateQueue.push(connection);
      this.debouncedProcessUpdateQueue();
    },
    async processUpdateQueue() {
      if (this.isProcessing) return;
      this.isProcessing = true;
      const layoutStore = useLayoutStore();
      const audioStore = useAudioSystemStore();

      while (this.updateQueue.length > 0) {
        const connection = this.updateQueue.shift()!;
        try {
          const plainConnection: NodeConnectionUpdate = {
            fromId: String(connection.fromId),
            toId: String(connection.toId),
            target: Number(connection.target) as PortId,
            amount: Number(connection.amount),
            isRemoving: Boolean(connection.isRemoving),
            modulationType: connection.modulationType,
            modulationTransformation:
              connection.modulationTransformation ??
              (ModulationTransformation.None as ModulationTransformation),
          };

          const instrument = audioStore.currentInstrument;
          if (!instrument) throw new Error('No instrument available');
          await instrument.updateConnection(plainConnection);

          if (layoutStore.synthLayout) {
            layoutStore.synthLayout.voices.forEach((voice) => {
              if (!voice.connections) voice.connections = [];

              if (plainConnection.isRemoving) {
                voice.connections = voice.connections.filter(
                  (conn) =>
                    !(
                      conn.fromId === plainConnection.fromId &&
                      conn.toId === plainConnection.toId &&
                      conn.target === plainConnection.target
                    ),
                );
              } else {
                const existingIndex = voice.connections.findIndex(
                  (conn) =>
                    conn.fromId === plainConnection.fromId &&
                    conn.toId === plainConnection.toId &&
                    conn.target === plainConnection.target,
                );

                const newConnection = {
                  fromId: plainConnection.fromId,
                  toId: plainConnection.toId,
                  target: plainConnection.target,
                  amount: plainConnection.amount,
                  modulationTransformation:
                    plainConnection.modulationTransformation,
                  modulationType:
                    plainConnection.modulationType ?? WasmModulationType.Additive,
                };

                if (existingIndex !== -1) {
                  voice.connections[existingIndex] = newConnection;
                } else {
                  voice.connections.push(newConnection);
                }
              }
            });
            layoutStore.syncCanonicalVoiceWithFirstVoice();
            layoutStore.commitLayoutChange();
          }
        } catch (error) {
          console.error('Connection update failed:', error);
          this.lastUpdateError = error as Error;
        }
      }

      this.isProcessing = false;
    },
    debouncedProcessUpdateQueue: debounce(function (this: {
      processUpdateQueue: () => Promise<void>;
    }) {
      void this.processUpdateQueue();
    }, 100),
    async deleteNodeCleanup(deletedNodeId: string) {
      const layoutStore = useLayoutStore();
      const nodeStateStore = useNodeStateStore();
      const audioStore = useAudioSystemStore();

      try {
        layoutStore.removeNodeFromLayout(deletedNodeId);
        layoutStore.deletedNodeIds.add(deletedNodeId);
        nodeStateStore.removeStatesForNode(deletedNodeId);

        await new Promise((resolve) => setTimeout(resolve, 100));

        const instrument = audioStore.currentInstrument;
        if (instrument) {
          const wasmStateJson = await instrument.getWasmNodeConnections();
            if (wasmStateJson) {
              const wasmState = JSON.parse(wasmStateJson);
              layoutStore.updateSynthLayout(wasmState);
              nodeStateStore.initializeDefaultStates();
            }
        }
      } catch (error) {
        console.error('Error during node cleanup:', error);
      } finally {
        setTimeout(() => {
          layoutStore.deletedNodeIds.delete(deletedNodeId);
        }, 300);
      }
    },
  },
});
