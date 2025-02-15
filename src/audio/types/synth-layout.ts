// src/audio/types/synth-layout.ts
import {
  PortId,
  WasmModulationType,
} from 'app/public/wasm/audio_processor';

// Define the types of nodes we can have in a voice
export enum VoiceNodeType {
  Oscillator = 'oscillator',
  Filter = 'filter',
  Envelope = 'envelope',
  LFO = 'lfo',
  Mixer = 'mixer',
  Noise = 'noise',
  GlobalFrequency = 'globalfrequency'
}

export interface LfoState {
  id?: number;
  frequency: number;
  waveform: number;
  useAbsolute: boolean;
  useNormalized: boolean;
  triggerMode: number;
  gain: number;
  active: boolean;
}

export interface NodeConnectionUpdate {
  fromId: number;
  toId: number;
  target: PortId;
  amount: number;
  isRemoving?: boolean;
  modulationType?: WasmModulationType;
}

export interface NodeConnection {
  fromId: number;
  toId: number;
  target: PortId;
  amount: number;
  modulationType: WasmModulationType;
}

export interface EnvelopeConfig {
  id: number;
  active: boolean;
  attack: number; // seconds
  decay: number; // seconds
  sustain: number; // 0-1
  release: number; // seconds
  attackCurve: number; // -10 to 10: negative = logarithmic, 0 = linear, positive = exponential
  decayCurve: number; // -10 to 10
  releaseCurve: number; // -10 to 10
}

export const PORT_LABELS: Record<PortId, string> = {
  [PortId.AudioInput0]: 'Audio Input 1',
  [PortId.AudioInput1]: 'Audio Input 2',
  [PortId.AudioInput2]: 'Audio Input 3',
  [PortId.AudioInput3]: 'Audio Input 4',
  [PortId.AudioOutput0]: 'Audio Output 1',
  [PortId.AudioOutput1]: 'Audio Output 2',
  [PortId.AudioOutput2]: 'Audio Output 3',
  [PortId.AudioOutput3]: 'Audio Output 4',
  [PortId.Gate]: 'Gate',
  [PortId.GlobalFrequency]: 'Global Frequency',
  [PortId.Frequency]: 'Base Frequency',
  [PortId.FrequencyMod]: 'Frequency Mod',
  [PortId.PhaseMod]: 'Phase Mod',
  [PortId.ModIndex]: 'Mod Index',
  [PortId.CutoffMod]: 'Filter Cutoff',
  [PortId.ResonanceMod]: 'Filter Resonance',
  [PortId.GainMod]: 'Gain',
  [PortId.EnvelopeMod]: 'Envelope Amount',
  [PortId.StereoPan]: 'Stereo Panning',
  [PortId.FeedbackMod]: 'Feedback',
  [PortId.DetuneMod]: 'Detune',
};

export interface ModulationTargetOption {
  value: PortId;
  label: string;
}

export interface FilterConfig {
  type: 'lowpass' | 'highpass' | 'bandpass';
}

export interface FilterState {
  id: number;
  cutoff: number;
  resonance: number;
  active: boolean;
}

// Represents a node in the voice with its configuration
export interface VoiceNode {
  id: number;
  type: VoiceNodeType;
}

// The complete layout of a voice
export interface VoiceLayout {
  id: number;
  nodes: {
    [key in VoiceNodeType]: VoiceNode[];
  };
  connections: NodeConnection[];
}

// Global nodes that are shared across all voices
export interface GlobalNodes {
  masterGain?: number;
  effectsChain?: VoiceNode[];
}

// The complete synth layout
export interface SynthLayout {
  voices: VoiceLayout[];
  globalNodes: GlobalNodes;
  metadata?: {
    maxVoices: number;
    maxOscillators: number;
    maxEnvelopes: number;
    maxLFOs: number;
    maxFilters: number;
    stateVersion: number;
  };
}

export type LayoutUpdateMessage = {
  type: 'synthLayout';
  layout: SynthLayout;
};

// Helper functions
export const getNodesOfType = (
  voice: VoiceLayout,
  type: VoiceNodeType,
): VoiceNode[] => {
  return voice.nodes[type] || [];
};

export interface RawNode {
  id: number;
  node_type: string;
}

export interface RawConnection {
  from_id: number;
  to_id: number;
  target: number;
  amount: number;
  modulation_type: string;
}

