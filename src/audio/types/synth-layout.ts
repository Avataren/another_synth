// src/audio/types/synth-layout.ts
import {
  type ModulationTransformation,
  WasmModulationType,
} from 'app/public/wasm/audio_processor';
import { PortId } from './generated/port-ids';

// Define the types of nodes we can have in a voice
export enum VoiceNodeType {
  Oscillator = 'oscillator',
  WavetableOscillator = 'wavetable_oscillator',
  Filter = 'filter',
  Envelope = 'envelope',
  LFO = 'lfo',
  Mixer = 'mixer',
  Noise = 'noise',
  Sampler = 'sampler',
  Glide = 'glide',
  GlobalFrequency = 'global_frequency',
  GlobalVelocity = 'global_velocity',
  Convolver = 'convolver',
  Delay = 'delay',
  GateMixer = 'gatemixer',
  ArpeggiatorGenerator = 'arpeggiator_generator',
  Chorus = 'chorus',
  Limiter = 'limiter',
  Reverb = 'freeverb',
  Compressor = 'compressor',
  Saturation = 'saturation',
  Bitcrusher = 'bitcrusher',
}

export interface ReverbState {
  id: string;
  active: boolean;
  room_size: number,
  damp: number,
  wet: number,
  dry: number,
  width: number,
}

export interface ChorusState {
  /** Unique identifier for this chorus node instance. */
  id: string;
  /** Whether the chorus effect is currently active/enabled. */
  active: boolean;
  /** The base delay time in milliseconds around which the LFO modulates. */
  baseDelayMs: number;
  /** The depth of the LFO modulation in milliseconds (how far the delay swings). */
  depthMs: number;
  /** The frequency of the Low-Frequency Oscillator (LFO) in Hertz. */
  lfoRateHz: number;
  /** The amount of the delayed signal fed back into the input (0.0 to ~0.98). */
  feedback: number;
  /** feedback lowpass filter cutoff (0 to 1) */
  feedback_filter: number;
  /** The balance between the original (dry) and processed (wet) signal (0.0 = dry, 1.0 = wet). */
  mix: number;
  /** The phase difference in degrees between the LFOs for the left and right channels (0 to 360). */
  stereoPhaseOffsetDeg: number;
}

export interface CompressorState {
  id: string;
  active: boolean;
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupGainDb: number;
  mix: number;
}

export interface SaturationState {
  id: string;
  active: boolean;
  drive: number;
  mix: number;
}

export interface BitcrusherState {
  id: string;
  active: boolean;
  bits: number;
  downsampleFactor: number;
  mix: number;
}

export enum SamplerLoopMode {
  Off = 0,
  Loop = 1,
  PingPong = 2,
}

export enum SamplerTriggerMode {
  FreeRunning = 0,
  Gate = 1,
  OneShot = 2,
}

export interface SamplerState {
  id: string;
  frequency: number;
  gain: number;
  detune_oct: number;
  detune_semi: number;
  detune_cents: number;
  detune: number;
  loopMode: SamplerLoopMode;
  loopStart: number; // normalized 0..1
  loopEnd: number; // normalized 0..1
  sampleLength: number;
  rootNote: number;
  triggerMode: SamplerTriggerMode;
  active: boolean;
  sampleRate: number;
  channels: number;
  fileName?: string;
}

/**
 * Generator type for procedurally-generated impulse responses
 */
export type ImpulseGenerator = 'hall' | 'plate';

/**
 * Parameters for procedurally-generated impulse responses
 */
export interface ImpulseGeneratorParams {
  /** Type of generator used */
  type: ImpulseGenerator;
  /** Decay time in seconds (0.1 - 10.0) */
  decayTime: number;
  /** For hall: room size (0.0 - 1.0), for plate: diffusion (0.0 - 1.0) */
  size: number;
  /** Sample rate used for generation */
  sampleRate: number;
}

export interface ConvolverState {
  id?: string;
  wetMix: number;
  active: boolean;
  /** If present, this convolver uses a procedurally-generated impulse response */
  generator?: ImpulseGeneratorParams;
}

export interface DelayState {
  id?: string;
  delayMs: number;
  feedback: number;
  wetMix: number;
  active: boolean;
}

export interface LfoState {
  id?: string;
  frequency: number;
  phaseOffset: number;
  waveform: number;
  useAbsolute: boolean;
  useNormalized: boolean;
  triggerMode: number;
  gain: number;
  active: boolean;
  loopMode: number;
  loopStart: number;
  loopEnd: number;
}

