// src/audio/sync-manager.ts

import { ModulationTarget, type ModulationTargetOption, type NodeConnection } from './types/synth-layout';
import { useAudioSystemStore } from '../stores/audio-system-store';
import { PortId } from 'app/public/wasm/audio_processor';

interface WasmVoice {
    connections: WasmConnection[];
}

interface WasmLayout {
    voices: WasmVoice[];
}

interface WasmConnection {
    from_id: number;
    to_id: number;
    target: PortId;
    amount: number;
}

interface WasmNode {
    id: number;
    node_type: string;
}

interface WasmVoiceState {
    id: number;
    nodes: WasmNode[];
    connections: WasmConnection[];
}

interface WasmState {
    version: number;
    voices: WasmVoiceState[];
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
            const stateData = JSON.parse(wasmState);
            this.stateVersion = stateData.version;
            await this.updateStoreState(stateData);
        } catch (error) {
            console.error('Force sync failed:', error);
            throw error;
        }
    }

    private async updateStoreState(stateData: WasmState) {
        if (!this.store.synthLayout) return;

        console.log('Updating store state with:', stateData);

        this.store.synthLayout.voices.forEach((voice, index) => {
            const wasmVoice = stateData.voices[index];
            if (wasmVoice) {
                // Clear existing connections first
                voice.connections = [];

                // Add new connections from WASM state, converting the target
                voice.connections = wasmVoice.connections.map(conn => ({
                    fromId: conn.from_id,
                    toId: conn.to_id,
                    target: this.convertFromWasmTarget(conn.target),  // Convert PortId to ModulationTarget
                    amount: conn.amount
                }));
            }
        });

        if (this.store.synthLayout.metadata) {
            this.store.synthLayout.metadata.stateVersion = this.stateVersion;
        }

        console.log('Store state updated:', this.store.synthLayout);
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

    private convertFromWasmTarget(target: PortId): ModulationTarget {
        switch (target) {
            case PortId.FrequencyMod:
                return ModulationTarget.Frequency;
            case PortId.GainMod:
                return ModulationTarget.Gain;
            case PortId.PhaseMod:
                return ModulationTarget.PhaseMod;
            case PortId.ModIndex:
                return ModulationTarget.ModIndex;
            case PortId.CutoffMod:
                return ModulationTarget.FilterCutoff;
            case PortId.ResonanceMod:
                return ModulationTarget.FilterResonance;
            default:
                console.warn('Unknown WASM target:', target);
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