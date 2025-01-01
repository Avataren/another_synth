// src/audio/modulation-route-manager.ts

import { useAudioSystemStore } from 'src/stores/audio-system-store';
import {
    VoiceNodeType,
    ModulationTarget,
    type NodeConnection,
    type ModulationTargetOption,
    type VoiceNode,
    isModulationTargetObject,
} from './types/synth-layout';

export interface TargetNode {
    id: number;
    name: string;
    type: VoiceNodeType;
}

export class ModulationRouteManager {
    constructor(
        private readonly store = useAudioSystemStore(),
        private readonly sourceId: number
    ) { }

    /**
     * Gets all target nodes that can accept new modulation connections
     */
    getAvailableTargets(): TargetNode[] {
        const voice = this.store.synthLayout?.voices[0];
        if (!voice) return [];

        const nodes: TargetNode[] = [];

        for (const type of Object.values(VoiceNodeType)) {
            const typeNodes = voice.nodes[type];
            typeNodes.forEach((node, index) => {
                if (node.id === this.sourceId) return;

                // Check if this node has any available parameters
                const params = this.getAvailableParams(node.id);
                if (params.length === 0) return;

                nodes.push({
                    id: node.id,
                    name: this.getNodeName(type, index),
                    type: type,
                });
            });
        }

        return nodes;
    }

    /**
     * Gets available parameters for a target node that aren't already used in other routes
     */
    getAvailableParams(targetId: number): ModulationTargetOption[] {
        const voice = this.store.synthLayout?.voices[0];
        if (!voice) return [];

        const node = this.findNodeById(targetId);
        if (!node) return [];

        // Get existing connections to this target from this source
        const existingConnections = voice.connections.filter(conn =>
            conn.fromId === this.sourceId &&
            conn.toId === targetId
        );

        // Get all possible parameters for this node type
        const allParams = this.getParamsForNodeType(node.type);

        // Filter out parameters that are already used
        return allParams.filter(param => {
            const isUsed = existingConnections.some(conn => {
                const connTarget = isModulationTargetObject(conn.target) ? conn.target.value : conn.target;
                return connTarget === param.value;
            });
            return !isUsed;
        });
    }

    private getNodeName(type: VoiceNodeType, index: number): string {
        switch (type) {
            case VoiceNodeType.Oscillator:
                return `Oscillator ${index + 1}`;
            case VoiceNodeType.Filter:
                return `Filter ${index + 1}`;
            case VoiceNodeType.Envelope:
                return `Envelope ${index + 1}`;
            case VoiceNodeType.LFO:
                return `LFO ${index + 1}`;
            default:
                return `${type} ${index + 1}`;
        }
    }

    private getParamsForNodeType(type: VoiceNodeType): ModulationTargetOption[] {
        switch (type) {
            case VoiceNodeType.Oscillator:
                return [
                    { value: ModulationTarget.PhaseMod, label: 'Phase' },
                    { value: ModulationTarget.Frequency, label: 'Frequency' },
                    { value: ModulationTarget.ModIndex, label: 'Mod Index' },
                    { value: ModulationTarget.Gain, label: 'Gain' },
                ];
            case VoiceNodeType.Filter:
                return [
                    { value: ModulationTarget.FilterCutoff, label: 'Cutoff' },
                    { value: ModulationTarget.FilterResonance, label: 'Resonance' },
                ];
            default:
                return [];
        }
    }

    private findNodeById(nodeId: number): VoiceNode | undefined {
        const voice = this.store.synthLayout?.voices[0];
        if (!voice) return undefined;

        for (const type of Object.values(VoiceNodeType)) {
            const node = voice.nodes[type].find(n => n.id === nodeId);
            if (node) return node;
        }
        return undefined;
    }

    async updateConnection(connection: NodeConnection): Promise<void> {
        try {
            await this.store.updateConnection(connection);
        } catch (error) {
            console.error('Failed to update connection:', error);
            throw error;
        }
    }
}