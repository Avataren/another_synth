import './textencoder.js';
import {
  ENGINES_PER_WORKLET,
  VOICES_PER_ENGINE,
  MACROS_PER_VOICE,
  TOTAL_VOICES,
} from '../worklet-config.js';
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
import type { LoadPatchMessage } from '../types/worklet-messages';
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

interface InstrumentSlot {
  instrumentId: string;
  startVoice: number;
  voiceCount: number;
  voiceLimit: number;
  engine: AudioEngine;
  adapter: AutomationAdapter;
  initialized: boolean;
}

class SynthAudioProcessor extends AudioWorkletProcessor {
  private ready: boolean = false;
  private stopped: boolean = false;
  private audioEngines: AudioEngine[] = []; // Multiple AudioEngine instances
  private engineInitialized: boolean[] = []; // Track which engines have patches loaded
  private readonly numEngines = ENGINES_PER_WORKLET;
  private readonly numVoices = VOICES_PER_ENGINE;
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
  private instrumentSlots: Map<string, InstrumentSlot> = new Map();
  private scratchLeft: Float32Array = new Float32Array(0);
  private scratchRight: Float32Array = new Float32Array(0);
  private engineParamCache: Array<Record<string, Float32Array>> = [];
  private slotParamCache: Map<
    string,
    { record: Record<string, Float32Array>; voiceCount: number }
  > = new Map();
  private lastCpuResponseMs = 0;
  private readonly cpuResponseIntervalMs = 50;

