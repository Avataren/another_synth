import { defineStore } from 'pinia';
import type {
  NodeConnection,
  SynthLayout,
  VoiceLayout,
} from 'src/audio/types/synth-layout';
import {
  VoiceNodeType,
  cloneVoiceLayout,
} from 'src/audio/types/synth-layout';
import type { PortId } from 'app/public/wasm/audio_processor';
import {
  normalizeConnection,
  type RawConnection,
  rustNodeTypeToTS,
} from 'src/audio/adapters/wasm-type-adapter';

interface RawNode {
  id: string;
  node_type: string;
  name: string;
}

type NodeMap = VoiceLayout['nodes'];

export const useLayoutStore = defineStore('layoutStore', {
  state: () => ({
    synthLayout: null as SynthLayout | null,
    isUpdatingFromWasm: false,
    deletedNodeIds: new Set<string>(),
  }),
  getters: {
    getVoiceNodes:
      (state) =>
      (voiceIndex: number, nodeType: VoiceNodeType) => {
        if (!state.synthLayout) return [];
        const voice = state.synthLayout.voices[voiceIndex];
        if (!voice) return [];
        return voice.nodes[nodeType] || [];
      },
    getNodeConnections:
      (state) =>
      (nodeId: string): NodeConnection[] => {
        if (!state.synthLayout) return [];
        const voice = state.synthLayout.voices[0];
        if (!voice) return [];
        return voice.connections.filter(
          (conn) => conn.fromId === nodeId || conn.toId === nodeId,
        );
      },
    findNodeById:
      (state) =>
      (nodeId: string) => {
        const voice = state.synthLayout?.voices[0];
        if (!voice) return null;

        for (const type of Object.values(VoiceNodeType)) {
          const node = voice.nodes[type]?.find((n) => n.id === nodeId);
          if (node) {
            return { ...node, type };
          }
        }
        return null;
      },
  },
  actions: {
    async waitForSynthLayout(timeoutMs = 8000): Promise<boolean> {
      const pollInterval = 50;
      const start = Date.now();

      while (
        !this.synthLayout ||
        !Array.isArray(this.synthLayout.voices) ||
        this.synthLayout.voices.length === 0 ||
        !this.synthLayout.voices[0] ||
        !this.synthLayout.voices[0]!.nodes
      ) {
        if (Date.now() - start > timeoutMs) {
          console.warn('Timed out waiting for synth layout');
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      return true;
    },
    updateSynthLayout(layout: SynthLayout) {
      if (
        !layout.voices ||
        !Array.isArray(layout.voices) ||
        layout.voices.length === 0
      ) {
        console.warn('Received invalid synth layout (no voices).');
        return;
      }

      const existingNames = new Map<string, string>();
      if (this.synthLayout) {
        this.synthLayout.voices.forEach((voice) => {
          Object.values(voice.nodes).forEach((nodeArray) => {
            nodeArray.forEach((node) => existingNames.set(node.id, node.name));
          });
        });
      }

      const layoutClone = JSON.parse(JSON.stringify(layout)) as SynthLayout;
      const previousVoiceCount =
        this.synthLayout?.voiceCount ?? this.synthLayout?.voices.length ?? 0;

      const convertConnections = (
        connections: Array<NodeConnection | RawConnection>,
      ): NodeConnection[] => {
        if (!Array.isArray(connections) || connections.length === 0) {
          return [];
        }

        const first = connections[0];
        if (first && typeof first === 'object' && 'from_id' in first) {
          return (connections as RawConnection[]).map((conn) =>
            normalizeConnection(conn),
          );
        }

        return (connections as NodeConnection[]).map((conn) => ({
          fromId: String(conn.fromId),
          toId: String(conn.toId),
          target: Number(conn.target) as PortId,
          amount: Number(conn.amount),
          modulationType: conn.modulationType,
          modulationTransformation: conn.modulationTransformation,
        }));
      };

      const convertNodesArray = (rawNodes: RawNode[]): NodeMap => {
        const nodesByType = Object.values(VoiceNodeType).reduce<NodeMap>(
          (acc, type) => {
            acc[type] = [];
            return acc;
          },
          {} as NodeMap,
        );

        const defaultNameCounts = new Map<
          VoiceNodeType,
          Map<string, number>
        >();
        const nextDefaultName = (type: VoiceNodeType, baseName: string) => {
          const typeCounts =
            defaultNameCounts.get(type) ?? new Map<string, number>();
          const nextCount = (typeCounts.get(baseName) ?? 0) + 1;
          typeCounts.set(baseName, nextCount);
          defaultNameCounts.set(type, typeCounts);
          return nextCount === 1 ? baseName : `${baseName} ${nextCount}`;
        };

        rawNodes.forEach((raw) => {
          const type = rustNodeTypeToTS(raw.node_type);
          const nodeId = String(raw.id);
          if (!nodeId) {
            console.warn('Ignoring node without ID', raw);
            return;
          }
          const baseName = raw.name?.trim() || `${type} ${nodeId}`;
          const nodeName = existingNames.get(nodeId) || nextDefaultName(type, baseName);
          if (!nodesByType[type]) {
            nodesByType[type] = [];
          }
          nodesByType[type]!.push({ id: nodeId, type, name: nodeName });
        });

        return nodesByType;
      };

      layoutClone.voices = layoutClone.voices.map((voice) => {
        const converted: VoiceLayout = {
          id: voice.id,
          nodes: Array.isArray(voice.nodes)
            ? convertNodesArray(voice.nodes as unknown as RawNode[])
            : voice.nodes,
          connections: convertConnections(
            (voice.connections ?? []) as Array<NodeConnection | RawConnection>,
          ),
        };

        Object.values(converted.nodes).forEach((nodeArray) => {
          nodeArray.forEach((node) => {
            if (!node.name) {
              node.name = node.id;
            }
          });
        });

        return converted;
      });

      const canonicalSource = layoutClone.voices[0]
        ? cloneVoiceLayout(layoutClone.voices[0]!)
        : undefined;

      const resolvedVoiceCount =
        layoutClone.voiceCount && layoutClone.voiceCount > 0
          ? layoutClone.voiceCount
          : previousVoiceCount > 0
            ? previousVoiceCount
            : layoutClone.voices.length;

      if (canonicalSource && layoutClone.voices.length !== resolvedVoiceCount) {
        layoutClone.voices = Array.from(
          { length: resolvedVoiceCount },
          (_, index) => {
            const clone = cloneVoiceLayout(canonicalSource);
            clone.id = index;
            return clone;
          },
        );
      } else {
        layoutClone.voices = layoutClone.voices.map((voice, index) => ({
          ...voice,
          id: index,
        }));
      }

      layoutClone.voiceCount = resolvedVoiceCount;
      if (layoutClone.voices[0]) {
        layoutClone.canonicalVoice = cloneVoiceLayout(
          layoutClone.voices[0]!,
        );
      }

      this.synthLayout = { ...layoutClone };
      this.deletedNodeIds.clear();
    },
    getNodeName(nodeId: string): string | undefined {
      const voice = this.synthLayout?.voices[0];
      if (!voice) return undefined;
      for (const type of Object.values(VoiceNodeType)) {
        const node = voice.nodes[type]?.find((n) => n.id === nodeId);
        if (node) return node.name;
      }
      return undefined;
    },
    renameNode(nodeId: string, newName: string) {
      if (!this.synthLayout) return;
      const normalized = newName.trim();
      if (!normalized) return;

      this.synthLayout.voices.forEach((voice) => {
        Object.values(voice.nodes).forEach((nodeArray) => {
          nodeArray.forEach((node) => {
            if (node.id === nodeId) {
              node.name = normalized;
            }
          });
        });
      });

      this.commitLayoutChange();
    },
    syncCanonicalVoiceWithFirstVoice() {
      if (!this.synthLayout || this.synthLayout.voices.length === 0) {
        return;
      }
      this.synthLayout.canonicalVoice = cloneVoiceLayout(
        this.synthLayout.voices[0]!,
      );
    },
    removeNodeFromLayout(nodeId: string) {
      if (!this.synthLayout) {
        return;
      }

      const updatedVoices = this.synthLayout.voices.map((voice) => {
        const updatedNodes: NodeMap = { ...voice.nodes };

        (Object.keys(updatedNodes) as Array<VoiceNodeType>).forEach((type) => {
          const nodeList = updatedNodes[type] || [];
          const filtered = nodeList.filter((node) => node.id !== nodeId);
          if (filtered.length !== nodeList.length) {
            updatedNodes[type] = filtered;
          }
        });

        const updatedConnections = voice.connections.filter(
          (conn) => conn.fromId !== nodeId && conn.toId !== nodeId,
        );

        return {
          ...voice,
          nodes: updatedNodes,
          connections: updatedConnections,
        };
      });

      this.synthLayout = {
        ...this.synthLayout,
        voices: updatedVoices,
      };
      this.syncCanonicalVoiceWithFirstVoice();
      this.commitLayoutChange();
    },
    commitLayoutChange() {
      if (this.synthLayout) {
        this.synthLayout = { ...this.synthLayout };
      }
    },
  },
});
