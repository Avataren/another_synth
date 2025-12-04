import './textencoder.js';
import type {
  ChorusState,
  ConvolverState,
  DelayState,
  EnvelopeConfig,
  CompressorState,
  RawConnection,
  RawVoice,
  ReverbState,
  SaturationState,
  BitcrusherState,
  VelocityState,
  WasmState,
} from '../types/synth-layout';
import {
  type SynthLayout,
  type VoiceLayout,
  type VoiceNode,
  VoiceNodeType,
  type NodeConnectionUpdate,
  type FilterState,
  convertRawModulationType,
} from '../types/synth-layout';
import { type NoiseUpdate } from '../types/noise.js';
import {
  AnalogOscillatorStateUpdate,
  AudioEngine,
  AutomationAdapter,
  ConnectionUpdate,
  apply_modulation_update,
  initSync,
  WasmLfoUpdateParams,
  ModulationTransformation,
  NoiseUpdateParams,
  PortId,
  WasmModulationType,
  WavetableOscillatorStateUpdate,
  type Waveform,
} from 'app/public/wasm/audio_processor.js';
import type OscillatorState from '../models/OscillatorState.js';
interface EnvelopeUpdate {
  config: EnvelopeConfig;
  envelopeId: string;
  messageId: string;
}

declare const sampleRate: number;

declare global {
  interface AudioWorkletNodeOptions {
    numberOfInputs?: number;
    numberOfOutputs?: number;
    outputChannelCount?: number[];
    parameterData?: Record<string, number>;
  }

  class AudioWorkletProcessor {
    constructor(options?: Partial<AudioWorkletNodeOptions>);
    readonly port: MessagePort;
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean;
  }

  function registerProcessor(
    name: string,
    processorCtor: typeof AudioWorkletProcessor,
  ): void;
}

export enum LfoTriggerMode {
  None = 0,
  Gate = 1,
  Envelope = 2,
}

export enum LFOWaveform {
  Sine = 0,
  Triangle = 1,
  Pulse = 2,
  Saw = 3,
}

export interface LfoUpdateData {
  lfoId: string;
  params: {
    lfoId: string;
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
  };
}

interface SamplerUpdateData {
  samplerId: string;
  state: {
    frequency: number;
    gain: number;
    loopMode: number;
    loopStart: number;
    loopEnd: number;
    rootNote: number;
    triggerMode: number;
    active: boolean;
  };
}

class SynthAudioProcessor extends AudioWorkletProcessor {
  private ready: boolean = false;
  private stopped: boolean = false;
  private audioEngines: AudioEngine[] = []; // Multiple AudioEngine instances
  private numEngines: number = 2; // Number of engines per worklet
  private numVoices: number = 8; // Voices per engine
  private readonly maxOscillators: number = 4;
  private readonly maxEnvelopes: number = 4;
  private readonly maxLFOs: number = 4;
  private readonly maxFilters: number = 4;
  private readonly macroCount: number = 4;
  private readonly macroBufferSize: number = 128;
  private voiceLayouts: VoiceLayout[] = [];
  private stateVersion: number = 0;
  private automationAdapter: AutomationAdapter | null = null;
  private isApplyingPatch = false;
  private patchNodeNames: Map<string, string> = new Map();
  private blockSizeFrames = 128;
  private hasBroadcastBlockSize = false;