export interface NodeConnectionUpdate {
  fromId: string;
  toId: string;
  target: PortId;
  amount: number;
  modulationTransformation: ModulationTransformation;
  isRemoving?: boolean;
  modulationType?: WasmModulationType;
}

export interface NodeConnection {
  fromId: string;
  toId: string;
  target: PortId;
  amount: number;
  modulationType: WasmModulationType;
  modulationTransformation: ModulationTransformation;
}

export interface EnvelopeConfig {
  id: string;
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
  [PortId.GlobalGate]: 'Gate',
  [PortId.GlobalFrequency]: 'Global Frequency',
  [PortId.GlobalVelocity]: 'Global Velocity',
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
  [PortId.WavetableIndex]: 'Wavetable Index',
  [PortId.WetDryMix]: 'Mix',
  [PortId.AttackMod]: 'Attack',
  [PortId.ArpGate]: 'Arpeggio gate',
  [PortId.CombinedGate]: 'Combined gate',
  [PortId.SampleOffset]: 'Sample Offset',
};

export interface ModulationTargetOption {
  value: PortId;
  label: string;
}

export interface FilterConfig {
  type: 'lowpass' | 'highpass' | 'bandpass';
}

export enum FilterType {
  LowPass = 0,
  LowShelf = 1,
  Peaking = 2,
  HighShelf = 3,
  Notch = 4,
  HighPass = 5,
  Ladder = 6,
  Comb = 7,
}

export enum FilterSlope {
  Db12 = 0,
  Db24,
}

export interface VelocityState {
  sensitivity: number;
  randomize: number;
  active: boolean;
}

export interface GlideState {
  id: string;
  active: boolean;
  time: number;
  // Legacy fields retained for backward compatibility with older patches
  riseTime?: number;
  fallTime?: number;
}

export interface FilterState {
  id: string;
  cutoff: number;
  resonance: number;
  keytracking: number;
  comb_frequency: number;
  comb_dampening: number;
  oversampling: number;
  gain: number;
  filter_type: FilterType;
  filter_slope: FilterSlope;
  active: boolean;
}

