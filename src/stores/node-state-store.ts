import { defineStore } from 'pinia';
import type OscillatorState from 'src/audio/models/OscillatorState';
import {
  FilterSlope,
  FilterType,
  SamplerLoopMode,
  SamplerTriggerMode,
  VoiceNodeType,
  type ChorusState,
  type ConvolverState,
  type DelayState,
  type EnvelopeConfig,
  type FilterState,
  type LfoState,
  type ReverbState,
  type SamplerState,
  type VelocityState,
  getNodesOfType,
} from 'src/audio/types/synth-layout';
import { NoiseType, type NoiseState } from 'src/audio/types/noise';
import { useLayoutStore } from './layout-store';
import { useInstrumentStore } from './instrument-store';
import {
  BASE_SAMPLER_TUNING_FREQUENCY,
  normalizeSamplerState,
  frequencyFromDetune,
  combineDetuneParts,
} from 'src/audio/utils/sampler-detune';

const DEFAULT_SAMPLE_RATE = 44100;

function createDefaultSamplerState(id: string): SamplerState {
  return normalizeSamplerState({
    id,
    frequency: BASE_SAMPLER_TUNING_FREQUENCY,
    gain: 1.0,
    detune_oct: 0,
    detune_semi: 0,
    detune_cents: 0,
    detune: 0,
    loopMode: SamplerLoopMode.Off,
    loopStart: 0,
    loopEnd: 1,
    sampleLength: DEFAULT_SAMPLE_RATE,
    rootNote: 60,
    triggerMode: SamplerTriggerMode.Gate,
    active: true,
    sampleRate: DEFAULT_SAMPLE_RATE,
    channels: 1,
  });
}

