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
import { useMacroStore } from './macro-store';

const DEFAULT_NODE_NAMES: Partial<Record<VoiceNodeType, string[]>> = {
  [VoiceNodeType.Oscillator]: ['Analog Oscillator'],
  [VoiceNodeType.WavetableOscillator]: ['Wavetable Oscillator'],
  [VoiceNodeType.Envelope]: ['Envelope'],
  [VoiceNodeType.LFO]: ['LFO'],
  [VoiceNodeType.Filter]: ['Filter Collection'],
  [VoiceNodeType.Mixer]: ['Mixer'],
  [VoiceNodeType.Noise]: ['Noise Generator'],
  [VoiceNodeType.Sampler]: ['Sampler'],
  [VoiceNodeType.Glide]: ['Glide'],
  [VoiceNodeType.GlobalFrequency]: ['Global Frequency'],
  [VoiceNodeType.GlobalVelocity]: ['Global Velocity'],
  [VoiceNodeType.Convolver]: ['Convolver'],
  [VoiceNodeType.Delay]: ['Delay'],
  [VoiceNodeType.GateMixer]: ['Gate Mixer'],
  [VoiceNodeType.ArpeggiatorGenerator]: ['Arpeggiator'],
  [VoiceNodeType.Chorus]: ['Chorus'],
  [VoiceNodeType.Limiter]: ['Limiter'],
  [VoiceNodeType.Reverb]: ['Reverb'],
  [VoiceNodeType.Compressor]: ['Compressor'],
  [VoiceNodeType.Saturation]: ['Saturation'],
  [VoiceNodeType.Bitcrusher]: ['Bitcrusher'],
};

