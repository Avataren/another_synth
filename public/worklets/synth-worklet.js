var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/audio/worklets/textencoder.js
(function(window) {
  "use strict";
  function TextEncoder2() {
  }
  TextEncoder2.prototype.encode = function(string) {
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
  globalThis.TextEncoder = TextEncoder2;
  if (!window["TextEncoder"]) window["TextEncoder"] = TextEncoder2;
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

// public/wasm/audio_processor.js
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
function debugString(val) {
  const type = typeof val;
  if (type == "number" || type == "boolean" || val == null) {
    return `${val}`;
  }
  if (type == "string") {
    return `"${val}"`;
  }
  if (type == "symbol") {
    const description = val.description;
    if (description == null) {
      return "Symbol";
    } else {
      return `Symbol(${description})`;
    }
  }
  if (type == "function") {
    const name = val.name;
    if (typeof name == "string" && name.length > 0) {
      return `Function(${name})`;
    } else {
      return "Function";
    }
  }
  if (Array.isArray(val)) {
    const length = val.length;
    let debug = "[";
    if (length > 0) {
      debug += debugString(val[0]);
    }
    for (let i = 1; i < length; i++) {
      debug += ", " + debugString(val[i]);
    }
    debug += "]";
    return debug;
  }
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
  let className;
  if (builtInMatches && builtInMatches.length > 1) {
    className = builtInMatches[1];
  } else {
    return toString.call(val);
  }
  if (className == "Object") {
    try {
      return "Object(" + JSON.stringify(val) + ")";
    } catch (_) {
      return "Object";
    }
  }
  if (val instanceof Error) {
    return `${val.name}: ${val.message}
${val.stack}`;
  }
  return className;
}
var WASM_VECTOR_LEN = 0;
var cachedTextEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder("utf-8") : { encode: () => {
  throw Error("TextEncoder not available");
} };
var encodeString = typeof cachedTextEncoder.encodeInto === "function" ? function(arg, view) {
  return cachedTextEncoder.encodeInto(arg, view);
} : function(arg, view) {
  const buf = cachedTextEncoder.encode(arg);
  view.set(buf);
  return {
    read: arg.length,
    written: buf.length
  };
};
function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === void 0) {
    const buf = cachedTextEncoder.encode(arg);
    const ptr2 = malloc(buf.length, 1) >>> 0;
    getUint8ArrayMemory0().subarray(ptr2, ptr2 + buf.length).set(buf);
    WASM_VECTOR_LEN = buf.length;
    return ptr2;
  }
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = getUint8ArrayMemory0();
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 127) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset);
    }
    ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
    const ret = encodeString(arg, view);
    offset += ret.written;
    ptr = realloc(ptr, len, offset, 1) >>> 0;
  }
  WASM_VECTOR_LEN = offset;
  return ptr;
}
var cachedDataViewMemory0 = null;
function getDataViewMemory0() {
  if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || cachedDataViewMemory0.buffer.detached === void 0 && cachedDataViewMemory0.buffer !== wasm.memory.buffer) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
  }
  return cachedDataViewMemory0;
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
function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_export_2.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}
var cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
  if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
    cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
  }
  return cachedFloat32ArrayMemory0;
}
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
var AudioEngineFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_audioengine_free(ptr >>> 0, 1));
var AudioEngine = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    AudioEngineFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_audioengine_free(ptr, 0);
  }
  constructor() {
    const ret = wasm.audioengine_new();
    this.__wbg_ptr = ret >>> 0;
    AudioEngineFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * @param {number} sample_rate
   * @param {number} num_voices
   */
  init(sample_rate, num_voices) {
    wasm.audioengine_init(this.__wbg_ptr, sample_rate, num_voices);
  }
  /**
   * @param {number} voice_index
   * @param {number} from_node
   * @param {PortId} from_port
   * @param {number} to_node
   * @param {PortId} to_port
   */
  remove_voice_connection(voice_index, from_node, from_port, to_node, to_port) {
    const ret = wasm.audioengine_remove_voice_connection(this.__wbg_ptr, voice_index, from_node, from_port, to_node, to_port);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @returns {any}
   */
  get_current_state() {
    const ret = wasm.audioengine_get_current_state(this.__wbg_ptr);
    return ret;
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
    wasm.audioengine_process_audio(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, master_gain, ptr4, len4, output_left, ptr5, len5, output_right);
  }
  /**
   * @param {number} voice_index
   * @param {number} num_oscillators
   * @returns {any}
   */
  initialize_voice(voice_index, num_oscillators) {
    const ret = wasm.audioengine_initialize_voice(this.__wbg_ptr, voice_index, num_oscillators);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @param {number} voice_index
   * @returns {any}
   */
  create_envelope(voice_index) {
    const ret = wasm.audioengine_create_envelope(this.__wbg_ptr, voice_index);
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
   * @param {boolean} active
   */
  update_envelope(voice_index, node_id, attack, decay, sustain, release, active) {
    const ret = wasm.audioengine_update_envelope(this.__wbg_ptr, voice_index, node_id, attack, decay, sustain, release, active);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} voice_index
   * @param {number} oscillator_id
   * @param {OscillatorStateUpdate} params
   */
  update_oscillator(voice_index, oscillator_id, params) {
    _assertClass(params, OscillatorStateUpdate);
    const ret = wasm.audioengine_update_oscillator(this.__wbg_ptr, voice_index, oscillator_id, params.__wbg_ptr);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} voice_index
   * @returns {any}
   */
  create_lfo(voice_index) {
    const ret = wasm.audioengine_create_lfo(this.__wbg_ptr, voice_index);
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
    const ret = wasm.audioengine_update_lfo(this.__wbg_ptr, voice_index, ptr0);
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
    const ret = wasm.audioengine_get_lfo_waveform(this.__wbg_ptr, waveform, buffer_size);
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
    const ret = wasm.audioengine_connect_voice_nodes(this.__wbg_ptr, voice_index, from_node, from_port, to_node, to_port, amount);
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
    const ret = wasm.audioengine_connect_macro(this.__wbg_ptr, voice_index, macro_index, target_node, target_port, amount);
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
    const ret = wasm.audioengine_connect_nodes(this.__wbg_ptr, voice_index, from_node, from_port, to_node, to_port, amount);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} voice_index
   * @returns {number}
   */
  add_oscillator(voice_index) {
    const ret = wasm.audioengine_add_oscillator(this.__wbg_ptr, voice_index);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  reset() {
    wasm.audioengine_reset(this.__wbg_ptr);
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
   * @returns {boolean}
   */
  get active() {
    const ret = wasm.__wbg_get_lfoupdateparams_active(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set active(arg0) {
    wasm.__wbg_set_lfoupdateparams_active(this.__wbg_ptr, arg0);
  }
  /**
   * @param {number} lfo_id
   * @param {number} frequency
   * @param {number} waveform
   * @param {boolean} use_absolute
   * @param {boolean} use_normalized
   * @param {number} trigger_mode
   * @param {boolean} active
   */
  constructor(lfo_id, frequency, waveform, use_absolute, use_normalized, trigger_mode, active) {
    const ret = wasm.lfoupdateparams_new(lfo_id, frequency, waveform, use_absolute, use_normalized, trigger_mode, active);
    this.__wbg_ptr = ret >>> 0;
    LfoUpdateParamsFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
};
var NodeIdFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_nodeid_free(ptr >>> 0, 1));
var OscillatorStateUpdateFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_oscillatorstateupdate_free(ptr >>> 0, 1));
var OscillatorStateUpdate = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    OscillatorStateUpdateFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_oscillatorstateupdate_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get phase_mod_amount() {
    const ret = wasm.__wbg_get_envelopeconfig_attack(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set phase_mod_amount(arg0) {
    wasm.__wbg_set_envelopeconfig_attack(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get freq_mod_amount() {
    const ret = wasm.__wbg_get_envelopeconfig_decay(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set freq_mod_amount(arg0) {
    wasm.__wbg_set_envelopeconfig_decay(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune_oct() {
    const ret = wasm.__wbg_get_envelopeconfig_sustain(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune_oct(arg0) {
    wasm.__wbg_set_envelopeconfig_sustain(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune_semi() {
    const ret = wasm.__wbg_get_envelopeconfig_release(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune_semi(arg0) {
    wasm.__wbg_set_envelopeconfig_release(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune_cents() {
    const ret = wasm.__wbg_get_envelopeconfig_attack_curve(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune_cents(arg0) {
    wasm.__wbg_set_envelopeconfig_attack_curve(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune() {
    const ret = wasm.__wbg_get_envelopeconfig_decay_curve(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune(arg0) {
    wasm.__wbg_set_envelopeconfig_decay_curve(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get hard_sync() {
    const ret = wasm.__wbg_get_oscillatorstateupdate_hard_sync(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set hard_sync(arg0) {
    wasm.__wbg_set_oscillatorstateupdate_hard_sync(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get gain() {
    const ret = wasm.__wbg_get_envelopeconfig_release_curve(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set gain(arg0) {
    wasm.__wbg_set_envelopeconfig_release_curve(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get active() {
    const ret = wasm.__wbg_get_oscillatorstateupdate_active(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set active(arg0) {
    wasm.__wbg_set_oscillatorstateupdate_active(this.__wbg_ptr, arg0);
  }
  /**
   * @param {number} phase_mod_amount
   * @param {number} freq_mod_amount
   * @param {number} detune_oct
   * @param {number} detune_semi
   * @param {number} detune_cents
   * @param {number} detune
   * @param {boolean} hard_sync
   * @param {number} gain
   * @param {boolean} active
   */
  constructor(phase_mod_amount, freq_mod_amount, detune_oct, detune_semi, detune_cents, detune, hard_sync, gain, active) {
    const ret = wasm.oscillatorstateupdate_new(phase_mod_amount, freq_mod_amount, detune_oct, detune_semi, detune_cents, detune, hard_sync, gain, active);
    this.__wbg_ptr = ret >>> 0;
    OscillatorStateUpdateFinalization.register(this, this.__wbg_ptr, this);
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
  imports.wbg.__wbg_set_1d80752d0d5f0b21 = function(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
  };
  imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
    arg0[arg1] = arg2;
  };
  imports.wbg.__wbg_set_4e647025551483bd = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = Reflect.set(arg0, arg1, arg2);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbindgen_bigint_from_u64 = function(arg0) {
    const ret = BigInt.asUintN(64, arg0);
    return ret;
  };
  imports.wbg.__wbindgen_copy_to_typed_array = function(arg0, arg1, arg2) {
    new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
  };
  imports.wbg.__wbindgen_debug_string = function(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbindgen_error_new = function(arg0, arg1) {
    const ret = new Error(getStringFromWasm0(arg0, arg1));
    return ret;
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
  cachedDataViewMemory0 = null;
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

// src/audio/worklets/handlers/oscillator-update-handler.ts
var OscillatorUpdateHandler = class {
  UpdateOscillator(engine, stateUpdate, oscillatorId, numVoices) {
    for (let i = 0; i < numVoices; i++) {
      engine.update_oscillator(i, oscillatorId, stateUpdate);
    }
  }
};

// src/audio/types/synth-layout.ts
var ModulationTarget = /* @__PURE__ */ ((ModulationTarget2) => {
  ModulationTarget2[ModulationTarget2["Frequency"] = 0] = "Frequency";
  ModulationTarget2[ModulationTarget2["Gain"] = 1] = "Gain";
  ModulationTarget2[ModulationTarget2["FilterCutoff"] = 2] = "FilterCutoff";
  ModulationTarget2[ModulationTarget2["FilterResonance"] = 3] = "FilterResonance";
  ModulationTarget2[ModulationTarget2["PhaseMod"] = 4] = "PhaseMod";
  ModulationTarget2[ModulationTarget2["ModIndex"] = 5] = "ModIndex";
  return ModulationTarget2;
})(ModulationTarget || {});
function isModulationTargetObject(target) {
  return typeof target === "object" && "value" in target;
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
    __publicField(this, "audioEngine", null);
    __publicField(this, "numVoices", 8);
    __publicField(this, "maxOscillators", 2);
    __publicField(this, "maxEnvelopes", 2);
    __publicField(this, "maxLFOs", 2);
    __publicField(this, "maxFilters", 1);
    __publicField(this, "voiceLayouts", []);
    __publicField(this, "nextNodeId", 0);
    __publicField(this, "oscHandler", new OscillatorUpdateHandler());
    this.port.onmessage = (event) => {
      if (event.data.type === "wasm-binary") {
        const { wasmBytes } = event.data;
        initSync({ module: new Uint8Array(wasmBytes) });
        this.audioEngine = new AudioEngine();
        this.audioEngine.init(sampleRate, this.numVoices);
        for (let i = 0; i < this.numVoices; i++) {
          const voiceLayout = this.initializeVoice(i);
          this.voiceLayouts.push(voiceLayout);
        }
        console.log("voiceLayouts:", this.voiceLayouts);
        const layout = {
          voices: this.voiceLayouts,
          globalNodes: {
            masterGain: this.getNextNodeId(),
            effectsChain: []
          },
          metadata: {
            maxVoices: this.numVoices,
            maxOscillators: this.maxOscillators,
            maxEnvelopes: this.maxEnvelopes,
            maxLFOs: this.maxLFOs,
            maxFilters: this.maxFilters
          }
        };
        this.port.postMessage({
          type: "synthLayout",
          layout
        });
        const engineState = this.audioEngine.get_current_state();
        console.log("Engine State from Rust:", engineState);
        this.ready = true;
      } else if (event.data.type === "updateModulation") {
        this.updateModulationForAllVoices(event.data.connection);
      } else if (event.data.type === "updateConnection") {
        const { voiceIndex, connection } = event.data;
        console.log("worklet:: got updateConnection:", voiceIndex, connection);
        this.updateConnection(voiceIndex, connection);
      } else if (event.data.type === "updateOscillator") {
        if (this.audioEngine != null) {
          const { oscillatorId, newState } = event.data;
          this.oscHandler.UpdateOscillator(
            this.audioEngine,
            new OscillatorStateUpdate(
              newState.phase_mod_amount,
              newState.freq_mod_amount,
              newState.detune_oct,
              newState.detune_semi,
              newState.detune_cents,
              newState.detune,
              newState.hard_sync,
              newState.gain,
              newState.active
            ),
            oscillatorId,
            this.numVoices
          );
        }
      } else if (event.data.type === "getNodeLayout") {
        if (!this.audioEngine) {
          this.port.postMessage({
            type: "error",
            messageId: event.data.messageId,
            message: "Audio engine not initialized"
          });
          return;
        }
        try {
          const layout = this.audioEngine.get_current_state();
          this.port.postMessage({
            type: "nodeLayout",
            messageId: event.data.messageId,
            layout: JSON.stringify(layout)
          });
        } catch (err) {
          this.port.postMessage({
            type: "error",
            messageId: event.data.messageId,
            message: err instanceof Error ? err.message : "Failed to get node layout"
          });
        }
      } else if (event.data.type === "getLfoWaveform") {
        if (this.audioEngine != null) {
          try {
            const waveformData = this.audioEngine.get_lfo_waveform(
              event.data.waveform,
              event.data.bufferSize
            );
            this.port.postMessage({
              type: "lfoWaveform",
              waveform: waveformData
            });
          } catch (err) {
            console.error("Error generating LFO waveform:", err);
            this.port.postMessage({
              type: "error",
              message: "Failed to generate LFO waveform"
            });
          }
        }
      } else if (event.data.type === "updateLfo") {
        if (this.audioEngine != null) {
          const { lfoId, params } = event.data;
          try {
            for (let i = 0; i < this.numVoices; i++) {
              const lfoParams = new LfoUpdateParams(
                lfoId,
                params.frequency,
                params.waveform,
                params.useAbsolute,
                params.useNormalized,
                params.triggerMode,
                params.active
              );
              this.audioEngine.update_lfo(i, lfoParams);
            }
          } catch (err) {
            console.error("Error updating LFO:", err);
          }
        }
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
  getNextNodeId() {
    return this.nextNodeId++;
  }
  initializeVoice(voiceIndex) {
    if (!this.audioEngine) {
      throw new Error("Audio engine not initialized");
    }
    const voiceLayout = {
      id: voiceIndex,
      nodes: {
        ["oscillator" /* Oscillator */]: [],
        ["envelope" /* Envelope */]: [],
        ["lfo" /* LFO */]: [],
        ["filter" /* Filter */]: []
      },
      connections: []
    };
    for (let i = 0; i < this.maxOscillators; i++) {
      const oscId = this.audioEngine.add_oscillator(voiceIndex);
      voiceLayout.nodes["oscillator" /* Oscillator */].push({
        id: oscId,
        type: "oscillator" /* Oscillator */
      });
    }
    for (let i = 0; i < this.maxEnvelopes; i++) {
      const result = this.audioEngine.create_envelope(voiceIndex);
      voiceLayout.nodes["envelope" /* Envelope */].push({
        id: result.envelopeId,
        type: "envelope" /* Envelope */
      });
    }
    for (let i = 0; i < this.maxLFOs; i++) {
      const result = this.audioEngine.create_lfo(voiceIndex);
      const lfoId = result.lfoId;
      voiceLayout.nodes["lfo" /* LFO */].push({
        id: lfoId,
        type: "lfo" /* LFO */
      });
      const lfoParams = new LfoUpdateParams(
        lfoId,
        2,
        // Default frequency
        0 /* Sine */,
        false,
        // Not absolute
        false,
        // Not normalized
        0 /* None */,
        false
      );
      this.audioEngine.update_lfo(voiceIndex, lfoParams);
    }
    const oscillators = voiceLayout.nodes["oscillator" /* Oscillator */];
    const [ampEnv] = voiceLayout.nodes["envelope" /* Envelope */];
    if (ampEnv && oscillators.length >= 2) {
      const [osc1, osc2] = oscillators;
      this.audioEngine.connect_voice_nodes(
        voiceIndex,
        ampEnv.id,
        PortId.AudioOutput0,
        osc1.id,
        PortId.GainMod,
        1
      );
      voiceLayout.connections.push({
        fromId: ampEnv.id,
        toId: osc1.id,
        target: 1 /* Gain */,
        amount: 1
      });
      this.audioEngine.connect_voice_nodes(
        voiceIndex,
        osc2.id,
        PortId.AudioOutput0,
        osc1.id,
        PortId.PhaseMod,
        1
      );
      voiceLayout.connections.push({
        fromId: osc2.id,
        toId: osc1.id,
        target: 4 /* PhaseMod */,
        amount: 1
      });
    }
    return voiceLayout;
  }
  isValidModulationTarget(target) {
    const targetValue = isModulationTargetObject(target) ? target.value : typeof target === "number" ? target : null;
    if (targetValue === null) return false;
    return Object.values(ModulationTarget).includes(targetValue);
  }
  getPortIdForTarget(target) {
    if (!this.isValidModulationTarget(target)) {
      console.warn("Invalid modulation target:", target);
      return PortId.GainMod;
    }
    const targetValue = isModulationTargetObject(target) ? target.value : target;
    console.log("Converting target:", targetValue);
    switch (targetValue) {
      case 0 /* Frequency */:
        return PortId.FrequencyMod;
      case 1 /* Gain */:
        return PortId.GainMod;
      case 2 /* FilterCutoff */:
        return PortId.CutoffMod;
      case 3 /* FilterResonance */:
        return PortId.ResonanceMod;
      case 4 /* PhaseMod */:
        return PortId.PhaseMod;
      case 5 /* ModIndex */:
        return PortId.ModIndex;
      default:
        console.warn("Unhandled target value, defaulting to GainMod:", targetValue);
        return PortId.GainMod;
    }
  }
  updateConnection(voiceId, connection) {
    if (!this.audioEngine || voiceId >= this.voiceLayouts.length) {
      console.warn("Invalid voice ID or audio engine not ready:", voiceId);
      return;
    }
    console.log(`Updating connection for voice ${voiceId}:`, connection);
    try {
      this.audioEngine.connect_voice_nodes(
        voiceId,
        connection.fromId,
        PortId.AudioOutput0,
        connection.toId,
        this.getPortIdForTarget(connection.target),
        connection.amount
      );
      console.log(`Connection updated for voice ${voiceId}`);
    } catch (err) {
      console.error(`Failed to update connection for voice ${voiceId}:`, err);
    }
  }
  updateModulationForAllVoices(connection) {
    if (!this.audioEngine) {
      console.warn("Audio engine not ready");
      return;
    }
    console.log("Updating modulation with connection:", connection);
    for (let voiceId = 0; voiceId < this.numVoices; voiceId++) {
      const voice = this.voiceLayouts[voiceId];
      if (!voice) continue;
      try {
        if (connection.isRemoving) {
          this.audioEngine.remove_voice_connection(
            voiceId,
            connection.fromId,
            PortId.AudioOutput0,
            connection.toId,
            this.getPortIdForTarget(connection.target)
          );
        } else {
          this.audioEngine.connect_voice_nodes(
            voiceId,
            connection.fromId,
            PortId.AudioOutput0,
            connection.toId,
            this.getPortIdForTarget(connection.target),
            connection.amount
          );
        }
        console.log(`Successfully updated voice ${voiceId}`);
      } catch (err) {
        console.error(`Failed to update modulation for voice ${voiceId}:`, err);
      }
    }
  }
  process(_inputs, outputs, parameters) {
    if (!this.ready || !this.audioEngine) return true;
    const output = outputs[0];
    if (!output) return true;
    const outputLeft = output[0];
    const outputRight = output[1] || output[0];
    if (!outputLeft || !outputRight) return true;
    const gateArray = new Float32Array(this.numVoices);
    const freqArray = new Float32Array(this.numVoices);
    const gainArray = new Float32Array(this.numVoices);
    const macroArray = new Float32Array(this.numVoices * 4 * 128);
    for (let i = 0; i < this.numVoices; i++) {
      gateArray[i] = parameters[`gate_${i}`]?.[0] ?? 0;
      freqArray[i] = parameters[`frequency_${i}`]?.[0] ?? 440;
      gainArray[i] = parameters[`gain_${i}`]?.[0] ?? 1;
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
    this.audioEngine.process_audio(
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
