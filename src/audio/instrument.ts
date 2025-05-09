// import { type PortId } from 'app/public/wasm/audio_processor';
import { type Wavetable } from 'src/components/WaveTable/WavetableUtils';
import { createStandardAudioWorklet } from './audio-processor-loader';
// import { type FilterState } from './dsp/filter-state';
// import { type NoiseState } from './dsp/noise-generator';
import type OscillatorState from './models/OscillatorState';
import { type NoiseState, type NoiseUpdate } from './types/noise';
import type {
  ChorusState,
  ConvolverState,
  DelayState,
  EnvelopeConfig,
  ReverbState,
  VelocityState,
} from './types/synth-layout';
import {
  type SynthLayout,
  // type NodeConnection,
  // type VoiceLayout,
  VoiceNodeType,
  type LfoState,
  type NodeConnectionUpdate,
  type FilterState,
} from './types/synth-layout';

// interface ConnectionUpdateMessage {
//   type: 'updateConnection';
//   voiceIndex: number;
//   connection: {
//     fromId: number;
//     toId: number;
//     target: PortId;
//     amount: number;
//     isRemoving?: boolean;
//   };
//   oldTarget?: PortId;
// }

export default class Instrument {
  readonly num_voices = 8;
  outputNode: AudioNode;
  workletNode: AudioWorkletNode | null = null;
  private activeNotes: Map<number, number> = new Map(); // midi note -> voice index
  private voiceLastUsedTime: number[] = []; // Track when each voice was last used
  private ready = false;
  private synthLayout: SynthLayout | null = null;

  public get isReady(): boolean {
    return this.ready;
  }

  constructor(
    destination: AudioNode,
    private audioContext: AudioContext,
    memory: WebAssembly.Memory,
  ) {
    this.outputNode = audioContext.createGain();
    (this.outputNode as GainNode).gain.value = 0.5;
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

  public deleteNode(nodeId: number) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;
    this.workletNode.port.postMessage({
      type: 'deleteNode',
      nodeId: nodeId,
    });
  }

