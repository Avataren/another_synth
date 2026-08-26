// src/audio/sync-manager.ts

import {
    type NodeConnectionUpdate,
    type NodeConnection,
} from './types/synth-layout';
import type InstrumentV2 from './instrument-v2';
import { useLayoutStore } from 'src/stores/layout-store';
import { useConnectionStore } from 'src/stores/connection-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import { type ModulationTransformation, type WasmModulationType } from 'app/public/wasm/audio_processor';
import { PortId } from './types/generated/port-ids';

interface WasmVoice {
    id: number;
    connections: WasmConnection[];
    nodes: WasmNode[];
}
interface WasmLayout {
    voices: WasmVoice[];
}

export interface WasmConnection {
    from_id: string;
    to_id: string;
    target: PortId;
    amount: number;
    modulationType: WasmModulationType;
    modulationTransform: ModulationTransformation
}

interface WasmNode {
    id: string;
    node_type: string;
    name: string;
}

/**
 * Does a single, one-shot reconciliation of the layout store's connections
 * against what WASM actually reports, right after the instrument boots.
 * (Despite the class name, there is no ongoing "management" here: this used
 * to also support periodic re-syncing via setInterval, but that was never
 * enabled -- see git history -- so it's been removed. If you need to force
 * a re-sync later, call start() again; it's idempotent per lastWasmState.)
 */
export class AudioSyncManager {
    private readonly resolveInstrument: () => InstrumentV2 | null;
    private layoutStore = useLayoutStore();
    private connectionStore = useConnectionStore();
    private nodeStateStore = useNodeStateStore();
    private lastWasmState: string = '';

    constructor(instrumentProvider: () => InstrumentV2 | null) {
        this.resolveInstrument = instrumentProvider;
    }

    async start() {
        try {
            await this.syncWithWasm();
        } catch (error) {
            console.error('Failed to start sync manager:', error);
            throw error;
        }
    }

    public async updateConnection(
        connection: NodeConnectionUpdate,
    ): Promise<void> {
        const instrument = this.resolveInstrument();
        if (!instrument?.isReady) return;

        try {
            // const numVoices = this.store.synthLayout?.voices.length || 0;
            // for (let voiceIndex = 0; voiceIndex < numVoices; voiceIndex++) {
            await instrument.updateConnection(connection);
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
        const getConnectionKey = (fromId: string, toId: string, target: PortId) => {
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
        const instrument = this.resolveInstrument();
        if (!instrument?.isReady) return;

        try {
            // const numVoices = this.layoutStore.synthLayout?.voices.length || 0;

            // Validate target is a valid PortId
            const target = connection.target;
            if (typeof target !== 'number' || !(target in PortId)) {
                throw new Error(`Invalid target: ${connection.target}`);
            }

            // Create plain connection object with the correct type
            const plainConnection: NodeConnectionUpdate = {
                fromId: String(connection.fromId),
                toId: String(connection.toId),
                target: target as PortId,
                amount: Number(connection.amount),
                isRemoving: Boolean(connection.isRemoving),
                modulationTransformation: connection.modulationTransformation,
            };

            console.log('Processing validated connection:', {
                original: connection,
                processed: plainConnection,
                targetValue: target,
            });

            // for (let voiceIndex = 0; voiceIndex < numVoices; voiceIndex++) {
            if (connection.isRemoving) {
                await instrument.updateConnection({
                    ...plainConnection,
                    isRemoving: true,
                });
            } else {
                await instrument.updateConnection(plainConnection);
            }
            // }
        } catch (error) {
            console.error('Failed to modify connection:', error);
            throw error;
        }
    }

    private async syncWithWasm() {
        try {
            const instrument = this.resolveInstrument();
            if (!instrument?.isReady) return;

            const wasmState =
                await instrument.getWasmNodeConnections();
            if (wasmState === this.lastWasmState) return;

            this.lastWasmState = wasmState;
            const wasmLayout = JSON.parse(wasmState) as WasmLayout;
            const wasmConnections = wasmLayout.voices.flatMap(
                (voice) => voice.connections || [],
            );
            const storeConnections =
                this.layoutStore.synthLayout?.voices.flatMap((voice) => voice.connections) ||
                [];
            const differences = this.findConnectionDifferences(
                storeConnections,
                wasmConnections,
            );

            if (differences.length > 0) {
                console.log('Found differences:', differences);

                const synthLayout = this.layoutStore.synthLayout;
                if (synthLayout) {
                    synthLayout.voices.forEach((voice, index) => {
                        const wasmVoice = wasmLayout.voices[index];
                        if (wasmVoice) {
                            // Only update with connections that should exist
                            const validConnections = wasmVoice.connections.filter((conn) => {
                                // Check if this connection was recently removed
                                const wasRemoved =
                                    this.connectionStore.isProcessing &&
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
                                modulationTransformation: conn.modulationTransform
                            }));
                        }
                    });
                    this.layoutStore.synthLayout = { ...synthLayout };
                    this.nodeStateStore.initializeDefaultStates();
                }
            }
        } catch (error) {
            console.error('Failed to sync with WASM:', error);
            throw error;
        }
    }
}