const isGenericNameForType = (name: string, type: VoiceNodeType): boolean => {
  if (!name) return true;
  const canonical = name.trim();
  if (!canonical) return true;
  const defaultNamesForType = DEFAULT_NODE_NAMES[type] ?? [];

  return (
    canonical === type ||
    canonical === type.charAt(0).toUpperCase() + type.slice(1) ||
    Object.values(VoiceNodeType).some((t) => canonical === t) ||
    defaultNamesForType.includes(canonical)
  );
};

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
        if (nodeId.startsWith('macro-')) {
          const macroIndex = Number(nodeId.replace('macro-', '')) || 0;
          return useMacroStore().routesForMacro(macroIndex).map((route) => ({
            fromId: nodeId,
            toId: route.targetId,
            target: route.targetPort,
            amount: route.amount,
            modulationType: route.modulationType,
            modulationTransformation: route.modulationTransformation,
          }));
        }
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

      // DEBUG: Log call stack to see where this is being called from
      console.log('[updateSynthLayout] Called with layout:', {
        voiceCount: layout.voices.length,
        firstVoiceNodesIsArray: Array.isArray(layout.voices[0]?.nodes),
        stack: new Error().stack?.split('\n').slice(1, 4).join('\n')
      });

      // DEBUG: If envelope nodes exist, log their names
      if (layout.voices[0] && !Array.isArray(layout.voices[0].nodes)) {
        const envelopes = layout.voices[0].nodes.envelope;
        if (envelopes && envelopes.length > 0) {
          console.log('[updateSynthLayout] Incoming envelope node names:', envelopes.map(e => ({ id: e.id, name: e.name })));
        }
      } else if (layout.voices[0] && Array.isArray(layout.voices[0].nodes)) {
        const rawNodes = layout.voices[0].nodes as unknown as Array<{ id: string; name: string; node_type: string }>;
        const envelopes = rawNodes.filter(n => n.node_type === 'Envelope');
        if (envelopes.length > 0) {
          console.log('[updateSynthLayout] Incoming RAW envelope node names:', envelopes.map(e => ({ id: e.id, name: e.name })));
        }
      }

      const existingNames = new Map<string, string>();
      if (this.synthLayout) {
        this.synthLayout.voices.forEach((voice) => {
          Object.values(voice.nodes).forEach((nodeArray) => {
            nodeArray.forEach((node) => {
              existingNames.set(node.id, node.name);
              console.log('[updateSynthLayout] Preserving existing name:', node.id, '→', node.name);
            });
          });
        });
      }
      console.log('[updateSynthLayout] existingNames size:', existingNames.size);

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
          // Name resolution priority:
          // 1. If rawName exists and looks custom (not just the node type), use it
          // 2. Otherwise, use existingName if available (preserves custom names from previous state)
          // 3. Otherwise, use rawName if it exists (even if generic)
          // 4. Otherwise, generate a default name
          const existingName = existingNames.get(nodeId);
          const rawName = raw.name?.trim();

          const normalizedRawName = rawName ?? '';
          const isGenericName = isGenericNameForType(normalizedRawName, type);

          let nodeName: string;
          if (normalizedRawName && !isGenericName) {
            // rawName looks custom, use it
            nodeName = normalizedRawName;
          } else if (existingName) {
            // We have a preserved custom name, use it
            nodeName = existingName;
          } else if (normalizedRawName) {
            // rawName is generic but we have nothing better
            nodeName = normalizedRawName;
          } else {
            // Generate a default name
            nodeName = nextDefaultName(type, `${type} ${nodeId}`);
          }

          console.log('[convertNodesArray] Node name resolution:', {
            nodeId,
            existingName,
            rawName,
            isGenericName,
            chosen: nodeName
          });
          if (!nodesByType[type]) {
            nodesByType[type] = [];
          }
          nodesByType[type]!.push({ id: nodeId, type, name: nodeName });
        });

        return nodesByType;
      };

      const ensureGlideNode = (voice: VoiceLayout) => {
        const existing = voice.nodes[VoiceNodeType.Glide] || [];
        if (existing.length === 0) {
          const id =
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? (crypto as unknown as { randomUUID: () => string }).randomUUID()
              : `glide_${Date.now()}_${Math.random().toString(16).slice(2)}`;
          voice.nodes[VoiceNodeType.Glide] = [
            { id, type: VoiceNodeType.Glide, name: 'Glide' },
          ];
        }
      };

      layoutClone.voices = layoutClone.voices.map((voice) => {
        console.log('[updateSynthLayout] Processing voice, nodes is array?', Array.isArray(voice.nodes));

        let processedNodes: NodeMap;
        if (Array.isArray(voice.nodes)) {
          processedNodes = convertNodesArray(voice.nodes as unknown as RawNode[]);
        } else {
          // Nodes are already in object format, but we still need to apply existingNames
          processedNodes = { ...voice.nodes } as NodeMap;
          Object.keys(processedNodes).forEach((type) => {
            const nodeArray = processedNodes[type as VoiceNodeType] || [];
            processedNodes[type as VoiceNodeType] = nodeArray.map(node => {
              const nodeType = type as VoiceNodeType;
              const existingName = existingNames.get(node.id);
              const incomingName = (node.name ?? '').trim();
              const hasCustomIncoming = incomingName && !isGenericNameForType(incomingName, nodeType);

              if (hasCustomIncoming) {
                return { ...node, name: incomingName };
              }

              if (existingName) {
                console.log('[updateSynthLayout] Applying existing name to object-format node:', node.id, '→', existingName);
                return { ...node, name: existingName };
              }

              if (incomingName) {
                return { ...node, name: incomingName };
              }

              return { ...node, name: node.id };
            });
          });
        }

        const converted: VoiceLayout = {
          id: voice.id,
          nodes: processedNodes,
          connections: convertConnections(
            (voice.connections ?? []) as Array<NodeConnection | RawConnection>,
          ),
        };

        ensureGlideNode(converted);

        Object.values(converted.nodes).forEach((nodeArray) => {
          nodeArray.forEach((node) => {
            if (!node.name) {
              node.name = node.id;
            }
            console.log('[updateSynthLayout] Final node name:', node.id, '→', node.name);
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

      // Update all voices
      this.synthLayout.voices.forEach((voice) => {
        Object.values(voice.nodes).forEach((nodeArray) => {
          nodeArray.forEach((node) => {
            if (node.id === nodeId) {
              node.name = normalized;
            }
          });
        });
      });

      // Also update canonicalVoice (used for patch serialization)
      if (this.synthLayout.canonicalVoice) {
        Object.values(this.synthLayout.canonicalVoice.nodes).forEach((nodeArray) => {
          nodeArray.forEach((node) => {
            if (node.id === nodeId) {
              node.name = normalized;
            }
          });
        });
      }

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
