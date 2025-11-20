import type OscillatorState from 'src/audio/models/OscillatorState';
import type {
  ChorusState,
  ConvolverState,
  DelayState,
  EnvelopeConfig,
  FilterState,
  LfoState,
  ReverbState,
  SamplerState,
  SynthLayout,
  VelocityState,
} from 'src/audio/types/synth-layout';
import type { NoiseState } from 'src/audio/types/noise';
import { useAudioSystemStore } from './audio-system-store';

export interface NodeStateSnapshot {
  oscillatorStates: Map<string, OscillatorState>;
  wavetableOscillatorStates: Map<string, OscillatorState>;
  samplerStates: Map<string, SamplerState>;
  samplerWaveforms: Map<string, Float32Array>;
  envelopeStates: Map<string, EnvelopeConfig>;
  convolverStates: Map<string, ConvolverState>;
  delayStates: Map<string, DelayState>;
  filterStates: Map<string, FilterState>;
  lfoStates: Map<string, LfoState>;
  chorusStates: Map<string, ChorusState>;
  reverbStates: Map<string, ReverbState>;
  noiseState: NoiseState;
  velocityState: VelocityState;
}

function clonePlainObject<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneStateMap<T>(map: Map<string, T>): Map<string, T> {
  return new Map(
    Array.from(map.entries()).map(([key, value]) => [
      key,
      clonePlainObject(value),
    ]),
  );
}

function cloneFloat32Map(map: Map<string, Float32Array>): Map<string, Float32Array> {
  return new Map(
    Array.from(map.entries()).map(([key, value]) => [key, value.slice()]),
  );
}

export function mirrorLayoutToLegacyStore(layout: SynthLayout | null): void {
  const audioStore = useAudioSystemStore();
  audioStore.synthLayout = layout ? clonePlainObject(layout) : null;
}

export function mirrorNodeStatesToLegacyStore(snapshot: NodeStateSnapshot): void {
  const audioStore = useAudioSystemStore();
  audioStore.oscillatorStates = cloneStateMap(snapshot.oscillatorStates);
  audioStore.wavetableOscillatorStates = cloneStateMap(
    snapshot.wavetableOscillatorStates,
  );
  audioStore.samplerStates = cloneStateMap(snapshot.samplerStates);
  audioStore.samplerWaveforms = cloneFloat32Map(snapshot.samplerWaveforms);
  audioStore.envelopeStates = cloneStateMap(snapshot.envelopeStates);
  audioStore.convolverStates = cloneStateMap(snapshot.convolverStates);
  audioStore.delayStates = cloneStateMap(snapshot.delayStates);
  audioStore.filterStates = cloneStateMap(snapshot.filterStates);
  audioStore.lfoStates = cloneStateMap(snapshot.lfoStates);
  audioStore.chorusStates = cloneStateMap(snapshot.chorusStates);
  audioStore.reverbStates = cloneStateMap(snapshot.reverbStates);
  audioStore.noiseState = clonePlainObject(snapshot.noiseState);
  audioStore.velocityState = clonePlainObject(snapshot.velocityState);
}
