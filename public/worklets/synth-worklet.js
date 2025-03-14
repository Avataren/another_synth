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
var WASM_VECTOR_LEN = 0;
var cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
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
function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function getArrayF32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
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
  "25": "ArpGate"
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
  Saw: 1,
  "1": "Saw",
  Square: 2,
  "2": "Square",
  Triangle: 3,
  "3": "Triangle",
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
  /**
   * @param {number} from_node
   * @param {PortId} from_port
   * @param {number} to_node
   * @param {PortId} to_port
   */
  remove_connection(from_node, from_port, to_node, to_port) {
    const ret = wasm.audioengine_remove_connection(this.__wbg_ptr, from_node, from_port, to_node, to_port);
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
   * @param {number} index
   */
  remove_effect(index) {
    const ret = wasm.audioengine_remove_effect(this.__wbg_ptr, index);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} noise_id
   * @param {NoiseUpdateParams} params
   */
  update_noise(noise_id, params) {
    _assertClass(params, NoiseUpdateParams);
    const ret = wasm.audioengine_update_noise(this.__wbg_ptr, noise_id, params.__wbg_ptr);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} node_id
   * @param {number} sensitivity
   * @param {number} randomize
   */
  update_velocity(node_id, sensitivity, randomize) {
    const ret = wasm.audioengine_update_velocity(this.__wbg_ptr, node_id, sensitivity, randomize);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} node_id
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
    const ret = wasm.audioengine_update_envelope(this.__wbg_ptr, node_id, attack, decay, sustain, release, attack_curve, decay_curve, release_curve, active);
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
   * @param {number} oscillator_id
   * @param {WavetableOscillatorStateUpdate} params
   */
  update_wavetable_oscillator(oscillator_id, params) {
    _assertClass(params, WavetableOscillatorStateUpdate);
    const ret = wasm.audioengine_update_wavetable_oscillator(this.__wbg_ptr, oscillator_id, params.__wbg_ptr);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
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
   * Refactored import_wavetable function that uses the hound-based helper.
   * It accepts the WAV data as a byte slice, uses a Cursor to create a reader,
   * builds a new morph collection from the data, adds it to the synth bank under
   * the name "imported", and then updates all wavetable oscillators to use it.
   * @param {number} node_id
   * @param {Uint8Array} data
   * @param {number} base_size
   */
  import_wavetable(node_id, data, base_size) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_import_wavetable(this.__wbg_ptr, node_id, ptr0, len0, base_size);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} oscillator_id
   * @param {AnalogOscillatorStateUpdate} params
   */
  update_oscillator(oscillator_id, params) {
    _assertClass(params, AnalogOscillatorStateUpdate);
    const ret = wasm.audioengine_update_oscillator(this.__wbg_ptr, oscillator_id, params.__wbg_ptr);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
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
   * @param {number} node_id
   * @param {number} wet_mix
   * @param {boolean} enabled
   */
  update_convolver(node_id, wet_mix, enabled) {
    wasm.audioengine_update_convolver(this.__wbg_ptr, node_id, wet_mix, enabled);
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
  create_filter() {
    const ret = wasm.audioengine_create_filter(this.__wbg_ptr);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  /**
   * @returns {number}
   */
  create_noise() {
    const ret = wasm.audioengine_create_noise(this.__wbg_ptr);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  /**
   * @returns {number}
   */
  create_oscillator() {
    const ret = wasm.audioengine_create_oscillator(this.__wbg_ptr);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  /**
   * @returns {number}
   */
  create_wavetable_oscillator() {
    const ret = wasm.audioengine_create_wavetable_oscillator(this.__wbg_ptr);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
  }
  /**
   * @param {number} filter_id
   * @param {number} cutoff
   * @param {number} resonance
   * @param {number} gain
   * @param {number} key_tracking
   * @param {number} comb_frequency
   * @param {number} comb_dampening
   * @param {number} oversampling
   * @param {FilterType} filter_type
   * @param {FilterSlope} filter_slope
   */
  update_filters(filter_id, cutoff, resonance, gain, key_tracking, comb_frequency, comb_dampening, oversampling, filter_type, filter_slope) {
    const ret = wasm.audioengine_update_filters(this.__wbg_ptr, filter_id, cutoff, resonance, gain, key_tracking, comb_frequency, comb_dampening, oversampling, filter_type, filter_slope);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} node_id
   * @param {number} waveform_length
   * @returns {Float32Array}
   */
  get_filter_ir_waveform(node_id, waveform_length) {
    const ret = wasm.audioengine_get_filter_ir_waveform(this.__wbg_ptr, node_id, waveform_length);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * Update all LFOs across all   voices. This is called by the host when the user
   * changes an LFO's settings.
   * @param {LfoUpdateParams} params
   */
  update_lfos(params) {
    _assertClass(params, LfoUpdateParams);
    var ptr0 = params.__destroy_into_raw();
    wasm.audioengine_update_lfos(this.__wbg_ptr, ptr0);
  }
  /**
   * @param {number} waveform
   * @param {number} phase_offset
   * @param {number} buffer_size
   * @param {boolean} use_absolute
   * @param {boolean} use_normalized
   * @returns {Float32Array}
   */
  get_lfo_waveform(waveform, phase_offset, buffer_size, use_absolute, use_normalized) {
    const ret = wasm.audioengine_get_lfo_waveform(this.__wbg_ptr, waveform, phase_offset, buffer_size, use_absolute, use_normalized);
    if (ret[3]) {
      throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  /**
   * @param {number} from_node
   * @param {PortId} from_port
   * @param {number} to_node
   * @param {PortId} to_port
   * @param {number} amount
   * @param {WasmModulationType | null | undefined} modulation_type
   * @param {ModulationTransformation} modulation_transform
   */
  connect_nodes(from_node, from_port, to_node, to_port, amount, modulation_type, modulation_transform) {
    const ret = wasm.audioengine_connect_nodes(this.__wbg_ptr, from_node, from_port, to_node, to_port, amount, isLikeNone(modulation_type) ? 3 : modulation_type, modulation_transform);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * @param {number} from_node
   * @param {number} to_node
   * @param {PortId} to_port
   */
  remove_specific_connection(from_node, to_node, to_port) {
    const ret = wasm.audioengine_remove_specific_connection(this.__wbg_ptr, from_node, to_node, to_port);
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
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set frequency(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get phase_offset() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_detune(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set phase_offset(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_detune(this.__wbg_ptr, arg0);
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
    const ret = wasm.__wbg_get_envelopeconfig_active(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set active(arg0) {
    wasm.__wbg_set_envelopeconfig_active(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get loop_mode() {
    const ret = wasm.__wbg_get_lfoupdateparams_loop_mode(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @param {number} arg0
   */
  set loop_mode(arg0) {
    wasm.__wbg_set_lfoupdateparams_loop_mode(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get loop_start() {
    const ret = wasm.__wbg_get_envelopeconfig_decay_curve(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set loop_start(arg0) {
    wasm.__wbg_set_envelopeconfig_decay_curve(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get loop_end() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_spread(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set loop_end(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_spread(this.__wbg_ptr, arg0);
  }
  /**
   * @param {number} lfo_id
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
    const ret = wasm.lfoupdateparams_new(lfo_id, frequency, phase_offset, waveform, use_absolute, use_normalized, trigger_mode, gain, active, loop_mode, loop_start, loop_end);
    this.__wbg_ptr = ret >>> 0;
    LfoUpdateParamsFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
};
var NodeIdFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_nodeid_free(ptr >>> 0, 1));
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
   * @returns {WasmNoiseType}
   */
  get noise_type() {
    const ret = wasm.__wbg_get_noiseupdateparams_noise_type(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {WasmNoiseType} arg0
   */
  set noise_type(arg0) {
    wasm.__wbg_set_noiseupdateparams_noise_type(this.__wbg_ptr, arg0);
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
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set gain(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {boolean}
   */
  get enabled() {
    const ret = wasm.__wbg_get_noiseupdateparams_enabled(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @param {boolean} arg0
   */
  set enabled(arg0) {
    wasm.__wbg_set_noiseupdateparams_enabled(this.__wbg_ptr, arg0);
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
};
var OscillatorStateUpdateFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_oscillatorstateupdate_free(ptr >>> 0, 1));
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
  get detune() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set detune(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr, arg0);
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
  get unison_voices() {
    const ret = wasm.__wbg_get_lfoupdateparams_loop_mode(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @param {number} arg0
   */
  set unison_voices(arg0) {
    wasm.__wbg_set_lfoupdateparams_loop_mode(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get spread() {
    const ret = wasm.__wbg_get_envelopeconfig_decay_curve(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set spread(arg0) {
    wasm.__wbg_set_envelopeconfig_decay_curve(this.__wbg_ptr, arg0);
  }
  /**
   * @returns {number}
   */
  get wavetable_index() {
    const ret = wasm.__wbg_get_analogoscillatorstateupdate_spread(this.__wbg_ptr);
    return ret;
  }
  /**
   * @param {number} arg0
   */
  set wavetable_index(arg0) {
    wasm.__wbg_set_analogoscillatorstateupdate_spread(this.__wbg_ptr, arg0);
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
  imports.wbg.__wbg_String_8f0eb39a4a4c2f66 = function(arg0, arg1) {
    const ret = String(arg1);
    const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
  };
  imports.wbg.__wbg_buffer_609cc3eee51ed158 = function(arg0) {
    const ret = arg0.buffer;
    return ret;
  };
  imports.wbg.__wbg_call_672a4d21634d4a24 = function() {
    return handleError(function(arg0, arg1) {
      const ret = arg0.call(arg1);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_crypto_12576cd66246998b = function() {
    return handleError(function(arg0) {
      const ret = arg0.crypto;
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_error_524f506f44df1645 = function(arg0) {
    console.error(arg0);
  };
  imports.wbg.__wbg_getRandomValues_5754b82ca6952f9b = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = arg0.getRandomValues(getArrayU8FromWasm0(arg1, arg2));
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_getRandomValues_78e016fdd1d721cf = function() {
    return handleError(function(arg0, arg1) {
      globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
    }, arguments);
  };
  imports.wbg.__wbg_getwithrefkey_1dc361bd10053bfe = function(arg0, arg1) {
    const ret = arg0[arg1];
    return ret;
  };
  imports.wbg.__wbg_instanceof_ArrayBuffer_e14585432e3737fc = function(arg0) {
    let result;
    try {
      result = arg0 instanceof ArrayBuffer;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Uint8Array_17156bcf118086a9 = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Uint8Array;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_instanceof_Window_def73ea0955fc569 = function(arg0) {
    let result;
    try {
      result = arg0 instanceof Window;
    } catch (_) {
      result = false;
    }
    const ret = result;
    return ret;
  };
  imports.wbg.__wbg_isSafeInteger_343e2beeeece1bb0 = function(arg0) {
    const ret = Number.isSafeInteger(arg0);
    return ret;
  };
  imports.wbg.__wbg_length_a446193dc22c12f8 = function(arg0) {
    const ret = arg0.length;
    return ret;
  };
  imports.wbg.__wbg_log_c222819a41e063d3 = function(arg0) {
    console.log(arg0);
  };
  imports.wbg.__wbg_new_405e22f390576ce2 = function() {
    const ret = new Object();
    return ret;
  };
  imports.wbg.__wbg_new_78feb108b6472713 = function() {
    const ret = new Array();
    return ret;
  };
  imports.wbg.__wbg_new_a12002a7f91c75be = function(arg0) {
    const ret = new Uint8Array(arg0);
    return ret;
  };
  imports.wbg.__wbg_newnoargs_105ed471475aaf50 = function(arg0, arg1) {
    const ret = new Function(getStringFromWasm0(arg0, arg1));
    return ret;
  };
  imports.wbg.__wbg_newwithlength_5a5efe313cfd59f1 = function(arg0) {
    const ret = new Float32Array(arg0 >>> 0);
    return ret;
  };
  imports.wbg.__wbg_random_3ad904d98382defe = function() {
    const ret = Math.random();
    return ret;
  };
  imports.wbg.__wbg_set_37837023f3d740e8 = function(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
  };
  imports.wbg.__wbg_set_3f1d0b984ed272ed = function(arg0, arg1, arg2) {
    arg0[arg1] = arg2;
  };
  imports.wbg.__wbg_set_65595bdd868b3009 = function(arg0, arg1, arg2) {
    arg0.set(arg1, arg2 >>> 0);
  };
  imports.wbg.__wbg_set_bb8cecf6a62b9f46 = function() {
    return handleError(function(arg0, arg1, arg2) {
      const ret = Reflect.set(arg0, arg1, arg2);
      return ret;
    }, arguments);
  };
  imports.wbg.__wbg_setindex_4e73afdcd9bb95cd = function(arg0, arg1, arg2) {
    arg0[arg1 >>> 0] = arg2;
  };
  imports.wbg.__wbg_static_accessor_GLOBAL_88a902d13a557d07 = function() {
    const ret = typeof global === "undefined" ? null : global;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
  };
  imports.wbg.__wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0 = function() {
    const ret = typeof globalThis === "undefined" ? null : globalThis;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
  };
  imports.wbg.__wbg_static_accessor_SELF_37c5d418e4bf5819 = function() {
    const ret = typeof self === "undefined" ? null : self;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
  };
  imports.wbg.__wbg_static_accessor_WINDOW_5de37043a91a9c40 = function() {
    const ret = typeof window === "undefined" ? null : window;
    return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
  };
  imports.wbg.__wbg_warn_4ca3906c248c47c4 = function(arg0) {
    console.warn(arg0);
  };
  imports.wbg.__wbindgen_as_number = function(arg0) {
    const ret = +arg0;
    return ret;
  };
  imports.wbg.__wbindgen_bigint_from_u64 = function(arg0) {
    const ret = BigInt.asUintN(64, arg0);
    return ret;
  };
  imports.wbg.__wbindgen_boolean_get = function(arg0) {
    const v = arg0;
    const ret = typeof v === "boolean" ? v ? 1 : 0 : 2;
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
  imports.wbg.__wbindgen_in = function(arg0, arg1) {
    const ret = arg0 in arg1;
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
  imports.wbg.__wbindgen_is_object = function(arg0) {
    const val = arg0;
    const ret = typeof val === "object" && val !== null;
    return ret;
  };
  imports.wbg.__wbindgen_is_undefined = function(arg0) {
    const ret = arg0 === void 0;
    return ret;
  };
  imports.wbg.__wbindgen_jsval_loose_eq = function(arg0, arg1) {
    const ret = arg0 == arg1;
    return ret;
  };
  imports.wbg.__wbindgen_memory = function() {
    const ret = wasm.memory;
    return ret;
  };
  imports.wbg.__wbindgen_number_get = function(arg0, arg1) {
    const obj = arg1;
    const ret = typeof obj === "number" ? obj : void 0;
    getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
  };
  imports.wbg.__wbindgen_number_new = function(arg0) {
    const ret = arg0;
    return ret;
  };
  imports.wbg.__wbindgen_string_get = function(arg0, arg1) {
    const obj = arg1;
    const ret = typeof obj === "string" ? obj : void 0;
    var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    var len1 = WASM_VECTOR_LEN;
    getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
    getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
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
  [PortId.Gate]: "Gate",
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
  [PortId.ArpGate]: "Arpeggio gate"
};
function convertRawModulationType(raw) {
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
    __publicField(this, "maxOscillators", 2);
    __publicField(this, "maxEnvelopes", 2);
    __publicField(this, "maxLFOs", 2);
    __publicField(this, "maxFilters", 1);
    __publicField(this, "voiceLayouts", []);
    __publicField(this, "nextNodeId", 0);
    __publicField(this, "stateVersion", 0);
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
        this.handleUpdateConvolver(event.data);
        break;
      case "updateDelayState":
        this.handleUpdateDelay(event.data);
        break;
      case "updateVelocity":
        this.handleUpdateVelocity(event.data);
        break;
    }
  }
  handleImportImpulseWaveformData(data) {
    const uint8Data = new Uint8Array(data.data);
    this.audioEngine.import_wave_impulse(data.nodeId, uint8Data);
  }
  handleImportWavetableData(data) {
    const uint8Data = new Uint8Array(data.data);
    this.audioEngine.import_wavetable(data.nodeId, uint8Data, 2048);
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
        maxFilters: this.maxFilters,
        stateVersion: this.stateVersion
      }
    };
    this.port.postMessage({
      type: "synthLayout",
      layout
    });
  }
  getNextNodeId() {
    return this.nextNodeId++;
  }
  createNodesAndSetupConnections() {
    if (!this.audioEngine) throw new Error("Audio engine not initialized");
    this.audioEngine.create_noise();
    const mixerId = this.audioEngine.create_mixer();
    console.log("#mixerID:", mixerId);
    const filterId = this.audioEngine.create_filter();
    this.audioEngine.create_filter();
    const oscIds = [];
    const wtoscId = this.audioEngine.create_wavetable_oscillator();
    oscIds.push(wtoscId);
    const oscId = this.audioEngine.create_oscillator();
    oscIds.push(oscId);
    const envelopeIds = [];
    for (let i = 0; i < this.maxEnvelopes; i++) {
      const result = this.audioEngine.create_envelope();
      console.log(`Created envelope ${i} with id ${result.envelopeId}`);
      envelopeIds.push(result.envelopeId);
    }
    const lfoIds = [];
    for (let i = 0; i < this.maxLFOs; i++) {
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
      ["global_frequency" /* GlobalFrequency */]: [],
      ["global_velocity" /* GlobalVelocity */]: [],
      ["convolver" /* Convolver */]: [],
      ["delay" /* Delay */]: []
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
        case "convolver":
          type = "convolver" /* Convolver */;
          break;
        case "delay":
          type = "delay" /* Delay */;
          break;
        default:
          console.warn("##### Unknown node type:", rawNode.node_type);
          type = rawNode.node_type;
      }
      nodesByType[type].push({ id: rawNode.id, type });
    }
    const connections = rawCanonicalVoice.connections.map(
      (rawConn) => ({
        fromId: rawConn.from_id,
        toId: rawConn.to_id,
        target: rawConn.target,
        amount: rawConn.amount,
        modulationType: convertRawModulationType(rawConn.modulation_type),
        modulationTransformation: rawConn.modulation_transformation
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
  handleRequestSync() {
    if (this.audioEngine) {
      this.stateVersion++;
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
  handleUpdateConvolver(data) {
    if (!this.audioEngine) return;
    this.audioEngine.update_convolver(
      data.nodeId,
      data.state.wetMix,
      data.state.active
    );
  }
  handleUpdateDelay(data) {
    if (!this.audioEngine) return;
    this.audioEngine.update_delay(
      data.nodeId,
      data.state.delayMs,
      data.state.feedback,
      data.state.wetMix,
      data.state.active
    );
  }
  handleUpdateModulation(data) {
    if (!this.audioEngine) return;
    try {
      if (data.connection.isRemoving) {
        this.audioEngine.remove_specific_connection(
          data.connection.fromId,
          data.connection.toId,
          data.connection.target
        );
      } else {
        this.audioEngine.connect_nodes(
          data.connection.fromId,
          PortId.AudioOutput0,
          data.connection.toId,
          data.connection.target,
          data.connection.amount,
          WasmModulationType.VCA,
          ModulationTransformation.None
        );
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
      this.port.postMessage({ type: "updateEnvelopeProcessed", messageId: data.messageId });
    } catch (err) {
      console.error("Error updating LFO:", err);
    }
  }
  handleUpdateLfo(data) {
    if (!this.audioEngine) return;
    try {
      const lfoParams = new LfoUpdateParams(
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
    if (!this.ready || !this.audioEngine) return true;
    const output = outputs[0];
    if (!output) return true;
    const outputLeft = output[0];
    const outputRight = output[1];
    if (!outputLeft || !outputRight) return true;
    const gateArray = new Float32Array(this.numVoices);
    const freqArray = new Float32Array(this.numVoices);
    const gainArray = new Float32Array(this.numVoices);
    const velocityArray = new Float32Array(this.numVoices);
    const macroArray = new Float32Array(this.numVoices * 4 * 128);
    for (let i = 0; i < this.numVoices; i++) {
      gateArray[i] = parameters[`gate_${i}`]?.[0] ?? 0;
      freqArray[i] = parameters[`frequency_${i}`]?.[0] ?? 440;
      gainArray[i] = parameters[`gain_${i}`]?.[0] ?? 1;
      velocityArray[i] = parameters[`velocity_${i}`]?.[0] ?? 0;
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
      velocityArray,
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
