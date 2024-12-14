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
function _assertClass(instance, klass) {
  if (!(instance instanceof klass)) {
    throw new Error(`expected instance of ${klass.name}`);
  }
}
function getArrayF32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
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
  GlobalFrequency: 9,
  "9": "GlobalFrequency",
  Frequency: 10,
  "10": "Frequency",
  FrequencyMod: 11,
  "11": "FrequencyMod",
  PhaseMod: 12,
  "12": "PhaseMod",
  ModIndex: 13,
  "13": "ModIndex",
  CutoffMod: 14,
  "14": "CutoffMod",
  ResonanceMod: 15,
  "15": "ResonanceMod",
  GainMod: 16,
  "16": "GainMod",
  EnvelopeMod: 17,
  "17": "EnvelopeMod"
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
   * @param {number} num_oscillators
   * @returns {any}
   */
  initialize_voice(voice_index, num_oscillators) {
    const ret = wasm.audioprocessor_initialize_voice(this.__wbg_ptr, voice_index, num_oscillators);
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
   * @param {number} oscillator_id
   * @param {OscillatorUpdateParams} params
   */
  update_oscillator(voice_index, oscillator_id, params) {
    _assertClass(params, OscillatorUpdateParams);
    const ret = wasm.audioprocessor_update_oscillator(this.__wbg_ptr, voice_index, oscillator_id, params.__wbg_ptr);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} voice_index
   * @returns {any}
   */
  create_lfo(voice_index) {
    const ret = wasm.audioprocessor_create_lfo(this.__wbg_ptr, voice_index);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @param {number} voice_index
   * @param {LfoUpdateParams} params
   */
  update_lfo(voice_index, params) {
    _assertClass(params, LfoUpdateParams);
    var ptr0 = params.__destroy_into_raw();
    const ret = wasm.audioprocessor_update_lfo(this.__wbg_ptr, voice_index, ptr0);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} waveform
   * @param {number} buffer_size
   * @returns {Float32Array}
   */
  get_lfo_waveform(waveform, buffer_size) {
    const ret = wasm.audioprocessor_get_lfo_waveform(this.__wbg_ptr, waveform, buffer_size);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
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
var LfoUpdateParamsFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_lfoupdateparams_free(ptr >>> 0, 1));
var LfoUpdateParams = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    LfoUpdateParamsFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_lfoupdateparams_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get lfo_id() {
    const ret = wasm.__wbg_get_connectionid_0(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @param {number} arg0
   */
  set lfo_id(arg0) {
    wasm.__wbg_set_connectionid_0(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get frequency() {
    const ret = wasm.__wbg_get_envelopeconfig_decay(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set frequency(arg0) {
    wasm.__wbg_set_envelopeconfig_decay(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get waveform() {
    const ret = wasm.__wbg_get_lfoupdateparams_waveform(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set waveform(arg0) {
    wasm.__wbg_set_lfoupdateparams_waveform(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get use_absolute() {
    const ret = wasm.__wbg_get_lfoupdateparams_use_absolute(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set use_absolute(arg0) {
    wasm.__wbg_set_lfoupdateparams_use_absolute(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get use_normalized() {
    const ret = wasm.__wbg_get_lfoupdateparams_use_normalized(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set use_normalized(arg0) {
    wasm.__wbg_set_lfoupdateparams_use_normalized(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get trigger_mode() {
    const ret = wasm.__wbg_get_lfoupdateparams_trigger_mode(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set trigger_mode(arg0) {
    wasm.__wbg_set_lfoupdateparams_trigger_mode(this.__wbg_ptr, arg0);
  }
  /**
   * @param {number} lfo_id
   * @param {number} frequency
   * @param {number} waveform
   * @param {boolean} use_absolute
   * @param {boolean} use_normalized
   * @param {number} trigger_mode
   */
  constructor(lfo_id, frequency, waveform, use_absolute, use_normalized, trigger_mode) {
    const ret = wasm.lfoupdateparams_new(lfo_id, frequency, waveform, use_absolute, use_normalized, trigger_mode);
    this.__wbg_ptr = ret >>> 0;
    LfoUpdateParamsFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
};
var NodeIdFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_nodeid_free(ptr >>> 0, 1));
var OscillatorUpdateParamsFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_oscillatorupdateparams_free(ptr >>> 0, 1));
var OscillatorUpdateParams = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    OscillatorUpdateParamsFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_oscillatorupdateparams_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get frequency() {
    const ret = wasm.__wbg_get_envelopeconfig_attack(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set frequency(arg0) {
    wasm.__wbg_set_envelopeconfig_attack(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get phase_mod_amount() {
    const ret = wasm.__wbg_get_envelopeconfig_decay(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set phase_mod_amount(arg0) {
    wasm.__wbg_set_envelopeconfig_decay(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get freq_mod_amount() {
    const ret = wasm.__wbg_get_envelopeconfig_sustain(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set freq_mod_amount(arg0) {
    wasm.__wbg_set_envelopeconfig_sustain(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune() {
    const ret = wasm.__wbg_get_envelopeconfig_release(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune(arg0) {
    wasm.__wbg_set_envelopeconfig_release(this.__wbg_ptr, arg0);
  }
  /**
   * @param {number} frequency
   * @param {number} phase_mod_amount
   * @param {number} freq_mod_amount
   * @param {number} detune
   */
  constructor(frequency, phase_mod_amount, freq_mod_amount, detune) {
    const ret = wasm.oscillatorupdateparams_new(frequency, phase_mod_amount, freq_mod_amount, detune);
    this.__wbg_ptr = ret >>> 0;
    OscillatorUpdateParamsFinalization.register(this, this.__wbg_ptr, this);
    return this;
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
  imports.wbg.__wbg_log_464d1b2190ca1e04 = function(arg0) {
    console.log(arg0);
  };
  imports.wbg.__wbg_new_254fa9eac11932ae = function() {
    const ret = new Array();
    return ret;
  };
  imports.wbg.__wbg_new_688846f374351c92 = function() {
    const ret = new Object();
    return ret;
  };
  imports.wbg.__wbg_push_6edad0df4b546b2c = function(arg0, arg1) {
    const ret = arg0.push(arg1);
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

// src/audio/worklets/synth-worklet.ts
var LfoTriggerMode = /* @__PURE__ */ ((LfoTriggerMode2) => {
  LfoTriggerMode2[LfoTriggerMode2["None"] = 0] = "None";
  LfoTriggerMode2[LfoTriggerMode2["Gate"] = 1] = "Gate";
  LfoTriggerMode2[LfoTriggerMode2["Envelope"] = 2] = "Envelope";
  return LfoTriggerMode2;
})(LfoTriggerMode || {});
var LFOWaveform = /* @__PURE__ */ ((LFOWaveform2) => {
  LFOWaveform2[LFOWaveform2["Sine"] = 0] = "Sine";
  LFOWaveform2[LFOWaveform2["Triangle"] = 1] = "Triangle";
  LFOWaveform2[LFOWaveform2["Pulse"] = 2] = "Pulse";
  LFOWaveform2[LFOWaveform2["Saw"] = 3] = "Saw";
  return LFOWaveform2;
})(LFOWaveform || {});
var SynthAudioProcessor = class extends AudioWorkletProcessor {
  constructor() {
    super();
    __publicField(this, "ready", false);
    __publicField(this, "processor", null);
    __publicField(this, "numVoices", 8);
    __publicField(this, "oscillatorsPerVoice", 2);
    // Can be increased later
    __publicField(this, "voices", []);
    this.port.onmessage = (event) => {
      if (event.data.type === "wasm-binary") {
        const { wasmBytes } = event.data;
        initSync({ module: new Uint8Array(wasmBytes) });
        this.processor = new AudioProcessor();
        this.processor.init(sampleRate, this.numVoices);
        for (let i = 0; i < this.numVoices; i++) {
          this.initialize_synth(i);
        }
        this.ready = true;
      }
    };
    this.port.postMessage({ type: "ready" });
  }
  static get parameterDescriptors() {
    const parameters = [];
    const numVoices = 8;
    const oscillatorsPerVoice = 2;
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
      for (let osc = 0; osc < oscillatorsPerVoice; osc++) {
        parameters.push({
          name: `osc${osc}_detune_${i}`,
          defaultValue: 0,
          minValue: -100,
          // ±100 cents = ±1 semitone
          maxValue: 100,
          automationRate: "a-rate"
        });
      }
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
  initialize_synth(voiceIndex) {
    const result = this.processor.initialize_voice(voiceIndex, this.oscillatorsPerVoice);
    const oscillatorIds = result.oscillatorIds;
    const envelopeId = result.envelopeId;
    const { lfoId: vibratoLfoId } = this.processor.create_lfo(voiceIndex);
    const { lfoId: modLfoId } = this.processor.create_lfo(voiceIndex);
    this.voices[voiceIndex] = {
      oscillators: oscillatorIds,
      envelope: envelopeId,
      vibratoLfo: vibratoLfoId,
      modLfo: modLfoId
    };
    const vibratoLfoParams = new LfoUpdateParams(
      vibratoLfoId,
      5,
      // 5 Hz - typical vibrato rate
      0 /* Sine */,
      // smooth sine wave
      false,
      // bipolar modulation
      false,
      // full -1 to 1 range
      0 /* None */
      // free-running
    );
    this.processor.update_lfo(voiceIndex, vibratoLfoParams);
    const modLfoParams = new LfoUpdateParams(
      modLfoId,
      0.5,
      // 0.5 Hz - slow modulation
      0 /* Sine */,
      true,
      // unipolar modulation
      true,
      // normalized range
      0 /* None */
    );
    this.processor.update_lfo(voiceIndex, modLfoParams);
    this.processor.update_envelope(
      voiceIndex,
      envelopeId,
      1e-3,
      // attack
      0.2,
      // decay
      0.2,
      // sustain
      0.5
      // release
    );
    for (const oscId of oscillatorIds) {
      this.processor.connect_voice_nodes(
        voiceIndex,
        envelopeId,
        PortId.AudioOutput0,
        oscId,
        PortId.GainMod,
        1
      );
    }
    this.processor.connect_macro(
      voiceIndex,
      0,
      vibratoLfoId,
      PortId.ModIndex,
      0.1
      // Max 10% frequency variation
    );
    for (const oscId of oscillatorIds) {
      this.processor.connect_voice_nodes(
        voiceIndex,
        vibratoLfoId,
        PortId.AudioOutput0,
        oscId,
        PortId.FrequencyMod,
        0
        // Initial amount - controlled by macro
      );
    }
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
    for (let i = 0; i < this.numVoices; i++) {
      gateArray[i] = parameters[`gate_${i}`]?.[0] ?? 0;
      freqArray[i] = parameters[`frequency_${i}`]?.[0] ?? 440;
      gainArray[i] = parameters[`gain_${i}`]?.[0] ?? 1;
      const voice = this.voices[i];
      for (let osc = 0; osc < this.oscillatorsPerVoice; osc++) {
        const oscId = voice.oscillators[osc];
        const detuneValue = parameters[`osc${osc}_detune_${i}`]?.[0] ?? 0;
        const params = new OscillatorUpdateParams(
          freqArray[i],
          1,
          // phase_mod_amount
          1,
          // freq_mod_amount
          detuneValue
        );
        this.processor.update_oscillator(i, oscId, params);
      }
      const voiceOffset = i * 4 * 128;
      for (let m = 0; m < 4; m++) {
        const macroOffset = voiceOffset + m * 128;
        const macroValue = parameters[`macro_${i}_${m}`]?.[0] ?? 0;
        for (let j = 0; j < 128; j++) {
          macroArray[macroOffset + j] = macroValue;
        }
      }
    }
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
export {
  LFOWaveform,
  LfoTriggerMode
};
