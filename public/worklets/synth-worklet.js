var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/audio/worklets/textencoder.js
(function(window) {
  "use strict";
  function TextEncoder() {
  }
  TextEncoder.prototype.encode = function(string) {
    var octets = [];
    var length = string.length;
    var i = 0;
    while (i < length) {
      var codePoint = string.codePointAt(i);
      var c = 0;
      var bits = 0;
      if (codePoint <= 127) {
        c = 0;
        bits = 0;
      } else if (codePoint <= 2047) {
        c = 6;
        bits = 192;
      } else if (codePoint <= 65535) {
        c = 12;
        bits = 224;
      } else if (codePoint <= 2097151) {
        c = 18;
        bits = 240;
      }
      octets.push(bits | codePoint >> c);
      c -= 6;
      while (c >= 0) {
        octets.push(128 | codePoint >> c & 63);
        c -= 6;
      }
      i += codePoint >= 65536 ? 2 : 1;
    }
    return octets;
  };
  globalThis.TextEncoder = TextEncoder;
  if (!window["TextEncoder"]) window["TextEncoder"] = TextEncoder;
  function TextDecoder2() {
  }
  TextDecoder2.prototype.decode = function(octets) {
    if (!octets) return "";
    var string = "";
    var i = 0;
    while (i < octets.length) {
      var octet = octets[i];
      var bytesNeeded = 0;
      var codePoint = 0;
      if (octet <= 127) {
        bytesNeeded = 0;
        codePoint = octet & 255;
      } else if (octet <= 223) {
        bytesNeeded = 1;
        codePoint = octet & 31;
      } else if (octet <= 239) {
        bytesNeeded = 2;
        codePoint = octet & 15;
      } else if (octet <= 244) {
        bytesNeeded = 3;
        codePoint = octet & 7;
      }
      if (octets.length - i - bytesNeeded > 0) {
        var k = 0;
        while (k < bytesNeeded) {
          octet = octets[i + k + 1];
          codePoint = codePoint << 6 | octet & 63;
          k += 1;
        }
      } else {
        codePoint = 65533;
        bytesNeeded = octets.length - i;
      }
      string += String.fromCodePoint(codePoint);
      i += bytesNeeded + 1;
    }
    return string;
  };
  globalThis.TextDecoder = TextDecoder2;
  if (!window["TextDecoder"]) window["TextDecoder"] = TextDecoder2;
})(
  typeof globalThis == "undefined" ? typeof global == "undefined" ? typeof self == "undefined" ? void 0 : self : global : globalThis
);

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
function _assertClass(instance, klass) {
  if (!(instance instanceof klass)) {
    throw new Error(`expected instance of ${klass.name}`);
  }
}
function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_export_0.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}
var PortId = Object.freeze({
  AudioInput0: 0,
  "0": "AudioInput0",
  AudioInput1: 1,
  "1": "AudioInput1",
  AudioInput2: 2,
  "2": "AudioInput2",
  AudioInput3: 3,
  "3": "AudioInput3",
  AudioOutput0: 4,
  "4": "AudioOutput0",
  AudioOutput1: 5,
  "5": "AudioOutput1",
  AudioOutput2: 6,
  "6": "AudioOutput2",
  AudioOutput3: 7,
  "7": "AudioOutput3",
  Gate: 8,
  "8": "Gate",
  Frequency: 9,
  "9": "Frequency",
  FrequencyMod: 10,
  "10": "FrequencyMod",
  PhaseMod: 11,
  "11": "PhaseMod",
  CutoffMod: 12,
  "12": "CutoffMod",
  ResonanceMod: 13,
  "13": "ResonanceMod",
  GainMod: 14,
  "14": "GainMod",
  EnvelopeMod: 15,
  "15": "EnvelopeMod"
});
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
   * @param {Float32Array} gate
   * @param {Float32Array} frequency_param
   * @param {Float32Array} output_left
   * @param {Float32Array} output_right
   */
  process_audio(gate, frequency_param, output_left, output_right) {
    const ptr0 = passArrayF32ToWasm0(gate, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(frequency_param, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    var ptr2 = passArrayF32ToWasm0(output_left, wasm.__wbindgen_malloc);
    var len2 = WASM_VECTOR_LEN;
    var ptr3 = passArrayF32ToWasm0(output_right, wasm.__wbindgen_malloc);
    var len3 = WASM_VECTOR_LEN;
    wasm.audioprocessor_process_audio(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, output_left, ptr3, len3, output_right);
  }
  /**
   * @returns {NodeId}
   */
  add_envelope() {
    const ret = wasm.audioprocessor_add_envelope(this.__wbg_ptr);
    return NodeId.__wrap(ret);
  }
  /**
   * @returns {NodeId}
   */
  add_oscillator() {
    const ret = wasm.audioprocessor_add_oscillator(this.__wbg_ptr);
    return NodeId.__wrap(ret);
  }
  /**
   * @param {NodeId} from_node
   * @param {PortId} from_port
   * @param {NodeId} to_node
   * @param {PortId} to_port
   * @param {number} amount
   * @returns {ConnectionId}
   */
  connect_nodes(from_node, from_port, to_node, to_port, amount) {
    _assertClass(from_node, NodeId);
    var ptr0 = from_node.__destroy_into_raw();
    _assertClass(to_node, NodeId);
    var ptr1 = to_node.__destroy_into_raw();
    const ret = wasm.audioprocessor_connect_nodes(this.__wbg_ptr, ptr0, from_port, ptr1, to_port, amount);
    return ConnectionId.__wrap(ret);
  }
  /**
   * @param {NodeId} node_id
   * @param {number} attack
   * @param {number} decay
   * @param {number} sustain
   * @param {number} release
   */
  update_envelope(node_id, attack, decay, sustain, release) {
    _assertClass(node_id, NodeId);
    var ptr0 = node_id.__destroy_into_raw();
    const ret = wasm.audioprocessor_update_envelope(this.__wbg_ptr, ptr0, attack, decay, sustain, release);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
};
var ConnectionIdFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_connectionid_free(ptr >>> 0, 1));
var ConnectionId = class _ConnectionId {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_ConnectionId.prototype);
    obj.__wbg_ptr = ptr;
    ConnectionIdFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    ConnectionIdFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_connectionid_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get 0() {
    const ret = wasm.__wbg_get_connectionid_0(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @param {number} arg0
   */
  set 0(arg0) {
    wasm.__wbg_set_connectionid_0(this.__wbg_ptr, arg0);
  }
};
var EnvelopeConfigFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_envelopeconfig_free(ptr >>> 0, 1));
var NodeIdFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_nodeid_free(ptr >>> 0, 1));
var NodeId = class _NodeId {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_NodeId.prototype);
    obj.__wbg_ptr = ptr;
    NodeIdFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    NodeIdFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_nodeid_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get 0() {
    const ret = wasm.__wbg_get_nodeid_0(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @param {number} arg0
   */
  set 0(arg0) {
    wasm.__wbg_set_connectionid_0(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  as_number() {
    const ret = wasm.nodeid_as_number(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @param {number} value
   * @returns {NodeId}
   */
  static from_number(value) {
    const ret = wasm.nodeid_from_number(value);
    return _NodeId.__wrap(ret);
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
  imports.wbg.__wbindgen_string_new = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
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
    __publicField(this, "oscillatorId", null);
    __publicField(this, "envelopeId", null);
    __publicField(this, "counter", 0);
    this.port.postMessage({ type: "ready" });
    this.port.onmessage = (event) => {
      if (event.data.type === "wasm-binary") {
        const { wasmBytes } = event.data;
        const bytes = new Uint8Array(wasmBytes);
        initSync({ module: bytes });
        this.processor = new AudioProcessor();
        this.processor.init(sampleRate);
        this.oscillatorId = this.processor.add_oscillator().as_number();
        this.envelopeId = this.processor.add_envelope().as_number();
        this.processor.connect_nodes(
          NodeId.from_number(this.envelopeId),
          PortId.AudioOutput0,
          // Envelope output
          NodeId.from_number(this.oscillatorId),
          // Goes to oscillator
          PortId.GainMod,
          // As gain modulation
          1
          // Full amount
        );
        if (this.envelopeId !== null) {
          this.processor.update_envelope(
            NodeId.from_number(this.envelopeId),
            0,
            0.85,
            0.15,
            0.5
          );
        }
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
  process(_inputs, outputs, parameters) {
    if (!this.ready) return true;
    const output = outputs[0];
    if (!output) return true;
    const outputLeft = output[0] || this.emptyBuffer;
    const outputRight = output[1] || new Float32Array(outputLeft.length);
    const gate = parameters.gate;
    const frequency = parameters.frequency;
    try {
      this.processor?.process_audio(gate, frequency, outputLeft, outputRight);
    } catch (e) {
      console.error("Error in process_audio:", e);
      throw e;
    }
    return true;
  }
};
registerProcessor("synth-audio-processor", SynthAudioProcessor);