export interface RawVoice {
  id: number;
  nodes: RawNode[];
  connections: RawConnection[];
}

export interface WasmState {
  voices: RawVoice[];
}

export const findNodeById = (
  voice: VoiceLayout,
  id: number,
): VoiceNode | undefined => {
  return Object.values(voice.nodes)
    .flat()
    .find((node) => node.id === id);
};

export const findNodeConnections = (
  voice: VoiceLayout,
  nodeId: number,
): NodeConnection[] => {
  return voice.connections.filter(
    (conn) => conn.fromId === nodeId || conn.toId === nodeId,
  );
};

export function convertRawModulationType(raw: string): WasmModulationType {
  switch (raw) {
    case 'VCA':
      return WasmModulationType.VCA;
    case 'Bipolar':
      return WasmModulationType.Bipolar;
    case 'Additive':
      return WasmModulationType.Additive;
    default:
      console.warn('Unknown modulation type:', raw);
      return WasmModulationType.Additive; // default fallback
  }
}


export function findModulationTargets(
  voice: VoiceLayout,
  sourceId: number,
): Array<{
  nodeId: number;
  target: PortId;
  amount: number;
}> {
  return voice.connections
    .filter((conn) => conn.fromId === sourceId)
    .map((conn) => ({
      nodeId: conn.toId,
      target: conn.target,
      amount: conn.amount,
    }));
}

// export function isModulationPort(port: PortId): boolean {
//     return port === PortId.FrequencyMod ||
//         port === PortId.PhaseMod ||
//         port === PortId.ModIndex ||
//         port === PortId.CutoffMod ||
//         port === PortId.ResonanceMod ||
//         port === PortId.GainMod ||
//         port === PortId.EnvelopeMod ||
//         port === PortId.StereoPan;
// }

export function getModulationTargetsForType(
  type: VoiceNodeType,
): ModulationTargetOption[] {
  switch (type) {
    case VoiceNodeType.Oscillator:
      return [
        { value: PortId.PhaseMod, label: PORT_LABELS[PortId.PhaseMod] },
        { value: PortId.FrequencyMod, label: PORT_LABELS[PortId.FrequencyMod] },
        { value: PortId.ModIndex, label: PORT_LABELS[PortId.ModIndex] },
        { value: PortId.GainMod, label: PORT_LABELS[PortId.GainMod] },
        { value: PortId.FeedbackMod, label: PORT_LABELS[PortId.FeedbackMod] },
      ];
    case VoiceNodeType.Filter:
      return [
        { value: PortId.AudioInput0, label: PORT_LABELS[PortId.AudioInput0] },
        { value: PortId.CutoffMod, label: PORT_LABELS[PortId.CutoffMod] },
        { value: PortId.ResonanceMod, label: PORT_LABELS[PortId.ResonanceMod] },
      ];
    case VoiceNodeType.Noise:
      return [
        { value: PortId.CutoffMod, label: PORT_LABELS[PortId.CutoffMod] },
        { value: PortId.GainMod, label: PORT_LABELS[PortId.GainMod] },
      ];
    case VoiceNodeType.Mixer:
      return [
        { value: PortId.AudioInput0, label: PORT_LABELS[PortId.AudioInput0] },
        { value: PortId.GainMod, label: PORT_LABELS[PortId.GainMod] },
        { value: PortId.StereoPan, label: PORT_LABELS[PortId.StereoPan] },
      ];
    case VoiceNodeType.LFO:
      return [
        { value: PortId.GainMod, label: PORT_LABELS[PortId.GainMod] },
        { value: PortId.FrequencyMod, label: PORT_LABELS[PortId.FrequencyMod] },
        { value: PortId.FrequencyMod, label: PORT_LABELS[PortId.FrequencyMod] },
      ];
    case VoiceNodeType.GlobalFrequency:
      return [{ value: PortId.DetuneMod, label: PORT_LABELS[PortId.DetuneMod] }];
    // case VoiceNodeType.Envelope:
    //   return [
    //     { value: PortId.GainMod, label: 'Gain' },
    //     // ... any other valid envelope targets
    //   ];
    default:
      return [];
  }
}

export function createNodeConnection(
  fromId: number,
  toId: number,
  target: PortId,
  amount: number,
  modulationType: WasmModulationType,
): NodeConnection {
  return { fromId, toId, target, amount, modulationType };
}