  static get parameterDescriptors() {
    const parameters = [];

    // Create parameters for each engine
    for (let e = 0; e < ENGINES_PER_WORKLET; e++) {
      for (let v = 0; v < VOICES_PER_ENGINE; v++) {
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

        // Macro parameters
        for (let m = 0; m < MACROS_PER_VOICE; m++) {
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
      case 'unloadInstrument':
        this.handleUnloadInstrument(event.data);
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
        this.handleCpuUsage(event.data);
        break;
      case 'stop':
        this.handleStop();
        break;
    }
  }

  private handleStop() {
    this.stopped = true;
  }

  private handleCpuUsage(request?: { messageId?: string }) {
    if (this.isApplyingPatch || !this.ready) {
      return;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastCpuResponseMs < this.cpuResponseIntervalMs) {
      return;
    }
    this.lastCpuResponseMs = now;

    type EngineCpuSample = {
      id: string;
      cpu: number;
      voices?: number;
      instrumentId?: string;
    };

    const perEngine: EngineCpuSample[] = [];
    const perInstrument: Record<string, number> = {};
    let total = 0;

    const addUsage = (
      id: string,
      engine: AudioEngine | undefined,
      context?: { voices?: number; instrumentId?: string },
    ) => {
      if (!engine) return;
      try {
        const cpu = engine.get_cpu_usage();
        if (!Number.isFinite(cpu)) return;
        const sample: EngineCpuSample = { id, cpu };
        if (context?.voices !== undefined) sample.voices = context.voices;
        if (context?.instrumentId !== undefined) sample.instrumentId = context.instrumentId;
        perEngine.push(sample);
        if (context?.instrumentId) {
          perInstrument[context.instrumentId] =
            (perInstrument[context.instrumentId] ?? 0) + cpu;
        }
        total += cpu;
      } catch (error) {
        // Borrow conflicts are expected occasionally; skip this sample.
      }
    };

    if (this.instrumentSlots.size > 0) {
      for (const slot of this.instrumentSlots.values()) {
        if (!slot.initialized) continue;
        addUsage(
          `instrument-${slot.instrumentId}`,
          slot.engine,
          { voices: slot.voiceCount, instrumentId: slot.instrumentId },
        );
      }
    } else {
      for (let i = 0; i < this.audioEngines.length; i++) {
        if (!this.engineInitialized[i]) continue;
        addUsage(`engine-${i}`, this.audioEngines[i], { voices: this.numVoices });
      }
    }

    this.port.postMessage({
      type: 'cpuUsage',
      cpu: total,
      total,
      perEngine,
      perInstrument,
      messageId: request?.messageId,
    });
  }

  private handleDeleteNode(data: { nodeId: string }) {
    this.audioEngines[0]!.delete_node(data.nodeId);
    this.handleRequestSync();
  }

  private handleConnectMacro(data: { macroIndex: number; targetId: string; targetPort: PortId; amount: number; modulationType: WasmModulationType; modulationTransformation: ModulationTransformation; instrumentId?: string }) {
    const targetEngines: Array<{ engine: AudioEngine; voices: number }> = [];

    if (data.instrumentId) {
      const slot = this.instrumentSlots.get(data.instrumentId);
      if (slot) {
        targetEngines.push({ engine: slot.engine, voices: slot.voiceCount });
      }
    } else if (this.instrumentSlots.size > 0) {
      for (const slot of this.instrumentSlots.values()) {
        targetEngines.push({ engine: slot.engine, voices: slot.voiceCount });
      }
    } else if (this.audioEngines[0]) {
      targetEngines.push({ engine: this.audioEngines[0], voices: Math.max(1, this.numVoices) });
    }

    for (const { engine, voices } of targetEngines) {
      const connectMacro = (engine as { connect_macro?: (...args: unknown[]) => unknown }).connect_macro;
      for (let voice = 0; voice < voices; voice++) {
        if (typeof connectMacro === 'function') {
          if (connectMacro.length >= 7) {
            connectMacro.call(
              engine,
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
              engine,
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
    instrumentId?: string;
  }) {
    const uint8Data = new Uint8Array(data.data);
    const engines = this.getTargetEngines(data.instrumentId);
    for (const engine of engines) {
      engine?.import_wavetable(data.nodeId, uint8Data, 2048);
    }
  }

  private handleImportSample(data: { nodeId: string; data: ArrayBuffer; instrumentId?: string }) {
    const engines = this.getTargetEngines(data.instrumentId);
    if (engines.length === 0) return;
    try {
      const uint8Data = new Uint8Array(data.data);
      for (const engine of engines) {
        engine?.import_sample(data.nodeId, uint8Data);
      }
    } catch (err) {
      console.error('Error importing sample:', err);
    }
  }

  private handleUpdateSampler(data: SamplerUpdateData & { instrumentId?: string }) {
    const engines = this.getTargetEngines(data.instrumentId);
    if (engines.length === 0) return;
    try {
      for (const engine of engines) {
        engine?.update_sampler(
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
      }
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

      this.instrumentSlots.clear();

      // Create multiple AudioEngine instances
      this.audioEngines = [];
      this.engineInitialized = [];
      for (let i = 0; i < this.numEngines; i++) {
        const engine = new AudioEngine(sampleRate);
        engine.init(sampleRate, this.numVoices);
        this.audioEngines.push(engine);
        this.engineInitialized.push(false); // No patches loaded yet
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
      const activeEngines = this.engineInitialized.filter(Boolean).length;
      console.log(`[SynthAudioProcessor] Ready with ${this.numEngines} engines (${activeEngines} active)`);
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

  private handleLoadPatch(data: LoadPatchMessage) {
    if (!this.ready) {
      console.warn('loadPatch requested before audio engine was ready');
      return;
    }

    if (data.instrumentId !== undefined) {
      this.handleInstrumentLoadPatch({
        ...data,
        instrumentId: data.instrumentId,
      });
      return;
    }

    // Legacy single-patch mode (patch editor / non-pooled instruments)
    if (!this.audioEngines[0]) {
      console.warn('loadPatch requested before audio engine was ready');
      return;
    }

    this.instrumentSlots.clear(); // Ensure pooled state does not leak into legacy mode
    this.isApplyingPatch = true;
    try {
      // Parse once so we can reuse it for each engine instance
      const basePatch = JSON.parse(data.patchJson);

      // Initialize the patch in every engine instance so voices routed to engine1/2 are active.
      for (let i = 0; i < this.audioEngines.length; i++) {
        const engine = this.audioEngines[i];
        if (!engine) continue;

        // Clone and clamp voice count for this engine to the per-engine voice budget.
        const patchForEngine = JSON.parse(JSON.stringify(basePatch));
        if (patchForEngine?.synthState?.layout) {
          patchForEngine.synthState.layout.voiceCount = this.numVoices;
        }

        const patchJsonForEngine = JSON.stringify(patchForEngine);
        engine.initWithPatch(patchJsonForEngine);
        this.engineInitialized[i] = true;
        console.log(`[SynthAudioProcessor] Engine ${i} now active with patch`);
      }

      // IMPORTANT: Always use VOICES_PER_ENGINE for the automation adapter to match
      // the statically-defined parameter descriptors, regardless of the patch voice count.
      // This prevents out-of-bounds errors when parameters contain data for all voices
      // but the patch uses fewer voices.
      this.automationAdapter = new AutomationAdapter(
        VOICES_PER_ENGINE, // Fixed to match parameter descriptors
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

  private handleInstrumentLoadPatch(data: {
    patchJson: string;
    instrumentId: string;
    startVoice?: number;
    voiceCount?: number;
    voiceLimit?: number;
  }) {
    const { instrumentId } = data;
    const startVoice = Math.max(0, data.startVoice ?? 0);
    const voiceCount = Math.max(1, Math.min(data.voiceCount ?? VOICES_PER_ENGINE, VOICES_PER_ENGINE));

    if (startVoice >= TOTAL_VOICES || startVoice + voiceCount > TOTAL_VOICES) {
      console.warn(
        `[SynthAudioProcessor] Rejecting patch for ${instrumentId}: voices ${startVoice}-${startVoice + voiceCount - 1} exceed descriptor budget (${TOTAL_VOICES})`,
      );
      return;
    }

    // Enforce single-engine spans so pooled instruments cannot straddle engine boundaries.
    const engineLocalStart = startVoice % VOICES_PER_ENGINE;
    if (engineLocalStart + voiceCount > VOICES_PER_ENGINE) {
      console.warn(
        `[SynthAudioProcessor] Rejecting patch for ${instrumentId}: allocation ${startVoice}-${startVoice + voiceCount - 1} crosses engine boundary`,
      );
      return;
    }

    this.isApplyingPatch = true;
    try {
      const basePatch = JSON.parse(data.patchJson);
      const patchLayout = basePatch?.synthState?.layout;
      const patchVoiceCount =
        patchLayout?.voiceCount ??
        (Array.isArray(patchLayout?.voices) ? patchLayout.voices.length : undefined) ??
        voiceCount;

      const voiceLimit = Math.max(
        1,
        Math.min(
          voiceCount,
          patchVoiceCount ?? voiceCount,
          data.voiceLimit ?? voiceCount,
        ),
      );

      const patchForSlot = JSON.parse(JSON.stringify(basePatch));
      if (patchForSlot?.synthState?.layout) {
        patchForSlot.synthState.layout.voiceCount = voiceLimit;
      }

      const slot = this.getOrCreateInstrumentSlot(
        instrumentId,
        startVoice,
        voiceCount,
        voiceLimit,
      );

      slot.engine.init(sampleRate, voiceCount);
      slot.engine.initWithPatch(JSON.stringify(patchForSlot));
      slot.voiceLimit = voiceLimit;
      slot.initialized = true;

      console.log(
        `[SynthAudioProcessor] Loaded patch for instrument ${instrumentId} voices ${startVoice}-${startVoice + voiceCount - 1} (limit ${voiceLimit})`,
      );
    } catch (error) {
      console.error('Failed to load instrument patch in worklet:', error);
      this.port.postMessage({
        type: 'error',
        source: 'loadPatch',
        message: `Failed to load patch for ${instrumentId}`,
      });
    } finally {
      this.isApplyingPatch = false;
    }
  }

  private getOrCreateInstrumentSlot(
    instrumentId: string,
    startVoice: number,
    voiceCount: number,
    voiceLimit: number,
  ): InstrumentSlot {
    const existing = this.instrumentSlots.get(instrumentId);

    if (existing && existing.voiceCount === voiceCount) {
      existing.startVoice = startVoice;
      existing.voiceLimit = voiceLimit;
      return existing;
    }

    const engine = new AudioEngine(sampleRate);
    engine.init(sampleRate, voiceCount);

    const adapter = new AutomationAdapter(
      voiceCount,
      this.macroCount,
      this.macroBufferSize,
    );

    const slot: InstrumentSlot = {
      instrumentId,
      startVoice,
      voiceCount,
      voiceLimit,
      engine,
      adapter,
      initialized: false,
    };

    this.instrumentSlots.set(instrumentId, slot);
    return slot;
  }

  private handleUnloadInstrument(data: {
    instrumentId?: string;
  }) {
    if (!data.instrumentId) return;
    if (this.instrumentSlots.delete(data.instrumentId)) {
      console.log(`[SynthAudioProcessor] Unloaded instrument ${data.instrumentId}`);
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

  /**
   * Map global worklet parameter arrays into a local engine parameter map for a pooled instrument slot.
   */
  private buildEngineParamsForSlot(
    slot: InstrumentSlot,
    parameters: Record<string, Float32Array>,
    target?: Record<string, Float32Array>,
  ): Record<string, Float32Array> {
    const engineParams: Record<string, Float32Array> = target ?? {};

    for (let v = 0; v < slot.voiceCount; v++) {
      const globalVoice = slot.startVoice + v;
      if (globalVoice >= TOTAL_VOICES) break;

      const engineIndex = Math.floor(globalVoice / VOICES_PER_ENGINE);
      const voiceIndex = globalVoice % VOICES_PER_ENGINE;

      const gateKey = `gate_engine${engineIndex}_voice${voiceIndex}`;
      const freqKey = `frequency_engine${engineIndex}_voice${voiceIndex}`;
      const gainKey = `gain_engine${engineIndex}_voice${voiceIndex}`;
      const velKey = `velocity_engine${engineIndex}_voice${voiceIndex}`;

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

      for (let m = 0; m < MACROS_PER_VOICE; m++) {
        const macroKey = `macro_engine${engineIndex}_voice${voiceIndex}_${m}`;
        if (parameters[macroKey]) {
          engineParams[`macro_${v}_${m}`] = parameters[macroKey];
        }
      }
    }

    return engineParams;
  }

  private getSlotParamRecord(slot: InstrumentSlot): Record<string, Float32Array> {
    const cached = this.slotParamCache.get(slot.instrumentId);
    if (cached && cached.voiceCount === slot.voiceCount) {
      return cached.record;
    }

    const record: Record<string, Float32Array> = {};
    this.slotParamCache.set(slot.instrumentId, {
      record,
      voiceCount: slot.voiceCount,
    });
    return record;
  }

  private ensureScratchLength(frames: number) {
    if (this.scratchLeft.length !== frames) {
      this.scratchLeft = new Float32Array(frames);
      this.scratchRight = new Float32Array(frames);
    }
  }

  private getTargetEngines(instrumentId?: string): AudioEngine[] {
    if (instrumentId) {
      const slot = this.instrumentSlots.get(instrumentId);
      return slot ? [slot.engine] : [];
    }

    if (this.instrumentSlots.size > 0) {
      return Array.from(this.instrumentSlots.values()).map((slot) => slot.engine);
    }

    return this.audioEngines;
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
    const leftOut = outputLeft as Float32Array;
    const rightOut = outputRight as Float32Array;

    const frames = outputLeft.length;
    this.ensureScratchLength(frames);
    if (!this.hasBroadcastBlockSize || frames !== this.blockSizeFrames) {
      this.blockSizeFrames = frames;
      this.hasBroadcastBlockSize = true;
      this.port.postMessage({ type: 'blockSize', blockSize: frames });
    }

    const masterGain = parameters.master_gain?.[0] ?? 1;
    const hasInstrumentSlots = this.instrumentSlots.size > 0;

    // Clear output buffers
    leftOut.fill(0);
    rightOut.fill(0);

    // Temporary buffers for each engine/instrument output
    const engineLeft = this.scratchLeft;
    const engineRight = this.scratchRight;

    try {
      if (hasInstrumentSlots) {
        for (const slot of this.instrumentSlots.values()) {
          if (!slot.initialized) continue;
          const adapter = slot.adapter;
          if (!adapter) continue;

          const engineParams = this.buildEngineParamsForSlot(
            slot,
            parameters,
            this.getSlotParamRecord(slot),
          );

          // Clear engine buffers
          engineLeft.fill(0);
          engineRight.fill(0);

          adapter.processBlock(
            slot.engine,
            engineParams,
            1.0,
            engineLeft,
            engineRight,
          );

          // Mix into output
          for (let i = 0; i < frames; i++) {
            const l = engineLeft[i] ?? 0;
            const r = engineRight[i] ?? 0;
            leftOut[i] = (leftOut[i] ?? 0) + l;
            rightOut[i] = (rightOut[i] ?? 0) + r;
          }
        }
      } else {
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

        // Process each engine
        for (let e = 0; e < this.audioEngines.length; e++) {
          const engine = this.audioEngines[e];
          if (!engine) continue; // Skip if engine is undefined
          if (!this.engineInitialized[e]) continue; // Skip if engine has no patch loaded

          // Extract parameters for this engine
          let engineParams = this.engineParamCache[e];
          if (!engineParams) {
            engineParams = {};
            this.engineParamCache[e] = engineParams;
          }

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
            const l = engineLeft[i] ?? 0;
            const r = engineRight[i] ?? 0;
            leftOut[i] = (leftOut[i] ?? 0) + l;
            rightOut[i] = (rightOut[i] ?? 0) + r;
          }
        }
      }

      // Apply master gain
      for (let i = 0; i < frames; i++) {
        leftOut[i] = (leftOut[i] ?? 0) * masterGain;
        rightOut[i] = (rightOut[i] ?? 0) * masterGain;
      }
    } catch (err) {
      console.error('Error processing automation block:', err);
    }

    return true;
  }
}

registerProcessor('synth-audio-processor', SynthAudioProcessor);
