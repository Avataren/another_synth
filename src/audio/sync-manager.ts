// src/audio/sync-manager.ts

import {
    type NodeConnectionUpdate,
    type NodeConnection,
} from './types/synth-layout';
import { useAudioSystemStore } from '../stores/audio-system-store';
import { PortId, type WasmModulationType } from 'app/public/wasm/audio_processor';

interface WasmVoice {
    id: number;
    connections: WasmConnection[];
    nodes: WasmNode[];
}
interface WasmLayout {
    voices: WasmVoice[];
}

export interface WasmConnection {
    from_id: number;
    to_id: number;
    target: PortId;
    amount: number;
    modulationType: WasmModulationType;
}

interface WasmNode {
    id: number;
    node_type: string;
}

// interface WasmVoiceState {
//     id: number;
//     nodes: WasmNode[];
//     connections: WasmConnection[];
// }

export interface WasmState {
    voices: WasmVoice[];
    version: number;
}

export class AudioSyncManager {
    private syncInterval: number | null = null;
    private store = useAudioSystemStore();
    private stateVersion: number = 0;
    private lastWasmState: string = '';
    private failedAttempts = 0;
    private readonly maxFailedAttempts = 3;

    // constructor(private syncIntervalMs: number = 1000) { }

    async start() {
        if (this.syncInterval) {
            return;
        }

        try {
            await this.syncWithWasm();
            //uncomment to check periodically
            // this.syncInterval = window.setInterval(() => {
            //     this.syncWithWasm().catch(error => {
            //         console.warn('Sync attempt failed:', error);
            //         this.failedAttempts++;

            //         if (this.failedAttempts >= this.maxFailedAttempts) {
            //             console.error('Max sync attempts reached, stopping sync manager');
            //             this.stop();
            //         }
            //     });
            // }, this.syncIntervalMs);
        } catch (error) {
            console.error('Failed to start sync manager:', error);
            throw error;
        }
    }

