// src/audio/modulation-route-manager.ts

import { useAudioSystemStore } from 'src/stores/audio-system-store';
import {
  VoiceNodeType,
  type ModulationTargetOption,
  type VoiceNode,
  type NodeConnectionUpdate,
  getModulationTargetsForType,
} from './types/synth-layout';

export interface TargetNode {
  id: number;
  name: string;
  type: VoiceNodeType;
}

export class ModulationRouteManager {
  constructor(
    private readonly store = useAudioSystemStore(),
    private readonly sourceId: number,
    private readonly sourceType: VoiceNodeType,
  ) {}

  /**
   * Gets all target nodes that can accept new modulation connections
   */
  getAvailableTargets(): TargetNode[] {
    const voice = this.store.synthLayout?.voices[0];
    if (!voice) {
      console.warn('No voice layout available');
      return [];
    }

    const nodes: TargetNode[] = [];

    for (const type of Object.values(VoiceNodeType)) {
      if (!voice.nodes[type]) {
        console.warn(`No nodes found for type ${type}`);
        continue;
      }

      const typeNodes = voice.nodes[type];
      typeNodes.forEach((node, index) => {
        // Skip self-modulation
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
    const node = this.findNodeById(targetId);
    if (!node) return [];

    // Get all possible parameters for this node type
    const allParams = getModulationTargetsForType(node.type);

    // Filter out parameters that are already used
    const existingConnections = this.store.getNodeConnections(this.sourceId);
    return allParams.filter((param) => {
      const isUsed = existingConnections.some(
        (conn) =>
          conn.fromId === this.sourceId &&
          conn.toId === targetId &&
          conn.target === param.value,
      );
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

  // private getParamsForNodeType(type: VoiceNodeType): ModulationTargetOption[] {
  //     switch (type) {
  //         case VoiceNodeType.Oscillator:
  //             return [
  //                 { value: ModulationTarget.PhaseMod, label: 'Phase' },
  //                 { value: ModulationTarget.Frequency, label: 'Frequency' },
  //                 { value: ModulationTarget.ModIndex, label: 'Mod Index' },
  //                 { value: ModulationTarget.Gain, label: 'Gain' },
  //             ];
  //         case VoiceNodeType.Filter:
  //             return [
  //                 { value: ModulationTarget.FilterCutoff, label: 'Cutoff' },
  //                 { value: ModulationTarget.FilterResonance, label: 'Resonance' },
  //             ];
  //         default:
  //             return [];
  //     }
  // }

  private findNodeById(nodeId: number): VoiceNode | undefined {
    const voice = this.store.synthLayout?.voices[0];
    if (!voice) return undefined;

    for (const type of Object.values(VoiceNodeType)) {
      const node = voice.nodes[type].find((n) => n.id === nodeId);
      if (node) return { ...node, type };
    }
    return undefined;
  }

  async updateConnection(connection: NodeConnectionUpdate): Promise<void> {
    try {
      await this.store.updateConnection(connection);
    } catch (error) {
      console.error('Failed to update connection:', error);
      throw error;
    }
  }
}