  public createNode(node: VoiceNodeType) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;
    this.workletNode.port.postMessage({
      type: 'createNode',
      node: node,
    });
  }

  public updateReverbState(nodeId: number, state: ReverbState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;
    this.workletNode.port.postMessage({
      type: 'updateReverb',
      nodeId: nodeId,
      state: state,
    });
  }

  public updateChorusState(nodeId: number, state: ChorusState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;
    this.workletNode.port.postMessage({
      type: 'updateChorus',
      nodeId: nodeId,
      state: state,
    });
  }

  public updateVelocityState(nodeId: number, state: VelocityState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;
    this.workletNode.port.postMessage({
      type: 'updateVelocity',
      noiseId: nodeId,
      config: {
        sensitivity: state.sensitivity,
        randomize: state.randomize,
        active: state.active,
      } as VelocityState,
    });
  }

  public updateNoiseState(nodeId: number, state: NoiseState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;

    this.workletNode.port.postMessage({
      type: 'updateNoise',
      noiseId: nodeId,
      config: {
        noise_type: state.noiseType,
        cutoff: state.cutoff,
        gain: state.gain || 1.0,
        enabled: state.is_enabled,
      } as NoiseUpdate,
    });
  }

  public importWavetableData(nodeId: number, wavData: Uint8Array): void {
    if (!this.ready || !this.workletNode) {
      console.error('Audio system not ready for importing wavetable data');
      return;
    }
    // Send the WAV data to the audio worklet.
    // Transfer the underlying ArrayBuffer to avoid copying.
    this.workletNode.port.postMessage({
      type: 'importWavetable',
      // Using wavData.buffer transfers the ArrayBuffer
      nodeId,
      data: wavData.buffer,
    });
    console.log('Sent wavetable data to worklet');
  }

  public importImpulseWaveformData(nodeId: number, wavData: Uint8Array): void {
    if (!this.ready || !this.workletNode) {
      console.error('Audio system not ready for importing wavetable data');
      return;
    }
    // Send the WAV data to the audio worklet.
    // Transfer the underlying ArrayBuffer to avoid copying.
    this.workletNode.port.postMessage({
      type: 'importImpulseWaveform',
      // Using wavData.buffer transfers the ArrayBuffer
      nodeId,
      data: wavData.buffer,
    });
    console.log('Sent wavetable data to worklet');
  }

  public updateDelayState(nodeId: number, newState: DelayState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;
    this.workletNode.port.postMessage({
      type: 'updateDelayState',
      nodeId: nodeId,
      state: newState,
    });
  }

  public updateConvolverState(nodeId: number, newState: ConvolverState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;
    this.workletNode.port.postMessage({
      type: 'updateConvolverState',
      nodeId: nodeId,
      state: newState,
    });
  }

  public updateWavetableOscillatorState(
    nodeId: number,
    newState: OscillatorState,
  ) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;

    // Find which voice this oscillator belongs to
    // const voiceIndex = this.findVoiceForNode(nodeId);
    this.workletNode.port.postMessage({
      type: 'updateWavetableOscillator',
      oscillatorId: nodeId,
      newState,
    });
  }

  public updateOscillatorState(nodeId: number, newState: OscillatorState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;
    console.log('### updateOscillatorState', nodeId, newState);
    // Find which voice this oscillator belongs to
    // const voiceIndex = this.findVoiceForNode(nodeId);
    this.workletNode.port.postMessage({
      type: 'updateOscillator',
      oscillatorId: nodeId,
      newState,
    });
  }

  public updateLfoState(nodeId: number, state: LfoState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;
    // const voiceIndex = this.findVoiceForNode(nodeId);
    // if (voiceIndex === -1) return;
    this.workletNode.port.postMessage({
      type: 'updateLfo',
      lfoId: nodeId,
      params: {
        lfoId: nodeId,
        frequency: state.frequency,
        phaseOffset: state.phaseOffset,
        waveform: state.waveform,
        useAbsolute: state.useAbsolute,
        useNormalized: state.useNormalized,
        triggerMode: state.triggerMode,
        gain: state.gain,
        active: state.active, // Add the active state
        loopMode: state.loopMode,
        loopStart: state.loopStart,
        loopEnd: state.loopEnd,
      },
    });
  }

  public async getWasmNodeConnections(): Promise<string> {
    if (!this.ready || !this.workletNode) {
      throw new Error('Audio system not ready');
    }
    console.log('#### getWasmNodeConnections');
    return new Promise<string>((resolve, reject) => {
      const messageId = Date.now().toString();
      // Initialize with a dummy value that we'll clear later
      let timeoutId = setTimeout(() => { }, 0);

      const handleMessage = (e: MessageEvent) => {
        if (e.data.type === 'nodeLayout' && e.data.messageId === messageId) {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          clearTimeout(timeoutId);
          resolve(e.data.layout);
        } else if (e.data.type === 'error' && e.data.messageId === messageId) {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          clearTimeout(timeoutId);
          reject(new Error(e.data.message));
        }
      };

      this.workletNode!.port.addEventListener('message', handleMessage);

      // Send request with ID
      this.workletNode!.port.postMessage({
        type: 'getNodeLayout',
        messageId: messageId,
      });

      // Clear the initial timeout and set the real one
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        this.workletNode?.port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for node layout data'));
      }, 5000);
    });
  }

  public async getEnvelopePreview(
    config: EnvelopeConfig,
    previewDuration: number,
  ): Promise<Float32Array> {
    if (!this.ready || !this.workletNode) {
      throw new Error('Audio system not ready');
    }

    return new Promise<Float32Array>((resolve, reject) => {
      const handleMessage = (e: MessageEvent) => {
        if (
          e.data.type === 'envelopePreview' &&
          e.data.source === 'getEnvelopePreview'
        ) {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(e.data.preview));
        } else if (
          e.data.type === 'error' &&
          e.data.source === 'getEnvelopePreview'
        ) {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          reject(new Error(e.data.message));
        }
      };

      this.workletNode?.port.addEventListener('message', handleMessage);

      this.workletNode?.port.postMessage({
        type: 'getEnvelopePreview',
        // Convert the config to a plain object (using JSON‑serialization or spread)
        config: JSON.parse(JSON.stringify(config)),
        previewDuration,
      });

      setTimeout(() => {
        this.workletNode?.port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for envelope preview'));
      }, 1000);
    });
  }

  public async getFilterResponse(
    node_id: number,
    length: number,
  ): Promise<Float32Array> {
    if (!this.ready || !this.workletNode) {
      throw new Error('Audio system not ready');
    }
    return new Promise<Float32Array>((resolve, reject) => {
      const handleMessage = (e: MessageEvent) => {
        if (e.data.type === 'FilterIrWaveform') {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(e.data.waveform));
        } else if (
          e.data.type === 'error' &&
          e.data.source === 'getLfoWaveform'
        ) {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          reject(new Error(e.data.message));
        }
      };

      this.workletNode?.port.addEventListener('message', handleMessage);
      console.log('## requesting IR waveform for node', node_id);
      this.workletNode?.port.postMessage({
        type: 'getFilterIRWaveform',
        node_id,
        length,
      });

      // Add timeout to prevent hanging
      setTimeout(() => {
        this.workletNode?.port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for waveform data'));
      }, 5000);
    });
  }

  public async getLfoWaveform(
    waveform: number,
    phaseOffset: number,
    frequency: number,
    bufferSize: number,
    use_absolute: boolean,
    use_normalized: boolean,
  ): Promise<Float32Array> {
    if (!this.ready || !this.workletNode) {
      throw new Error('Audio system not ready');
    }

    return new Promise<Float32Array>((resolve, reject) => {
      const handleMessage = (e: MessageEvent) => {
        if (e.data.type === 'lfoWaveform') {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          resolve(new Float32Array(e.data.waveform));
        } else if (
          e.data.type === 'error' &&
          e.data.source === 'getLfoWaveform'
        ) {
          this.workletNode?.port.removeEventListener('message', handleMessage);
          reject(new Error(e.data.message));
        }
      };

      this.workletNode?.port.addEventListener('message', handleMessage);

      this.workletNode?.port.postMessage({
        type: 'getLfoWaveform',
        waveform,
        phaseOffset,
        frequency,
        bufferSize,
        use_absolute,
        use_normalized,
      });

      // Add timeout to prevent hanging
      setTimeout(() => {
        this.workletNode?.port.removeEventListener('message', handleMessage);
        reject(new Error('Timeout waiting for waveform data'));
      }, 5000);
    });
  }

  public updateEnvelopeState(nodeId: number, newState: EnvelopeConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ready || !this.workletNode || !this.synthLayout) {
        //reject(new Error('Audio system not ready'));
        resolve();
        return;
      }

      // Generate a unique message ID. Here we use the current time plus a random number.
      const messageId = `${Date.now()}_${Math.random()}`;

      // Define a listener that waits for the confirmation message.
      const listener = (event: MessageEvent) => {
        const data = event.data;
        if (data && data.type === 'updateEnvelopeProcessed' && data.messageId === messageId) {
          // Remove the listener and resolve the promise.
          this.workletNode?.port.removeEventListener('message', listener);
          resolve();
        }
      };

      // Attach the listener.
      this.workletNode.port.addEventListener('message', listener);

      setTimeout(() => {
        this.workletNode?.port.removeEventListener('message', listener);
        reject(new Error('Timeout waiting for envelope update confirmation'));
      }, 2000);

      // Post the message to update the envelope state.
      this.workletNode.port.postMessage({
        type: 'updateEnvelope',
        envelopeId: nodeId,
        config: newState,
        messageId: messageId,
      });
    });
  }

  public updateArpeggiatorPattern(nodeId: number, pattern: { value: number; active: boolean }[]) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;
    this.workletNode.port.postMessage({
      type: 'updateArpeggiatorPattern',
      nodeId,
      pattern,
    });
  }


  public updateArpeggiatorStepDuration(nodeId: number, stepDurationMs: number) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;
    this.workletNode.port.postMessage({
      type: 'updateArpeggiatorStepDuration',
      nodeId,
      stepDurationMs,
    });
  }

  public updateWavetable(nodeId: number, newWavetable: Wavetable) {
    console.log('### instrument got wavetable:', newWavetable);
  }

  public updateFilterState(nodeId: number, newState: FilterState) {
    if (!this.ready || !this.workletNode || !this.synthLayout) return;

    // const voiceIndex = this.findVoiceForNode(nodeId);
    // if (voiceIndex === -1) return;

    this.workletNode.port.postMessage({
      type: 'updateFilter',
      filterId: nodeId,
      config: newState,
    });
  }

  public updateConnection(connection: NodeConnectionUpdate): void {
    if (!this.ready || !this.workletNode) return;

    // Validate input parameters
    if (typeof connection.target !== 'number') {
      console.error(
        'Invalid target type in connection:',
        typeof connection.target,
      );
      return;
    }

    if (
      typeof connection.fromId !== 'number' ||
      typeof connection.toId !== 'number'
    ) {
      console.error('Invalid ID type in connection:', {
        fromId: typeof connection.fromId,
        toId: typeof connection.toId,
      });
      return;
    }

    // Create a safe connection object with validated values
    const safeConnection = {
      fromId: connection.fromId,
      toId: connection.toId,
      target: connection.target,
      amount: Number(connection.amount) || 0,
      modulationType: connection.modulationType,
      modulationTransformation: connection.modulationTransformation,
      isRemoving: Boolean(connection.isRemoving),
    };

    console.log('Sending validated connection:', safeConnection);

    try {
      this.workletNode.port.postMessage({
        type: 'updateConnection',
        connection: safeConnection,
      });
    } catch (error) {
      console.error('Failed to send connection message:', error, {
        connection: safeConnection,
        original: connection,
      });
      throw error;
    }
  }

  // async createModulation(
  //   sourceId: number,
  //   targetId: number,
  //   target: PortId,
  //   amount: number,
  // ): Promise<void> {
  //   const message: {
  //     type: 'updateModulation';
  //     connection: {
  //       fromId: number;
  //       toId: number;
  //       target: PortId;
  //       amount: number;
  //     };
  //   } = {
  //     type: 'updateModulation',
  //     connection: {
  //       fromId: Number(sourceId),
  //       toId: Number(targetId),
  //       target, // PortId is already the correct type
  //       amount: Number(amount),
  //     },
  //   };

  //   // Return a Promise that resolves when the state is updated
  //   return new Promise((resolve, reject) => {
  //     if (!this.workletNode) {
  //       reject(new Error('Worklet not initialized'));
  //       return;
  //     }

  //     const messageId = Date.now().toString();
  //     const timeoutId = setTimeout(() => {
  //       this.workletNode?.port.removeEventListener('message', handleResponse);
  //       reject(new Error('Timeout waiting for modulation update'));
  //     }, 1000);

  //     const handleResponse = (e: MessageEvent) => {
  //       if (
  //         e.data.type === 'modulationUpdated' &&
  //         e.data.messageId === messageId
  //       ) {
  //         clearTimeout(timeoutId);
  //         this.workletNode?.port.removeEventListener('message', handleResponse);
  //         resolve();
  //       }
  //     };

  //     this.workletNode.port.addEventListener('message', handleResponse);

  //     this.workletNode.port.postMessage({
  //       ...message,
  //       messageId,
  //     });
  //   });
  // }

  public remove_specific_connection(
    from_node: number,
    to_node: number,
    to_port: number,
  ) {
    if (!this.ready || !this.workletNode) return;

    this.workletNode.port.postMessage({
      type: 'removeConnection',
      fromNode: from_node,
      toNode: to_node,
      toPort: to_port,
    });
  }

  // public createModulationForVoice(
  //   sourceId: number,
  //   targetId: number,
  //   target: PortId,
  //   amount: number,
  // ) {
  //   const connection: NodeConnection = {
  //     fromId: sourceId,
  //     toId: targetId,
  //     target,
  //     amount,
  //   };
  //   this.updateConnection(connection);
  // }

  public note_on(midi_note: number, velocity: number) {
    if (!this.ready || !this.workletNode) return;

    if (this.activeNotes.has(midi_note)) {
      this.note_off(midi_note);
    }

    const voiceIndex = this.findFreeVoice();
    if (voiceIndex !== -1) {
      const frequency = this.midiNoteToFrequency(midi_note);

      const freqParam = this.workletNode.parameters.get(
        `frequency_${voiceIndex}`,
      );
      const gateParam = this.workletNode.parameters.get(`gate_${voiceIndex}`);
      const gainParam = this.workletNode.parameters.get(`gain_${voiceIndex}`);
      const velocityParam = this.workletNode.parameters.get(
        `velocity_${voiceIndex}`,
      );

      if (freqParam && gateParam && gainParam) {
        freqParam.setValueAtTime(frequency, this.audioContext.currentTime);
        gateParam.setValueAtTime(0.0, this.audioContext.currentTime);
        gateParam.setValueAtTime(1.0, this.audioContext.currentTime + 0.005);
        //gainParam.setValueAtTime(velocity / 127, this.audioContext.currentTime);
      }

      if (velocityParam) {
        const normVel = velocity / 127.0;
        velocityParam.setValueAtTime(normVel, this.audioContext.currentTime);
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
        if (voice.nodes[nodeType]?.some((node) => node.id === nodeId)) {
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