  static get parameterDescriptors() {
    const parameters = [];
    const numEngines = 2; // Support 2 AudioEngine instances per worklet
    const numVoices = 8;  // 8 voices per engine

    // Create parameters for each engine
    for (let e = 0; e < numEngines; e++) {
      for (let v = 0; v < numVoices; v++) {
        parameters.push(
          {
            name: `gate_engine${e}_voice${v}`,
            defaultValue: 0,
            minValue: 0,
            maxValue: 1,
            automationRate: 'a-rate',
          },
          {
            name: `frequency_engine${e}_voice${v}`,
            defaultValue: 440,
            minValue: 20,
            maxValue: 20000,
            automationRate: 'a-rate',
          },
          {
            name: `gain_engine${e}_voice${v}`,
            defaultValue: 1,
            minValue: 0,
            maxValue: 1,
            automationRate: 'k-rate',
          },
          {
            name: `velocity_engine${e}_voice${v}`,
            defaultValue: 0,
            minValue: 0,
            maxValue: 1,
            automationRate: 'k-rate',
          },
        );

        // Macro parameters (4 per voice per engine)
        for (let m = 0; m < 4; m++) {
          parameters.push({
            name: `macro_engine${e}_voice${v}_${m}`,
            defaultValue: 0,
            minValue: 0,
            maxValue: 1,
            automationRate: 'a-rate',
          });
        }
      }
    }

    parameters.push({
      name: 'master_gain',
      defaultValue: 1,
      minValue: 0,
      maxValue: 1,
      automationRate: 'k-rate',
    });

    return parameters;
  }

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    this.port.postMessage({ type: 'ready' });
  }

  private handleMessage(event: MessageEvent) {
    switch (event.data.type) {
      case 'wasm-binary':
        this.handleWasmInit(event.data);
        break;
      case 'loadPatch':
        this.handleLoadPatch(event.data);
        break;
      case 'updateModulation': // Add this case
        this.handleUpdateModulation(event.data);
        break;
      case 'updateNoise':
        this.handleNoiseUpdate(event.data);
        break;
      case 'updateFilter':
        this.handleUpdateFilter(event.data);
        break;
      case 'updateConnection':
        this.handleUpdateConnection(event.data);
        break;
      case 'updateWavetableOscillator':
        this.handleUpdateWavetableOscillator(event.data);
        break;
      case 'updateOscillator':
        this.handleUpdateOscillator(event.data);
        break;
      case 'getNodeLayout':
        this.handleGetNodeLayout(event.data);
        break;
      case 'getLfoWaveform':
        this.handleGetLfoWaveform(event.data);
        break;
      case 'updateLfo':
        this.handleUpdateLfo(event.data);
        break;
      case 'updateEnvelope':
        this.handleUpdateEnvelope(event.data);
        break;
      case 'requestSync':
        this.handleRequestSync();
        break;
      case 'getEnvelopePreview':
        this.handleGetEnvelopePreview(event.data);
        break;
      case 'getFilterIRWaveform':
        this.handleGetFilterIrWaveform(event.data);
        break;
      case 'importWavetable':
        this.handleImportWavetableData(event.data);
        break;
      case 'importImpulseWaveform':
        this.handleImportImpulseWaveformData(event.data);
        break;
      case 'updateConvolverState':
      case 'updateConvolver':
        this.handleUpdateConvolver(event.data);
        break;
      case 'updateDelayState':
      case 'updateDelay':
        this.handleUpdateDelay(event.data);
        break;
      case 'updateCompressor':
        this.handleUpdateCompressor(event.data);
        break;
      case 'updateSaturation':
        this.handleUpdateSaturation(event.data);
        break;
      case 'updateBitcrusher':
        this.handleUpdateBitcrusher(event.data);
        break;
      case 'updateVelocity':
        this.handleUpdateVelocity(event.data);
        break;
      case 'connectMacro':
        this.handleConnectMacro(event.data);
        break;
      case 'updateGlide':
        this.handleUpdateGlide(event.data);
        break;
      case 'deleteNode':
        this.handleDeleteNode(event.data);
        break;
      case 'createNode':
        this.handleCreateNode(event.data);
        break;
      case 'updateChorus':
        this.handleUpdateChorus(event.data);
        break;
      case 'updateReverb':
        this.handleUpdateReverb(event.data);
        break;
      case 'updateSampler':
        this.handleUpdateSampler(event.data);
        break;
      case 'importSample':
        this.handleImportSample(event.data);
        break;
      case 'getSamplerWaveform':
        this.handleGetSamplerWaveform(event.data);
        break;
      case 'exportSampleData':
        this.handleExportSampleData(event.data);
        break;
      case 'exportConvolverData':
        this.handleExportConvolverData(event.data);
        break;
      case 'generateHallReverb':
        this.handleGenerateHallReverb(event.data);
        break;
      case 'generatePlateReverb':
        this.handleGeneratePlateReverb(event.data);
        break;
      case 'cpuUsage':
        this.handleCpuUsage();
        break;
      case 'stop':
        this.handleStop();
        break;
    }
  }

  private handleStop() {
    this.stopped = true;
  }

  private handleCpuUsage() {
    if (!this.audioEngines[0] || this.isApplyingPatch || !this.ready) {
      return;
    }

    try {
      const cpu = this.audioEngines[0].get_cpu_usage();
      this.port.postMessage({ type: 'cpuUsage', cpu });
    } catch (error) {
      // Silently skip if there's a borrow conflict (happens during audio processing)
      // This is expected and not an error condition
    }
  }

  private handleDeleteNode(data: { nodeId: string }) {
    this.audioEngines[0]!.delete_node(data.nodeId);
    this.handleRequestSync();
  }

  private handleConnectMacro(data: { macroIndex: number; targetId: string; targetPort: PortId; amount: number; modulationType: WasmModulationType; modulationTransformation: ModulationTransformation }) {
    if (!this.audioEngines[0]) return;
    // Always wire macros across the active voice count; voiceLayouts can be a single
    // canonical layout, so fall back to the configured voice count instead of length.
    const voices = Math.max(1, this.numVoices);
    const connectMacro =
      (this.audioEngines[0] as { connect_macro?: (...args: unknown[]) => unknown })
        .connect_macro;
    for (let voice = 0; voice < voices; voice++) {
      if (typeof connectMacro === 'function') {
        // Prefer new signature with modulationType/transform; fall back to legacy 5-arg binding if present
        if (connectMacro.length >= 7) {
          connectMacro.call(
            this.audioEngines[0],
            voice,
            data.macroIndex,
            data.targetId,
            data.targetPort,
            data.amount,
            data.modulationType,
            data.modulationTransformation,
          );
        } else {
          connectMacro.call(
            this.audioEngines[0],
            voice,
            data.macroIndex,
            data.targetId,
            data.targetPort,
            data.amount,
          );
        }
      }
    }
  }

  private handleCreateNode(data: { node?: VoiceNodeType; nodeType?: VoiceNodeType }) {
    const nodeType = data.node ?? data.nodeType;
    if (nodeType === undefined) {
      console.error('handleCreateNode received no node type payload', data);
      return;
    }

    switch (nodeType) {
      case VoiceNodeType.Oscillator:
        this.audioEngines[0]!.create_oscillator();
        break;
      case VoiceNodeType.Filter:
        this.audioEngines[0]!.create_filter();
        break;
      case VoiceNodeType.LFO:
        this.audioEngines[0]!.create_lfo();
        break;
      case VoiceNodeType.WavetableOscillator:
        this.audioEngines[0]!.create_wavetable_oscillator();
        break;
      case VoiceNodeType.Noise:
        this.audioEngines[0]!.create_noise();
        break;
      case VoiceNodeType.Sampler:
        this.audioEngines[0]!.create_sampler();
        break;
      case VoiceNodeType.Envelope:
        this.audioEngines[0]!.create_envelope();
        break;
      case VoiceNodeType.Convolver:
      case VoiceNodeType.Delay:
      case VoiceNodeType.Chorus:
      case VoiceNodeType.Reverb:
      case VoiceNodeType.Compressor:
      case VoiceNodeType.Saturation:
      case VoiceNodeType.Bitcrusher:
        // Effects live on the global stack and are created during engine init.
        console.warn('Effect nodes are created by default; skipping explicit creation for', nodeType);
        break;
      default:
        console.error('Missing creation case for: ', nodeType);
        break;
    }
    this.handleRequestSync();
  }

  private handleImportImpulseWaveformData(data: {
    type: string;
    // Using wavData.buffer transfers the ArrayBuffer
    nodeId: string;
    data: Uint8Array;
  }) {
    if (!this.audioEngines[0]) return;

    const effectId = Number(data.nodeId);
    if (!Number.isFinite(effectId)) {
      console.error(
        'handleImportImpulseWaveformData: invalid nodeId for effect:',
        data.nodeId,
      );
      return;
    }

    const uint8Data = new Uint8Array(data.data);
    this.audioEngines[0].import_wave_impulse(effectId, uint8Data);
  }

  private handleImportWavetableData(data: {
    type: string;
    // Using wavData.buffer transfers the ArrayBuffer
    nodeId: string;
    data: Uint8Array;
  }) {
    const uint8Data = new Uint8Array(data.data);
    this.audioEngines[0]!.import_wavetable(data.nodeId, uint8Data, 2048);
  }

  private handleImportSample(data: { nodeId: string; data: ArrayBuffer }) {
    if (!this.audioEngines[0]) return;
    try {
      const uint8Data = new Uint8Array(data.data);
      this.audioEngines[0].import_sample(data.nodeId, uint8Data);
    } catch (err) {
      console.error('Error importing sample:', err);
    }
  }

  private handleUpdateSampler(data: SamplerUpdateData) {
    if (!this.audioEngines[0]) return;
    try {
      this.audioEngines[0].update_sampler(
        data.samplerId,
        data.state.frequency,
        data.state.gain,
        data.state.loopMode,
        data.state.loopStart,
        data.state.loopEnd,
        data.state.rootNote,
        data.state.triggerMode,
        data.state.active,
      );
    } catch (err) {
      console.error('Error updating sampler:', err);
    }
  }

  // Inside SynthAudioProcessor's handleMessage method:
  private handleGetEnvelopePreview(data: {
    config: EnvelopeConfig;
    previewDuration: number;
  }) {
    if (!this.audioEngines[0]) return;
    try {
      // Call the wasm-bound function on the AudioEngine instance.
      // Ensure you pass the envelope config and preview duration.
      const envelopePreviewData = AudioEngine.get_envelope_preview(
        sampleRate,
        data.config, // The envelope configuration (should match EnvelopeConfig)
        data.previewDuration,
      );
      // Send the preview data (a Float32Array) back to the main thread.
      this.port.postMessage({
        type: 'envelopePreview',
        preview: envelopePreviewData, // This is already a Float32Array.
        source: 'getEnvelopePreview',
      });
    } catch (err) {
      console.error('Error generating envelope preview:', err);
      this.port.postMessage({
        type: 'error',
        source: 'getEnvelopePreview',
        message: 'Failed to generate envelope preview',
      });
    }
  }

  private handleWasmInit(data: { wasmBytes: ArrayBuffer }) {
    try {
      const { wasmBytes } = data;
      initSync({ module: new Uint8Array(wasmBytes) });

      // Create multiple AudioEngine instances
      this.audioEngines = [];
      for (let i = 0; i < this.numEngines; i++) {
        const engine = new AudioEngine(sampleRate);
        engine.init(sampleRate, this.numVoices);
        this.audioEngines.push(engine);
        console.log(`[SynthAudioProcessor] Initialized engine ${i}`);
      }

      this.automationAdapter = new AutomationAdapter(
        this.numVoices,
        this.macroCount,
        this.macroBufferSize,
      );

      // Initialize all voices in the first engine (for backward compatibility)
      // TODO: Support per-engine initialization
      this.createNodesAndSetupConnections();
      this.initializeVoices();
      this.initializeState();

      this.ready = true;
      console.log(`[SynthAudioProcessor] Ready with ${this.numEngines} engines`);
    } catch (error) {
      console.error('Failed to initialize WASM audio engine:', error);
      this.port.postMessage({
        type: 'error',
        error: 'Failed to initialize audio engine',
      });
    }
  }

  /**
   * Apply custom node names from the incoming patch JSON onto the in-memory
   * voice layouts. The WASM engine reports default names, so we reconcile them
   * here to keep UI labels in sync with patch metadata.
   */
  private applyPatchNamesToLayouts(patchJson: string): void {
    if (!this.voiceLayouts || this.voiceLayouts.length === 0) return;

    try {
      const parsed = JSON.parse(patchJson);
      const layout = parsed?.synthState?.layout;
      const canonicalVoice =
        layout?.canonicalVoice ??
        (Array.isArray(layout?.voices) && layout.voices.length > 0
          ? layout.voices[0]
          : null);

      const nodes = canonicalVoice?.nodes;
      if (!nodes || typeof nodes !== 'object') return;

      const nameById = new Map<string, string>();
      const isNamedNode = (value: unknown): value is { id: string; name?: unknown } =>
        !!value &&
        typeof value === 'object' &&
        'id' in value &&
        typeof (value as { id: unknown }).id === 'string';

      Object.values(nodes).forEach((nodeArray: unknown) => {
        if (!Array.isArray(nodeArray)) return;
        nodeArray.forEach((node: unknown) => {
          if (!isNamedNode(node)) return;
          const name = node.name;
          if (typeof name === 'string' && name.trim().length > 0) {
            nameById.set(node.id, name);
          }
        });
      });

      if (nameById.size === 0) return;
      this.patchNodeNames = nameById;

      this.voiceLayouts.forEach((voice) => {
        Object.values(voice.nodes).forEach((nodeArray) => {
          nodeArray.forEach((node) => {
            const customName = nameById.get(node.id);
            if (customName) {
              node.name = customName;
            }
          });
        });
      });
    } catch (err) {
      console.warn('Failed to apply patch names to layouts', err);
    }
  }

  /**
   * Reapply any stored patch names onto current voice layouts before sending
   * them to the main thread (covers later layout posts).
   */
  private applyStoredNamesToLayouts(): void {
    if (!this.voiceLayouts || this.patchNodeNames.size === 0) return;
    this.voiceLayouts.forEach((voice) => {
      Object.values(voice.nodes).forEach((nodeArray) => {
        nodeArray.forEach((node) => {
          const customName = this.patchNodeNames.get(node.id);
          if (customName) {
            node.name = customName;
          }
        });
      });
    });
  }

  private handleLoadPatch(data: { patchJson: string }) {
    if (!this.audioEngines[0]) {
      console.warn('loadPatch requested before audio engine was ready');
      return;
    }

    this.isApplyingPatch = true;
    try {
      const voiceCount = this.audioEngines[0].initWithPatch(data.patchJson);
      if (Number.isFinite(voiceCount) && voiceCount > 0) {
        this.numVoices = voiceCount;
      }

      // IMPORTANT: Always use 8 voices for the automation adapter to match
      // the statically-defined parameter descriptors, regardless of the patch voice count.
      // This prevents out-of-bounds errors when parameters contain data for all 8 voices
      // but the patch uses fewer voices.
      this.automationAdapter = new AutomationAdapter(
        8, // Fixed to match parameter descriptors
        this.macroCount,
        this.macroBufferSize,
      );

      this.initializeVoices();
      this.applyPatchNamesToLayouts(data.patchJson);
      this.stateVersion++;
      this.postSynthLayout();
      this.handleRequestSync(false);
    } catch (error) {
      console.error('Failed to load patch in worklet:', error);
      this.port.postMessage({
        type: 'error',
        source: 'loadPatch',
        message: 'Failed to load patch',
      });
    } finally {
      this.isApplyingPatch = false;
    }
  }

  private initializeState() {
    if (!this.audioEngines[0]) return;

    const initialState = this.audioEngines[0].get_current_state();
    this.stateVersion++;

    // Send both the initial state and state version
    this.port.postMessage({
      type: 'initialState',
      state: initialState,
      version: this.stateVersion,
    });

    this.postSynthLayout();
  }

  private postSynthLayout() {
    if (!this.audioEngines[0]) return;
    this.applyStoredNamesToLayouts();
    const layout: SynthLayout = {
      voices: this.voiceLayouts,
      globalNodes: {
        effectsChain: [],
      },
      metadata: {
        maxVoices: this.numVoices,
        maxOscillators: this.maxOscillators,
        maxEnvelopes: this.maxEnvelopes,
        maxLFOs: this.maxLFOs,
        maxFilters: this.maxFilters,
        stateVersion: this.stateVersion,
      },
    };
    this.port.postMessage({
      type: 'synthLayout',
      layout,
    });
  }

  private createNodesAndSetupConnections(): void {
    if (!this.audioEngines[0]) throw new Error('Audio engine not initialized');

    // Create noise generator.
    //this.audioEngines[0].create_noise();
    // Create mixer.
    const mixerId = this.audioEngines[0].create_mixer() as string;

    // const arpId = this.audioEngines[0].create_arpeggiator();
    // Create filter.
    const filterId = this.audioEngines[0].create_filter();
    // this.audioEngines[0].create_filter();

    const samplerNodeId = this.audioEngines[0].create_sampler();

    // Create oscillators.
    const oscIds: string[] = [];
    const wtoscId = this.audioEngines[0].create_wavetable_oscillator();
    oscIds.push(wtoscId);

    const oscId = this.audioEngines[0].create_oscillator();
    oscIds.push(oscId);

    // Create envelopes.
    const envelopeIds: string[] = [];
    for (let i = 0; i < 1; i++) {
      const result = this.audioEngines[0].create_envelope();
      envelopeIds.push(result.envelopeId);
    }

    // Create LFOs.
    const lfoIds: string[] = [];
    for (let i = 0; i < 1; i++) {
      const result = this.audioEngines[0].create_lfo();
      lfoIds.push(result.lfoId);
    }

    // Global frequency node is assumed to have id 0.
    // (No creation method needed if it's fixed.)

    // --- Set up initial connections (as in your original code) ---
    if (envelopeIds.length > 0 && oscIds.length >= 2) {
      // this.audioEngines[0].connect_nodes(
      //   arpId!,
      //   PortId.AudioOutput0,
      //   oscIds[0]!,
      //   PortId.DetuneMod,
      //   1,
      //   WasmModulationType.Additive,
      //   ModulationTransformation.None,
      // );

      // this.audioEngines[0].connect_nodes(
      //   arpId!,
      //   PortId.AudioOutput0,
      //   oscIds[1]!,
      //   PortId.DetuneMod,
      //   1,
      //   WasmModulationType.Additive,
      //   ModulationTransformation.None,
      // );

      // Connect filter to mixer's audio input.
      this.audioEngines[0].connect_nodes(
        filterId,
        PortId.AudioOutput0,
        mixerId,
        PortId.AudioInput0,
        1.0,
        WasmModulationType.Additive,
        ModulationTransformation.None,
      );

      // this.audioEngines[0].connect_nodes(
      //   filterId2,
      //   PortId.AudioOutput0,
      //   mixerId,
      //   PortId.AudioInput0,
      //   1.0,
      //   WasmModulationType.Additive,
      // );

      // Connect envelope to mixer's gain input.
      this.audioEngines[0].connect_nodes(
        envelopeIds[0]!,
        PortId.AudioOutput0,
        mixerId,
        PortId.GainMod,
        1.0,
        WasmModulationType.VCA,
        ModulationTransformation.None,
      );

      // Connect oscillator 1 to filter's audio input.
      this.audioEngines[0].connect_nodes(
        oscIds[0]!,
        PortId.AudioOutput0,
        filterId,
        PortId.AudioInput0,
        1.0,
        WasmModulationType.Additive,
        ModulationTransformation.None,
      );

      // Connect sampler to filter's audio input.
      this.audioEngines[0].connect_nodes(
        samplerNodeId,
        PortId.AudioOutput0,
        filterId,
        PortId.AudioInput0,
        1.0,
        WasmModulationType.Additive,
        ModulationTransformation.None,
      );

      // Connect oscillator 2's output to oscillator 1's phase mod.
      this.audioEngines[0].connect_nodes(
        oscIds[1]!,
        PortId.AudioOutput0,
        oscIds[0]!,
        PortId.PhaseMod,
        1.0,
        WasmModulationType.Additive,
        ModulationTransformation.None,
      );

      // Request a state sync (if needed).
      this.handleRequestSync();
    } else {
      console.warn('Not enough nodes for initial connections');
    }
  }

  private initializeVoices(): void {
    if (!this.audioEngines[0]) throw new Error('Audio engine not initialized');

    // Retrieve and cast the raw WASM state.
    const wasmState = this.audioEngines[0].get_current_state() as WasmState;
    console.log('Raw WASM state:', wasmState);

    if (!wasmState.voices || wasmState.voices.length === 0) {
      throw new Error('No voices available in WASM state');
    }

    // Use voice 0 as the canonical voice.
    const rawCanonicalVoice: RawVoice = wasmState.voices[0]!;

    // Convert the raw nodes array into an object keyed by VoiceNodeType.
    const nodesByType: {
      [key in VoiceNodeType]: VoiceNode[];
    } = {
      [VoiceNodeType.Oscillator]: [],
      [VoiceNodeType.WavetableOscillator]: [],
      [VoiceNodeType.Envelope]: [],
      [VoiceNodeType.LFO]: [],
      [VoiceNodeType.Filter]: [],
      [VoiceNodeType.Mixer]: [],
      [VoiceNodeType.Noise]: [],
      [VoiceNodeType.Sampler]: [],
      [VoiceNodeType.Glide]: [],
      [VoiceNodeType.GlobalFrequency]: [],
      [VoiceNodeType.GlobalVelocity]: [],
      [VoiceNodeType.Convolver]: [],
      [VoiceNodeType.Delay]: [],
      [VoiceNodeType.GateMixer]: [],
      [VoiceNodeType.ArpeggiatorGenerator]: [],
      [VoiceNodeType.Chorus]: [],
      [VoiceNodeType.Limiter]: [],
      [VoiceNodeType.Reverb]: [],
      [VoiceNodeType.Compressor]: [],
      [VoiceNodeType.Saturation]: [],
      [VoiceNodeType.Bitcrusher]: [],
    };

    for (const rawNode of rawCanonicalVoice.nodes) {
      let type: VoiceNodeType;
      console.log('## checking rawNode.node_type:', rawNode.node_type);
      switch (rawNode.node_type.trim()) {
        case 'analog_oscillator':
          type = VoiceNodeType.Oscillator;
          break;
        case 'filtercollection':
          type = VoiceNodeType.Filter;
          break;
        case 'envelope':
          type = VoiceNodeType.Envelope;
          break;
        case 'lfo':
          type = VoiceNodeType.LFO;
          break;
        case 'mixer':
          type = VoiceNodeType.Mixer;
          break;
        case 'noise_generator':
          type = VoiceNodeType.Noise;
          break;
        case 'global_frequency':
          type = VoiceNodeType.GlobalFrequency;
          break;
        case 'wavetable_oscillator':
          type = VoiceNodeType.WavetableOscillator;
          break;
        case 'sampler':
        case 'Sampler':
          type = VoiceNodeType.Sampler;
          break;
        case 'convolver':
          type = VoiceNodeType.Convolver;
          break;
        case 'delay':
          type = VoiceNodeType.Delay;
          break;
        case 'gatemixer':
          type = VoiceNodeType.GateMixer;
          break;
        case 'glide':
          type = VoiceNodeType.Glide;
          break;
        case 'arpeggiator_generator':
          type = VoiceNodeType.ArpeggiatorGenerator;
          break;
        case 'global_velocity':
          type = VoiceNodeType.GlobalVelocity;
          break;
        case 'chorus':
          type = VoiceNodeType.Chorus;
          break;
        case 'limiter':
          type = VoiceNodeType.Limiter;
          break;
        case 'freeverb':
          type = VoiceNodeType.Reverb;
          break;
        case 'compressor':
          type = VoiceNodeType.Compressor;
          break;
        case 'saturation':
          type = VoiceNodeType.Saturation;
          break;
        case 'bitcrusher':
          type = VoiceNodeType.Bitcrusher;
          break;

        default:
          console.warn('##### Unknown node type:', rawNode.node_type);
          type = rawNode.node_type as VoiceNodeType;
      }
      nodesByType[type].push({
        id: rawNode.id,
        type,
        name: rawNode.name,
      });
    }

    // Convert the raw connections into the expected format.
    const connections = rawCanonicalVoice.connections.map(
      (rawConn: RawConnection) => ({
        fromId: rawConn.from_id,
        toId: rawConn.to_id,
        target: rawConn.target as PortId,
        amount: rawConn.amount,
        modulationType: convertRawModulationType(rawConn.modulation_type),
        modulationTransformation: rawConn.modulation_transform,
      }),
    );

    // Build the canonical VoiceLayout.
    const canonicalVoice: VoiceLayout = {
      id: rawCanonicalVoice.id,
      nodes: nodesByType,
      connections: connections,
    };

    // (Optional) Replicate the canonical voice across all voices.
    this.voiceLayouts = [];
    for (let i = 0; i < this.numVoices; i++) {
      this.voiceLayouts.push({ ...canonicalVoice, id: i });
    }
  }

  remove_specific_connection(
    from_node: string,
    to_node: string,
    to_port: PortId,
  ) {
    if (!this.audioEngines[0]) return;
    this.audioEngines[0].remove_specific_connection(from_node, to_node, to_port);
  }

  private handleUpdateConnection(data: { connection: NodeConnectionUpdate }) {
    const { connection } = data;
    if (!this.audioEngines[0]) return;

    try {
      console.log('Worklet handling connection update:', {
        connection,
        type: connection.isRemoving ? 'remove' : 'update',
        targetPort: connection.target,
      });

      // Always use remove_specific_connection when removing
      if (connection.isRemoving) {
        this.audioEngines[0].remove_specific_connection(
          connection.fromId,
          connection.toId,
          connection.target,
        );

        console.log('Removed connection:', {
          from: connection.fromId,
          to: connection.toId,
          target: connection.target,
        });
        return; // Exit early after removal
      }

      // For updates/adds:
      // First remove any existing connection with the same target
      this.audioEngines[0].remove_specific_connection(
        connection.fromId,
        connection.toId,
        connection.target,
      );

      // Then add the new connection
      console.log('Adding new connection:', {
        from: connection.fromId,
        fromPort: PortId.AudioOutput0,
        to: connection.toId,
        target: connection.target,
        amount: connection.amount,
        modulationType: connection.modulationType,
        modulationTransformation: connection.modulationTransformation,
      });

      const numericTransformValue = connection.modulationTransformation; // It's already a number (e.g., 1)

      console.log('Adding new connection (sending numeric transform):', {
        from: connection.fromId,
        to: connection.toId,
        target: connection.target,
        amount: connection.amount,
        modulationType: connection.modulationType, // Check type consistency here too
        modulationTransformation: numericTransformValue, // Log the number (e.g., 1)
      });

      this.audioEngines[0].connect_nodes(
        connection.fromId,
        PortId.AudioOutput0,
        connection.toId,
        connection.target,
        connection.amount,
        connection.modulationType,
        connection.modulationTransformation,
      );

      // Verify connection was added
      this.handleRequestSync();
    } catch (err) {
      console.error('Connection update failed in worklet:', err, {
        data: connection,
      });
    }
  }

  private handleRequestSync(incrementVersion = true) {
    if (this.audioEngines[0]) {
      if (incrementVersion) {
        this.stateVersion++;
      }
      this.port.postMessage({
        type: 'stateUpdated',
        version: this.stateVersion,
        state: this.audioEngines[0].get_current_state(),
      });
    }
  }

  private handleNoiseUpdate(data: { noiseId: string; config: NoiseUpdate }) {
    if (!this.audioEngines[0]) return;
    console.log('noiseData:', data);

    const params = new NoiseUpdateParams(
      data.config.noise_type,
      data.config.cutoff,
      data.config.gain,
      data.config.enabled,
    );

    this.audioEngines[0].update_noise(data.noiseId, params);
  }

  private handleUpdateChorus(data: {
    type: string;
    nodeId: string;
    state: ChorusState;
  }) {
    if (!this.audioEngines[0]) return;

    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error('handleUpdateChorus: invalid nodeId:', data.nodeId);
      return;
    }

    this.audioEngines[0].update_chorus(
      nodeId,
      data.state.active,
      data.state.baseDelayMs,
      data.state.depthMs,
      data.state.lfoRateHz,
      data.state.feedback,
      data.state.feedback_filter,
      data.state.mix,
      data.state.stereoPhaseOffsetDeg,
    );
  }

  private handleUpdateCompressor(data: {
    type: string;
    nodeId: string;
    state: CompressorState;
  }) {
    if (!this.audioEngines[0]) return;

    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error('handleUpdateCompressor: invalid nodeId:', data.nodeId);
      return;
    }

    this.audioEngines[0].update_compressor(
      nodeId,
      data.state.active,
      data.state.thresholdDb,
      data.state.ratio,
      data.state.attackMs,
      data.state.releaseMs,
      data.state.makeupGainDb,
      data.state.mix,
    );
  }

  private handleUpdateReverb(data: {
    type: string;
    nodeId: string;
    state: ReverbState;
  }) {
    if (!this.audioEngines[0]) return;

    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error('handleUpdateReverb: invalid nodeId:', data.nodeId);
      return;
    }

    this.audioEngines[0].update_reverb(
      nodeId,
      data.state.active,
      data.state.room_size,
      data.state.damp,
      data.state.wet,
      data.state.dry,
      data.state.width,
    );
  }

  private handleUpdateFilter(data: {
    type: string;
    filterId: string;
    config: FilterState;
  }) {
    // console.log('handle filter update:', data);
    this.audioEngines[0]!.update_filters(
      data.filterId,
      data.config.cutoff,
      data.config.resonance,
      data.config.gain,
      data.config.keytracking,
      data.config.comb_frequency,
      data.config.comb_dampening,
      data.config.oversampling,
      data.config.filter_type,
      data.config.filter_slope,
    );
  }

  private handleUpdateVelocity(data: {
    type: string;
    nodeId: string;
    config: VelocityState;
  }) {
    if (!this.audioEngines[0]) return;
    this.audioEngines[0].update_velocity(
      data.nodeId,
      data.config.sensitivity,
      data.config.randomize,
    );
  }

  private handleUpdateGlide(data: {
    type: string;
    glideId: string;
    time?: number;
    riseTime?: number;
    fallTime?: number;
    active: boolean;
  }) {
    if (!this.audioEngines[0]) return;
    const glideTime =
      data.time ??
      Math.max(
        data.riseTime ?? 0,
        data.fallTime ?? 0,
      );
    this.audioEngines[0].update_glide(
      data.glideId,
      glideTime,
      data.active,
    );
  }

  private handleUpdateConvolver(data: {
    type: string;
    nodeId: string;
    state: ConvolverState;
  }) {
    if (!this.audioEngines[0]) return;

    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error('handleUpdateConvolver: invalid nodeId:', data.nodeId);
      return;
    }

    this.audioEngines[0].update_convolver(nodeId, data.state.wetMix, data.state.active);
  }

  private handleUpdateDelay(data: {
    type: string;
    nodeId: string;
    state: DelayState;
  }) {
    if (!this.audioEngines[0]) return;

    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error('handleUpdateDelay: invalid nodeId:', data.nodeId);
      return;
    }

    this.audioEngines[0].update_delay(
      nodeId,
      data.state.delayMs,
      data.state.feedback,
      data.state.wetMix,
      data.state.active,
    );
  }

  private handleUpdateSaturation(data: {
    type: string;
    nodeId: string;
    state: SaturationState;
  }) {
    if (!this.audioEngines[0]) return;

    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error('handleUpdateSaturation: invalid nodeId:', data.nodeId);
      return;
    }

    (this.audioEngines[0] as unknown as {
      update_saturation: (id: number, drive: number, mix: number, active: boolean) => void;
    }).update_saturation(
      nodeId,
      data.state.drive,
      data.state.mix,
      data.state.active,
    );
  }

  private handleUpdateBitcrusher(data: {
    type: string;
    nodeId: string;
    state: BitcrusherState;
  }) {
    if (!this.audioEngines[0]) return;

    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error('handleUpdateBitcrusher: invalid nodeId:', data.nodeId);
      return;
    }

    const bits = Math.max(1, Math.round(data.state.bits));
    const downsample = Math.max(1, Math.round(data.state.downsampleFactor));
    const mix = Math.min(1, Math.max(0, data.state.mix));

    (this.audioEngines[0] as unknown as {
      update_bitcrusher: (id: number, bits: number, downsampleFactor: number, mix: number, active: boolean) => void;
    }).update_bitcrusher(nodeId, bits, downsample, mix, data.state.active);
  }

  private handleUpdateModulation(data: {
    connection: NodeConnectionUpdate;
    messageId: string;
  }) {
    if (!this.audioEngines[0]) return;

    const { connection } = data;
    const transformation =
      connection.modulationTransformation ?? ModulationTransformation.None;
    const update = new ConnectionUpdate(
      connection.fromId,
      connection.toId,
      connection.target,
      connection.amount,
      transformation,
      connection.isRemoving ?? false,
      connection.modulationType ?? null,
    );

    try {
      if (this.automationAdapter) {
        this.automationAdapter.applyConnectionUpdate(this.audioEngines[0], update);
      } else {
        apply_modulation_update(this.audioEngines[0], update);
      }
    } catch (err) {
      console.error('Error updating modulation:', err);
    }
  }

  private handleUpdateWavetableOscillator(data: {
    oscillatorId: string;
    newState: OscillatorState;
  }) {
    if (!this.audioEngines[0]) return;

    const oscStateUpdate = new WavetableOscillatorStateUpdate(
      data.newState.phase_mod_amount,
      data.newState.detune,
      data.newState.hard_sync,
      data.newState.gain,
      data.newState.active,
      data.newState.feedback_amount,
      data.newState.unison_voices,
      data.newState.spread,
      data.newState.wave_index,
    );

    try {
      this.audioEngines[0].update_wavetable_oscillator(
        data.oscillatorId,
        oscStateUpdate,
      );
    } catch (err) {
      console.error('Failed to update oscillator:', err);
    }
  }

  private handleUpdateOscillator(data: {
    oscillatorId: string;
    newState: OscillatorState;
  }) {
    if (!this.audioEngines[0]) return;

    const oscStateUpdate = new AnalogOscillatorStateUpdate(
      data.newState.phase_mod_amount,
      data.newState.detune,
      data.newState.hard_sync,
      data.newState.gain,
      data.newState.active,
      data.newState.feedback_amount,
      (data.newState.waveform >> 0) as unknown as Waveform,
      data.newState.unison_voices,
      data.newState.spread,
    );

    try {
      this.audioEngines[0].update_oscillator(data.oscillatorId, oscStateUpdate);
    } catch (err) {
      console.error('Failed to update oscillator:', err);
    }
  }

  private handleGetNodeLayout(data: { messageId: string }) {
    if (!this.audioEngines[0]) {
      this.port.postMessage({
        type: 'error',
        messageId: data.messageId,
        message: 'Audio engine not initialized',
      });
      return;
    }

    try {
      const layout = this.audioEngines[0].get_current_state();

      console.log('synth-worklet::handleGetNodeLayer layout:', layout);
      this.port.postMessage({
        type: 'nodeLayout',
        messageId: data.messageId,
        layout: JSON.stringify(layout),
      });
    } catch (err) {
      this.port.postMessage({
        type: 'error',
        messageId: data.messageId,
        message:
          err instanceof Error ? err.message : 'Failed to get node layout',
      });
    }
  }

  private handleGetFilterIrWaveform(data: { node_id: string; length: number }) {
    if (!this.audioEngines[0]) return;

    try {
      const waveformData = this.audioEngines[0].get_filter_ir_waveform(
        data.node_id,
        data.length,
      );
      this.port.postMessage({
        type: 'FilterIrWaveform',
        waveform: waveformData,
      });
    } catch (err) {
      console.error('Error generating Filter IR waveform:', err);
      this.port.postMessage({
        type: 'error',
        message: 'Failed to generate Filter IR waveform',
      });
    }
  }

  private handleGetLfoWaveform(data: {
    waveform: number;
    phaseOffset: number;
    frequency: number;
    bufferSize: number;
    use_absolute: boolean;
    use_normalized: boolean;
  }) {
    if (!this.audioEngines[0]) return;

    try {
      const waveformData = this.audioEngines[0].get_lfo_waveform(
        data.waveform,
        data.phaseOffset,
        data.frequency,
        data.bufferSize,
        data.use_absolute,
        data.use_normalized,
      );

      this.port.postMessage({
        type: 'lfoWaveform',
        waveform: waveformData,
      });
    } catch (err) {
      console.error('Error generating LFO waveform:', err);
      this.port.postMessage({
        type: 'error',
        message: 'Failed to generate LFO waveform',
      });
    }
  }

  private handleGetSamplerWaveform(data: {
    samplerId: string;
    maxLength?: number;
    messageId: string;
  }) {
    if (!this.audioEngines[0]) return;
    try {
      const waveform = this.audioEngines[0].get_sampler_waveform(
        data.samplerId,
        data.maxLength ?? 512,
      );
      this.port.postMessage({
        type: 'samplerWaveform',
        samplerId: data.samplerId,
        messageId: data.messageId,
        waveform,
      });
    } catch (err) {
      console.error('Error getting sampler waveform:', err);
      this.port.postMessage({
        type: 'error',
        source: 'getSamplerWaveform',
        messageId: data.messageId,
        message: 'Failed to get sampler waveform',
      });
    }
  }

  private handleExportSampleData(data: {
    samplerId: string;
    messageId: string;
  }) {
    if (!this.audioEngines[0]) return;
    try {
      const sampleData = this.audioEngines[0].export_sample_data(data.samplerId);
      this.port.postMessage({
        type: 'sampleData',
        samplerId: data.samplerId,
        messageId: data.messageId,
        sampleData,
      });
    } catch (err) {
      console.error('Error exporting sample data:', err);
      this.port.postMessage({
        type: 'error',
        source: 'exportSampleData',
        messageId: data.messageId,
        message: 'Failed to export sample data',
      });
    }
  }

  private handleExportConvolverData(data: {
    convolverId: string;
    messageId: string;
  }) {
    if (!this.audioEngines[0]) return;
    try {
      const convolverData = this.audioEngines[0].export_convolver_data(data.convolverId);
      this.port.postMessage({
        type: 'convolverData',
        convolverId: data.convolverId,
        messageId: data.messageId,
        convolverData,
      });
    } catch (err) {
      console.error('Error exporting convolver data:', err);
      this.port.postMessage({
        type: 'error',
        source: 'exportConvolverData',
        messageId: data.messageId,
        message: 'Failed to export convolver data',
      });
    }
  }

  private handleGenerateHallReverb(data: {
    nodeId: string;
    decayTime: number;
    roomSize: number;
    sampleRate: number;
  }) {
    if (!this.audioEngines[0]) return;
    try {
      // Generate the impulse response
      const impulse = this.audioEngines[0].generate_hall_impulse(
        data.decayTime,
        data.roomSize,
      );

      // Convert nodeId to effect index (nodeId includes EFFECT_NODE_ID_OFFSET)
      const nodeIdNum = Number(data.nodeId);
      const EFFECT_NODE_ID_OFFSET = 10_000;
      const effectIndex = nodeIdNum - EFFECT_NODE_ID_OFFSET;

      // Update the existing convolver's impulse
      this.audioEngines[0].update_effect_impulse(effectIndex, impulse);
      console.log(`Updated convolver at index ${effectIndex} with hall reverb impulse`);

      // Trigger layout sync to update UI
      this.handleRequestSync();
    } catch (err) {
      console.error('Error generating hall reverb:', err);
    }
  }

  private handleGeneratePlateReverb(data: {
    nodeId: string;
    decayTime: number;
    diffusion: number;
    sampleRate: number;
  }) {
    if (!this.audioEngines[0]) return;
    try {
      // Generate the impulse response
      const impulse = this.audioEngines[0].generate_plate_impulse(
        data.decayTime,
        data.diffusion,
      );

      // Convert nodeId to effect index (nodeId includes EFFECT_NODE_ID_OFFSET)
      const nodeIdNum = Number(data.nodeId);
      const EFFECT_NODE_ID_OFFSET = 10_000;
      const effectIndex = nodeIdNum - EFFECT_NODE_ID_OFFSET;

      // Update the existing convolver's impulse
      this.audioEngines[0].update_effect_impulse(effectIndex, impulse);
      console.log(`Updated convolver at index ${effectIndex} with plate reverb impulse`);

      // Trigger layout sync to update UI
      this.handleRequestSync();
    } catch (err) {
      console.error('Error generating plate reverb:', err);
    }
  }

  private handleUpdateEnvelope(data: EnvelopeUpdate) {
    if (!this.audioEngines[0]) return;
    //console.log('handleUpdateEnvelope:', data);
    try {
      this.audioEngines[0].update_envelope(
        data.envelopeId,
        data.config.attack,
        data.config.decay,
        data.config.sustain,
        data.config.release,
        data.config.attackCurve,
        data.config.decayCurve,
        data.config.releaseCurve,
        data.config.active,
      );
      this.port.postMessage({
        type: 'updateEnvelopeProcessed',
        messageId: data.messageId,
      });
    } catch (err) {
      console.error('Error updating LFO:', err);
    }
  }

  private handleUpdateLfo(data: LfoUpdateData) {
    if (!this.audioEngines[0]) return;

    try {
      const lfoParams = new WasmLfoUpdateParams(
        data.params.lfoId,
        data.params.frequency,
        data.params.phaseOffset,
        data.params.waveform,
        data.params.useAbsolute,
        data.params.useNormalized,
        data.params.triggerMode,
        data.params.gain,
        data.params.active,
        data.params.loopMode,
        data.params.loopStart,
        data.params.loopEnd,
      );
      this.audioEngines[0].update_lfos(lfoParams);
    } catch (err) {
      console.error('Error updating LFO:', err);
    }
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    if (this.stopped) {
      return false;
    }

    if (!this.ready || this.audioEngines.length === 0 || this.isApplyingPatch) {
      return true;
    }

    const output = outputs[0];
    if (!output) return true;

    const outputLeft = output[0];
    const outputRight = output[1];

    if (!outputLeft || !outputRight) return true;

    const frames = outputLeft.length;
    if (!this.hasBroadcastBlockSize || frames !== this.blockSizeFrames) {
      this.blockSizeFrames = frames;
      this.hasBroadcastBlockSize = true;
      this.port.postMessage({ type: 'blockSize', blockSize: frames });
    }

    const masterGain = parameters.master_gain?.[0] ?? 1;

    if (!this.automationAdapter) {
      // IMPORTANT: Always use 8 voices to match parameter descriptors
      this.automationAdapter = new AutomationAdapter(
        8, // Fixed to match parameter descriptors
        this.macroCount,
        this.macroBufferSize,
      );
    }

    const adapter = this.automationAdapter;
    if (!adapter) return true;

    // Clear output buffers
    outputLeft.fill(0);
    outputRight.fill(0);

    // Temporary buffers for each engine's output
    const engineLeft = new Float32Array(frames);
    const engineRight = new Float32Array(frames);

    try {
      // Process each engine
      for (let e = 0; e < this.audioEngines.length; e++) {
        const engine = this.audioEngines[e];
        if (!engine) continue; // Skip if engine is undefined

        // Extract parameters for this engine
        const engineParams: Record<string, Float32Array> = {};

        // Map engine-specific parameters (gate_engine0_voice0 -> gate_0)
        for (let v = 0; v < this.numVoices; v++) {
          const gateKey = `gate_engine${e}_voice${v}`;
          const freqKey = `frequency_engine${e}_voice${v}`;
          const gainKey = `gain_engine${e}_voice${v}`;
          const velKey = `velocity_engine${e}_voice${v}`;

          if (parameters[gateKey]) {
            engineParams[`gate_${v}`] = parameters[gateKey];
          }
          if (parameters[freqKey]) {
            engineParams[`frequency_${v}`] = parameters[freqKey];
          }
          if (parameters[gainKey]) {
            engineParams[`gain_${v}`] = parameters[gainKey];
          }
          if (parameters[velKey]) {
            engineParams[`velocity_${v}`] = parameters[velKey];
          }

          // Macros
          for (let m = 0; m < 4; m++) {
            const macroKey = `macro_engine${e}_voice${v}_${m}`;
            if (parameters[macroKey]) {
              engineParams[`macro_${v}_${m}`] = parameters[macroKey];
            }
          }
        }

        // Clear engine buffers
        engineLeft.fill(0);
        engineRight.fill(0);

        // Process this engine
        adapter.processBlock(
          engine,
          engineParams,
          1.0, // Apply master gain at the end
          engineLeft,
          engineRight,
        );

        // Mix into output
        for (let i = 0; i < frames; i++) {
          const leftSample = engineLeft[i];
          const rightSample = engineRight[i];
          const outLeft = outputLeft[i];
          const outRight = outputRight[i];
          if (leftSample !== undefined && outLeft !== undefined) {
            outputLeft[i] = outLeft + leftSample;
          }
          if (rightSample !== undefined && outRight !== undefined) {
            outputRight[i] = outRight + rightSample;
          }
        }
      }

      // Apply master gain
      for (let i = 0; i < frames; i++) {
        const left = outputLeft[i];
        const right = outputRight[i];
        if (left !== undefined) outputLeft[i] = left * masterGain;
        if (right !== undefined) outputRight[i] = right * masterGain;
      }
    } catch (err) {
      console.error('Error processing automation block:', err);
    }

    return true;
  }
}

registerProcessor('synth-audio-processor', SynthAudioProcessor);
