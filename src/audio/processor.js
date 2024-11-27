class WasmAudioProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'frequency',
        defaultValue: 440,
        minValue: 20,
        maxValue: 20000,
        automationRate: 'a-rate',
      },
    ];
  }
  constructor() {
    super();
    this.wasmInstance = null;
    this.shared_memory = null;
    this.isInitialized = false;
    this.sampleRate = sampleRate;

    // We'll use fixed offsets for our buffers
    // This is simple but reliable
    this.audioBufferOffset = 0; // Start at beginning of memory

    this.port.onmessage = async (event) => {
      if (event.data.type === 'initialize') {
        try {
          const { wasmBinary, memory } = event.data;
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
          this.audioBufferOffset = this.wasmInstance.allocateF32Array(128);
          this.paramFrequencyOffset = this.wasmInstance.allocateF32Array(128);
          this.isInitialized = true;
          this.port.postMessage({ type: 'initialized' });
        } catch (error) {
          console.error('Failed to initialize WASM:', error);
          this.port.postMessage({ type: 'error', error: error.message });
        }
      }
    };

    this.port.postMessage({ type: 'ready' });
  }

  process(_inputs, outputs, parameters) {
    if (!this.isInitialized) return true;

    const output = outputs[0];
    const channel = output[0];

    //copy parameters to wasm shared memory:
    const wasmMemoryParamBuffer = new Float32Array(
      this.shared_memory.buffer,
      this.paramFrequencyOffset,
      channel.length,
    );

    wasmMemoryParamBuffer.set(
      parameters.frequency.length > 1
        ? parameters.frequency
        : new Float32Array(channel.length).fill(parameters.frequency[0]),
    );

    try {
      // Generate our audio data
      this.wasmInstance.fillSine(
        this.audioBufferOffset, // Use our fixed offset
        channel.length,
        this.paramFrequencyOffset,
        this.sampleRate,
      );

      // Create a view of the memory where we wrote our data
      const wasmMemoryBuffer = new Float32Array(
        this.shared_memory.buffer,
        this.audioBufferOffset,
        channel.length,
      );

      // Copy to output
      channel.set(wasmMemoryBuffer);
    } catch (error) {
      console.error('Error during audio processing:', error);
    }

    return true;
  }
}

registerProcessor('wasm-audio-processor', WasmAudioProcessor);