// Represents a node in the voice with its configuration
export interface VoiceNode {
  id: string;
  type: VoiceNodeType;
  name: string;
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
export interface LayoutMetadata {
  maxVoices: number;
  maxOscillators: number;
  maxEnvelopes: number;
  maxLFOs: number;
  maxFilters: number;
  stateVersion: number;
}

export interface SynthLayout {
  voices: VoiceLayout[];
  globalNodes: GlobalNodes;
  metadata?: LayoutMetadata | undefined;
  voiceCount?: number;
  canonicalVoice?: VoiceLayout;
}

export interface PatchLayout {
  voiceCount?: number;
  canonicalVoice?: VoiceLayout;
  voices?: VoiceLayout[];
  globalNodes?: GlobalNodes;
  metadata?: LayoutMetadata | undefined;
}

export type LayoutUpdateMessage = {
  type: 'synthLayout';
  layout: SynthLayout;
};

const deepClone = <T>(value: T): T => {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
};

const cloneGlobalNodes = (globalNodes?: GlobalNodes): GlobalNodes => {
  if (!globalNodes) {
    return {};
  }
  return deepClone(globalNodes);
};

export const cloneVoiceLayout = (voice: VoiceLayout): VoiceLayout =>
  deepClone(voice);

export function synthLayoutToPatchLayout(layout: SynthLayout): PatchLayout {
  if (!layout.voices || layout.voices.length === 0) {
    throw new Error('Synth layout must contain at least one voice');
  }

  const canonicalSource = layout.canonicalVoice ?? layout.voices[0]!;

  return {
    voiceCount: layout.voiceCount ?? layout.voices.length,
    canonicalVoice: cloneVoiceLayout(canonicalSource),
    globalNodes: cloneGlobalNodes(layout.globalNodes),
    metadata: layout.metadata ? { ...layout.metadata } : undefined,
  };
}

export function patchLayoutToSynthLayout(layout: PatchLayout): SynthLayout {
  const canonicalSource =
    layout.canonicalVoice ??
    (layout.voices && layout.voices.length > 0 ? layout.voices[0] : undefined);

  if (!canonicalSource) {
    throw new Error('Patch layout missing canonical voice definition');
  }

  const canonicalVoice = cloneVoiceLayout(canonicalSource);
  const fallbackCount = layout.voices?.length ?? 1;
  const resolvedVoiceCount = Math.max(
    1,
    layout.voiceCount && layout.voiceCount > 0
      ? layout.voiceCount
      : fallbackCount,
  );

  const voices =
    layout.voices && layout.voices.length > 0
      ? layout.voices.map((voice, index) => {
          const clone = cloneVoiceLayout(voice);
          clone.id = index;
          return clone;
        })
      : Array.from({ length: resolvedVoiceCount }, (_, index) => {
          const clone = cloneVoiceLayout(canonicalVoice);
          clone.id = index;
          return clone;
        });

  return {
    voices,
    globalNodes: cloneGlobalNodes(layout.globalNodes),
    metadata: layout.metadata ? { ...layout.metadata } : undefined,
    voiceCount: resolvedVoiceCount,
    canonicalVoice,
  };
}

// Helper functions
export const getNodesOfType = (
  voice: VoiceLayout,
  type: VoiceNodeType,
): VoiceNode[] => {
  return voice.nodes[type] || [];
};

export interface RawNode {
  id: string;
  node_type: string;
  name: string;
}

export interface RawConnection {
  from_id: string;
  to_id: string;
  target: number;
  amount: number;
  modulation_type: number | string; // Can be number from Rust (0,1,2) or string from TypeScript
  modulation_transform: ModulationTransformation;
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
  id: string,
): VoiceNode | undefined => {
  return Object.values(voice.nodes)
    .flat()
    .find((node) => node.id === id);
};

export const findNodeConnections = (
  voice: VoiceLayout,
  nodeId: string,
): NodeConnection[] => {
  return voice.connections.filter(
    (conn) => conn.fromId === nodeId || conn.toId === nodeId,
  );
};

export function convertRawModulationType(raw: number | string): WasmModulationType {
  // Handle numeric values from Rust (0=VCA, 1=Bipolar, 2=Additive)
  if (typeof raw === 'number') {
    switch (raw) {
      case 0:
        return WasmModulationType.VCA;
      case 1:
        return WasmModulationType.Bipolar;
      case 2:
        return WasmModulationType.Additive;
      default:
        console.warn('Unknown numeric modulation type:', raw);
        return WasmModulationType.Additive;
    }
  }
  // Handle string values
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
  sourceId: string,
): Array<{
  nodeId: string;
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

export function getModulationTargetsForType(
  type: VoiceNodeType,
): ModulationTargetOption[] {
  switch (type) {
    case VoiceNodeType.WavetableOscillator:
      return [
        { value: PortId.DetuneMod, label: PORT_LABELS[PortId.DetuneMod] },
        {
          value: PortId.WavetableIndex,
          label: PORT_LABELS[PortId.WavetableIndex],
        },
        { value: PortId.ModIndex, label: PORT_LABELS[PortId.ModIndex] },
        { value: PortId.GainMod, label: PORT_LABELS[PortId.GainMod] },
        { value: PortId.PhaseMod, label: PORT_LABELS[PortId.PhaseMod] },
        { value: PortId.FeedbackMod, label: PORT_LABELS[PortId.FeedbackMod] },
        { value: PortId.FrequencyMod, label: PORT_LABELS[PortId.FrequencyMod] },
      ];
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
        { value: PortId.GainMod, label: PORT_LABELS[PortId.GainMod] },
        { value: PortId.CutoffMod, label: PORT_LABELS[PortId.CutoffMod] },
      ];
    case VoiceNodeType.Sampler:
      return [
        { value: PortId.FrequencyMod, label: PORT_LABELS[PortId.FrequencyMod] },
        { value: PortId.GainMod, label: PORT_LABELS[PortId.GainMod] },
        { value: PortId.StereoPan, label: PORT_LABELS[PortId.StereoPan] },
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
    case VoiceNodeType.Envelope:
      return [
        { value: PortId.AttackMod, label: PORT_LABELS[PortId.AttackMod] },
        { value: PortId.GainMod, label: PORT_LABELS[PortId.GainMod] },
      ];
    case VoiceNodeType.GlobalFrequency:
      return [
        { value: PortId.DetuneMod, label: PORT_LABELS[PortId.DetuneMod] },
      ];
    default:
      return [];
  }
}

export function createNodeConnection(
  fromId: string,
  toId: string,
  target: PortId,
  amount: number,
  modulationType: WasmModulationType,
  modulationTransformation: ModulationTransformation,
): NodeConnection {
  return {
    fromId,
    toId,
    target,
    amount,
    modulationType,
    modulationTransformation,
  };
}
