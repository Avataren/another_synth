// src/audio/sync-manager.ts

import { type ModulationTarget, type ModulationTargetOption, type NodeConnection } from './types/synth-layout';
import { useAudioSystemStore } from '../stores/audio-system-store';

// Must match the Rust PortId enum exactly
enum WasmPortId {
    AudioInput0 = 0,
    AudioInput1 = 1,
    AudioInput2 = 2,
    AudioInput3 = 3,
    AudioOutput0 = 4,
    AudioOutput1 = 5,
    AudioOutput2 = 6,
    AudioOutput3 = 7,
    Gate = 8,
    GlobalFrequency = 9,
    Frequency = 10,
    FrequencyMod = 11,
    PhaseMod = 12,
    ModIndex = 13,
    CutoffMod = 14,
    ResonanceMod = 15,
    GainMod = 16,
    EnvelopeMod = 17
}

interface WasmConnection {
    from_id: number;
    to_id: number;
    target: number;
    amount: number;
}

interface WasmVoice {
    connections: WasmConnection[];
}

interface WasmLayout {
    voices: WasmVoice[];
}

export class AudioSyncManager {
    private syncInterval: number | null = null;
    private store = useAudioSystemStore();
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

    private convertToWasmTarget(storeTarget: number): number {
        switch (storeTarget) {
            case 0: // Frequency
                return WasmPortId.FrequencyMod;
            case 1: // Gain
                return WasmPortId.GainMod;
            case 2: // FilterCutoff
                return WasmPortId.CutoffMod;
            case 3: // FilterResonance
                return WasmPortId.ResonanceMod;
            case 4: // PhaseMod
                return WasmPortId.PhaseMod;
            case 5: // ModIndex
                return WasmPortId.ModIndex;
            default:
                return storeTarget;
        }
    }

    private convertFromWasmTarget(wasmTarget: number): number {
        switch (wasmTarget) {
            case WasmPortId.FrequencyMod:
                return 0; // Frequency
            case WasmPortId.GainMod:
                return 1; // Gain
            case WasmPortId.CutoffMod:
                return 2; // FilterCutoff
            case WasmPortId.ResonanceMod:
                return 3; // FilterResonance
            case WasmPortId.PhaseMod:
                return 4; // PhaseMod
            case WasmPortId.ModIndex:
                return 5; // ModIndex
            default:
                return wasmTarget;
        }
    }

    private normalizeConnections(connections: WasmConnection[]): WasmConnection[] {
        // Group connections by from_id, to_id, and target
        const connectionMap = new Map<string, WasmConnection>();

        for (const conn of connections) {
            const key = `${conn.from_id}-${conn.to_id}-${conn.target}`;
            // Keep the connection with the highest amount for each unique key
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
        const normalizedStoreConns = this.normalizeConnections(storeConns.map(conn => ({
            from_id: conn.fromId,
            to_id: conn.toId,
            target: this.convertToWasmTarget(this.getTargetValue(conn.target)),
            amount: conn.amount
        })));
        // Normalize WASM connections
        const normalizedWasmConns = this.normalizeConnections(wasmConns);

        // Create maps for easy lookup
        const storeMap = new Map(normalizedStoreConns.map(conn => [
            `${conn.from_id}-${conn.to_id}-${conn.target}`,
            conn
        ]));
        const wasmMap = new Map(normalizedWasmConns.map(conn => [
            `${conn.from_id}-${conn.to_id}-${conn.target}`,
            conn
        ]));

        // Find differences
        for (const [key, storeConn] of storeMap) {
            const wasmConn = wasmMap.get(key);
            if (!wasmConn || Math.abs(storeConn.amount - wasmConn.amount) >= 0.001) {
                differences.push({ store: this.convertToStoreConnection(storeConn), wasm: wasmConn || null });
            }
        }

        for (const [key, wasmConn] of wasmMap) {
            if (!storeMap.has(key)) {
                differences.push({ store: null, wasm: wasmConn });
            }
        }

        if (differences.length > 0) {
            console.log('Normalized connections:');
            console.log('Store:', JSON.stringify(normalizedStoreConns, null, 2));
            console.log('WASM:', JSON.stringify(normalizedWasmConns, null, 2));
            console.log('Differences:', differences);
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