class WasmAudioProcessor extends AudioWorkletProcessor {
  wasmInstance = null;
  shared_memory = null;
  isInitialized = false;
  parameterBuffers = new Map();
  audioBufferOffset = 0;
  offsetsPtr = 0;
  bufferSize = 128;

  static get parameterDescriptors() {
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
    this.port.onmessage = async (event) => {
      if (event.data.type === 'initialize') {
        await this.initializeWasm(event.data);
      }
    };

    this.port.postMessage({ type: 'ready' });
  }

  async initializeWasm(data) {
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
      this.wasmInstance = instance.exports;

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
      this.offsetsPtr = this.wasmInstance.createBufferOffsets(
        this.audioBufferOffset,
        this.parameterBuffers.get('frequency'),
        this.parameterBuffers.get('gain'),
        this.parameterBuffers.get('detune'),
      );

      this.isInitialized = true;
      this.port.postMessage({ type: 'initialized' });
    } catch (error) {
      console.error('Failed to initialize WASM:', error);
      this.port.postMessage({ type: 'error', error: error.message });
    }
  }

  copyParameterToWasm(paramName, paramData, channelLength) {
    const offset = this.parameterBuffers.get(paramName);
    if (offset === undefined || !this.shared_memory) return;

    const wasmBuffer = new Float32Array(
      this.shared_memory.buffer,
      offset,
      channelLength,
    );

    wasmBuffer.set(
      paramData.length > 1
        ? paramData
        : new Float32Array(channelLength).fill(paramData[0]),
    );
  }

  process(_inputs, outputs, parameters) {
    if (!this.isInitialized || !this.shared_memory) return true;

    const output = outputs[0];
    const channel = output[0];

    // Copy all parameters to WASM memory
    for (const [paramName, paramData] of Object.entries(parameters)) {
      this.copyParameterToWasm(paramName, paramData, channel.length);
    }

    try {
      // Generate audio data using the offsets pointer
      this.wasmInstance.fillSine(this.offsetsPtr, channel.length, sampleRate);

      // Copy the result back
      const wasmMemoryBuffer = new Float32Array(
        this.shared_memory.buffer,
        this.audioBufferOffset,
        channel.length,
      );

      channel.set(wasmMemoryBuffer);
    } catch (error) {
      console.error('Error during audio processing:', error);
    }

    return true;
  }
}

registerProcessor('wasm-audio-processor', WasmAudioProcessor);
