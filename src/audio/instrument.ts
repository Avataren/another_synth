import { createStandardAudioWorklet } from './audio-processor-loader';
import { type EnvelopeConfig } from './dsp/envelope';
import { type FilterState } from './dsp/filter-state';
// import { type NoiseState } from './dsp/noise-generator';
import type OscillatorState from './models/OscillatorState';
import {
  type SynthLayout,
  type NodeConnection,
  // type VoiceLayout,
  VoiceNodeType,
  type ModulationTarget,
  type LfoState
} from './types/synth-layout';

export default class Instrument {
  readonly num_voices = 8;
  outputNode: AudioNode;
  workletNode: AudioWorkletNode | null = null;
  private activeNotes: Map<number, number> = new Map(); // midi note -> voice index
  private voiceLastUsedTime: number[] = []; // Track when each voice was last used
  private ready = false;
  private synthLayout: SynthLayout | null = null;

  constructor(
    destination: AudioNode,
    private audioContext: AudioContext,
    memory: WebAssembly.Memory,
  ) {
    this.outputNode = audioContext.createGain();
    (this.outputNode as GainNode).gain.value = 0.25;
    this.outputNode.connect(destination);
    this.voiceLastUsedTime = new Array(this.num_voices).fill(0);
    this.setupAudio(memory);
  }

  private async setupAudio(_memory: WebAssembly.Memory) {
    try {
      this.workletNode = await createStandardAudioWorklet(this.audioContext);

      // Set up parameters for each voice
      for (let i = 0; i < this.num_voices; i++) {
        const gateParam = this.workletNode.parameters.get(`gate_${i}`);
        if (gateParam) gateParam.value = 0;

        const freqParam = this.workletNode.parameters.get(`frequency_${i}`);
        if (freqParam) freqParam.value = 440;

        const gainParam = this.workletNode.parameters.get(`gain_${i}`);
        if (gainParam) gainParam.value = 1;
      }

      this.workletNode.connect(this.outputNode);
      this.ready = true;
      console.log('Audio setup completed successfully');
    } catch (error) {
      console.error('Failed to set up audio:', error);
    }
  }

  public updateLayout(layout: SynthLayout) {
    this.synthLayout = layout;
    console.log('Updated synth layout:', layout);
  }

  public updateOscillatorState(nodeId: number, newState: OscillatorState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;

    // Find which voice this oscillator belongs to
    const voiceIndex = this.findVoiceForNode(nodeId);
    if (voiceIndex === -1) return;
    this.workletNode.port.postMessage({
      type: 'updateOscillator',
      voiceIndex,
      oscillatorId: nodeId,
      newState,
    });
  }

  public updateLfoState(nodeId: number, state: LfoState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;

    const voiceIndex = this.findVoiceForNode(nodeId);
    if (voiceIndex === -1) return;

    this.workletNode.port.postMessage({
      type: 'updateLfo',
      voiceIndex,
      lfoId: nodeId,
      params: {
        lfoId: nodeId,
        frequency: state.frequency,
        waveform: state.waveform,
        useAbsolute: state.useAbsolute,
        useNormalized: state.useNormalized,
        triggerMode: state.triggerMode,
        active: state.active  // Add the active state
      }
    });
  }

