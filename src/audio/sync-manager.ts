// src/audio/sync-manager.ts

import { isModulationTargetObject, ModulationTarget, type ModulationTargetObject, type ModulationTargetOption, type NodeConnection } from './types/synth-layout';
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
        const normalizedTarget = isModulationTargetObject(target)
            ? target.value
            : target;

        // Convert from ModulationTarget enum to WASM PortId values
        switch (normalizedTarget) {
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
            case ModulationTarget.Frequency:
                return PortId.FrequencyMod;
            case ModulationTarget.Gain:
                return PortId.GainMod;
            case ModulationTarget.PhaseMod:
                return PortId.PhaseMod;
            case ModulationTarget.ModIndex:
                return PortId.ModIndex;
            case ModulationTarget.FilterCutoff:
                return PortId.CutoffMod;
            case ModulationTarget.FilterResonance:
                return PortId.ResonanceMod;
            default:
                console.warn('Unknown target:', target);
                return PortId.GainMod;
        }
    }

    private convertFromWasmTarget(portId: PortId): ModulationTarget {
        console.log('Converting from WASM PortId to ModulationTarget:', {
            portId,
            portIdEnum: PortId[portId]
        });

        switch (portId) {
            case PortId.FrequencyMod:    // 11
                return ModulationTarget.Frequency;  // 0
            case PortId.GainMod:         // 16
                return ModulationTarget.Gain;       // 1
            case PortId.CutoffMod:       // 14
                return ModulationTarget.FilterCutoff; // 2
            case PortId.ResonanceMod:    // 15
                return ModulationTarget.FilterResonance; // 3
            case PortId.PhaseMod:        // 12
                return ModulationTarget.PhaseMod;   // 4
            case PortId.ModIndex:        // 13
                return ModulationTarget.ModIndex;   // 5
            default:
                console.warn('Unknown WASM PortId:', portId);
                return ModulationTarget.Gain;
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

        // Convert store connections to WASM format and normalize them
        const normalizedStoreConns: WasmConnection[] = storeConns.map(conn => ({
            from_id: conn.fromId,
            to_id: conn.toId,
            target: this.convertToWasmTarget(this.getTargetValue(conn.target)),
            amount: conn.amount
        }));

        // Create maps for easy lookup
        const storeMap = new Map(normalizedStoreConns.map(conn => [
            `${conn.from_id}-${conn.to_id}-${conn.target}`,
            conn
        ]));
        const wasmMap = new Map(wasmConns.map(conn => [
            `${conn.from_id}-${conn.to_id}-${conn.target}`,
            conn
        ]));

        // Find differences
        for (const [key, storeConn] of storeMap) {
            const wasmConn = wasmMap.get(key);
            if (!wasmConn || Math.abs(storeConn.amount - wasmConn.amount) >= 0.001) {
                differences.push({
                    store: this.convertToStoreConnection(storeConn),
                    wasm: wasmConn || null
                });
            }
        }

        for (const [key, wasmConn] of wasmMap) {
            if (!storeMap.has(key)) {
                differences.push({ store: null, wasm: wasmConn });
            }
        }

        if (differences.length > 0) {
            console.log('Normalized connections:', {
                store: normalizedStoreConns,
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

    private async syncWithWasm() {
        try {

            if (!this.store.currentInstrument?.isReady) {
                return;
            }

            if (!this.store.currentInstrument) {
                return;
            }

            const wasmState = await this.store.currentInstrument.getWasmNodeConnections();

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

                    const synthLayout = this.store.synthLayout;
                    if (synthLayout) {
                        // Update each voice's connections
                        synthLayout.voices.forEach((voice, index) => {
                            const wasmVoice = wasmLayout.voices[index];
                            if (wasmVoice) {
                                voice.connections = wasmVoice.connections.map(conn => ({
                                    fromId: conn.from_id,
                                    toId: conn.to_id,
                                    target: this.convertFromWasmTarget(conn.target),
                                    amount: conn.amount
                                }));
                            }
                        });
                    }
                }

                // Reset failed attempts on successful sync
                this.failedAttempts = 0;

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