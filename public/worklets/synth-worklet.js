var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// rust-wasm/pkg/audio_processor.js
var wasm;
var cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
var cachedTextDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }) : { decode: () => {
  throw Error("TextDecoder not available");
} };
if (typeof TextDecoder !== "undefined") {
  cachedTextDecoder.decode();
}
function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
var cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
  if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
    cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
  }
  return cachedFloat32ArrayMemory0;
}
var WASM_VECTOR_LEN = 0;
function passArrayF32ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 4, 4) >>> 0;
  getFloat32ArrayMemory0().set(arg, ptr / 4);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
var AudioProcessorFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_audioprocessor_free(ptr >>> 0, 1));
var AudioProcessor = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    AudioProcessorFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_audioprocessor_free(ptr, 0);
  }
  constructor() {
    const ret = wasm.audioprocessor_new();
    this.__wbg_ptr = ret >>> 0;
    AudioProcessorFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * @param {number} sample_rate
   */
  init(sample_rate) {
    wasm.audioprocessor_init(this.__wbg_ptr, sample_rate);
  }
  /**
   * @param {number} attack
   * @param {number} decay
   * @param {number} sustain
   * @param {number} release
   */
  update_envelope(attack, decay, sustain, release) {
    wasm.audioprocessor_update_envelope(this.__wbg_ptr, attack, decay, sustain, release);
  }
  /**
   * @param {Float32Array} _input_left
   * @param {Float32Array} _input_right
   * @param {Float32Array} gate_param
   * @param {Float32Array} frequency_param
   * @param {Float32Array} output_left
   * @param {Float32Array} output_right
   */
  process_audio(_input_left, _input_right, gate_param, frequency_param, output_left, output_right) {
    const ptr0 = passArrayF32ToWasm0(_input_left, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(_input_right, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(gate_param, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF32ToWasm0(frequency_param, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    var ptr4 = passArrayF32ToWasm0(output_left, wasm.__wbindgen_malloc);
    var len4 = WASM_VECTOR_LEN;
    var ptr5 = passArrayF32ToWasm0(output_right, wasm.__wbindgen_malloc);
    var len5 = WASM_VECTOR_LEN;
    wasm.audioprocessor_process_audio(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, output_left, ptr5, len5, output_right);
  }
};
async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        if (module.headers.get("Content-Type") != "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }
}
function __wbg_get_imports() {
  const imports = {};
  imports.wbg = {};
  imports.wbg.__wbindgen_copy_to_typed_array = function(arg0, arg1, arg2) {
    new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
  };
  imports.wbg.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_export_0;
    const offset = table.grow(4);
    table.set(0, void 0);
    table.set(offset + 0, void 0);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
    ;
  };
  imports.wbg.__wbindgen_throw = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
  };
  return imports;
}
function __wbg_init_memory(imports, memory) {
}
function __wbg_finalize_init(instance, module) {
  wasm = instance.exports;
  __wbg_init.__wbindgen_wasm_module = module;
  cachedFloat32ArrayMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}
function initSync(module) {
  if (wasm !== void 0) return wasm;
  if (typeof module !== "undefined") {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ({ module } = module);
    } else {
      console.warn("using deprecated parameters for `initSync()`; pass a single object instead");
    }
  }
  const imports = __wbg_get_imports();
  __wbg_init_memory(imports);
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module);
  }
  const instance = new WebAssembly.Instance(module, imports);
  return __wbg_finalize_init(instance, module);
}
async function __wbg_init(module_or_path) {
  if (wasm !== void 0) return wasm;
  if (typeof module_or_path !== "undefined") {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn("using deprecated parameters for the initialization function; pass a single object instead");
    }
  }
  if (typeof module_or_path === "undefined") {
    module_or_path = new URL("audio_processor_bg.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();
  if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {
    module_or_path = fetch(module_or_path);
  }
  __wbg_init_memory(imports);
  const { instance, module } = await __wbg_load(await module_or_path, imports);
  return __wbg_finalize_init(instance, module);
}

// src/audio/worklets/synth-worklet.ts
var SynthAudioProcessor = class extends AudioWorkletProcessor {
  constructor() {
    super();
    __publicField(this, "ready", false);
    __publicField(this, "emptyBuffer", new Float32Array(128));
    __publicField(this, "processor", null);
    __publicField(this, "counter", 0);
    this.port.postMessage({ type: "ready" });
    this.port.onmessage = (event) => {
      if (event.data.type === "wasm-binary") {
        const { wasmBytes } = event.data;
        const bytes = new Uint8Array(wasmBytes);
        initSync({ module: bytes });
        this.processor = new AudioProcessor();
        this.processor.init(sampleRate);
        this.processor.update_envelope(0.1, 0.2, 0.7, 0.3);
        this.ready = true;
      }
    };
  }
  static get parameterDescriptors() {
    return [
      {
        name: "frequency",
        defaultValue: 440,
        minValue: 20,
        maxValue: 2e4,
        automationRate: "a-rate"
      },
      {
        name: "gain",
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: "k-rate"
      },
      {
        name: "gate",
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: "a-rate"
      }
    ];
  }
  process(inputs, outputs, parameters) {
    if (!this.ready) return true;
    const output = outputs[0];
    const input = inputs[0];
    if (!output) return true;
    const outputLeft = output[0] || this.emptyBuffer;
    const outputRight = output[1] || new Float32Array(outputLeft.length);
    const inputLeft = input?.[0] || this.emptyBuffer;
    const inputRight = input?.[1] || this.emptyBuffer;
    const gate = parameters.gate;
    const frequency = parameters.frequency;
    this.counter++;
    if (!(this.counter % 1e3)) {
    }
    this.processor?.process_audio(
      inputLeft,
      inputRight,
      gate,
      frequency,
      outputLeft,
      outputRight
    );
    return true;
  }
};
registerProcessor("synth-audio-processor", SynthAudioProcessor);
