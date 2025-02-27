/// <reference lib="webworker" />

declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (): AudioWorkletProcessor;
};

declare const registerProcessor: (
  name: string,
  processorCtor: typeof AudioWorkletProcessor,
) => void;

declare const sampleRate: number;

interface AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}

interface WasmExports {
  // allocateF32Array: (length: number) => number;
  // createBufferOffsets: (
  //   output: number,
  //   frequency: number,
  //   gain: number,
  //   detune: number,
  //   gate: number,
  //   oscillator1State: number,
  //   oscillator2State: number,
  // ) => number;
  fillSine: (
    offsetsPtr: number,
    envPtr: number,
    length: number,
    sampleRate: number,
  ) => void;
  // createEnvelopeState: (
  //   attackTime: number,
  //   decayTime: number,
  //   sustainLevel: number,
  //   releaseTime: number,
  // ) => number;
}

interface WasmMemoryPointers {
  audioBufferPtr: number;
  envelope1Ptr: number;
  frequencyPtr: number;
  gainPtr: number;
  detunePtr: number;
  gatePtr: number;
  offsetsPtr: number;
}

interface InitializeMessage {
  type: 'initialize';
  wasmBinary: ArrayBuffer;
  memory: WebAssembly.Memory;
  memorySegment: WasmMemoryPointers;
}

class WasmAudioProcessor extends AudioWorkletProcessor {
  private wasmInstance: WasmExports | null = null;
  private shared_memory: WebAssembly.Memory | null = null;
  private isInitialized = false;
  private audioBufferOffset = 0;
  private offsetsPtr = 0;
  private envPtr = 0;
  private readonly bufferSize = 128;
  private memorySegment: WasmMemoryPointers | null = null;

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      {
        name: 'frequency',
        defaultValue: 440,
        minValue: 20,
        maxValue: 20000,
        automationRate: 'a-rate',
      },
      {
        name: 'gain',
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      },
      {
        name: 'detune',
        defaultValue: 0,
        minValue: -1200,
        maxValue: 1200,
        automationRate: 'k-rate',
      },
      {
        name: 'gate',
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate',
      },
    ];
  }

  constructor() {
    super();
    this.port.onmessage = async (event: MessageEvent) => {
      if (event.data.type === 'initialize') {
        await this.initializeWasm(event.data as InitializeMessage);
      }
    };

    this.port.postMessage({ type: 'ready' });
  }

  private async initializeWasm(data: InitializeMessage): Promise<void> {
    try {
      const { wasmBinary, memory, memorySegment } = data;
      this.shared_memory = memory;
      this.memorySegment = memorySegment;
      const importObject = {
        env: {
          memory,
          abort: () => console.error('WASM abort called'),
        },
      };

      const module = await WebAssembly.compile(wasmBinary);
      const instance = await WebAssembly.instantiate(module, importObject);
      this.wasmInstance = instance.exports as unknown as WasmExports;

      // Allocate main audio output buffer
      this.audioBufferOffset = memorySegment.audioBufferPtr;
      this.envPtr = memorySegment.envelope1Ptr;
      this.offsetsPtr = memorySegment.offsetsPtr;

      console.log('Processor received pointers:', {
        audio: data.memorySegment.audioBufferPtr,
        env: data.memorySegment.envelope1Ptr,
        freq: data.memorySegment.frequencyPtr,
        gain: data.memorySegment.gainPtr,
        gate: data.memorySegment.gatePtr,
        offsets: data.memorySegment.offsetsPtr,
      });

      this.isInitialized = true;
      this.port.postMessage({ type: 'initialized' });
    } catch (error) {
      console.error('Failed to initialize WASM:', error);
      this.port.postMessage({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  lastGate = -1;
  private copyParameterToWasm(
    paramName: string,
    paramData: Float32Array,
    channelLength: number,
  ): void {
    if (!this.memorySegment) return;
    // Get the correct pointer based on parameter name
    let offset: number;
    switch (paramName) {
      case 'frequency':
        offset = this.memorySegment.frequencyPtr;
        break;
      case 'gain':
        offset = this.memorySegment.gainPtr;
        break;
      case 'detune':
        offset = this.memorySegment.detunePtr;
        break;
      case 'gate':
        offset = this.memorySegment.gatePtr;
        break;
      default:
        return;
    }

    if (!this.shared_memory) return;

    const wasmBuffer = new Float32Array(
      this.shared_memory.buffer,
      offset,
      channelLength,
    );

    const fillValue = paramData.length > 1 ? undefined : paramData[0];
    wasmBuffer.set(
      fillValue !== undefined
        ? new Float32Array(channelLength).fill(fillValue)
        : paramData,
    );
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    if (!this.isInitialized || !this.shared_memory || !this.wasmInstance)
      return true;
    const output = outputs[0];
    if (!output) return true;

    const channel = output[0];
    if (!channel) return true;

    // Copy all parameters to WASM memory
    for (const [paramName, paramData] of Object.entries(parameters)) {
      this.copyParameterToWasm(paramName, paramData, channel.length);
    }

    // Generate audio data using the offsets pointer
    this.wasmInstance.fillSine(
      this.offsetsPtr,
      this.envPtr,
      channel.length,
      sampleRate,
    );

    // Copy the result back
    const wasmMemoryBuffer = new Float32Array(
      this.shared_memory.buffer,
      this.audioBufferOffset,
      channel.length,
    );

    channel.set(wasmMemoryBuffer);

    return true;
  }
}

registerProcessor('wasm-audio-processor', WasmAudioProcessor);
