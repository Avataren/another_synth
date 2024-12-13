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
function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_export_2.set(idx, obj);
  return idx;
}
function handleError(f, args) {
  try {
    return f.apply(this, args);
  } catch (e) {
    const idx = addToExternrefTable0(e);
    wasm.__wbindgen_exn_store(idx);
  }
}
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
function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_export_2.get(idx);
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
  ModIndex: 12,
  "12": "ModIndex",
  CutoffMod: 13,
  "13": "CutoffMod",
  ResonanceMod: 14,
  "14": "ResonanceMod",
  GainMod: 15,
  "15": "GainMod",
  EnvelopeMod: 16,
  "16": "EnvelopeMod"
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
   * @param {number} num_voices
   */
  init(sample_rate, num_voices) {
    wasm.audioprocessor_init(this.__wbg_ptr, sample_rate, num_voices);
  }
  /**
   * @param {Float32Array} gates
   * @param {Float32Array} frequencies
   * @param {Float32Array} gains
   * @param {Float32Array} macro_values
   * @param {number} master_gain
   * @param {Float32Array} output_left
   * @param {Float32Array} output_right
   */
  process_audio(gates, frequencies, gains, macro_values, master_gain, output_left, output_right) {
    const ptr0 = passArrayF32ToWasm0(gates, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(frequencies, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(gains, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF32ToWasm0(macro_values, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    var ptr4 = passArrayF32ToWasm0(output_left, wasm.__wbindgen_malloc);
    var len4 = WASM_VECTOR_LEN;
    var ptr5 = passArrayF32ToWasm0(output_right, wasm.__wbindgen_malloc);
    var len5 = WASM_VECTOR_LEN;
    wasm.audioprocessor_process_audio(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, master_gain, ptr4, len4, output_left, ptr5, len5, output_right);
  }
  /**
   * @param {number} voice_index
   * @returns {any}
   */
  create_fm_voice(voice_index) {
    const ret = wasm.audioprocessor_create_fm_voice(this.__wbg_ptr, voice_index);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @param {number} voice_index
   * @param {number} node_id
   * @param {number} attack
   * @param {number} decay
   * @param {number} sustain
   * @param {number} release
   */
  update_envelope(voice_index, node_id, attack, decay, sustain, release) {
    const ret = wasm.audioprocessor_update_envelope(this.__wbg_ptr, voice_index, node_id, attack, decay, sustain, release);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} voice_index
   * @param {number} from_node
   * @param {PortId} from_port
   * @param {number} to_node
   * @param {PortId} to_port
   * @param {number} amount
   */
  connect_voice_nodes(voice_index, from_node, from_port, to_node, to_port, amount) {
    const ret = wasm.audioprocessor_connect_voice_nodes(this.__wbg_ptr, voice_index, from_node, from_port, to_node, to_port, amount);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} voice_index
   * @param {number} macro_index
   * @param {number} target_node
   * @param {PortId} target_port
   * @param {number} amount
   */
  connect_macro(voice_index, macro_index, target_node, target_port, amount) {
    const ret = wasm.audioprocessor_connect_macro(this.__wbg_ptr, voice_index, macro_index, target_node, target_port, amount);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} voice_index
   * @param {number} from_node
   * @param {PortId} from_port
   * @param {number} to_node
   * @param {PortId} to_port
   * @param {number} amount
   */
  connect_nodes(voice_index, from_node, from_port, to_node, to_port, amount) {
    const ret = wasm.audioprocessor_connect_nodes(this.__wbg_ptr, voice_index, from_node, from_port, to_node, to_port, amount);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} voice_index
   * @returns {number}
   */
  add_oscillator(voice_index) {
    const ret = wasm.audioprocessor_add_oscillator(this.__wbg_ptr, voice_index);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
};
var ConnectionIdFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_connectionid_free(ptr >>> 0, 1));
var EnvelopeConfigFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_envelopeconfig_free(ptr >>> 0, 1));
var NodeIdFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_nodeid_free(ptr >>> 0, 1));
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
  imports.wbg.__wbg_log_464d1b2190ca1e04 = function(arg0) {
    console.log(arg0);
  };
  imports.wbg.__wbg_new_688846f374351c92 = function() {
    const ret = new Object();
    return ret;
  };
  imports.wbg.__wbg_set_4e647025551483bd = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = Reflect.set(arg0, arg1, arg2);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbindgen_copy_to_typed_array = function(arg0, arg1, arg2) {
    new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
  };
  imports.wbg.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_export_2;
    const offset = table.grow(4);
    table.set(0, void 0);
    table.set(offset + 0, void 0);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
    ;
  };
  imports.wbg.__wbindgen_number_new = function(arg0) {
    const ret = arg0;
    return ret;
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

// public/wasm/audio_processor.js
var wasm2;
var cachedTextDecoder2 = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { ignoreBOM: true, fatal: true }) : { decode: () => {
  throw Error("TextDecoder not available");
} };
if (typeof TextDecoder !== "undefined") {
  cachedTextDecoder2.decode();
}
var PortId2 = Object.freeze({
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
  ModIndex: 12,
  "12": "ModIndex",
  CutoffMod: 13,
  "13": "CutoffMod",
  ResonanceMod: 14,
  "14": "ResonanceMod",
  GainMod: 15,
  "15": "GainMod",
  EnvelopeMod: 16,
  "16": "EnvelopeMod"
});
var AudioProcessorFinalization2 = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm2.__wbg_audioprocessor_free(ptr >>> 0, 1));
var ConnectionIdFinalization2 = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm2.__wbg_connectionid_free(ptr >>> 0, 1));
var EnvelopeConfigFinalization2 = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm2.__wbg_envelopeconfig_free(ptr >>> 0, 1));
var NodeIdFinalization2 = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm2.__wbg_nodeid_free(ptr >>> 0, 1));

