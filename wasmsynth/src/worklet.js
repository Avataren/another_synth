if (!globalThis.registeredProcessors)
  globalThis.registeredProcessors = new Set();

if (!globalThis.registeredProcessors.has('WasmProcessor')) {
  registerProcessor(
    'WasmProcessor',
    class WasmProcessor extends AudioWorkletProcessor {
      constructor(options) {
        super();
        let [module, memory, handle] = options.processorOptions;
        bindgen.initSync({ module, memory });
        this.processor = bindgen.WasmAudioProcessor.unpack(handle);
      }
      process(inputs, outputs) {
        if (!outputs[0] || !outputs[0][0]) {
          console.warn('No valid output buffer');
          return true;
        }
        return this.processor.process(outputs[0][0]);
      }
    },
  );
  globalThis.registeredProcessors.add('WasmProcessor');
}