    stop() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        this.failedAttempts = 0;
    }

    public async forceSync(): Promise<void> {
        if (!this.store.currentInstrument?.isReady) return;

        try {
            const wasmState =
                await this.store.currentInstrument.getWasmNodeConnections();
            const stateData: WasmState = JSON.parse(wasmState);

            // Compare current state with new state
            const currentState = JSON.stringify(
                this.store.synthLayout?.voices.map((v) => v.connections),
            );
            const newState = JSON.stringify(
                stateData.voices.map((v: WasmVoice) => v.connections),
            );

            if (currentState !== newState) {
                console.log('State mismatch detected, updating from WASM');
                this.stateVersion = stateData.version;
                await this.updateStoreState(stateData);
            }
        } catch (error) {
            console.error('Force sync failed:', error);
            throw error;
        }
    }

    private async updateStoreState(stateData: WasmState) {
        if (!this.store.synthLayout) return;

        try {
            console.log('Updating store state from WASM:', {
                incoming: stateData,
                current: this.store.synthLayout,
            });

            this.store.isUpdatingFromWasm = true;

            this.store.synthLayout.voices.forEach((voice, index) => {
                const wasmVoice = stateData.voices[index];
                if (wasmVoice) {
                    // Create new array to prevent mutation
                    const newConnections = wasmVoice.connections.map((conn) => ({
                        fromId: conn.from_id,
                        toId: conn.to_id,
                        target: conn.target, // PortId is used directly
                        amount: conn.amount,
                        modulationType: conn.modulationType,
                    }));

                    voice.connections = newConnections;
                }
            });

            if (this.store.synthLayout.metadata) {
                this.store.synthLayout.metadata.stateVersion = this.stateVersion;
            }

            // Force update
            this.store.synthLayout = { ...this.store.synthLayout };
        } catch (error) {
            console.error('Failed to update store state:', error);
        } finally {
            this.store.isUpdatingFromWasm = false;
        }
    }

    // public async validateState(): Promise<boolean> {
    //     if (!this.store.currentInstrument?.isReady) return true;

    //     const wasmState = await this.store.currentInstrument.getWasmNodeConnections();
    //     const stateData: WasmState = JSON.parse(wasmState);

    //     const currentState = JSON.stringify(this.store.synthLayout?.voices.map(v => v.connections));
    //     const wasmStateStr = JSON.stringify(stateData.voices.map((v: WasmVoice) => v.connections));

    //     return currentState === wasmStateStr;
    // }

    public async updateConnection(
        connection: NodeConnectionUpdate,
    ): Promise<void> {
        if (!this.store.currentInstrument?.isReady) return;

        try {
            // const numVoices = this.store.synthLayout?.voices.length || 0;
            // for (let voiceIndex = 0; voiceIndex < numVoices; voiceIndex++) {
            await this.store.currentInstrument.updateConnection(connection);
            // }
        } catch (error) {
            console.error('Failed to update connection:', error);
            throw error;
        }
    }

    private findConnectionDifferences(
        storeConns: NodeConnection[],
        wasmConns: WasmConnection[],
    ): Array<{ store: NodeConnection | null; wasm: WasmConnection | null }> {
        const differences: Array<{
            store: NodeConnection | null;
            wasm: WasmConnection | null;
        }> = [];

        // Create maps for easier lookup using identical key generation
        const getConnectionKey = (fromId: number, toId: number, target: PortId) => {
            return `${fromId}-${toId}-${target}`;
        };

        const storeMap = new Map<string, NodeConnection>();
        storeConns.forEach((conn) => {
            const key = getConnectionKey(conn.fromId, conn.toId, conn.target);
            storeMap.set(key, conn);
        });

        const wasmMap = new Map<string, WasmConnection>();
        wasmConns.forEach((conn) => {
            const key = getConnectionKey(conn.from_id, conn.to_id, conn.target);
            wasmMap.set(key, conn);
        });

        // Find differences
        for (const [key, storeConn] of storeMap) {
            if (!wasmMap.has(key)) {
                differences.push({ store: storeConn, wasm: null });
            }
        }

        for (const [key, wasmConn] of wasmMap) {
            if (!storeMap.has(key)) {
                differences.push({ store: null, wasm: wasmConn });
            }
        }

        return differences;
    }

    public async modifyConnection(
        connection: NodeConnectionUpdate,
    ): Promise<void> {
        if (!this.store.currentInstrument?.isReady) return;

        try {
            // const numVoices = this.store.synthLayout?.voices.length || 0;

            // Validate target is a valid PortId
            const target = connection.target;
            if (typeof target !== 'number' || !(target in PortId)) {
                throw new Error(`Invalid target: ${connection.target}`);
            }

            // Create plain connection object with the correct type
            const plainConnection: NodeConnectionUpdate = {
                fromId: Number(connection.fromId),
                toId: Number(connection.toId),
                target: target as PortId,
                amount: Number(connection.amount),
                isRemoving: Boolean(connection.isRemoving),
            };

            console.log('Processing validated connection:', {
                original: connection,
                processed: plainConnection,
                targetValue: target,
            });

            // for (let voiceIndex = 0; voiceIndex < numVoices; voiceIndex++) {
            if (connection.isRemoving) {
                await this.store.currentInstrument.updateConnection({
                    ...plainConnection,
                    isRemoving: true,
                });
            } else {
                await this.store.currentInstrument.updateConnection(plainConnection);
            }
            // }
        } catch (error) {
            console.error('Failed to modify connection:', error);
            throw error;
        }
    }

    private async syncWithWasm() {
        try {
            if (!this.store.currentInstrument?.isReady) return;

            const wasmState =
                await this.store.currentInstrument.getWasmNodeConnections();
            if (wasmState === this.lastWasmState) return;

            this.lastWasmState = wasmState;
            console.log('# wasmState:', wasmState);
            const wasmLayout = JSON.parse(wasmState) as WasmLayout;
            const wasmConnections = wasmLayout.voices.flatMap(
                (voice) => voice.connections || [],
            );
            const storeConnections =
                this.store.synthLayout?.voices.flatMap((voice) => voice.connections) ||
                [];
            const differences = this.findConnectionDifferences(
                storeConnections,
                wasmConnections,
            );

            if (differences.length > 0) {
                console.log('Found differences:', differences);

                const synthLayout = this.store.synthLayout;
                if (synthLayout) {
                    synthLayout.voices.forEach((voice, index) => {
                        const wasmVoice = wasmLayout.voices[index];
                        if (wasmVoice) {
                            // Only update with connections that should exist
                            const validConnections = wasmVoice.connections.filter((conn) => {
                                // Check if this connection was recently removed
                                const wasRemoved =
                                    this.store.isUpdating &&
                                    storeConnections.every(
                                        (storeConn) =>
                                            !(
                                                storeConn.fromId === conn.from_id &&
                                                storeConn.toId === conn.to_id &&
                                                storeConn.target === conn.target
                                            ),
                                    );
                                return !wasRemoved;
                            });

                            voice.connections = validConnections.map((conn) => ({
                                fromId: conn.from_id,
                                toId: conn.to_id,
                                target: conn.target,
                                amount: conn.amount,
                                modulationType: conn.modulationType,
                            }));
                        }
                    });
                }
            }
        } catch (error) {
            console.error('Failed to sync with WASM:', error);
            throw error;
        }
    }
}