  public async getLfoWaveform(waveform: number, bufferSize: number): Promise<Float32Array> {
    if (!this.ready || !this.workletNode) {
      throw new Error('Audio system not ready');
    }

    return new Promise<Float32Array>((resolve, reject) => {
      const handleMessage = (e: MessageEvent) => {
        if (e.data.type === 'lfoWaveform') {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(e.data.waveform));
        } else if (e.data.type === 'error' && e.data.source === 'getLfoWaveform') {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          reject(new Error(e.data.message));
        }
      };

      this.workletNode?.port.addEventListener('message', handleMessage);

      this.workletNode?.port.postMessage({
        type: 'getLfoWaveform',
        waveform,
        bufferSize
      });

      // Add timeout to prevent hanging
      setTimeout(() => {
        this.workletNode?.port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for waveform data'));
      }, 1000);
    });
  }

  public updateEnvelopeState(nodeId: number, newState: EnvelopeConfig) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;

    const voiceIndex = this.findVoiceForNode(nodeId);
    if (voiceIndex === -1) return;

    this.workletNode.port.postMessage({
      type: 'updateEnvelope',
      voiceIndex,
      envelopeId: nodeId,
      config: newState,
    });
  }

  public updateFilterState(nodeId: number, newState: FilterState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;

    const voiceIndex = this.findVoiceForNode(nodeId);
    if (voiceIndex === -1) return;

    this.workletNode.port.postMessage({
      type: 'updateFilter',
      voiceIndex,
      filterId: nodeId,
      config: newState,
    });
  }

  public updateConnection(voiceIndex: number, connection: NodeConnection) {
    if (!this.ready || !this.workletNode) return;

    this.workletNode.port.postMessage({
      type: 'updateConnection',
      voiceIndex,
      connection,
    });
  }

  public createModulation(
    sourceId: number,
    targetId: number,
    target: ModulationTarget,
    amount: number
  ): void {
    if (!this.ready || !this.workletNode) return;

    // Apply the modulation to all voices
    for (let voiceIndex = 0; voiceIndex < this.num_voices; voiceIndex++) {
      this.workletNode.port.postMessage({
        type: 'updateConnection',
        voiceIndex,
        connection: {
          fromId: sourceId,
          toId: targetId,
          target,
          amount,
        },
      });
    }
  }

  public createModulationForVoice(
    voiceIndex: number,
    sourceId: number,
    targetId: number,
    target: ModulationTarget,
    amount: number
  ) {
    const connection: NodeConnection = {
      fromId: sourceId,
      toId: targetId,
      target,
      amount
    };
    this.updateConnection(voiceIndex, connection);
  }

  public note_on(midi_note: number, velocity: number) {
    if (!this.ready || !this.workletNode) return;

    if (this.activeNotes.has(midi_note)) {
      this.note_off(midi_note);
    }

    const voiceIndex = this.findFreeVoice();
    if (voiceIndex !== -1) {
      const frequency = this.midiNoteToFrequency(midi_note);

      const freqParam = this.workletNode.parameters.get(`frequency_${voiceIndex}`);
      const gateParam = this.workletNode.parameters.get(`gate_${voiceIndex}`);
      const gainParam = this.workletNode.parameters.get(`gain_${voiceIndex}`);

      if (freqParam && gateParam && gainParam) {
        freqParam.setValueAtTime(frequency, this.audioContext.currentTime);
        gateParam.setValueAtTime(0.0, this.audioContext.currentTime);
        gateParam.setValueAtTime(1.0, this.audioContext.currentTime + 0.005);
        gainParam.setValueAtTime(velocity / 127, this.audioContext.currentTime);
      }

      this.activeNotes.set(midi_note, voiceIndex);
      this.voiceLastUsedTime[voiceIndex] = performance.now();
    }
  }

  public note_off(midi_note: number) {
    if (!this.ready || !this.workletNode) return;

    const voiceIndex = this.activeNotes.get(midi_note);
    if (voiceIndex !== undefined) {
      const gateParam = this.workletNode.parameters.get(`gate_${voiceIndex}`);
      if (gateParam) {
        gateParam.setValueAtTime(0.0, this.audioContext.currentTime);
      }
      this.activeNotes.delete(midi_note);
    }
  }

  private findVoiceForNode(nodeId: number): number {
    if (!this.synthLayout) return -1;

    for (let i = 0; i < this.synthLayout.voices.length; i++) {
      const voice = this.synthLayout.voices[i]!;
      // Check all node types
      for (const nodeType of Object.values(VoiceNodeType)) {
        if (voice.nodes[nodeType]?.some(node => node.id === nodeId)) {
          return i;
        }
      }
    }
    return -1;
  }

  private findFreeVoice(): number {
    const usedVoiceIndices = new Set(this.activeNotes.values());

    // Find the oldest free voice
    let oldestFreeVoiceIndex = -1;
    let oldestFreeVoiceTime = Infinity;

    for (let i = 0; i < this.num_voices; i++) {
      if (!usedVoiceIndices.has(i)) {
        if (this.voiceLastUsedTime[i]! < oldestFreeVoiceTime) {
          oldestFreeVoiceTime = this.voiceLastUsedTime[i]!;
          oldestFreeVoiceIndex = i;
        }
      }
    }

    if (oldestFreeVoiceIndex !== -1) {
      return oldestFreeVoiceIndex;
    }

    // If no free voice is available, steal the oldest active voice
    let oldestActiveVoiceIndex = -1;
    let oldestActiveVoiceTime = Infinity;

    for (const voiceIndex of this.activeNotes.values()) {
      if (this.voiceLastUsedTime[voiceIndex]! < oldestActiveVoiceTime) {
        oldestActiveVoiceTime = this.voiceLastUsedTime[voiceIndex]!;
        oldestActiveVoiceIndex = voiceIndex;
      }
    }

    if (oldestActiveVoiceIndex !== -1) {
      for (const [noteToRelease, voiceIndex] of this.activeNotes) {
        if (voiceIndex === oldestActiveVoiceIndex) {
          this.note_off(noteToRelease);
          break;
        }
      }
      return oldestActiveVoiceIndex;
    }

    return -1;
  }

  private midiNoteToFrequency(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12);
  }
}