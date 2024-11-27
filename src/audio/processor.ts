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
  allocateF32Array: (length: number) => number;
  createBufferOffsets: (
    output: number,
    frequency: number,
    gain: number,
    detune: number,
  ) => number;
  fillSine: (offsetsPtr: number, length: number, sampleRate: number) => void;
}

interface InitializeMessage {
  type: 'initialize';
  wasmBinary: ArrayBuffer;
  memory: WebAssembly.Memory;
}

class WasmAudioProcessor extends AudioWorkletProcessor {
  private wasmInstance: WasmExports | null = null;
  private shared_memory: WebAssembly.Memory | null = null;
  private isInitialized = false;
  private parameterBuffers: Map<string, number> = new Map();
  private audioBufferOffset = 0;
  private offsetsPtr = 0;
  private readonly bufferSize = 128;

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
      const { wasmBinary, memory } = data;
      this.shared_memory = memory;

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
      this.audioBufferOffset = this.wasmInstance.allocateF32Array(
        this.bufferSize,
      );

      // Allocate parameter buffers
      for (const param of WasmAudioProcessor.parameterDescriptors) {
        const offset = this.wasmInstance.allocateF32Array(this.bufferSize);
        this.parameterBuffers.set(param.name, offset);
      }

      // Create the buffer offsets struct in WASM memory
      const frequencyOffset = this.parameterBuffers.get('frequency');
      const gainOffset = this.parameterBuffers.get('gain');
      const detuneOffset = this.parameterBuffers.get('detune');

      if (
        frequencyOffset === undefined ||
        gainOffset === undefined ||
        detuneOffset === undefined
      ) {
        throw new Error('Required parameter buffers not allocated');
      }

      this.offsetsPtr = this.wasmInstance.createBufferOffsets(
        this.audioBufferOffset,
        frequencyOffset,
        gainOffset,
        detuneOffset,
      );

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

  private copyParameterToWasm(
    paramName: string,
    paramData: Float32Array,
    channelLength: number,
  ): void {
    const offset = this.parameterBuffers.get(paramName);
    if (offset === undefined || !this.shared_memory) return;

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
    this.wasmInstance.fillSine(this.offsetsPtr, channel.length, sampleRate);

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