export const useNodeStateStore = defineStore('nodeStateStore', {
  state: () => ({
    oscillatorStates: new Map<string, OscillatorState>(),
    wavetableOscillatorStates: new Map<string, OscillatorState>(),
    samplerStates: new Map<string, SamplerState>(),
    samplerWaveforms: new Map<string, Float32Array>(),
    envelopeStates: new Map<string, EnvelopeConfig>(),
    convolverStates: new Map<string, ConvolverState>(),
    delayStates: new Map<string, DelayState>(),
    filterStates: new Map<string, FilterState>(),
    lfoStates: new Map<string, LfoState>(),
    chorusStates: new Map<string, ChorusState>(),
    reverbStates: new Map<string, ReverbState>(),
    noiseState: {
      noiseType: NoiseType.White,
      cutoff: 1.0,
      gain: 1.0,
      is_enabled: false,
    } as NoiseState,
    velocityState: {
      sensitivity: 1.0,
      randomize: 0.0,
      active: true,
    } as VelocityState,
  }),
  actions: {
    initializeDefaultStates() {
      const layoutStore = useLayoutStore();
      const voice = layoutStore.synthLayout?.voices[0];
      if (!voice) return;

      this.samplerStates.forEach((state, nodeId) => {
        this.samplerStates.set(
          nodeId,
          normalizeSamplerState({
            ...state,
            id: nodeId,
          }),
        );
      });

      const validNodeIds = new Set<string>();
      Object.values(voice.nodes).forEach((nodeArray) => {
        nodeArray.forEach((node) => validNodeIds.add(node.id));
      });

      const prune = (map: Map<string, unknown>) => {
        map.forEach((_, id) => {
          if (!validNodeIds.has(id)) {
            map.delete(id);
          }
        });
      };

      prune(this.oscillatorStates);
      prune(this.wavetableOscillatorStates);
      prune(this.samplerStates);
      prune(this.envelopeStates);
      prune(this.lfoStates);
      prune(this.filterStates);
      prune(this.convolverStates);
      prune(this.delayStates);
      prune(this.chorusStates);
      prune(this.reverbStates);

      getNodesOfType(voice, VoiceNodeType.Oscillator)?.forEach((node) => {
        if (!this.oscillatorStates.has(node.id)) {
          this.oscillatorStates.set(node.id, {
            id: node.id,
            detune_oct: 0,
            detune_cents: 0,
            detune_semi: 0,
            waveform: 0,
            gain: 0.5,
            phase_mod_amount: 0,
            freq_mod_amount: 0,
            detune: 0,
            hard_sync: false,
            active: true,
            feedback_amount: 0,
            unison_voices: 1,
            spread: 0,
            wave_index: 0,
          });
        }
      });

      getNodesOfType(voice, VoiceNodeType.WavetableOscillator)?.forEach(
        (node) => {
          if (!this.wavetableOscillatorStates.has(node.id)) {
            this.wavetableOscillatorStates.set(node.id, {
              id: node.id,
              detune_oct: 0,
              detune_cents: 0,
              detune_semi: 0,
              waveform: 0,
              gain: 0.5,
              phase_mod_amount: 0,
              freq_mod_amount: 0,
              detune: 0,
              hard_sync: false,
              active: true,
              feedback_amount: 0,
              unison_voices: 1,
              spread: 0,
              wave_index: 0,
            });
          }
        },
      );

      getNodesOfType(voice, VoiceNodeType.Sampler)?.forEach((node) => {
        if (!this.samplerStates.has(node.id)) {
          this.samplerStates.set(node.id, createDefaultSamplerState(node.id));
        }
      });

      getNodesOfType(voice, VoiceNodeType.Envelope)?.forEach((node) => {
        if (!this.envelopeStates.has(node.id)) {
          this.envelopeStates.set(node.id, {
            id: node.id,
            attack: 0.0,
            decay: 0.1,
            sustain: 0.5,
            release: 0.1,
            active: true,
            attackCurve: 0,
            decayCurve: 0,
            releaseCurve: 0,
          });
        }
      });

      getNodesOfType(voice, VoiceNodeType.LFO)?.forEach((node) => {
        if (!this.lfoStates.has(node.id)) {
          this.lfoStates.set(node.id, {
            id: node.id,
            frequency: 1.0,
            waveform: 0,
            phaseOffset: 0.0,
            useAbsolute: false,
            useNormalized: false,
            triggerMode: 0,
            gain: 1.0,
            active: true,
            loopMode: 0.0,
            loopStart: 0.5,
            loopEnd: 1.0,
          });
        }
      });

      getNodesOfType(voice, VoiceNodeType.Filter)?.forEach((node) => {
        if (!this.filterStates.has(node.id)) {
          this.filterStates.set(node.id, {
            id: node.id,
            cutoff: 20000,
            resonance: 0,
            keytracking: 0,
            comb_frequency: 220,
            comb_dampening: 0.5,
            oversampling: 0,
            gain: 0.5,
            filter_type: FilterType.LowPass,
            filter_slope: FilterSlope.Db12,
            active: true,
          });
        }
      });

    },
    resetCurrentStateToDefaults(applyToWasm = true) {
      this.oscillatorStates = new Map();
      this.wavetableOscillatorStates = new Map();
      this.samplerStates = new Map();
      this.samplerWaveforms = new Map();
      this.envelopeStates = new Map();
      this.convolverStates = new Map();
      this.delayStates = new Map();
      this.filterStates = new Map();
      this.lfoStates = new Map();
      this.chorusStates = new Map();
      this.reverbStates = new Map();
      this.noiseState = {
        noiseType: NoiseType.White,
        cutoff: 1.0,
        gain: 1.0,
        is_enabled: false,
      };
      this.velocityState = {
        sensitivity: 1.0,
        randomize: 0.0,
        active: true,
      };

      this.initializeDefaultStates();
      if (applyToWasm) {
        this.applyPreservedStatesToWasm();
      }
    },
    applyPreservedStatesToWasm() {
      const instrument = useInstrumentStore().currentInstrument;
      if (!instrument) return;

      this.oscillatorStates.forEach((state, nodeId) => {
        instrument.updateOscillatorState(nodeId, {
          ...state,
          id: nodeId,
        });
      });

      this.wavetableOscillatorStates.forEach((state, nodeId) => {
        instrument.updateWavetableOscillatorState(nodeId, {
          ...state,
          id: nodeId,
        });
      });

      this.envelopeStates.forEach((state, nodeId) => {
        instrument.updateEnvelopeState(nodeId, {
          ...state,
          id: nodeId,
        });
      });

      this.lfoStates.forEach((state, nodeId) => {
        instrument.updateLfoState(nodeId, {
          id: nodeId,
          frequency: state.frequency,
          phaseOffset: state.phaseOffset || 0.0,
          waveform: state.waveform,
          useAbsolute: state.useAbsolute,
          useNormalized: state.useNormalized,
          triggerMode: state.triggerMode,
          gain: state.gain,
          active: state.active,
          loopMode: state.loopMode,
          loopStart: state.loopStart,
          loopEnd: state.loopEnd,
        });
      });

      this.filterStates.forEach((state, nodeId) => {
        instrument.updateFilterState(nodeId, {
          ...state,
          id: nodeId,
        });
      });

      this.convolverStates.forEach((state, nodeId) => {
        if (instrument.updateConvolverState) {
          instrument.updateConvolverState(nodeId, {
            ...state,
            id: nodeId,
          });
        }
      });

      this.delayStates.forEach((state, nodeId) => {
        if (instrument.updateDelayState) {
          instrument.updateDelayState(nodeId, {
            ...state,
            id: nodeId,
          });
        }
      });

      this.chorusStates.forEach((state, nodeId) => {
        if (instrument.updateChorusState) {
          instrument.updateChorusState(nodeId, {
            ...state,
            id: nodeId,
          });
        }
      });

      this.samplerStates.forEach((_state, nodeId) => {
        this.sendSamplerState(nodeId);
      });
    },
    updateSampler(nodeId: string, patch: Partial<SamplerState>) {
      const current =
        this.samplerStates.get(nodeId) || createDefaultSamplerState(nodeId);
      const merged: SamplerState = {
        ...current,
        ...patch,
        id: nodeId,
      };
      const normalized = normalizeSamplerState(merged);
      this.samplerStates.set(nodeId, normalized);
      this.sendSamplerState(nodeId);
    },
    setSamplerSampleInfo(
      nodeId: string,
      info: { sampleLength: number; sampleRate: number; channels: number; fileName?: string },
    ) {
      const current =
        this.samplerStates.get(nodeId) || createDefaultSamplerState(nodeId);
      const safeLength = info.sampleLength || current.sampleLength;
      const updated: SamplerState = {
        ...current,
        sampleLength: safeLength,
        sampleRate: info.sampleRate || current.sampleRate,
        channels:
          typeof info.channels === 'number' ? info.channels : current.channels,
        loopEnd: safeLength > 0 ? 1 : current.loopEnd,
      };
      if (info.fileName !== undefined) {
        updated.fileName = info.fileName;
      }
      this.samplerStates.set(nodeId, updated);
      this.sendSamplerState(nodeId);
      void this.fetchSamplerWaveform(nodeId);
    },
    async fetchSamplerWaveform(nodeId: string, maxPoints = 512) {
      const instrument = useInstrumentStore().currentInstrument;
      if (!instrument) return;
      try {
        const waveform = await instrument.getSamplerWaveform(nodeId, maxPoints);
        this.samplerWaveforms.set(nodeId, waveform);
      } catch (error) {
        console.error('Failed to fetch sampler waveform', error);
      }
    },
    buildSamplerUpdatePayload(state: SamplerState) {
      const sampleLength = Math.max(1, state.sampleLength || DEFAULT_SAMPLE_RATE);
      const loopStartNorm = Math.min(Math.max(state.loopStart ?? 0, 0), 1);
      const requestedEnd = Math.min(Math.max(state.loopEnd ?? 1, 0), 1);
      const minDelta = 1 / sampleLength;
      const loopEndNorm =
        requestedEnd <= loopStartNorm + minDelta
          ? Math.min(1, loopStartNorm + minDelta)
          : requestedEnd;
      const detuneCents =
        state.detune ??
        combineDetuneParts(
          state.detune_oct ?? 0,
          state.detune_semi ?? 0,
          state.detune_cents ?? 0,
        );
      const tuningFrequency = frequencyFromDetune(detuneCents);

      return {
        frequency: tuningFrequency,
        gain: state.gain,
        loopMode: state.loopMode,
        loopStart: loopStartNorm * sampleLength,
        loopEnd: loopEndNorm * sampleLength,
        rootNote: state.rootNote,
        triggerMode: state.triggerMode,
        active: state.active,
      };
    },
    sendSamplerState(nodeId: string) {
      const instrument = useInstrumentStore().currentInstrument;
      if (!instrument) return;
      const state = this.samplerStates.get(nodeId);
      if (!state) return;
      const payload = this.buildSamplerUpdatePayload(state);
      instrument.updateSamplerState(nodeId, payload);
    },
    assignStatesFromPatch(deserialized: {
      oscillators: Map<string, OscillatorState>;
      wavetableOscillators: Map<string, OscillatorState>;
      filters: Map<string, FilterState>;
      envelopes: Map<string, EnvelopeConfig>;
      lfos: Map<string, LfoState>;
      samplers: Map<string, SamplerState>;
      convolvers: Map<string, ConvolverState>;
      delays: Map<string, DelayState>;
      choruses: Map<string, ChorusState>;
      reverbs: Map<string, ReverbState>;
      noise?: NoiseState;
      velocity?: VelocityState;
    }) {
      this.oscillatorStates = deserialized.oscillators;
      this.wavetableOscillatorStates = deserialized.wavetableOscillators;
      this.filterStates = deserialized.filters;
      this.envelopeStates = deserialized.envelopes;
      this.lfoStates = deserialized.lfos;
      this.samplerStates = new Map(
        Array.from(deserialized.samplers.entries()).map(([nodeId, state]) => [
          nodeId,
          normalizeSamplerState({
            ...state,
            id: nodeId,
          }),
        ]),
      );
      this.convolverStates = deserialized.convolvers;
      this.delayStates = deserialized.delays;
      this.chorusStates = deserialized.choruses;
      this.reverbStates = deserialized.reverbs;
      if (deserialized.noise) {
        this.noiseState = deserialized.noise;
      }
      if (deserialized.velocity) {
        this.velocityState = deserialized.velocity;
      }
    },
    removeStatesForNode(nodeId: string) {
      this.oscillatorStates.delete(nodeId);
      this.wavetableOscillatorStates.delete(nodeId);
      this.envelopeStates.delete(nodeId);
      this.lfoStates.delete(nodeId);
      this.filterStates.delete(nodeId);
      this.delayStates.delete(nodeId);
      this.convolverStates.delete(nodeId);
      this.chorusStates.delete(nodeId);
      this.samplerStates.delete(nodeId);
      this.samplerWaveforms.delete(nodeId);
      this.reverbStates.delete(nodeId);
    },
  },
});
