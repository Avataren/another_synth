var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/audio/worklets/textencoder.js
(function(window2) {
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
  if (!window2["TextEncoder"]) window2["TextEncoder"] = TextEncoder2;
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
  if (!window2["TextDecoder"]) window2["TextDecoder"] = TextDecoder2;
})(
  typeof globalThis == "undefined" ? typeof global == "undefined" ? typeof self == "undefined" ? void 0 : self : global : globalThis
);

// public/wasm/audio_processor.js
var wasm;
var cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
var MAX_SAFARI_DECODE_BYTES = 2146435072;
var numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
function getStringFromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return decodeText(ptr, len);
}
var WASM_VECTOR_LEN = 0;
var cachedTextEncoder = new TextEncoder();
if (!("encodeInto" in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function(arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
      read: arg.length,
      written: buf.length
    };
  };
}
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
    const ret = cachedTextEncoder.encodeInto(arg, view);
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
function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_export_4.set(idx, obj);
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
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
var cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
  if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
    cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
  }
  return cachedFloat32ArrayMemory0;
}
function getArrayF32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function isLikeNone(x) {
  return x === void 0 || x === null;
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
function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_export_4.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}
function _assertClass(instance, klass) {
  if (!(instance instanceof klass)) {
    throw new Error(`expected instance of ${klass.name}`);
  }
}
function passArrayF32ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 4, 4) >>> 0;
  getFloat32ArrayMemory0().set(arg, ptr / 4);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function apply_modulation_update(engine, update) {
  _assertClass(engine, AudioEngine);
  _assertClass(update, ConnectionUpdate);
  const ret = wasm.apply_modulation_update(engine.__wbg_ptr, update.__wbg_ptr);
  if (ret[1]) {
    throw takeFromExternrefTable0(ret[0]);
  }
}
function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
var FilterSlope = Object.freeze({
  Db12: 0,
  "0": "Db12",
  Db24: 1,
  "1": "Db24"
});
var FilterType = Object.freeze({
  LowPass: 0,
  "0": "LowPass",
  LowShelf: 1,
  "1": "LowShelf",
  Peaking: 2,
  "2": "Peaking",
  HighShelf: 3,
  "3": "HighShelf",
  Notch: 4,
  "4": "Notch",
  HighPass: 5,
  "5": "HighPass",
  Ladder: 6,
  "6": "Ladder",
  Comb: 7,
  "7": "Comb",
  BandPass: 8,
  "8": "BandPass"
});
var LfoLoopMode = Object.freeze({
  Off: 0,
  "0": "Off",
  Loop: 1,
  "1": "Loop",
  PingPong: 2,
  "2": "PingPong"
});
var ModulationTransformation = Object.freeze({
  None: 0,
  "0": "None",
  Invert: 1,
  "1": "Invert",
  Square: 2,
  "2": "Square",
  Cube: 3,
  "3": "Cube"
});
var NoiseType = Object.freeze({
  White: 0,
  "0": "White",
  Pink: 1,
  "1": "Pink",
  Brownian: 2,
  "2": "Brownian"
});
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
  GlobalGate: 8,
  "8": "GlobalGate",
  GlobalFrequency: 9,
  "9": "GlobalFrequency",
  GlobalVelocity: 10,
  "10": "GlobalVelocity",
  Frequency: 11,
  "11": "Frequency",
  FrequencyMod: 12,
  "12": "FrequencyMod",
  PhaseMod: 13,
  "13": "PhaseMod",
  ModIndex: 14,
  "14": "ModIndex",
  CutoffMod: 15,
  "15": "CutoffMod",
  ResonanceMod: 16,
  "16": "ResonanceMod",
  GainMod: 17,
  "17": "GainMod",
  EnvelopeMod: 18,
  "18": "EnvelopeMod",
  StereoPan: 19,
  "19": "StereoPan",
  FeedbackMod: 20,
  "20": "FeedbackMod",
  DetuneMod: 21,
  "21": "DetuneMod",
  WavetableIndex: 22,
  "22": "WavetableIndex",
  WetDryMix: 23,
  "23": "WetDryMix",
  AttackMod: 24,
  "24": "AttackMod",
  ArpGate: 25,
  "25": "ArpGate",
  CombinedGate: 26,
  "26": "CombinedGate"
});
var SamplerLoopMode = Object.freeze({
  Off: 0,
  "0": "Off",
  Loop: 1,
  "1": "Loop",
  PingPong: 2,
  "2": "PingPong"
});
var SamplerTriggerMode = Object.freeze({
  FreeRunning: 0,
  "0": "FreeRunning",
  Gate: 1,
  "1": "Gate",
  OneShot: 2,
  "2": "OneShot"
});
var WasmModulationType = Object.freeze({
  VCA: 0,
  "0": "VCA",
  Bipolar: 1,
  "1": "Bipolar",
  Additive: 2,
  "2": "Additive"
});
var WasmNoiseType = Object.freeze({
  White: 0,
  "0": "White",
  Pink: 1,
  "1": "Pink",
  Brownian: 2,
  "2": "Brownian"
});
var Waveform = Object.freeze({
  Sine: 0,
  "0": "Sine",
  Triangle: 1,
  "1": "Triangle",
  Saw: 2,
  "2": "Saw",
  Square: 3,
  "3": "Square",
  Custom: 4,
  "4": "Custom"
});
var AnalogOscillatorStateUpdateFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_analogoscillatorstateupdate_free(ptr >>> 0, 1));
var AnalogOscillatorStateUpdate = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    AnalogOscillatorStateUpdateFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_analogoscillatorstateupdate_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get phase_mod_amount() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set phase_mod_amount(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get freq_mod_amount() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_freq_mod_amount(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set freq_mod_amount(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_freq_mod_amount(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune_oct() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_detune_oct(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune_oct(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_detune_oct(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune_semi() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_detune_semi(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune_semi(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_detune_semi(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune_cents() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_detune_cents(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune_cents(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_detune_cents(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_detune(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_detune(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get hard_sync() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_hard_sync(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set hard_sync(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_hard_sync(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get gain() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_gain(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set gain(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_gain(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get active() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_active(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set active(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_active(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get feedback_amount() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_feedback_amount(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set feedback_amount(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_feedback_amount(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {Waveform}
   */
  get waveform() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_waveform(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {Waveform} arg0
   */
  set waveform(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_waveform(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get unison_voices() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_unison_voices(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @param {number} arg0
   */
  set unison_voices(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_unison_voices(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get spread() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_spread(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set spread(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_spread(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get wave_index() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_wave_index(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set wave_index(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_wave_index(this.__wbg_ptr, arg0);
  }
  /**
   * @param {number} phase_mod_amount
   * @param {number} detune
   * @param {boolean} hard_sync
   * @param {number} gain
   * @param {boolean} active
   * @param {number} feedback_amount
   * @param {Waveform} waveform
   * @param {number} unison_voices
   * @param {number} spread
   */
  constructor(phase_mod_amount, detune, hard_sync, gain, active, feedback_amount, waveform, unison_voices, spread) {
    const ret = wasm.analogoscillatorstateupdate_new(phase_mod_amount, detune, hard_sync, gain, active, feedback_amount, waveform, unison_voices, spread);
    this.__wbg_ptr = ret >>> 0;
    AnalogOscillatorStateUpdateFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
};
if (Symbol.dispose) AnalogOscillatorStateUpdate.prototype[Symbol.dispose] = AnalogOscillatorStateUpdate.prototype.free;
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
  /**
   * @returns {number}
   */
  add_chorus() {
    const ret = wasm.audioengine_add_chorus(this.__wbg_ptr);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  /**
   * @returns {any}
   */
  create_lfo() {
    const ret = wasm.audioengine_create_lfo(this.__wbg_ptr);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @returns {number}
   */
  add_limiter() {
    const ret = wasm.audioengine_add_limiter(this.__wbg_ptr);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  /**
   * @param {string} node_id_str
   */
  delete_node(node_id_str) {
    const ptr0 = passStringToWasm0(node_id_str, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_delete_node(this.__wbg_ptr, ptr0, len0);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * Update all LFOs across all voices. This is called by the host when the user
   * changes an LFO's settings.
   * @param {WasmLfoUpdateParams} params
   */
  update_lfos(params) {
    _assertClass(params, WasmLfoUpdateParams);
    var ptr0 = params.__destroy_into_raw();
    wasm.audioengine_update_lfos(this.__wbg_ptr, ptr0);
  }
  /**
   * @param {number} room_size
   * @param {number} damp
   * @param {number} wet
   * @param {number} dry
   * @param {number} width
   * @returns {number}
   */
  add_freeverb(room_size, damp, wet, dry, width) {
    const ret = wasm.audioengine_add_freeverb(this.__wbg_ptr, room_size, damp, wet, dry, width);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  /**
   * @returns {any}
   */
  create_mixer() {
    const ret = wasm.audioengine_create_mixer(this.__wbg_ptr);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @returns {string}
   */
  create_noise() {
    let deferred2_0;
    let deferred2_1;
    try {
      const ret = wasm.audioengine_create_noise(this.__wbg_ptr);
      var ptr1 = ret[0];
      var len1 = ret[1];
      if (ret[3]) {
        ptr1 = 0;
        len1 = 0;
        throw takeFromExternrefTable0(ret[2]);
      }
      deferred2_0 = ptr1;
      deferred2_1 = len1;
      return getStringFromWasm0(ptr1, len1);
    } finally {
      wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
  }
  /**
   * @param {number} node_id
   * @param {number} delay_ms
   * @param {number} feedback
   * @param {number} wet_mix
   * @param {boolean} enabled
   */
  update_delay(node_id, delay_ms, feedback, wet_mix, enabled) {
    wasm.audioengine_update_delay(this.__wbg_ptr, node_id, delay_ms, feedback, wet_mix, enabled);
  }
  /**
   * @param {string} glide_id
   * @param {number} glide_time
   * @param {boolean} active
   */
  update_glide(glide_id, glide_time, active) {
    const ptr0 = passStringToWasm0(glide_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_update_glide(this.__wbg_ptr, ptr0, len0, glide_time, active);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {string} noise_id
   * @param {NoiseUpdateParams} params
   */
  update_noise(noise_id, params) {
    const ptr0 = passStringToWasm0(noise_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(params, NoiseUpdateParams);
    const ret = wasm.audioengine_update_noise(this.__wbg_ptr, ptr0, len0, params.__wbg_ptr);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} voice_index
   * @param {number} macro_index
   * @param {string} target_node
   * @param {PortId} target_port
   * @param {number} amount
   */
  connect_macro(voice_index, macro_index, target_node, target_port, amount) {
    const ptr0 = passStringToWasm0(target_node, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_connect_macro(this.__wbg_ptr, voice_index, macro_index, ptr0, len0, target_port, amount);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {string} from_node
   * @param {PortId} from_port
   * @param {string} to_node
   * @param {PortId} to_port
   * @param {number} amount
   * @param {WasmModulationType | null | undefined} modulation_type
   * @param {ModulationTransformation} modulation_transform
   */
  connect_nodes(from_node, from_port, to_node, to_port, amount, modulation_type, modulation_transform) {
    const ptr0 = passStringToWasm0(from_node, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(to_node, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_connect_nodes(this.__wbg_ptr, ptr0, len0, from_port, ptr1, len1, to_port, amount, isLikeNone(modulation_type) ? 3 : modulation_type, modulation_transform);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @returns {string}
   */
  create_filter() {
    let deferred2_0;
    let deferred2_1;
    try {
      const ret = wasm.audioengine_create_filter(this.__wbg_ptr);
      var ptr1 = ret[0];
      var len1 = ret[1];
      if (ret[3]) {
        ptr1 = 0;
        len1 = 0;
        throw takeFromExternrefTable0(ret[2]);
      }
      deferred2_0 = ptr1;
      deferred2_1 = len1;
      return getStringFromWasm0(ptr1, len1);
    } finally {
      wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
  }
  /**
   * @returns {number}
   */
  get_cpu_usage() {
    const ret = wasm.audioengine_get_cpu_usage(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {string} sampler_id
   * @param {Uint8Array} data
   */
  import_sample(sampler_id, data) {
    const ptr0 = passStringToWasm0(sampler_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_import_sample(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {Float32Array} gates
   * @param {Float32Array} frequencies
   * @param {Float32Array} gains
   * @param {Float32Array} velocities
   * @param {Float32Array} macro_values
   * @param {number} master_gain
   * @param {Float32Array} output_left
   * @param {Float32Array} output_right
   */
  process_audio(gates, frequencies, gains, velocities, macro_values, master_gain, output_left, output_right) {
    const ptr0 = passArrayF32ToWasm0(gates, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayF32ToWasm0(frequencies, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(gains, wasm.__wbindgen_malloc);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArrayF32ToWasm0(velocities, wasm.__wbindgen_malloc);
    const len3 = WASM_VECTOR_LEN;
    const ptr4 = passArrayF32ToWasm0(macro_values, wasm.__wbindgen_malloc);
    const len4 = WASM_VECTOR_LEN;
    var ptr5 = passArrayF32ToWasm0(output_left, wasm.__wbindgen_malloc);
    var len5 = WASM_VECTOR_LEN;
    var ptr6 = passArrayF32ToWasm0(output_right, wasm.__wbindgen_malloc);
    var len6 = WASM_VECTOR_LEN;
    wasm.audioengine_process_audio(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, master_gain, ptr5, len5, output_left, ptr6, len6, output_right);
  }
  /**
   * @param {number} index
   */
  remove_effect(index) {
    const ret = wasm.audioengine_remove_effect(this.__wbg_ptr, index);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} node_id
   * @param {boolean} active
   * @param {number} base_delay_ms
   * @param {number} depth_ms
   * @param {number} lfo_rate_hz
   * @param {number} feedback
   * @param {number} feedback_filter
   * @param {number} mix
   * @param {number} stereo_phase_offset_deg
   */
  update_chorus(node_id, active, base_delay_ms, depth_ms, lfo_rate_hz, feedback, feedback_filter, mix, stereo_phase_offset_deg) {
    wasm.audioengine_update_chorus(this.__wbg_ptr, node_id, active, base_delay_ms, depth_ms, lfo_rate_hz, feedback, feedback_filter, mix, stereo_phase_offset_deg);
  }
  /**
   * @param {number} node_id
   * @param {boolean} active
   * @param {number} room_size
   * @param {number} damp
   * @param {number} wet
   * @param {number} dry
   * @param {number} width
   */
  update_reverb(node_id, active, room_size, damp, wet, dry, width) {
    wasm.audioengine_update_reverb(this.__wbg_ptr, node_id, active, room_size, damp, wet, dry, width);
  }
  /**
   * @param {number} threshold_db
   * @param {number} ratio
   * @param {number} attack_ms
   * @param {number} release_ms
   * @param {number} makeup_gain_db
   * @param {number} mix
   * @returns {number}
   */
  add_compressor(threshold_db, ratio, attack_ms, release_ms, makeup_gain_db, mix) {
    const ret = wasm.audioengine_add_compressor(this.__wbg_ptr, threshold_db, ratio, attack_ms, release_ms, makeup_gain_db, mix);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  /**
   * @returns {string}
   */
  create_sampler() {
    let deferred2_0;
    let deferred2_1;
    try {
      const ret = wasm.audioengine_create_sampler(this.__wbg_ptr);
      var ptr1 = ret[0];
      var len1 = ret[1];
      if (ret[3]) {
        ptr1 = 0;
        len1 = 0;
        throw takeFromExternrefTable0(ret[2]);
      }
      deferred2_0 = ptr1;
      deferred2_1 = len1;
      return getStringFromWasm0(ptr1, len1);
    } finally {
      wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
  }
  /**
   * @param {string} filter_id
   * @param {number} cutoff
   * @param {number} resonance
   * @param {number} gain
   * @param {number} key_tracking
   * @param {number} comb_frequency
   * @param {number} comb_dampening
   * @param {number} _oversampling
   * @param {FilterType} filter_type
   * @param {FilterSlope} filter_slope
   */
  update_filters(filter_id, cutoff, resonance, gain, key_tracking, comb_frequency, comb_dampening, _oversampling, filter_type, filter_slope) {
    const ptr0 = passStringToWasm0(filter_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_update_filters(this.__wbg_ptr, ptr0, len0, cutoff, resonance, gain, key_tracking, comb_frequency, comb_dampening, _oversampling, filter_type, filter_slope);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {string} sampler_id
   * @param {number} frequency
   * @param {number} gain
   * @param {number} loop_mode
   * @param {number} loop_start
   * @param {number} loop_end
   * @param {number} root_note
   * @param {number} trigger_mode
   * @param {boolean} active
   */
  update_sampler(sampler_id, frequency, gain, loop_mode, loop_start, loop_end, root_note, trigger_mode, active) {
    const ptr0 = passStringToWasm0(sampler_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_update_sampler(this.__wbg_ptr, ptr0, len0, frequency, gain, loop_mode, loop_start, loop_end, root_note, trigger_mode, active);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} decay_time
   * @param {number} room_size
   * @param {number} sample_rate
   * @returns {number}
   */
  add_hall_reverb(decay_time, room_size, sample_rate) {
    const ret = wasm.audioengine_add_hall_reverb(this.__wbg_ptr, decay_time, room_size, sample_rate);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  /**
   * @returns {any}
   */
  create_envelope() {
    const ret = wasm.audioengine_create_envelope(this.__wbg_ptr);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @param {string} patch_json
   * @returns {number}
   */
  initWithPatch(patch_json) {
    const ptr0 = passStringToWasm0(patch_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_initWithPatch(this.__wbg_ptr, ptr0, len0);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  /**
   * @param {number} from_idx
   * @param {number} to_idx
   */
  reorder_effects(from_idx, to_idx) {
    const ret = wasm.audioengine_reorder_effects(this.__wbg_ptr, from_idx, to_idx);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {string} node_id
   * @param {number} attack
   * @param {number} decay
   * @param {number} sustain
   * @param {number} release
   * @param {number} attack_curve
   * @param {number} decay_curve
   * @param {number} release_curve
   * @param {boolean} active
   */
  update_envelope(node_id, attack, decay, sustain, release, attack_curve, decay_curve, release_curve, active) {
    const ptr0 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_update_envelope(this.__wbg_ptr, ptr0, len0, attack, decay, sustain, release, attack_curve, decay_curve, release_curve, active);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {string} node_id
   * @param {number} sensitivity
   * @param {number} randomize
   */
  update_velocity(node_id, sensitivity, randomize) {
    const ptr0 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_update_velocity(this.__wbg_ptr, ptr0, len0, sensitivity, randomize);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} decay_time
   * @param {number} diffusion
   * @param {number} sample_rate
   * @returns {number}
   */
  add_plate_reverb(decay_time, diffusion, sample_rate) {
    const ret = wasm.audioengine_add_plate_reverb(this.__wbg_ptr, decay_time, diffusion, sample_rate);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  /**
   * @param {number} waveform
   * @param {number} phase_offset
   * @param {number} frequency
   * @param {number} buffer_size
   * @param {boolean} use_absolute
   * @param {boolean} use_normalized
   * @returns {Float32Array}
   */
  get_lfo_waveform(waveform, phase_offset, frequency, buffer_size, use_absolute, use_normalized) {
    const ret = wasm.audioengine_get_lfo_waveform(this.__wbg_ptr, waveform, phase_offset, frequency, buffer_size, use_absolute, use_normalized);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * Refactored import_wavetable function that uses the hound-based helper.
   * It accepts the WAV data as a byte slice, uses a Cursor to create a reader,
   * builds a new morph collection from the data, adds it to the synth bank under
   * the name "imported", and then updates all wavetable oscillators to use it.
   * @param {string} node_id
   * @param {Uint8Array} data
   * @param {number} base_size
   */
  import_wavetable(node_id, data, base_size) {
    const ptr0 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_import_wavetable(this.__wbg_ptr, ptr0, len0, ptr1, len1, base_size);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} node_id
   * @param {number} wet_mix
   * @param {boolean} enabled
   */
  update_convolver(node_id, wet_mix, enabled) {
    wasm.audioengine_update_convolver(this.__wbg_ptr, node_id, wet_mix, enabled);
  }
  /**
   * @returns {string}
   */
  create_oscillator() {
    let deferred2_0;
    let deferred2_1;
    try {
      const ret = wasm.audioengine_create_oscillator(this.__wbg_ptr);
      var ptr1 = ret[0];
      var len1 = ret[1];
      if (ret[3]) {
        ptr1 = 0;
        len1 = 0;
        throw takeFromExternrefTable0(ret[2]);
      }
      deferred2_0 = ptr1;
      deferred2_1 = len1;
      return getStringFromWasm0(ptr1, len1);
    } finally {
      wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
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
   * @param {string} from_node
   * @param {PortId} from_port
   * @param {string} to_node
   * @param {PortId} to_port
   */
  remove_connection(from_node, from_port, to_node, to_port) {
    const ptr0 = passStringToWasm0(from_node, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(to_node, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_remove_connection(this.__wbg_ptr, ptr0, len0, from_port, ptr1, len1, to_port);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} node_id
   * @param {boolean} active
   * @param {number} threshold_db
   * @param {number} ratio
   * @param {number} attack_ms
   * @param {number} release_ms
   * @param {number} makeup_gain_db
   * @param {number} mix
   */
  update_compressor(node_id, active, threshold_db, ratio, attack_ms, release_ms, makeup_gain_db, mix) {
    wasm.audioengine_update_compressor(this.__wbg_ptr, node_id, active, threshold_db, ratio, attack_ms, release_ms, makeup_gain_db, mix);
  }
  /**
   * @param {string} oscillator_id
   * @param {AnalogOscillatorStateUpdate} params
   */
  update_oscillator(oscillator_id, params) {
    const ptr0 = passStringToWasm0(oscillator_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(params, AnalogOscillatorStateUpdate);
    const ret = wasm.audioengine_update_oscillator(this.__wbg_ptr, ptr0, len0, params.__wbg_ptr);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @returns {any}
   */
  create_arpeggiator() {
    const ret = wasm.audioengine_create_arpeggiator(this.__wbg_ptr);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * Export raw sample data with metadata for serialization
   * @param {string} sampler_id
   * @returns {object}
   */
  export_sample_data(sampler_id) {
    const ptr0 = passStringToWasm0(sampler_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_export_sample_data(this.__wbg_ptr, ptr0, len0);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @param {AutomationFrame} frame
   * @param {number} master_gain
   * @param {Float32Array} output_left
   * @param {Float32Array} output_right
   */
  process_with_frame(frame, master_gain, output_left, output_right) {
    _assertClass(frame, AutomationFrame);
    var ptr0 = passArrayF32ToWasm0(output_left, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    var ptr1 = passArrayF32ToWasm0(output_right, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    wasm.audioengine_process_with_frame(this.__wbg_ptr, frame.__wbg_ptr, master_gain, ptr0, len0, output_left, ptr1, len1, output_right);
  }
  /**
   * @param {number} effect_id
   * @param {Uint8Array} data
   */
  import_wave_impulse(effect_id, data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_import_wave_impulse(this.__wbg_ptr, effect_id, ptr0, len0);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} sample_rate
   * @param {any} js_config
   * @param {number} preview_duration
   * @returns {Float32Array}
   */
  static get_envelope_preview(sample_rate, js_config, preview_duration) {
    const ret = wasm.audioengine_get_envelope_preview(sample_rate, js_config, preview_duration);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * @param {string} sampler_id
   * @param {number} max_points
   * @returns {Float32Array}
   */
  get_sampler_waveform(sampler_id, max_points) {
    const ptr0 = passStringToWasm0(sampler_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_get_sampler_waveform(this.__wbg_ptr, ptr0, len0, max_points);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
  }
  /**
   * Export raw convolver impulse response with metadata for serialization
   * @param {string} convolver_id
   * @returns {object}
   */
  export_convolver_data(convolver_id) {
    const ptr0 = passStringToWasm0(convolver_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_export_convolver_data(this.__wbg_ptr, ptr0, len0);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
  }
  /**
   * Generate a hall reverb impulse response and return it as a Vec<f32>
   * @param {number} decay_time
   * @param {number} room_size
   * @returns {Float32Array}
   */
  generate_hall_impulse(decay_time, room_size) {
    const ret = wasm.audioengine_generate_hall_impulse(this.__wbg_ptr, decay_time, room_size);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * Update an existing effect's impulse response (for effects that are Convolvers)
   * @param {number} effect_index
   * @param {Float32Array} impulse_response
   */
  update_effect_impulse(effect_index, impulse_response) {
    const ptr0 = passArrayF32ToWasm0(impulse_response, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_update_effect_impulse(this.__wbg_ptr, effect_index, ptr0, len0);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * Generate a plate reverb impulse response and return it as a Vec<f32>
   * @param {number} decay_time
   * @param {number} diffusion
   * @returns {Float32Array}
   */
  generate_plate_impulse(decay_time, diffusion) {
    const ret = wasm.audioengine_generate_plate_impulse(this.__wbg_ptr, decay_time, diffusion);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @param {string} node_id
   * @param {number} waveform_length
   * @returns {Float32Array}
   */
  get_filter_ir_waveform(node_id, waveform_length) {
    const ptr0 = passStringToWasm0(node_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_get_filter_ir_waveform(this.__wbg_ptr, ptr0, len0, waveform_length);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
  }
  /**
   * @returns {string | undefined}
   */
  get_gate_mixer_node_id() {
    const ret = wasm.audioengine_get_gate_mixer_node_id(this.__wbg_ptr);
    let v1;
    if (ret[0] !== 0) {
      v1 = getStringFromWasm0(ret[0], ret[1]).slice();
      wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v1;
  }
  /**
   * @param {string} from_node
   * @param {string} to_node
   * @param {PortId} to_port
   */
  remove_specific_connection(from_node, to_node, to_port) {
    const ptr0 = passStringToWasm0(from_node, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(to_node, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_remove_specific_connection(this.__wbg_ptr, ptr0, len0, ptr1, len1, to_port);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @returns {string}
   */
  create_wavetable_oscillator() {
    let deferred2_0;
    let deferred2_1;
    try {
      const ret = wasm.audioengine_create_wavetable_oscillator(this.__wbg_ptr);
      var ptr1 = ret[0];
      var len1 = ret[1];
      if (ret[3]) {
        ptr1 = 0;
        len1 = 0;
        throw takeFromExternrefTable0(ret[2]);
      }
      deferred2_0 = ptr1;
      deferred2_1 = len1;
      return getStringFromWasm0(ptr1, len1);
    } finally {
      wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
  }
  /**
   * @param {string} oscillator_id
   * @param {WavetableOscillatorStateUpdate} params
   */
  update_wavetable_oscillator(oscillator_id, params) {
    const ptr0 = passStringToWasm0(oscillator_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    _assertClass(params, WavetableOscillatorStateUpdate);
    const ret = wasm.audioengine_update_wavetable_oscillator(this.__wbg_ptr, ptr0, len0, params.__wbg_ptr);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} sample_rate
   */
  constructor(sample_rate) {
    const ret = wasm.audioengine_new(sample_rate);
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
  reset() {
    wasm.audioengine_reset(this.__wbg_ptr);
  }
  /**
   * @param {number} max_delay_ms
   * @param {number} delay_ms
   * @param {number} feedback
   * @param {number} mix
   * @returns {number}
   */
  add_delay(max_delay_ms, delay_ms, feedback, mix) {
    const ret = wasm.audioengine_add_delay(this.__wbg_ptr, max_delay_ms, delay_ms, feedback, mix);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
};
if (Symbol.dispose) AudioEngine.prototype[Symbol.dispose] = AudioEngine.prototype.free;
var AutomationAdapterFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_automationadapter_free(ptr >>> 0, 1));
var AutomationAdapter = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    AutomationAdapterFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_automationadapter_free(ptr, 0);
  }
  /**
   * @param {AudioEngine} engine
   * @param {any} parameters
   * @param {number} master_gain
   * @param {Float32Array} output_left
   * @param {Float32Array} output_right
   */
  processBlock(engine, parameters, master_gain, output_left, output_right) {
    _assertClass(engine, AudioEngine);
    var ptr0 = passArrayF32ToWasm0(output_left, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    var ptr1 = passArrayF32ToWasm0(output_right, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.automationadapter_processBlock(this.__wbg_ptr, engine.__wbg_ptr, parameters, master_gain, ptr0, len0, output_left, ptr1, len1, output_right);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {AudioEngine} engine
   * @param {ConnectionUpdate} update
   */
  applyConnectionUpdate(engine, update) {
    _assertClass(engine, AudioEngine);
    _assertClass(update, ConnectionUpdate);
    const ret = wasm.automationadapter_applyConnectionUpdate(this.__wbg_ptr, engine.__wbg_ptr, update.__wbg_ptr);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} num_voices
   * @param {number} macro_count
   * @param {number} macro_buffer_len
   */
  constructor(num_voices, macro_count, macro_buffer_len) {
    const ret = wasm.automationadapter_new(num_voices, macro_count, macro_buffer_len);
    this.__wbg_ptr = ret >>> 0;
    AutomationAdapterFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
};
if (Symbol.dispose) AutomationAdapter.prototype[Symbol.dispose] = AutomationAdapter.prototype.free;
var AutomationFrameFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_automationframe_free(ptr >>> 0, 1));
var AutomationFrame = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    AutomationFrameFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_automationframe_free(ptr, 0);
  }
  /**
   * @param {any} parameters
   */
  populateFromParameters(parameters) {
    const ret = wasm.automationframe_populateFromParameters(this.__wbg_ptr, parameters);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} num_voices
   * @param {number} macro_count
   * @param {number} macro_buffer_len
   */
  constructor(num_voices, macro_count, macro_buffer_len) {
    const ret = wasm.automationadapter_new(num_voices, macro_count, macro_buffer_len);
    this.__wbg_ptr = ret >>> 0;
    AutomationFrameFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
};
if (Symbol.dispose) AutomationFrame.prototype[Symbol.dispose] = AutomationFrame.prototype.free;
var ConnectionIdFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_connectionid_free(ptr >>> 0, 1));
var ConnectionId = class {
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
if (Symbol.dispose) ConnectionId.prototype[Symbol.dispose] = ConnectionId.prototype.free;
var ConnectionUpdateFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_connectionupdate_free(ptr >>> 0, 1));
var ConnectionUpdate = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    ConnectionUpdateFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_connectionupdate_free(ptr, 0);
  }
  /**
   * @returns {boolean}
   */
  get isRemoving() {
    const ret = wasm.connectionupdate_isRemoving(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @returns {WasmModulationType | undefined}
   */
  get modulationType() {
    const ret = wasm.connectionupdate_modulationType(this.__wbg_ptr);
    return ret === 3 ? void 0 : ret;
  }
  /**
   * @returns {ModulationTransformation}
   */
  get modulationTransformation() {
    const ret = wasm.connectionupdate_modulationTransformation(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {string}
   */
  get toId() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.connectionupdate_toId(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {number}
   */
  get amount() {
    const ret = wasm.connectionupdate_amount(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {PortId}
   */
  get target() {
    const ret = wasm.connectionupdate_target(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {string}
   */
  get fromId() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.connectionupdate_fromId(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @param {string} from_id
   * @param {string} to_id
   * @param {PortId} target
   * @param {number} amount
   * @param {ModulationTransformation} modulation_transformation
   * @param {boolean} is_removing
   * @param {WasmModulationType | null} [modulation_type]
   */
  constructor(from_id, to_id, target, amount, modulation_transformation, is_removing, modulation_type) {
    const ptr0 = passStringToWasm0(from_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(to_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.connectionupdate_new_wasm(ptr0, len0, ptr1, len1, target, amount, modulation_transformation, is_removing, isLikeNone(modulation_type) ? 3 : modulation_type);
    this.__wbg_ptr = ret >>> 0;
    ConnectionUpdateFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
};
if (Symbol.dispose) ConnectionUpdate.prototype[Symbol.dispose] = ConnectionUpdate.prototype.free;
var EnvelopeConfigFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_envelopeconfig_free(ptr >>> 0, 1));
var EnvelopeConfig = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    EnvelopeConfigFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_envelopeconfig_free(ptr, 0);
  }
  /**
   * @param {number} attack
   * @param {number} decay
   * @param {number} sustain
   * @param {number} release
   * @param {number} attack_curve
   * @param {number} decay_curve
   * @param {number} release_curve
   * @param {number} attack_smoothing_samples
   * @param {boolean} active
   */
  constructor(attack, decay, sustain, release, attack_curve, decay_curve, release_curve, attack_smoothing_samples, active) {
    const ret = wasm.envelopeconfig_new(attack, decay, sustain, release, attack_curve, decay_curve, release_curve, attack_smoothing_samples, active);
    this.__wbg_ptr = ret >>> 0;
    EnvelopeConfigFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * @returns {number}
   */
  get attack() {
    const ret = wasm.__wbg_get_envelopeconfig_attack(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set attack(arg0) {
    wasm.__wbg_set_envelopeconfig_attack(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get decay() {
    const ret = wasm.__wbg_get_envelopeconfig_decay(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set decay(arg0) {
    wasm.__wbg_set_envelopeconfig_decay(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get sustain() {
    const ret = wasm.__wbg_get_envelopeconfig_sustain(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set sustain(arg0) {
    wasm.__wbg_set_envelopeconfig_sustain(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get release() {
    const ret = wasm.__wbg_get_envelopeconfig_release(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set release(arg0) {
    wasm.__wbg_set_envelopeconfig_release(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get attack_curve() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set attack_curve(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get decay_curve() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_freq_mod_amount(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set decay_curve(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_freq_mod_amount(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get release_curve() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_detune_oct(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set release_curve(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_detune_oct(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get attack_smoothing_samples() {
    const ret = wasm.__wbg_get_envelopeconfig_attack_smoothing_samples(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @param {number} arg0
   */
  set attack_smoothing_samples(arg0) {
    wasm.__wbg_set_envelopeconfig_attack_smoothing_samples(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get active() {
    const ret = wasm.__wbg_get_envelopeconfig_active(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set active(arg0) {
    wasm.__wbg_set_envelopeconfig_active(this.__wbg_ptr, arg0);
  }
};
if (Symbol.dispose) EnvelopeConfig.prototype[Symbol.dispose] = EnvelopeConfig.prototype.free;
var NoiseUpdateFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_noiseupdate_free(ptr >>> 0, 1));
var NoiseUpdate = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    NoiseUpdateFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_noiseupdate_free(ptr, 0);
  }
  /**
   * @returns {NoiseType}
   */
  get noise_type() {
    const ret = wasm.__wbg_get_noiseupdate_noise_type(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {NoiseType} arg0
   */
  set noise_type(arg0) {
    wasm.__wbg_set_noiseupdate_noise_type(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get cutoff() {
    const ret = wasm.__wbg_get_envelopeconfig_attack(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set cutoff(arg0) {
    wasm.__wbg_set_envelopeconfig_attack(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get gain() {
    const ret = wasm.__wbg_get_envelopeconfig_decay(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set gain(arg0) {
    wasm.__wbg_set_envelopeconfig_decay(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get enabled() {
    const ret = wasm.__wbg_get_noiseupdate_enabled(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set enabled(arg0) {
    wasm.__wbg_set_noiseupdate_enabled(this.__wbg_ptr, arg0);
  }
};
if (Symbol.dispose) NoiseUpdate.prototype[Symbol.dispose] = NoiseUpdate.prototype.free;
var NoiseUpdateParamsFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_noiseupdateparams_free(ptr >>> 0, 1));
var NoiseUpdateParams = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    NoiseUpdateParamsFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_noiseupdateparams_free(ptr, 0);
  }
  /**
   * @param {WasmNoiseType} noise_type
   * @param {number} cutoff
   * @param {number} gain
   * @param {boolean} enabled
   */
  constructor(noise_type, cutoff, gain, enabled) {
    const ret = wasm.noiseupdateparams_new(noise_type, cutoff, gain, enabled);
    this.__wbg_ptr = ret >>> 0;
    NoiseUpdateParamsFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * @returns {WasmNoiseType}
   */
  get noise_type() {
    const ret = wasm.__wbg_get_noiseupdate_noise_type(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {WasmNoiseType} arg0
   */
  set noise_type(arg0) {
    wasm.__wbg_set_noiseupdate_noise_type(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get cutoff() {
    const ret = wasm.__wbg_get_envelopeconfig_attack(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set cutoff(arg0) {
    wasm.__wbg_set_envelopeconfig_attack(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get gain() {
    const ret = wasm.__wbg_get_envelopeconfig_decay(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set gain(arg0) {
    wasm.__wbg_set_envelopeconfig_decay(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get enabled() {
    const ret = wasm.__wbg_get_noiseupdate_enabled(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set enabled(arg0) {
    wasm.__wbg_set_noiseupdate_enabled(this.__wbg_ptr, arg0);
  }
};
if (Symbol.dispose) NoiseUpdateParams.prototype[Symbol.dispose] = NoiseUpdateParams.prototype.free;
var WasmLfoUpdateParamsFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_wasmlfoupdateparams_free(ptr >>> 0, 1));
var WasmLfoUpdateParams = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    WasmLfoUpdateParamsFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_wasmlfoupdateparams_free(ptr, 0);
  }
  /**
   * @param {string} lfo_id
   * @param {number} frequency
   * @param {number} phase_offset
   * @param {number} waveform
   * @param {boolean} use_absolute
   * @param {boolean} use_normalized
   * @param {number} trigger_mode
   * @param {number} gain
   * @param {boolean} active
   * @param {number} loop_mode
   * @param {number} loop_start
   * @param {number} loop_end
   */
  constructor(lfo_id, frequency, phase_offset, waveform, use_absolute, use_normalized, trigger_mode, gain, active, loop_mode, loop_start, loop_end) {
    const ptr0 = passStringToWasm0(lfo_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmlfoupdateparams_new(ptr0, len0, frequency, phase_offset, waveform, use_absolute, use_normalized, trigger_mode, gain, active, loop_mode, loop_start, loop_end);
    this.__wbg_ptr = ret >>> 0;
    WasmLfoUpdateParamsFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
};
if (Symbol.dispose) WasmLfoUpdateParams.prototype[Symbol.dispose] = WasmLfoUpdateParams.prototype.free;
var WasmNodeIdFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_wasmnodeid_free(ptr >>> 0, 1));
var WasmNodeId = class _WasmNodeId {
  static __wrap(ptr) {
    ptr = ptr >>> 0;
    const obj = Object.create(_WasmNodeId.prototype);
    obj.__wbg_ptr = ptr;
    WasmNodeIdFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    WasmNodeIdFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_wasmnodeid_free(ptr, 0);
  }
  /**
   * @param {string} s
   * @returns {WasmNodeId}
   */
  static fromString(s) {
    const ptr0 = passStringToWasm0(s, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.wasmnodeid_fromString(ptr0, len0);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return _WasmNodeId.__wrap(ret[0]);
  }
  constructor() {
    const ret = wasm.wasmnodeid_new();
    this.__wbg_ptr = ret >>> 0;
    WasmNodeIdFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * @returns {string}
   */
  toString() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.wasmnodeid_toString(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
};
if (Symbol.dispose) WasmNodeId.prototype[Symbol.dispose] = WasmNodeId.prototype.free;
var WavetableOscillatorStateUpdateFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_wavetableoscillatorstateupdate_free(ptr >>> 0, 1));
var WavetableOscillatorStateUpdate = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    WavetableOscillatorStateUpdateFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_wavetableoscillatorstateupdate_free(ptr, 0);
  }
  /**
   * @returns {number}
   */
  get phase_mod_amount() {
    const ret = wasm.__wbg_get_envelopeconfig_release(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set phase_mod_amount(arg0) {
    wasm.__wbg_set_envelopeconfig_release(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get freq_mod_amount() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set freq_mod_amount(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune_oct() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_freq_mod_amount(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune_oct(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_freq_mod_amount(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune_semi() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_detune_oct(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune_semi(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_detune_oct(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune_cents() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_detune_semi(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune_cents(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_detune_semi(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get detune() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_detune_cents(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_detune_cents(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get hard_sync() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_hard_sync(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set hard_sync(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_hard_sync(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get gain() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_detune(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set gain(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_detune(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get active() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_active(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set active(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_active(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get feedback_amount() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_gain(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set feedback_amount(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_gain(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get waveform() {
    const ret = wasm.__wbg_get_wavetableoscillatorstateupdate_waveform(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @param {number} arg0
   */
  set waveform(arg0) {
    wasm.__wbg_set_wavetableoscillatorstateupdate_waveform(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get unison_voices() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_unison_voices(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @param {number} arg0
   */
  set unison_voices(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_unison_voices(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get spread() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_spread(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set spread(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_spread(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get wavetable_index() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_wave_index(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set wavetable_index(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_wave_index(this.__wbg_ptr, arg0);
  }
  /**
   * @param {number} phase_mod_amount
   * @param {number} detune
   * @param {boolean} hard_sync
   * @param {number} gain
   * @param {boolean} active
   * @param {number} feedback_amount
   * @param {number} unison_voices
   * @param {number} spread
   * @param {number} wavetable_index
   */
  constructor(phase_mod_amount, detune, hard_sync, gain, active, feedback_amount, unison_voices, spread, wavetable_index) {
    const ret = wasm.wavetableoscillatorstateupdate_new(phase_mod_amount, detune, hard_sync, gain, active, feedback_amount, unison_voices, spread, wavetable_index);
    this.__wbg_ptr = ret >>> 0;
    WavetableOscillatorStateUpdateFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
};
if (Symbol.dispose) WavetableOscillatorStateUpdate.prototype[Symbol.dispose] = WavetableOscillatorStateUpdate.prototype.free;
var EXPECTED_RESPONSE_TYPES = /* @__PURE__ */ new Set(["basic", "cors", "default"]);
async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && EXPECTED_RESPONSE_TYPES.has(module.type);
        if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
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
  imports.wbg.__wbg_Error_e17e777aac105295 = function(arg0, arg1) {
    const ret = Error(getStringFromWasm0(arg0, arg1));
    return ret;
  };
  imports.wbg.__wbg_String_8f0eb39a4a4c2f66 = function(arg0, arg1) {
    const ret = String(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg_call_13410aac570ffff7 = function() {
    return handleError(function(arg0, arg1) {
      const ret = arg0.call(arg1);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_crypto_92ce5ebc02988b17 = function() {
    return handleError(function(arg0) {
      const ret = arg0.crypto;
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_error_99981e16d476aa5c = function(arg0) {
    console.error(arg0);
  };
  imports.wbg.__wbg_getRandomValues_98a405f989c78bd6 = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = arg0.getRandomValues(getArrayU8FromWasm0(arg1, arg2));
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_get_458e874b43b18b25 = function() {
    return handleError(function(arg0, arg1) {
      const ret = Reflect.get(arg0, arg1);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_getindex_4e77f71a06df6a25 = function(arg0, arg1) {
    const ret = arg0[arg1 >>> 0];
    return ret;
  };
  imports.wbg.__wbg_getwithrefkey_1dc361bd10053bfe = function(arg0, arg1) {
    const ret = arg0[arg1];
    return ret;
  };
  imports.wbg.__wbg_instanceof_ArrayBuffer_67f3012529f6a2dd = function(arg0) {
    let result;
    try {
      result = arg0 instanceof ArrayBuffer;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Crypto_33ac2d91cca59233 = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Crypto;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Float32Array_7d3bcffee607cdf7 = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Float32Array;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Object_fbf5fef4952ff29b = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Object;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Uint8Array_9a8378d955933db7 = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Uint8Array;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Window_12d20d558ef92592 = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Window;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_length_6bb7e81f9d7713e4 = function(arg0) {
    const ret = arg0.length;
    return ret;
  };
  imports.wbg.__wbg_length_a8cca01d07ea9653 = function(arg0) {
    const ret = arg0.length;
    return ret;
  };
  imports.wbg.__wbg_log_6c7b5f4f00b8ce3f = function(arg0) {
    console.log(arg0);
  };
  imports.wbg.__wbg_new_19c25a3f2fa63a02 = function() {
    const ret = new Object();
    return ret;
  };
  imports.wbg.__wbg_new_1f3a344cf3123716 = function() {
    const ret = new Array();
    return ret;
  };
  imports.wbg.__wbg_new_638ebfaedbf32a5e = function(arg0) {
    const ret = new Uint8Array(arg0);
    return ret;
  };
  imports.wbg.__wbg_newfromslice_eb3df67955925a7c = function(arg0, arg1) {
    const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
    return ret;
  };
  imports.wbg.__wbg_newnoargs_254190557c45b4ec = function(arg0, arg1) {
    const ret = new Function(getStringFromWasm0(arg0, arg1));
    return ret;
  };
  imports.wbg.__wbg_newwithlength_dff392ea2a428c80 = function(arg0) {
    const ret = new Float32Array(arg0 >>> 0);
    return ret;
  };
  imports.wbg.__wbg_now_1e80617bcee43265 = function() {
    const ret = Date.now();
    return ret;
  };
  imports.wbg.__wbg_prototypesetcall_3d4a26c1ed734349 = function(arg0, arg1, arg2) {
    Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
  };
  imports.wbg.__wbg_random_7ed63a0b38ee3b75 = function() {
    const ret = Math.random();
    return ret;
  };
  imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
    arg0[arg1] = arg2;
  };
  imports.wbg.__wbg_set_453345bcda80b89a = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = Reflect.set(arg0, arg1, arg2);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_set_90f6c0f7bd8c0415 = function(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
  };
  imports.wbg.__wbg_setindex_9fa996a3659904af = function(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
  };
  imports.wbg.__wbg_static_accessor_GLOBAL_8921f820c2ce3f12 = function() {
    const ret = typeof global === "undefined" ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
  };
  imports.wbg.__wbg_static_accessor_GLOBAL_THIS_f0a4409105898184 = function() {
    const ret = typeof globalThis === "undefined" ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
  };
  imports.wbg.__wbg_static_accessor_SELF_995b214ae681ff99 = function() {
    const ret = typeof self === "undefined" ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
  };
  imports.wbg.__wbg_static_accessor_WINDOW_cde3890479c675ea = function() {
    const ret = typeof window === "undefined" ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
  };
  imports.wbg.__wbg_warn_e2ada06313f92f09 = function(arg0) {
    console.warn(arg0);
  };
  imports.wbg.__wbg_wbindgenbooleanget_3fe6f642c7d97746 = function(arg0) {
    const v = arg0;
    const ret = typeof v === "boolean" ? v : void 0;
    return isLikeNone(ret) ? 16777215 : ret ? 1 : 0;
  };
  imports.wbg.__wbg_wbindgencopytotypedarray_d105febdb9374ca3 = function(arg0, arg1, arg2) {
    new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
  };
  imports.wbg.__wbg_wbindgendebugstring_99ef257a3ddda34d = function(arg0, arg1) {
    const ret = debugString(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg_wbindgenin_d7a1ee10933d2d55 = function(arg0, arg1) {
    const ret = arg0 in arg1;
    return ret;
  };
  imports.wbg.__wbg_wbindgenisnull_f3037694abe4d97a = function(arg0) {
    const ret = arg0 === null;
    return ret;
  };
  imports.wbg.__wbg_wbindgenisobject_307a53c6bd97fbf8 = function(arg0) {
    const val = arg0;
    const ret = typeof val === "object" && val !== null;
    return ret;
  };
  imports.wbg.__wbg_wbindgenisundefined_c4b71d073b92f3c5 = function(arg0) {
    const ret = arg0 === void 0;
    return ret;
  };
  imports.wbg.__wbg_wbindgenjsvallooseeq_9bec8c9be826bed1 = function(arg0, arg1) {
    const ret = arg0 == arg1;
    return ret;
  };
  imports.wbg.__wbg_wbindgennumberget_f74b4c7525ac05cb = function(arg0, arg1) {
    const obj = arg1;
    const ret = typeof obj === "number" ? obj : void 0;
    getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
  };
  imports.wbg.__wbg_wbindgenstringget_0f16a6ddddef376f = function(arg0, arg1) {
    const obj = arg1;
    const ret = typeof obj === "string" ? obj : void 0;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg_wbindgenthrow_451ec1a8469d7eb6 = function(arg0, arg1) {
    throw new Error(getStringFromWasm0(arg0, arg1));
  };
  imports.wbg.__wbindgen_cast_2241b6af4c4b2941 = function(arg0, arg1) {
    const ret = getStringFromWasm0(arg0, arg1);
    return ret;
  };
  imports.wbg.__wbindgen_cast_4625c577ab2ec9ee = function(arg0) {
    const ret = BigInt.asUintN(64, arg0);
    return ret;
  };
  imports.wbg.__wbindgen_cast_d6cd19b81560fd6e = function(arg0) {
    const ret = arg0;
    return ret;
  };
  imports.wbg.__wbindgen_init_externref_table = function() {
    const table = wasm.__wbindgen_export_4;
    const offset = table.grow(4);
    table.set(0, void 0);
    table.set(offset + 0, void 0);
    table.set(offset + 1, null);
    table.set(offset + 2, true);
    table.set(offset + 3, false);
    ;
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

// src/audio/types/synth-layout.ts
var PORT_LABELS = {
  [PortId.AudioInput0]: "Audio Input 1",
  [PortId.AudioInput1]: "Audio Input 2",
  [PortId.AudioInput2]: "Audio Input 3",
  [PortId.AudioInput3]: "Audio Input 4",
  [PortId.AudioOutput0]: "Audio Output 1",
  [PortId.AudioOutput1]: "Audio Output 2",
  [PortId.AudioOutput2]: "Audio Output 3",
  [PortId.AudioOutput3]: "Audio Output 4",
  [PortId.GlobalGate]: "Gate",
  [PortId.GlobalFrequency]: "Global Frequency",
  [PortId.GlobalVelocity]: "Global Velocity",
  [PortId.Frequency]: "Base Frequency",
  [PortId.FrequencyMod]: "Frequency Mod",
  [PortId.PhaseMod]: "Phase Mod",
  [PortId.ModIndex]: "Mod Index",
  [PortId.CutoffMod]: "Filter Cutoff",
  [PortId.ResonanceMod]: "Filter Resonance",
  [PortId.GainMod]: "Gain",
  [PortId.EnvelopeMod]: "Envelope Amount",
  [PortId.StereoPan]: "Stereo Panning",
  [PortId.FeedbackMod]: "Feedback",
  [PortId.DetuneMod]: "Detune",
  [PortId.WavetableIndex]: "Wavetable Index",
  [PortId.WetDryMix]: "Mix",
  [PortId.AttackMod]: "Attack",
  [PortId.ArpGate]: "Arpeggio gate",
  [PortId.CombinedGate]: "Combined gate"
};
function convertRawModulationType(raw) {
  if (typeof raw === "number") {
    switch (raw) {
      case 0:
        return WasmModulationType.VCA;
      case 1:
        return WasmModulationType.Bipolar;
      case 2:
        return WasmModulationType.Additive;
      default:
        console.warn("Unknown numeric modulation type:", raw);
        return WasmModulationType.Additive;
    }
  }
  switch (raw) {
    case "VCA":
      return WasmModulationType.VCA;
    case "Bipolar":
      return WasmModulationType.Bipolar;
    case "Additive":
      return WasmModulationType.Additive;
    default:
      console.warn("Unknown modulation type:", raw);
      return WasmModulationType.Additive;
  }
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
    __publicField(this, "maxOscillators", 4);
    __publicField(this, "maxEnvelopes", 4);
    __publicField(this, "maxLFOs", 4);
    __publicField(this, "maxFilters", 4);
    __publicField(this, "macroCount", 4);
    __publicField(this, "macroBufferSize", 128);
    __publicField(this, "voiceLayouts", []);
    __publicField(this, "stateVersion", 0);
    __publicField(this, "automationAdapter", null);
    __publicField(this, "isApplyingPatch", false);
    __publicField(this, "patchNodeNames", /* @__PURE__ */ new Map());
    __publicField(this, "blockSizeFrames", 128);
    __publicField(this, "hasBroadcastBlockSize", false);
    this.port.onmessage = (event) => {
      this.handleMessage(event);
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
        },
        {
          name: `velocity_${i}`,
          defaultValue: 0,
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
  handleMessage(event) {
    switch (event.data.type) {
      case "wasm-binary":
        this.handleWasmInit(event.data);
        break;
      case "loadPatch":
        this.handleLoadPatch(event.data);
        break;
      case "updateModulation":
        this.handleUpdateModulation(event.data);
        break;
      case "updateNoise":
        this.handleNoiseUpdate(event.data);
        break;
      case "updateFilter":
        this.handleUpdateFilter(event.data);
        break;
      case "updateConnection":
        this.handleUpdateConnection(event.data);
        break;
      case "updateWavetableOscillator":
        this.handleUpdateWavetableOscillator(event.data);
        break;
      case "updateOscillator":
        this.handleUpdateOscillator(event.data);
        break;
      case "getNodeLayout":
        this.handleGetNodeLayout(event.data);
        break;
      case "getLfoWaveform":
        this.handleGetLfoWaveform(event.data);
        break;
      case "updateLfo":
        this.handleUpdateLfo(event.data);
        break;
      case "updateEnvelope":
        this.handleUpdateEnvelope(event.data);
        break;
      case "requestSync":
        this.handleRequestSync();
        break;
      case "getEnvelopePreview":
        this.handleGetEnvelopePreview(event.data);
        break;
      case "getFilterIRWaveform":
        this.handleGetFilterIrWaveform(event.data);
        break;
      case "importWavetable":
        this.handleImportWavetableData(event.data);
        break;
      case "importImpulseWaveform":
        this.handleImportImpulseWaveformData(event.data);
        break;
      case "updateConvolverState":
      case "updateConvolver":
        this.handleUpdateConvolver(event.data);
        break;
      case "updateDelayState":
      case "updateDelay":
        this.handleUpdateDelay(event.data);
        break;
      case "updateCompressor":
        this.handleUpdateCompressor(event.data);
        break;
      case "updateVelocity":
        this.handleUpdateVelocity(event.data);
        break;
      case "updateGlide":
        this.handleUpdateGlide(event.data);
        break;
      case "deleteNode":
        this.handleDeleteNode(event.data);
        break;
      case "createNode":
        this.handleCreateNode(event.data);
        break;
      case "updateChorus":
        this.handleUpdateChorus(event.data);
        break;
      case "updateReverb":
        this.handleUpdateReverb(event.data);
        break;
      case "updateSampler":
        this.handleUpdateSampler(event.data);
        break;
      case "importSample":
        this.handleImportSample(event.data);
        break;
      case "getSamplerWaveform":
        this.handleGetSamplerWaveform(event.data);
        break;
      case "exportSampleData":
        this.handleExportSampleData(event.data);
        break;
      case "exportConvolverData":
        this.handleExportConvolverData(event.data);
        break;
      case "generateHallReverb":
        this.handleGenerateHallReverb(event.data);
        break;
      case "generatePlateReverb":
        this.handleGeneratePlateReverb(event.data);
        break;
      case "cpuUsage":
        this.handleCpuUsage();
        break;
    }
  }
  handleCpuUsage() {
    if (!this.audioEngine || this.isApplyingPatch || !this.ready) {
      return;
    }
    try {
      const cpu = this.audioEngine.get_cpu_usage();
      this.port.postMessage({ type: "cpuUsage", cpu });
    } catch (error) {
    }
  }
  handleDeleteNode(data) {
    this.audioEngine.delete_node(data.nodeId);
    this.handleRequestSync();
  }
  handleCreateNode(data) {
    const nodeType = data.node ?? data.nodeType;
    if (nodeType === void 0) {
      console.error("handleCreateNode received no node type payload", data);
      return;
    }
    console.log("handleCreateNode: ", nodeType);
    switch (nodeType) {
      case "oscillator" /* Oscillator */:
        this.audioEngine.create_oscillator();
        break;
      case "filter" /* Filter */:
        this.audioEngine.create_filter();
        break;
      case "lfo" /* LFO */:
        this.audioEngine.create_lfo();
        break;
      case "wavetable_oscillator" /* WavetableOscillator */:
        this.audioEngine.create_wavetable_oscillator();
        break;
      case "noise" /* Noise */:
        this.audioEngine.create_noise();
        break;
      case "sampler" /* Sampler */:
        this.audioEngine.create_sampler();
        break;
      case "envelope" /* Envelope */:
        this.audioEngine.create_envelope();
        break;
      case "convolver" /* Convolver */:
      case "delay" /* Delay */:
      case "chorus" /* Chorus */:
      case "freeverb" /* Reverb */:
      case "compressor" /* Compressor */:
        console.warn("Effect nodes are created by default; skipping explicit creation for", nodeType);
        break;
      default:
        console.error("Missing creation case for: ", nodeType);
        break;
    }
    this.handleRequestSync();
  }
  handleImportImpulseWaveformData(data) {
    if (!this.audioEngine) return;
    const effectId = Number(data.nodeId);
    if (!Number.isFinite(effectId)) {
      console.error(
        "handleImportImpulseWaveformData: invalid nodeId for effect:",
        data.nodeId
      );
      return;
    }
    const uint8Data = new Uint8Array(data.data);
    this.audioEngine.import_wave_impulse(effectId, uint8Data);
  }
  handleImportWavetableData(data) {
    const uint8Data = new Uint8Array(data.data);
    this.audioEngine.import_wavetable(data.nodeId, uint8Data, 2048);
  }
  handleImportSample(data) {
    if (!this.audioEngine) return;
    try {
      const uint8Data = new Uint8Array(data.data);
      this.audioEngine.import_sample(data.nodeId, uint8Data);
    } catch (err) {
      console.error("Error importing sample:", err);
    }
  }
  handleUpdateSampler(data) {
    if (!this.audioEngine) return;
    try {
      this.audioEngine.update_sampler(
        data.samplerId,
        data.state.frequency,
        data.state.gain,
        data.state.loopMode,
        data.state.loopStart,
        data.state.loopEnd,
        data.state.rootNote,
        data.state.triggerMode,
        data.state.active
      );
    } catch (err) {
      console.error("Error updating sampler:", err);
    }
  }
  // Inside SynthAudioProcessor's handleMessage method:
  handleGetEnvelopePreview(data) {
    if (!this.audioEngine) return;
    try {
      const envelopePreviewData = AudioEngine.get_envelope_preview(
        sampleRate,
        data.config,
        // The envelope configuration (should match EnvelopeConfig)
        data.previewDuration
      );
      this.port.postMessage({
        type: "envelopePreview",
        preview: envelopePreviewData,
        // This is already a Float32Array.
        source: "getEnvelopePreview"
      });
    } catch (err) {
      console.error("Error generating envelope preview:", err);
      this.port.postMessage({
        type: "error",
        source: "getEnvelopePreview",
        message: "Failed to generate envelope preview"
      });
    }
  }
  handleWasmInit(data) {
    try {
      const { wasmBytes } = data;
      initSync({ module: new Uint8Array(wasmBytes) });
      console.log("SAMPLERATE: ", sampleRate);
      this.audioEngine = new AudioEngine(sampleRate);
      this.audioEngine.init(sampleRate, this.numVoices);
      this.automationAdapter = new AutomationAdapter(
        this.numVoices,
        this.macroCount,
        this.macroBufferSize
      );
      this.createNodesAndSetupConnections();
      this.initializeVoices();
      this.initializeState();
      this.ready = true;
    } catch (error) {
      console.error("Failed to initialize WASM audio engine:", error);
      this.port.postMessage({
        type: "error",
        error: "Failed to initialize audio engine"
      });
    }
  }
  /**
   * Apply custom node names from the incoming patch JSON onto the in-memory
   * voice layouts. The WASM engine reports default names, so we reconcile them
   * here to keep UI labels in sync with patch metadata.
   */
  applyPatchNamesToLayouts(patchJson) {
    if (!this.voiceLayouts || this.voiceLayouts.length === 0) return;
    try {
      const parsed = JSON.parse(patchJson);
      const layout = parsed?.synthState?.layout;
      const canonicalVoice = layout?.canonicalVoice ?? (Array.isArray(layout?.voices) && layout.voices.length > 0 ? layout.voices[0] : null);
      const nodes = canonicalVoice?.nodes;
      if (!nodes || typeof nodes !== "object") return;
      const nameById = /* @__PURE__ */ new Map();
      const isNamedNode = (value) => !!value && typeof value === "object" && "id" in value && typeof value.id === "string";
      Object.values(nodes).forEach((nodeArray) => {
        if (!Array.isArray(nodeArray)) return;
        nodeArray.forEach((node) => {
          if (!isNamedNode(node)) return;
          const name = node.name;
          if (typeof name === "string" && name.trim().length > 0) {
            nameById.set(node.id, name);
          }
        });
      });
      if (nameById.size === 0) return;
      this.patchNodeNames = nameById;
      this.voiceLayouts.forEach((voice) => {
        Object.values(voice.nodes).forEach((nodeArray) => {
          nodeArray.forEach((node) => {
            const customName = nameById.get(node.id);
            if (customName) {
              node.name = customName;
            }
          });
        });
      });
    } catch (err) {
      console.warn("Failed to apply patch names to layouts", err);
    }
  }
  /**
   * Reapply any stored patch names onto current voice layouts before sending
   * them to the main thread (covers later layout posts).
   */
  applyStoredNamesToLayouts() {
    if (!this.voiceLayouts || this.patchNodeNames.size === 0) return;
    this.voiceLayouts.forEach((voice) => {
      Object.values(voice.nodes).forEach((nodeArray) => {
        nodeArray.forEach((node) => {
          const customName = this.patchNodeNames.get(node.id);
          if (customName) {
            node.name = customName;
          }
        });
      });
    });
  }
  handleLoadPatch(data) {
    if (!this.audioEngine) {
      console.warn("loadPatch requested before audio engine was ready");
      return;
    }
    this.isApplyingPatch = true;
    try {
      const voiceCount = this.audioEngine.initWithPatch(data.patchJson);
      if (Number.isFinite(voiceCount) && voiceCount > 0) {
        this.numVoices = voiceCount;
      }
      this.automationAdapter = new AutomationAdapter(
        8,
        // Fixed to match parameter descriptors
        this.macroCount,
        this.macroBufferSize
      );
      this.initializeVoices();
      this.applyPatchNamesToLayouts(data.patchJson);
      this.stateVersion++;
      this.postSynthLayout();
      this.handleRequestSync(false);
    } catch (error) {
      console.error("Failed to load patch in worklet:", error);
      this.port.postMessage({
        type: "error",
        source: "loadPatch",
        message: "Failed to load patch"
      });
    } finally {
      this.isApplyingPatch = false;
    }
  }
  initializeState() {
    if (!this.audioEngine) return;
    const initialState = this.audioEngine.get_current_state();
    console.log("initialState:", initialState);
    this.stateVersion++;
    this.port.postMessage({
      type: "initialState",
      state: initialState,
      version: this.stateVersion
    });
    this.postSynthLayout();
  }
  postSynthLayout() {
    if (!this.audioEngine) return;
    this.applyStoredNamesToLayouts();
    const layout = {
      voices: this.voiceLayouts,
      globalNodes: {
        effectsChain: []
      },
      metadata: {
        maxVoices: this.numVoices,
        maxOscillators: this.maxOscillators,
        maxEnvelopes: this.maxEnvelopes,
        maxLFOs: this.maxLFOs,
        maxFilters: this.maxFilters,
        stateVersion: this.stateVersion
      }
    };
    this.port.postMessage({
      type: "synthLayout",
      layout
    });
  }
  createNodesAndSetupConnections() {
    if (!this.audioEngine) throw new Error("Audio engine not initialized");
    const mixerId = this.audioEngine.create_mixer();
    console.log("#mixerID:", mixerId);
    const filterId = this.audioEngine.create_filter();
    const samplerNodeId = this.audioEngine.create_sampler();
    const oscIds = [];
    const wtoscId = this.audioEngine.create_wavetable_oscillator();
    oscIds.push(wtoscId);
    const oscId = this.audioEngine.create_oscillator();
    oscIds.push(oscId);
    const envelopeIds = [];
    for (let i = 0; i < 1; i++) {
      const result = this.audioEngine.create_envelope();
      console.log(`Created envelope ${i} with id ${result.envelopeId}`);
      envelopeIds.push(result.envelopeId);
    }
    const lfoIds = [];
    for (let i = 0; i < 1; i++) {
      const result = this.audioEngine.create_lfo();
      console.log(`Created LFO ${i} with id ${result.lfoId}`);
      lfoIds.push(result.lfoId);
    }
    if (envelopeIds.length > 0 && oscIds.length >= 2) {
      this.audioEngine.connect_nodes(
        filterId,
        PortId.AudioOutput0,
        mixerId,
        PortId.AudioInput0,
        1,
        WasmModulationType.Additive,
        ModulationTransformation.None
      );
      this.audioEngine.connect_nodes(
        envelopeIds[0],
        PortId.AudioOutput0,
        mixerId,
        PortId.GainMod,
        1,
        WasmModulationType.VCA,
        ModulationTransformation.None
      );
      this.audioEngine.connect_nodes(
        oscIds[0],
        PortId.AudioOutput0,
        filterId,
        PortId.AudioInput0,
        1,
        WasmModulationType.Additive,
        ModulationTransformation.None
      );
      this.audioEngine.connect_nodes(
        samplerNodeId,
        PortId.AudioOutput0,
        filterId,
        PortId.AudioInput0,
        1,
        WasmModulationType.Additive,
        ModulationTransformation.None
      );
      this.audioEngine.connect_nodes(
        oscIds[1],
        PortId.AudioOutput0,
        oscIds[0],
        PortId.PhaseMod,
        1,
        WasmModulationType.Additive,
        ModulationTransformation.None
      );
      this.handleRequestSync();
    } else {
      console.warn("Not enough nodes for initial connections");
    }
  }
  initializeVoices() {
    if (!this.audioEngine) throw new Error("Audio engine not initialized");
    const wasmState = this.audioEngine.get_current_state();
    console.log("Raw WASM state:", wasmState);
    if (!wasmState.voices || wasmState.voices.length === 0) {
      throw new Error("No voices available in WASM state");
    }
    const rawCanonicalVoice = wasmState.voices[0];
    const nodesByType = {
      ["oscillator" /* Oscillator */]: [],
      ["wavetable_oscillator" /* WavetableOscillator */]: [],
      ["envelope" /* Envelope */]: [],
      ["lfo" /* LFO */]: [],
      ["filter" /* Filter */]: [],
      ["mixer" /* Mixer */]: [],
      ["noise" /* Noise */]: [],
      ["sampler" /* Sampler */]: [],
      ["glide" /* Glide */]: [],
      ["global_frequency" /* GlobalFrequency */]: [],
      ["global_velocity" /* GlobalVelocity */]: [],
      ["convolver" /* Convolver */]: [],
      ["delay" /* Delay */]: [],
      ["gatemixer" /* GateMixer */]: [],
      ["arpeggiator_generator" /* ArpeggiatorGenerator */]: [],
      ["chorus" /* Chorus */]: [],
      ["limiter" /* Limiter */]: [],
      ["freeverb" /* Reverb */]: [],
      ["compressor" /* Compressor */]: []
    };
    for (const rawNode of rawCanonicalVoice.nodes) {
      let type;
      console.log("## checking rawNode.node_type:", rawNode.node_type);
      switch (rawNode.node_type.trim()) {
        case "analog_oscillator":
          type = "oscillator" /* Oscillator */;
          break;
        case "filtercollection":
          type = "filter" /* Filter */;
          break;
        case "envelope":
          type = "envelope" /* Envelope */;
          break;
        case "lfo":
          type = "lfo" /* LFO */;
          break;
        case "mixer":
          type = "mixer" /* Mixer */;
          break;
        case "noise_generator":
          type = "noise" /* Noise */;
          break;
        case "global_frequency":
          type = "global_frequency" /* GlobalFrequency */;
          break;
        case "wavetable_oscillator":
          type = "wavetable_oscillator" /* WavetableOscillator */;
          break;
        case "sampler":
        case "Sampler":
          type = "sampler" /* Sampler */;
          break;
        case "convolver":
          type = "convolver" /* Convolver */;
          break;
        case "delay":
          type = "delay" /* Delay */;
          break;
        case "gatemixer":
          type = "gatemixer" /* GateMixer */;
          break;
        case "glide":
          type = "glide" /* Glide */;
          break;
        case "arpeggiator_generator":
          type = "arpeggiator_generator" /* ArpeggiatorGenerator */;
          break;
        case "global_velocity":
          type = "global_velocity" /* GlobalVelocity */;
          break;
        case "chorus":
          type = "chorus" /* Chorus */;
          break;
        case "limiter":
          type = "limiter" /* Limiter */;
          break;
        case "freeverb":
          type = "freeverb" /* Reverb */;
          break;
        case "compressor":
          type = "compressor" /* Compressor */;
          break;
        default:
          console.warn("##### Unknown node type:", rawNode.node_type);
          type = rawNode.node_type;
      }
      nodesByType[type].push({
        id: rawNode.id,
        type,
        name: rawNode.name
      });
    }
    const connections = rawCanonicalVoice.connections.map(
      (rawConn) => ({
        fromId: rawConn.from_id,
        toId: rawConn.to_id,
        target: rawConn.target,
        amount: rawConn.amount,
        modulationType: convertRawModulationType(rawConn.modulation_type),
        modulationTransformation: rawConn.modulation_transform
      })
    );
    const canonicalVoice = {
      id: rawCanonicalVoice.id,
      nodes: nodesByType,
      connections
    };
    this.voiceLayouts = [];
    for (let i = 0; i < this.numVoices; i++) {
      this.voiceLayouts.push({ ...canonicalVoice, id: i });
    }
  }
  remove_specific_connection(from_node, to_node, to_port) {
    if (!this.audioEngine) return;
    this.audioEngine.remove_specific_connection(from_node, to_node, to_port);
  }
  handleUpdateConnection(data) {
    const { connection } = data;
    if (!this.audioEngine) return;
    try {
      console.log("Worklet handling connection update:", {
        connection,
        type: connection.isRemoving ? "remove" : "update",
        targetPort: connection.target
      });
      if (connection.isRemoving) {
        this.audioEngine.remove_specific_connection(
          connection.fromId,
          connection.toId,
          connection.target
        );
        console.log("Removed connection:", {
          from: connection.fromId,
          to: connection.toId,
          target: connection.target
        });
        return;
      }
      this.audioEngine.remove_specific_connection(
        connection.fromId,
        connection.toId,
        connection.target
      );
      console.log("Adding new connection:", {
        from: connection.fromId,
        fromPort: PortId.AudioOutput0,
        to: connection.toId,
        target: connection.target,
        amount: connection.amount,
        modulationType: connection.modulationType,
        modulationTransformation: connection.modulationTransformation
      });
      const numericTransformValue = connection.modulationTransformation;
      console.log("Adding new connection (sending numeric transform):", {
        from: connection.fromId,
        to: connection.toId,
        target: connection.target,
        amount: connection.amount,
        modulationType: connection.modulationType,
        // Check type consistency here too
        modulationTransformation: numericTransformValue
        // Log the number (e.g., 1)
      });
      this.audioEngine.connect_nodes(
        connection.fromId,
        PortId.AudioOutput0,
        connection.toId,
        connection.target,
        connection.amount,
        connection.modulationType,
        connection.modulationTransformation
      );
      this.handleRequestSync();
    } catch (err) {
      console.error("Connection update failed in worklet:", err, {
        data: connection
      });
    }
  }
  handleRequestSync(incrementVersion = true) {
    if (this.audioEngine) {
      if (incrementVersion) {
        this.stateVersion++;
      }
      this.port.postMessage({
        type: "stateUpdated",
        version: this.stateVersion,
        state: this.audioEngine.get_current_state()
      });
    }
  }
  handleNoiseUpdate(data) {
    if (!this.audioEngine) return;
    console.log("noiseData:", data);
    const params = new NoiseUpdateParams(
      data.config.noise_type,
      data.config.cutoff,
      data.config.gain,
      data.config.enabled
    );
    this.audioEngine.update_noise(data.noiseId, params);
  }
  handleUpdateChorus(data) {
    if (!this.audioEngine) return;
    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error("handleUpdateChorus: invalid nodeId:", data.nodeId);
      return;
    }
    this.audioEngine.update_chorus(
      nodeId,
      data.state.active,
      data.state.baseDelayMs,
      data.state.depthMs,
      data.state.lfoRateHz,
      data.state.feedback,
      data.state.feedback_filter,
      data.state.mix,
      data.state.stereoPhaseOffsetDeg
    );
  }
  handleUpdateCompressor(data) {
    if (!this.audioEngine) return;
    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error("handleUpdateCompressor: invalid nodeId:", data.nodeId);
      return;
    }
    this.audioEngine.update_compressor(
      nodeId,
      data.state.active,
      data.state.thresholdDb,
      data.state.ratio,
      data.state.attackMs,
      data.state.releaseMs,
      data.state.makeupGainDb,
      data.state.mix
    );
  }
  handleUpdateReverb(data) {
    if (!this.audioEngine) return;
    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error("handleUpdateReverb: invalid nodeId:", data.nodeId);
      return;
    }
    this.audioEngine.update_reverb(
      nodeId,
      data.state.active,
      data.state.room_size,
      data.state.damp,
      data.state.wet,
      data.state.dry,
      data.state.width
    );
  }
  handleUpdateFilter(data) {
    console.log("handle filter update:", data);
    this.audioEngine.update_filters(
      data.filterId,
      data.config.cutoff,
      data.config.resonance,
      data.config.gain,
      data.config.keytracking,
      data.config.comb_frequency,
      data.config.comb_dampening,
      data.config.oversampling,
      data.config.filter_type,
      data.config.filter_slope
    );
  }
  handleUpdateVelocity(data) {
    if (!this.audioEngine) return;
    this.audioEngine.update_velocity(
      data.nodeId,
      data.config.sensitivity,
      data.config.randomize
    );
  }
  handleUpdateGlide(data) {
    if (!this.audioEngine) return;
    const glideTime = data.time ?? Math.max(
      data.riseTime ?? 0,
      data.fallTime ?? 0
    );
    this.audioEngine.update_glide(
      data.glideId,
      glideTime,
      data.active
    );
  }
  handleUpdateConvolver(data) {
    if (!this.audioEngine) return;
    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error("handleUpdateConvolver: invalid nodeId:", data.nodeId);
      return;
    }
    this.audioEngine.update_convolver(nodeId, data.state.wetMix, data.state.active);
  }
  handleUpdateDelay(data) {
    if (!this.audioEngine) return;
    const nodeId = Number(data.nodeId);
    if (!Number.isFinite(nodeId)) {
      console.error("handleUpdateDelay: invalid nodeId:", data.nodeId);
      return;
    }
    this.audioEngine.update_delay(
      nodeId,
      data.state.delayMs,
      data.state.feedback,
      data.state.wetMix,
      data.state.active
    );
  }
  handleUpdateModulation(data) {
    if (!this.audioEngine) return;
    const { connection } = data;
    const transformation = connection.modulationTransformation ?? ModulationTransformation.None;
    const update = new ConnectionUpdate(
      connection.fromId,
      connection.toId,
      connection.target,
      connection.amount,
      transformation,
      connection.isRemoving ?? false,
      connection.modulationType ?? null
    );
    try {
      if (this.automationAdapter) {
        this.automationAdapter.applyConnectionUpdate(this.audioEngine, update);
      } else {
        apply_modulation_update(this.audioEngine, update);
      }
    } catch (err) {
      console.error("Error updating modulation:", err);
    }
  }
  handleUpdateWavetableOscillator(data) {
    if (!this.audioEngine) return;
    const oscStateUpdate = new WavetableOscillatorStateUpdate(
      data.newState.phase_mod_amount,
      data.newState.detune,
      data.newState.hard_sync,
      data.newState.gain,
      data.newState.active,
      data.newState.feedback_amount,
      data.newState.unison_voices,
      data.newState.spread,
      data.newState.wave_index
    );
    try {
      this.audioEngine.update_wavetable_oscillator(
        data.oscillatorId,
        oscStateUpdate
      );
    } catch (err) {
      console.error("Failed to update oscillator:", err);
    }
  }
  handleUpdateOscillator(data) {
    if (!this.audioEngine) return;
    const oscStateUpdate = new AnalogOscillatorStateUpdate(
      data.newState.phase_mod_amount,
      data.newState.detune,
      data.newState.hard_sync,
      data.newState.gain,
      data.newState.active,
      data.newState.feedback_amount,
      data.newState.waveform >> 0,
      data.newState.unison_voices,
      data.newState.spread
    );
    try {
      this.audioEngine.update_oscillator(data.oscillatorId, oscStateUpdate);
    } catch (err) {
      console.error("Failed to update oscillator:", err);
    }
  }
  handleGetNodeLayout(data) {
    if (!this.audioEngine) {
      this.port.postMessage({
        type: "error",
        messageId: data.messageId,
        message: "Audio engine not initialized"
      });
      return;
    }
    try {
      const layout = this.audioEngine.get_current_state();
      console.log("synth-worklet::handleGetNodeLayer layout:", layout);
      this.port.postMessage({
        type: "nodeLayout",
        messageId: data.messageId,
        layout: JSON.stringify(layout)
      });
    } catch (err) {
      this.port.postMessage({
        type: "error",
        messageId: data.messageId,
        message: err instanceof Error ? err.message : "Failed to get node layout"
      });
    }
  }
  handleGetFilterIrWaveform(data) {
    if (!this.audioEngine) return;
    try {
      const waveformData = this.audioEngine.get_filter_ir_waveform(
        data.node_id,
        data.length
      );
      this.port.postMessage({
        type: "FilterIrWaveform",
        waveform: waveformData
      });
    } catch (err) {
      console.error("Error generating Filter IR waveform:", err);
      this.port.postMessage({
        type: "error",
        message: "Failed to generate Filter IR waveform"
      });
    }
  }
  handleGetLfoWaveform(data) {
    if (!this.audioEngine) return;
    try {
      const waveformData = this.audioEngine.get_lfo_waveform(
        data.waveform,
        data.phaseOffset,
        data.frequency,
        data.bufferSize,
        data.use_absolute,
        data.use_normalized
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
  handleGetSamplerWaveform(data) {
    if (!this.audioEngine) return;
    try {
      const waveform = this.audioEngine.get_sampler_waveform(
        data.samplerId,
        data.maxLength ?? 512
      );
      this.port.postMessage({
        type: "samplerWaveform",
        samplerId: data.samplerId,
        messageId: data.messageId,
        waveform
      });
    } catch (err) {
      console.error("Error getting sampler waveform:", err);
      this.port.postMessage({
        type: "error",
        source: "getSamplerWaveform",
        messageId: data.messageId,
        message: "Failed to get sampler waveform"
      });
    }
  }
  handleExportSampleData(data) {
    if (!this.audioEngine) return;
    try {
      const sampleData = this.audioEngine.export_sample_data(data.samplerId);
      this.port.postMessage({
        type: "sampleData",
        samplerId: data.samplerId,
        messageId: data.messageId,
        sampleData
      });
    } catch (err) {
      console.error("Error exporting sample data:", err);
      this.port.postMessage({
        type: "error",
        source: "exportSampleData",
        messageId: data.messageId,
        message: "Failed to export sample data"
      });
    }
  }
  handleExportConvolverData(data) {
    if (!this.audioEngine) return;
    try {
      const convolverData = this.audioEngine.export_convolver_data(data.convolverId);
      this.port.postMessage({
        type: "convolverData",
        convolverId: data.convolverId,
        messageId: data.messageId,
        convolverData
      });
    } catch (err) {
      console.error("Error exporting convolver data:", err);
      this.port.postMessage({
        type: "error",
        source: "exportConvolverData",
        messageId: data.messageId,
        message: "Failed to export convolver data"
      });
    }
  }
  handleGenerateHallReverb(data) {
    if (!this.audioEngine) return;
    try {
      const impulse = this.audioEngine.generate_hall_impulse(
        data.decayTime,
        data.roomSize
      );
      const nodeIdNum = Number(data.nodeId);
      const EFFECT_NODE_ID_OFFSET = 1e4;
      const effectIndex = nodeIdNum - EFFECT_NODE_ID_OFFSET;
      this.audioEngine.update_effect_impulse(effectIndex, impulse);
      console.log(`Updated convolver at index ${effectIndex} with hall reverb impulse`);
      this.handleRequestSync();
    } catch (err) {
      console.error("Error generating hall reverb:", err);
    }
  }
  handleGeneratePlateReverb(data) {
    if (!this.audioEngine) return;
    try {
      const impulse = this.audioEngine.generate_plate_impulse(
        data.decayTime,
        data.diffusion
      );
      const nodeIdNum = Number(data.nodeId);
      const EFFECT_NODE_ID_OFFSET = 1e4;
      const effectIndex = nodeIdNum - EFFECT_NODE_ID_OFFSET;
      this.audioEngine.update_effect_impulse(effectIndex, impulse);
      console.log(`Updated convolver at index ${effectIndex} with plate reverb impulse`);
      this.handleRequestSync();
    } catch (err) {
      console.error("Error generating plate reverb:", err);
    }
  }
  handleUpdateEnvelope(data) {
    if (!this.audioEngine) return;
    try {
      this.audioEngine.update_envelope(
        data.envelopeId,
        data.config.attack,
        data.config.decay,
        data.config.sustain,
        data.config.release,
        data.config.attackCurve,
        data.config.decayCurve,
        data.config.releaseCurve,
        data.config.active
      );
      this.port.postMessage({
        type: "updateEnvelopeProcessed",
        messageId: data.messageId
      });
    } catch (err) {
      console.error("Error updating LFO:", err);
    }
  }
  handleUpdateLfo(data) {
    if (!this.audioEngine) return;
    try {
      const lfoParams = new WasmLfoUpdateParams(
        data.params.lfoId,
        data.params.frequency,
        data.params.phaseOffset,
        data.params.waveform,
        data.params.useAbsolute,
        data.params.useNormalized,
        data.params.triggerMode,
        data.params.gain,
        data.params.active,
        data.params.loopMode,
        data.params.loopStart,
        data.params.loopEnd
      );
      this.audioEngine.update_lfos(lfoParams);
    } catch (err) {
      console.error("Error updating LFO:", err);
    }
  }
  process(_inputs, outputs, parameters) {
    if (!this.ready || !this.audioEngine || this.isApplyingPatch) {
      return true;
    }
    const output = outputs[0];
    if (!output) return true;
    const outputLeft = output[0];
    const outputRight = output[1];
    if (!outputLeft || !outputRight) return true;
    const frames = outputLeft.length;
    if (!this.hasBroadcastBlockSize || frames !== this.blockSizeFrames) {
      this.blockSizeFrames = frames;
      this.hasBroadcastBlockSize = true;
      this.port.postMessage({ type: "blockSize", blockSize: frames });
    }
    const masterGain = parameters.master_gain?.[0] ?? 1;
    if (!this.automationAdapter) {
      this.automationAdapter = new AutomationAdapter(
        8,
        // Fixed to match parameter descriptors
        this.macroCount,
        this.macroBufferSize
      );
    }
    const adapter = this.automationAdapter;
    if (!adapter) return true;
    try {
      adapter.processBlock(
        this.audioEngine,
        parameters,
        masterGain,
        outputLeft,
        outputRight
      );
    } catch (err) {
      console.error("Error processing automation block:", err);
    }
    return true;
  }
};
registerProcessor("synth-audio-processor", SynthAudioProcessor);
export {
  LFOWaveform,
  LfoTriggerMode
};