// src/audio/worklets/synth-worklet.ts
var SynthAudioProcessor = class extends AudioWorkletProcessor {
  constructor() {
    super();
    __publicField(this, "ready", false);
    __publicField(this, "processor", null);
    __publicField(this, "numVoices", 8);
    __publicField(this, "macroPhase", 0);
    this.port.onmessage = (event) => {
      if (event.data.type === "wasm-binary") {
        const { wasmBytes } = event.data;
        initSync({ module: new Uint8Array(wasmBytes) });
        this.processor = new AudioProcessor();
        this.processor.init(sampleRate, this.numVoices);
        for (let i = 0; i < this.numVoices; i++) {
          this.setupFMVoice(i);
        }
        this.ready = true;
      }
    };
    this.port.postMessage({ type: "ready" });
  }
  static get parameterDescriptors() {
    const parameters = [];
    const numVoices = 8;
    for (let i = 0; i < numVoices; i++) {
      parameters.push(
        {
          name: `gate_${i}`,
          defaultValue: 0,
          minValue: 0,
          maxValue: 1,
          automationRate: "a-rate"
        },
        {
          name: `frequency_${i}`,
          defaultValue: 440,
          minValue: 20,
          maxValue: 2e4,
          automationRate: "a-rate"
        },
        {
          name: `gain_${i}`,
          defaultValue: 1,
          minValue: 0,
          maxValue: 1,
          automationRate: "k-rate"
        }
      );
      for (let m = 0; m < 4; m++) {
        parameters.push({
          name: `macro_${i}_${m}`,
          defaultValue: 0,
          minValue: 0,
          maxValue: 1,
          automationRate: "a-rate"
        });
      }
    }
    parameters.push({
      name: "master_gain",
      defaultValue: 1,
      minValue: 0,
      maxValue: 1,
      automationRate: "k-rate"
    });
    return parameters;
  }
  setupFMVoice(voiceIndex) {
    const { carrierId, modulatorId, envelopeId } = this.processor.create_fm_voice(voiceIndex);
    this.processor.update_envelope(
      voiceIndex,
      envelopeId,
      0.01,
      // attack
      0.2,
      // decay
      0.5,
      // sustain
      0.5
      // release
    );
    this.processor.connect_voice_nodes(
      voiceIndex,
      envelopeId,
      PortId2.AudioOutput0,
      carrierId,
      PortId2.GainMod,
      1
    );
    this.processor.connect_voice_nodes(
      voiceIndex,
      modulatorId,
      PortId2.AudioOutput0,
      carrierId,
      PortId2.PhaseMod,
      1
    );
    console.log("Setting up macro connection:", {
      voiceIndex,
      carrierId,
      targetPort: PortId2.ModIndex
    });
    this.processor.connect_macro(
      voiceIndex,
      0,
      // first macro
      carrierId,
      PortId2.ModIndex,
      1
    );
    return { carrierId, modulatorId, envelopeId };
  }
  process(_inputs, outputs, parameters) {
    if (!this.ready || !this.processor) return true;
    const output = outputs[0];
    if (!output) return true;
    const outputLeft = output[0];
    const outputRight = output[1] || output[0];
    const gateArray = new Float32Array(this.numVoices);
    const freqArray = new Float32Array(this.numVoices);
    const gainArray = new Float32Array(this.numVoices);
    const macroArray = new Float32Array(this.numVoices * 4 * 128);
    const blocksPerSecond = sampleRate / 128;
    const totalBlocksForCycle = blocksPerSecond * 4;
    const normalizedPhase = this.macroPhase % totalBlocksForCycle / totalBlocksForCycle;
    let currentValue;
    if (normalizedPhase < 0.5) {
      currentValue = normalizedPhase * 2;
    } else {
      currentValue = 2 * (1 - normalizedPhase);
    }
    for (let i = 0; i < this.numVoices; i++) {
      gateArray[i] = parameters[`gate_${i}`]?.[0] ?? 0;
      freqArray[i] = parameters[`frequency_${i}`]?.[0] ?? 440;
      gainArray[i] = parameters[`gain_${i}`]?.[0] ?? 1;
      const voiceOffset = i * 4 * 128;
      for (let m = 0; m < 4; m++) {
        const macroOffset = voiceOffset + m * 128;
        if (m === 0) {
          for (let j = 0; j < 128; j++) {
            macroArray[macroOffset + j] = currentValue;
          }
        } else {
          for (let j = 0; j < 128; j++) {
            macroArray[macroOffset + j] = 0;
          }
        }
      }
    }
    this.macroPhase += 1;
    const masterGain = parameters.master_gain?.[0] ?? 1;
    this.processor.process_audio(
      gateArray,
      freqArray,
      gainArray,
      macroArray,
      masterGain,
      outputLeft,
      outputRight
    );
    return true;
  }
};
registerProcessor("synth-audio-processor", SynthAudioProcessor);
