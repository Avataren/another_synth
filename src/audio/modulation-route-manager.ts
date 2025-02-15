// src/audio/modulation-route-manager.ts

import { useAudioSystemStore } from 'src/stores/audio-system-store';
import {
  VoiceNodeType,
  type ModulationTargetOption,
  type VoiceNode,
  type NodeConnectionUpdate,
  getModulationTargetsForType,
} from './types/synth-layout';
import { PortId, WasmModulationType } from 'app/public/wasm/audio_processor';

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
  ) { }

  private getNodeName(type: VoiceNodeType, index: number): string {
    switch (type) {
      // case VoiceNodeType.Oscillator:
      //   return `Oscillator ${index + 1}`;
      // case VoiceNodeType.Filter:
      //   return `Filter ${index + 1}`;
      // case VoiceNodeType.Envelope:
      //   return `Envelope ${index + 1}`;
      // case VoiceNodeType.LFO:
      //   return `LFO ${index + 1}`;
      // case VoiceNodeType.GlobalFrequency:
      //   return `Global Frequency ${index + 1}`;
      default:
        return `${type} ${index + 1}`;
    }
  }

  private findNodeById(nodeId: number): VoiceNode | undefined {
    const voice = this.store.synthLayout?.voices[0];
    if (!voice) return undefined;

    for (const type of Object.values(VoiceNodeType)) {
      const node = voice.nodes[type].find((n) => n.id === nodeId);
      if (node) return { ...node, type };
    }
    return undefined;
  }

  private isConnectionCreatingFeedback(
    sourceId: number,
    targetNodeId: number,
  ): boolean {
    const voice = this.store.synthLayout?.voices[0];
    if (!voice) return false;

    // Check if this connection already exists
    const existingConnection = voice.connections.find(
      (conn) => conn.fromId === sourceId && conn.toId === targetNodeId,
    );

    // If the connection already exists, it's not creating new feedback
    if (existingConnection) {
      return false;
    }

    // Helper function to check if there's a path from target back to source
    const hasPathToSource = (
      currentId: number,
      visited: Set<number>,
    ): boolean => {
      if (currentId === sourceId) return true;
      if (visited.has(currentId)) return false;

      visited.add(currentId);

      // Get all connections from the current node
      const outgoingConnections = this.store.getNodeConnections(currentId);

      // Check each connection
      for (const conn of outgoingConnections) {
        if (hasPathToSource(conn.toId, new Set(visited))) {
          return true;
        }
      }

      return false;
    };

    // Start checking from the target node
    return hasPathToSource(targetNodeId, new Set());
  }

  public getDefaultModulationType(port: PortId): WasmModulationType {
    switch (port) {
      case PortId.FrequencyMod:
        return WasmModulationType.Bipolar; // Type 1
      case PortId.PhaseMod:
      case PortId.ModIndex:

        return WasmModulationType.Additive; // Type 2
      case PortId.GainMod:
      case PortId.FeedbackMod:
        return WasmModulationType.VCA; // Type 0
      default:
        return WasmModulationType.Additive; // Type 0
    }
  }

  /**
   * Gets available parameters for a target node that aren't already used in other routes
   */
  getAvailableParams(targetId: number): ModulationTargetOption[] {
    const node = this.findNodeById(targetId);
    if (!node) return [];

    // Get all possible parameters for this node type
    const allParams = getModulationTargetsForType(node.type);

    // Get existing connections only for this specific source->target pair
    const existingConnections = this.store
      .getNodeConnections(this.sourceId)
      .filter(
        (conn) => conn.fromId === this.sourceId && conn.toId === targetId,
      );

    // Only filter out parameters that are already connected for this specific target
    const availableParams = allParams.filter((param) => {
      const isUsedForThisTarget = existingConnections.some(
        (conn) => conn.target === param.value,
      );
      return !isUsedForThisTarget;
    });

    return availableParams;
  }

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
      if (!voice.nodes[type]) continue;

      const typeNodes = voice.nodes[type];
      typeNodes.forEach((node, index) => {
        // Skip self-modulation and nodes that would create feedback
        if (
          node.id === this.sourceId ||
          this.isConnectionCreatingFeedback(this.sourceId, node.id)
        ) {
          return;
        }

        // Include node if it has any available parameters
        const params = this.getAvailableParams(node.id);
        if (params.length > 0) {
          nodes.push({
            id: node.id,
            name: this.getNodeName(type, index),
            type: type,
          });
        }
      });
    }

    return nodes;
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

  async updateConnection(connection: NodeConnectionUpdate): Promise<void> {
    try {
      // Remove this auto-defaulting logic:
      // if (!connection.modulationType) {
      //   connection.modulationType = this.getDefaultModulationType(connection.target);
      // }

      // Log the connection before sending to store
      console.log('ModulationRouteManager handling connection:', {
        original: connection,
        modType: connection.modulationType,
      });

      await this.store.updateConnection(connection);
    } catch (error) {
      console.error('Failed to update connection:', error);
      throw error;
    }
  }
}
