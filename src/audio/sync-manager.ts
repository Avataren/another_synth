// src/audio/sync-manager.ts

import {
    isModulationTargetObject, ModulationTarget, type NodeConnectionUpdate,
    type ModulationTargetObject, type ModulationTargetOption, type NodeConnection
} from './types/synth-layout';
import { useAudioSystemStore } from '../stores/audio-system-store';
import { PortId } from 'app/public/wasm/audio_processor';

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

    constructor(private syncIntervalMs: number = 1000) { }

    async start() {
        if (this.syncInterval) {
            return;
        }

        try {
            await this.syncWithWasm();
            this.syncInterval = window.setInterval(() => {
                this.syncWithWasm().catch(error => {
                    console.warn('Sync attempt failed:', error);
                    this.failedAttempts++;

                    if (this.failedAttempts >= this.maxFailedAttempts) {
                        console.error('Max sync attempts reached, stopping sync manager');
                        this.stop();
                    }
                });
            }, this.syncIntervalMs);
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
            const wasmState = await this.store.currentInstrument.getWasmNodeConnections();
            const stateData: WasmState = JSON.parse(wasmState);

            // Compare current state with new state
            const currentState = JSON.stringify(this.store.synthLayout?.voices.map(v => v.connections));
            const newState = JSON.stringify(stateData.voices.map((v: WasmVoice) => v.connections));

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
                current: this.store.synthLayout
            });

            this.store.isUpdatingFromWasm = true;

            this.store.synthLayout.voices.forEach((voice, index) => {
                const wasmVoice = stateData.voices[index];
                if (wasmVoice) {
                    // Create new array to prevent mutation
                    const newConnections = wasmVoice.connections.map(conn => {
                        const target = this.convertFromWasmTarget(conn.target);
                        console.log('Converting connection:', {
                            from: conn,
                            convertedTarget: target,
                            ModulationTarget: ModulationTarget[target]
                        });
                        return {
                            fromId: conn.from_id,
                            toId: conn.to_id,
                            target: target,
                            amount: conn.amount
                        };
                    });

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


    public async validateState(): Promise<boolean> {
        if (!this.store.currentInstrument?.isReady) return true;

        const wasmState = await this.store.currentInstrument.getWasmNodeConnections();
        const stateData: WasmState = JSON.parse(wasmState);

        const currentState = JSON.stringify(this.store.synthLayout?.voices.map(v => v.connections));
        const wasmStateStr = JSON.stringify(stateData.voices.map((v: WasmVoice) => v.connections));

        return currentState === wasmStateStr;
    }

    public convertModulationTarget(target: ModulationTarget | ModulationTargetObject): number {
        const rawTarget = isModulationTargetObject(target)
            ? Number(target.value)
            : Number(target);

        // Convert from ModulationTarget enum to WASM PortId values
        switch (rawTarget) {
            case ModulationTarget.Frequency:
                return 11;  // FrequencyMod
            case ModulationTarget.Gain:
                return 16;  // GainMod
            case ModulationTarget.FilterCutoff:
                return 14;  // CutoffMod
            case ModulationTarget.FilterResonance:
                return 15;  // ResonanceMod
            case ModulationTarget.PhaseMod:
                return 12;  // PhaseMod
            case ModulationTarget.ModIndex:
                return 13;  // ModIndex
            default:
                console.warn('Unknown target:', target);
                return 16;  // Default to GainMod
        }
    }

    private convertToWasmTarget(target: ModulationTarget): PortId {
        switch (target) {
            case ModulationTarget.PhaseMod:
                return PortId.PhaseMod;      // 12
            case ModulationTarget.Gain:
                return PortId.GainMod;       // 16
            case ModulationTarget.Frequency:
                return PortId.FrequencyMod;  // 11
            case ModulationTarget.ModIndex:
                return PortId.ModIndex;      // 13
            case ModulationTarget.FilterCutoff:
                return PortId.CutoffMod;     // 14
            case ModulationTarget.FilterResonance:
                return PortId.ResonanceMod;  // 15
            default:
                console.error('Unknown target:', target);
                throw new Error(`Invalid modulation target: ${target}`);
        }
    }

    private convertFromWasmTarget(portId: PortId): ModulationTarget {
        switch (portId) {
            case PortId.PhaseMod:        // 12
                return ModulationTarget.PhaseMod;   // 4
            case PortId.GainMod:         // 16
                return ModulationTarget.Gain;       // 1
            case PortId.FrequencyMod:    // 11
                return ModulationTarget.Frequency;  // 0
            case PortId.ModIndex:        // 13
                return ModulationTarget.ModIndex;   // 5
            case PortId.CutoffMod:       // 14
                return ModulationTarget.FilterCutoff; // 2
            case PortId.ResonanceMod:    // 15
                return ModulationTarget.FilterResonance; // 3
            default:
                console.error('Unknown WASM PortId:', portId);
                throw new Error(`Invalid port ID: ${portId}`);
        }
    }

    private normalizeConnections(connections: WasmConnection[]): WasmConnection[] {
        // Group connections by from_id, to_id, and target
        const connectionMap = new Map<string, WasmConnection>();

        for (const conn of connections) {
            const key = `${conn.from_id}-${conn.to_id}-${conn.target}`;
            if (!connectionMap.has(key) || connectionMap.get(key)!.amount < conn.amount) {
                connectionMap.set(key, conn);
            }
        }

        return Array.from(connectionMap.values());
    }

    private getTargetValue(target: ModulationTarget | ModulationTargetOption): ModulationTarget {
        if (typeof target === 'object' && 'value' in target) {
            return target.value;
        }
        return target;
    }

    private findConnectionDifferences(
        storeConns: NodeConnection[],
        wasmConns: WasmConnection[]
    ): Array<{ store: NodeConnection | null, wasm: WasmConnection | null }> {
        const differences: Array<{
            store: NodeConnection | null,
            wasm: WasmConnection | null
        }> = [];

        // Create maps for easier lookup using a composite key that includes target
        const getStoreConnectionKey = (fromId: number, toId: number, target: ModulationTarget | ModulationTargetOption) => {
            const targetValue = isModulationTargetObject(target) ? target.value : target;
            return `${fromId}-${toId}-${targetValue}`;
        };

        const getWasmConnectionKey = (fromId: number, toId: number, target: PortId) => {
            return `${fromId}-${toId}-${this.convertFromWasmTarget(target)}`;
        };

        const storeMap = new Map<string, NodeConnection>();
        storeConns.forEach(conn => {
            const key = getStoreConnectionKey(conn.fromId, conn.toId, conn.target);
            storeMap.set(key, conn);
        });

        const wasmMap = new Map<string, WasmConnection>();
        wasmConns.forEach(conn => {
            const key = getWasmConnectionKey(conn.from_id, conn.to_id, conn.target);
            wasmMap.set(key, conn);
        });

        // Check for differences
        for (const [key, storeConn] of storeMap) {
            if (!wasmMap.has(key)) {
                differences.push({ store: storeConn, wasm: null });
            }
        }

        // Find WASM connections that don't exist in store
        for (const [key, wasmConn] of wasmMap) {
            if (!storeMap.has(key)) {
                differences.push({ store: null, wasm: wasmConn });
            }
        }

        if (differences.length > 0) {
            console.log('Connection differences:', {
                store: storeConns,
                wasm: wasmConns,
                differences
            });
        }

        return differences;
    }

    private convertToStoreConnection(wasmConn: WasmConnection): NodeConnection {
        return {
            fromId: wasmConn.from_id,
            toId: wasmConn.to_id,
            target: this.convertFromWasmTarget(wasmConn.target),
            amount: wasmConn.amount
        };
    }

    public async modifyConnection(connection: NodeConnectionUpdate): Promise<void> {
        if (!this.store.currentInstrument?.isReady) return;

        try {
            const numVoices = this.store.synthLayout?.voices.length || 0;

            // Create plain object version of connection
            const plainConnection = {
                fromId: Number(connection.fromId),
                toId: Number(connection.toId),
                target: typeof connection.target === 'object' ? Number(connection.target.value) : Number(connection.target),
                amount: Number(connection.amount),
                isRemoving: Boolean(connection.isRemoving)
            };

            for (let voiceIndex = 0; voiceIndex < numVoices; voiceIndex++) {
                if (connection.isRemoving) {
                    this.store.currentInstrument.updateConnection(voiceIndex, {
                        ...plainConnection,
                        isRemoving: true
                    });
                } else {
                    this.store.currentInstrument.updateConnection(voiceIndex, plainConnection);
                }
            }
        } catch (error) {
            console.error('Failed to modify connection:', error);
            throw error;
        }
    }

    private async syncWithWasm() {
        try {
            if (!this.store.currentInstrument?.isReady) {
                return;
            }

            const wasmState = await this.store.currentInstrument.getWasmNodeConnections();

            // Only proceed if state has changed
            if (wasmState === this.lastWasmState) {
                return;
            }

            this.lastWasmState = wasmState;

            try {
                const wasmLayout = JSON.parse(wasmState) as WasmLayout;
                const wasmConnections = wasmLayout.voices.flatMap(voice => voice.connections || []);

                const storeConnections = this.store.synthLayout?.voices.flatMap(voice =>
                    voice.connections
                ) || [];

                const differences = this.findConnectionDifferences(storeConnections, wasmConnections);

                if (differences.length > 0) {
                    console.log('Found differences:', differences);

                    // Instead of automatically updating from WASM state, we should respect removals
                    const synthLayout = this.store.synthLayout;
                    if (synthLayout) {
                        synthLayout.voices.forEach((voice, index) => {
                            const wasmVoice = wasmLayout.voices[index];
                            if (wasmVoice) {
                                // Only update with connections that should exist
                                const validConnections = wasmVoice.connections.filter(conn => {
                                    // Check if this connection was recently removed
                                    const wasRemoved = this.store.isUpdating &&
                                        storeConnections.every(storeConn =>
                                            !(storeConn.fromId === conn.from_id &&
                                                storeConn.toId === conn.to_id &&
                                                this.convertFromWasmTarget(conn.target) === storeConn.target));
                                    return !wasRemoved;
                                });

                                voice.connections = validConnections.map(conn => ({
                                    fromId: conn.from_id,
                                    toId: conn.to_id,
                                    target: this.convertFromWasmTarget(conn.target),
                                    amount: conn.amount
                                }));
                            }
                        });
                    }
                }

            } catch (error) {
                console.error('Failed to parse or process WASM state:', error);
                throw error;
            }

        } catch (error) {
            console.error('Failed to sync with WASM:', error);
            throw error;
        }
    }
}