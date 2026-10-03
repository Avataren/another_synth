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
function _assertClass(instance, klass) {
  if (!(instance instanceof klass)) {
    throw new Error(`expected instance of ${klass.name}`);
  }
}
function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_export_4.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}
function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function passArrayF32ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 4, 4) >>> 0;
  getFloat32ArrayMemory0().set(arg, ptr / 4);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
var cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
  if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
    cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
  }
  return cachedUint16ArrayMemory0;
}
function passArray16ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 2, 2) >>> 0;
  getUint16ArrayMemory0().set(arg, ptr / 2);
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
  "26": "CombinedGate",
  SampleOffset: 27,
  "27": "SampleOffset"
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
var A2PlayerFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_a2player_free(ptr >>> 0, 1));
var A2Player = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    A2PlayerFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_a2player_free(ptr, 0);
  }
  /**
   * @returns {boolean}
   */
  is_playing() {
    const ret = wasm.a2player_is_playing(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * Order positions before the first jump marker (the song's length as
   * the tracker shows it).
   * @returns {number}
   */
  order_count() {
    const ret = wasm.a2player_order_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * The raw order entry at `index` (a pattern, or 0x80 + a jump target).
   * @param {number} index
   * @returns {number}
   */
  order_entry(index) {
    const ret = wasm.a2player_order_entry(this.__wbg_ptr, index);
    return ret;
  }
  /**
   * @returns {number}
   */
  track_count() {
    const ret = wasm.a2player_track_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Pattern `pattern`'s cells for display, as the engine plays them (old
   * effect numbers mapped to the v9+ set, fixed notes as notes): six bytes
   * per cell (note, instrument, effect, param, effect 2, param 2),
   * row-major over `rows_per_pattern()` rows and `track_count()` tracks.
   * Empty for a pattern the song does not have.
   * @param {number} pattern
   * @returns {Uint8Array}
   */
  pattern_cells(pattern) {
    const ret = wasm.a2player_pattern_cells(this.__wbg_ptr, pattern);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
  }
  /**
   * Bit masks over tracks (bit `t` = track `t`): muted tracks, and (when
   * non-zero) the only tracks heard. Applied as the chip's channel mask.
   * @param {number} mute
   * @param {number} solo
   */
  set_mute_solo(mute, solo) {
    wasm.a2player_set_mute_solo(this.__wbg_ptr, mute, solo);
  }
  /**
   * The OPL channel track `track` plays on.
   * @param {number} track
   * @returns {number}
   */
  track_channel(track) {
    const ret = wasm.a2player_track_channel(this.__wbg_ptr, track);
    return ret >>> 0;
  }
  /**
   * Keep playing order position `order` (its pattern) over and over:
   * the tracker's "play pattern". `-1` plays the song on.
   * @param {number} order
   */
  set_loop_order(order) {
    wasm.a2player_set_loop_order(this.__wbg_ptr, order);
  }
  /**
   * @param {number} index
   * @returns {string}
   */
  instrument_name(index) {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.a2player_instrument_name(this.__wbg_ptr, index);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * The instruments that hold FM data.
   * @returns {number}
   */
  instrument_count() {
    const ret = wasm.a2player_instrument_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  rows_per_pattern() {
    const ret = wasm.a2player_rows_per_pattern(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Record per-channel scope taps during `render` (off by default).
   * @param {boolean} enabled
   */
  set_taps_enabled(enabled) {
    wasm.a2player_set_taps_enabled(this.__wbg_ptr, enabled);
  }
  /**
   * Whether the song has come round once (passed its order list's end
   * or a jump back) or stopped. It plays on either way.
   * @returns {boolean}
   */
  song_end_reached() {
    const ret = wasm.a2player_song_end_reached(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * Parses an `.a2m` module and builds a paused player at its start. A
   * file the parser or the player cannot play is refused with one
   * sentence saying why.
   * @param {Uint8Array} bytes
   * @param {number} sample_rate
   */
  constructor(bytes, sample_rate) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.a2player_new(ptr0, len0, sample_rate);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    this.__wbg_ptr = ret[0] >>> 0;
    A2PlayerFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * @returns {number}
   */
  row() {
    const ret = wasm.a2player_row(this.__wbg_ptr);
    return ret >>> 0;
  }
  play() {
    wasm.a2player_play(this.__wbg_ptr);
  }
  /**
   * Moves to the start of `row` in order position `order`, keeping the
   * play/pause state. The song is replayed silently from its top to get
   * there; a row it never reaches is jumped to directly. Returns whether
   * the row was reached by playing.
   * @param {number} order
   * @param {number} row
   * @returns {boolean}
   */
  seek(order, row) {
    const ret = wasm.a2player_seek(this.__wbg_ptr, order, row);
    return ret !== 0;
  }
  /**
   * The row playing now: its order position, pattern and row.
   * @returns {number}
   */
  order() {
    const ret = wasm.a2player_order(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Stops the clock (the output is silence) without losing the position.
   */
  pause() {
    wasm.a2player_pause(this.__wbg_ptr);
  }
  /**
   * Renders `left.len()` frames (and the same into `right`); silence
   * while paused. Returns the frames written.
   * @param {Float32Array} left
   * @param {Float32Array} right
   * @returns {number}
   */
  render(left, right) {
    var ptr0 = passArrayF32ToWasm0(left, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    var ptr1 = passArrayF32ToWasm0(right, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.a2player_render(this.__wbg_ptr, ptr0, len0, left, ptr1, len1, right);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  pattern() {
    const ret = wasm.a2player_pattern(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * The timer rate now (Hz): tempo × macro speed-up.
   * @returns {number}
   */
  refresh() {
    const ret = wasm.a2player_refresh(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {number}
   */
  version() {
    const ret = wasm.a2player_version(this.__wbg_ptr);
    return ret;
  }
  /**
   * 18: every OPL3 channel (what `read_tap` covers).
   * @returns {number}
   */
  channels() {
    const ret = wasm.a2player_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {string}
   */
  composer() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.a2player_composer(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * OPL channel `ch`'s tap from the last `render` (±1: one operator's
   * full swing); zeros when taps are off. `track_channel` maps tracks.
   * @param {number} ch
   * @param {Float32Array} out
   */
  read_tap(ch, out) {
    var ptr0 = passArrayF32ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.a2player_read_tap(this.__wbg_ptr, ch, ptr0, len0, out);
  }
  /**
   * @param {number} gain
   */
  set_gain(gain) {
    wasm.a2player_set_gain(this.__wbg_ptr, gain);
  }
  /**
   * @returns {string}
   */
  song_name() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.a2player_song_name(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
};
if (Symbol.dispose) A2Player.prototype[Symbol.dispose] = A2Player.prototype.free;
var AhxPlayerFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_ahxplayer_free(ptr >>> 0, 1));
var AhxPlayer = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    AhxPlayerFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_ahxplayer_free(ptr, 0);
  }
  /**
   * @returns {boolean}
   */
  is_playing() {
    const ret = wasm.ahxplayer_is_playing(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * Whether the render path is locked out of building tables.
   * @returns {boolean}
   */
  hifi_locked() {
    const ret = wasm.ahxplayer_hifi_locked(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @returns {number}
   */
  sample_rate() {
    const ret = wasm.ahxplayer_sample_rate(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {boolean}
   */
  hifi_enabled() {
    const ret = wasm.ahxplayer_hifi_enabled(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * @returns {number}
   */
  track_length() {
    const ret = wasm.ahxplayer_track_length(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {boolean}
   */
  loop_position() {
    const ret = wasm.ahxplayer_loop_position(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * Live per-voice mute and solo as bit masks (bit `i` = voice `i`); see
   * [`AhxEngine::set_mute_solo`]. The state belongs to this player and is
   * kept across `rewind`; all zero (the default) leaves the mix untouched.
   * @param {number} mute
   * @param {number} solo
   */
  set_mute_solo(mute, solo) {
    wasm.ahxplayer_set_mute_solo(this.__wbg_ptr, mute, solo);
  }
  /**
   * Per-voice waveform capture for oscilloscopes; off by default and
   * bit-neutral to the mix (see [`AhxEngine::enable_capture`]).
   * @param {boolean} on
   */
  enable_capture(on) {
    wasm.ahxplayer_enable_capture(this.__wbg_ptr, on);
  }
  /**
   * Live (keyboard preview) mode: this player stops playing the song and
   * is played by [`preview_note_on`](Self::preview_note_on) /
   * [`preview_note_off`](Self::preview_note_off) instead, one mono voice
   * with the song's instruments (see [`AhxEngine::enable_live`]). It starts
   * rendering at once (a preview has no transport to `play`) and there is no
   * way back: make a separate player for the song. Turning hi-fi on after
   * this builds its tables lazily instead of walking the song, which a
   * preview never plays.
   */
  enable_preview() {
    wasm.ahxplayer_enable_preview(this.__wbg_ptr);
  }
  /**
   * @returns {number}
   */
  position_count() {
    const ret = wasm.ahxplayer_position_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {boolean}
   */
  capture_enabled() {
    const ret = wasm.ahxplayer_capture_enabled(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * Lookups since the prewarm that the exact table could not serve. Zero:
   * the render thread built nothing and degraded nowhere; diagnostics.
   * @returns {number}
   */
  hifi_miss_count() {
    const ret = wasm.ahxplayer_hifi_miss_count(this.__wbg_ptr);
    return ret;
  }
  /**
   * @returns {boolean}
   */
  preview_enabled() {
    const ret = wasm.ahxplayer_preview_enabled(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * Plays `instrument` (1-based) at `note` (1..=60, the AHX pitch table's
   * index) with `velocity` (0..=127), retriggering the voice on the next
   * tick. With hi-fi on, builds the tables this note will want first, so
   * call it from a message handler and not from the render callback. `false`, changing nothing, outside preview mode or for an
   * instrument the song does not have.
   * @param {number} instrument
   * @param {number} note
   * @param {number} velocity
   * @returns {boolean}
   */
  preview_note_on(instrument, note, velocity) {
    const ret = wasm.ahxplayer_preview_note_on(this.__wbg_ptr, instrument, note, velocity);
    return ret !== 0;
  }
  /**
   * Song channels the engine does not play: 0 for every real file (only a
   * malformed HVL wider than the reference's 16-voice array is cut).
   * @returns {number}
   */
  dropped_channels() {
    const ret = wasm.ahxplayer_dropped_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Mip tables cached (0 with hi-fi off); diagnostics.
   * @returns {number}
   */
  hifi_table_count() {
    const ret = wasm.ahxplayer_hifi_table_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Instruments the song has (1-based numbering runs `1..=instrument_count`).
   * @returns {number}
   */
  instrument_count() {
    const ret = wasm.ahxplayer_instrument_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Releases the previewed note (the instrument's release, or its hard cut).
   */
  preview_note_off() {
    wasm.ahxplayer_preview_note_off(this.__wbg_ptr);
  }
  /**
   * Set once the song has reached its end (it then loops from its restart
   * position, as the reference does); cleared by [`restart`](Self::restart).
   * @returns {boolean}
   */
  song_end_reached() {
    const ret = wasm.ahxplayer_song_end_reached(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * The PList row the previewed note's voice ran last, `-1` when there is
   * none (see [`AhxEngine::live_plist_state`]). A scalar, not a `Vec`: the
   * worklet reads it every render quantum.
   * @returns {number}
   */
  preview_plist_row() {
    const ret = wasm.ahxplayer_preview_plist_row(this.__wbg_ptr);
    return ret;
  }
  /**
   * Loop the current position instead of moving on from it; see
   * [`AhxEngine::set_loop_position`]. Kept across `restart` and `seek`.
   * @param {boolean} on
   */
  set_loop_position(on) {
    wasm.ahxplayer_set_loop_position(this.__wbg_ptr, on);
  }
  /**
   * Replaces instrument `instrument` (1-based, as a pattern step numbers it)
   * of the loaded song with the one in `bytes`: the 22-byte instrument core
   * followed by its PList entries in the song's own layout (4 bytes each in
   * AHX, 5 in HVL), no name, exactly as long as its length byte says. The
   * bytes are decoded by the file loader's own functions
   * ([`format::parse_instrument`]), the name is kept, and the song's
   * instrument list is what changes: a song player plays the new instrument
   * from its next trigger (a voice already holding it also picks up PList and
   * envelope changes at once, see [`AhxEngine::replace_instrument`]) and a
   * preview player from its next note-on. Nothing is reloaded and the
   * transport does not move.
   *
   * With hi-fi on, a song player rebuilds the tables the edited song asks
   * for before this returns (see [`AhxEngine::prewarm_hifi_after_edit`]) --
   * unless the edit reaches no table (volume, envelope, hard cut) or the
   * instrument is one no step ever triggers, which costs nothing; a preview player only forgets what it prewarmed for that
   * instrument. Both happen here, in the caller's message handler, never in
   * `render`.
   *
   * An error, with the song untouched, for bytes the format does not decode
   * to one instrument or an `instrument` the song does not have.
   * @param {number} instrument
   * @param {Uint8Array} bytes
   */
  replace_instrument(instrument, bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ahxplayer_replace_instrument(this.__wbg_ptr, instrument, ptr0, len0);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * Fills `out` with `voice`'s latest waveform (oldest first, `i16`, full
   * scale `+-8192`) and returns the number of points written; 0 when
   * capture is off or `voice` is out of range. Reuses the caller's buffer,
   * so a per-report call allocates nothing on the Rust side.
   * @param {number} voice
   * @param {Int16Array} out
   * @returns {number}
   */
  read_channel_snapshot(voice, out) {
    var ptr0 = passArray16ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    const ret = wasm.ahxplayer_read_channel_snapshot(this.__wbg_ptr, voice, ptr0, len0, out);
    return ret >>> 0;
  }
  /**
   * Pays the walk that deferred edits owe (nothing when none does): one
   * [`AhxEngine::prewarm_hifi_after_edit`] however many instruments changed.
   * Call it from the message handler, never from `render`.
   */
  finish_instrument_edits() {
    wasm.ahxplayer_finish_instrument_edits(this.__wbg_ptr);
  }
  /**
   * Ticks a note-on's prewarm holds a key down for `instrument` (1-based)
   * before releasing it, bounded by what the instrument can produce (see
   * [`live_warm_hold_ticks`](super::engine::live_warm_hold_ticks)); 0 for an
   * instrument the song does not have. Diagnostics.
   * @param {number} instrument
   * @returns {number}
   */
  preview_warm_hold_ticks(instrument) {
    const ret = wasm.ahxplayer_preview_warm_hold_ticks(this.__wbg_ptr, instrument);
    return ret >>> 0;
  }
  /**
   * The instrument (1-based) that row belongs to, `0` when there is none.
   * @returns {number}
   */
  preview_plist_instrument() {
    const ret = wasm.ahxplayer_preview_plist_instrument(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {boolean}
   */
  continue_phase_on_trigger() {
    const ret = wasm.ahxplayer_continue_phase_on_trigger(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * [`replace_instrument`](Self::replace_instrument) without the hi-fi walk:
   * the instrument is swapped now, and any walk it owes waits for
   * [`finish_instrument_edits`](Self::finish_instrument_edits). A burst of
   * edits (the editor sends what has piled up in one message) is then one
   * walk of the song instead of one per instrument.
   * @param {number} instrument
   * @param {Uint8Array} bytes
   */
  replace_instrument_deferred(instrument, bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ahxplayer_replace_instrument_deferred(this.__wbg_ptr, instrument, ptr0, len0);
    if (ret[1]) {
      throw takeFromExternrefTable0(ret[0]);
    }
  }
  /**
   * Keep the wave phase across instrument triggers (the 68k behaviour)
   * instead of restarting it at 0; see
   * [`AhxEngine::set_continue_phase_on_trigger`]. Off by default, so a bare
   * `AhxPlayer` renders the reference goldens; the app's worklet turns it
   * on for every song it loads.
   * @param {boolean} on
   */
  set_continue_phase_on_trigger(on) {
    wasm.ahxplayer_set_continue_phase_on_trigger(this.__wbg_ptr, on);
  }
  /**
   * Parses an AHX (`THX`) or HVL file and builds a paused player.
   * `stereo_mode` (0..=4) is AHX's stereo-separation setting; HVL files
   * carry their own. The channel count follows the song: 4 for AHX, the
   * header's native count for HVL, see [`channels`](Self::channels).
   * @param {Uint8Array} bytes
   * @param {number} sample_rate
   * @param {number} stereo_mode
   */
  constructor(bytes, sample_rate, stereo_mode) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.ahxplayer_new(ptr0, len0, sample_rate, stereo_mode);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    this.__wbg_ptr = ret[0] >>> 0;
    AhxPlayerFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * @returns {number}
   */
  row() {
    const ret = wasm.ahxplayer_row(this.__wbg_ptr);
    return ret;
  }
  play() {
    wasm.ahxplayer_play(this.__wbg_ptr);
  }
  /**
   * Moves to `row` of `position` (an index into the song's position list),
   * keeping the play/pause state: a playing song carries on from there, a
   * paused one waits there. The next sample rendered is the first of that
   * row. Returns 0 for a position or row out of range (nothing changes), 1
   * when the song's own flow reaches it (every voice is exactly as if the
   * song had played to there, see [`AhxEngine::seek`]), 2 when it never
   * does and the row starts cold.
   * @param {number} position
   * @param {number} row
   * @returns {number}
   */
  seek(position, row) {
    const ret = wasm.ahxplayer_seek(this.__wbg_ptr, position, row);
    return ret;
  }
  /**
   * Stops rendering (the output is silence) without losing the position.
   */
  pause() {
    wasm.ahxplayer_pause(this.__wbg_ptr);
  }
  /**
   * Ticks per row (the song's current speed).
   * @returns {number}
   */
  tempo() {
    const ret = wasm.ahxplayer_tempo(this.__wbg_ptr);
    return ret;
  }
  /**
   * Ticks played so far (50 Hz x speed multiplier).
   * @returns {number}
   */
  ticks() {
    const ret = wasm.ahxplayer_ticks(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Fills `left`/`right` with planar `f32` and returns the number of
   * frames written (`min(left.len(), right.len())`). While paused the
   * engine does not advance and the output is zeroed.
   * @param {Float32Array} left
   * @param {Float32Array} right
   * @returns {number}
   */
  render(left, right) {
    var ptr0 = passArrayF32ToWasm0(left, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    var ptr1 = passArrayF32ToWasm0(right, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.ahxplayer_render(this.__wbg_ptr, ptr0, len0, left, ptr1, len1, right);
    return ret >>> 0;
  }
  /**
   * Back to the start of `subsong` (0 = the main song), paused. `false`
   * for an out-of-range subsong, in which case nothing changes.
   * @param {number} subsong
   * @returns {boolean}
   */
  restart(subsong) {
    const ret = wasm.ahxplayer_restart(this.__wbg_ptr, subsong);
    return ret !== 0;
  }
  /**
   * @returns {number}
   */
  channels() {
    const ret = wasm.ahxplayer_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  position() {
    const ret = wasm.ahxplayer_position(this.__wbg_ptr);
    return ret;
  }
  /**
   * Linear output gain, clamped to `[0, 2]`; NaN is ignored.
   * @param {number} gain
   */
  set_gain(gain) {
    wasm.ahxplayer_set_gain(this.__wbg_ptr, gain);
  }
  /**
   * Band-limited ("hi-fi") oscillators instead of the reference's aliasing
   * ones; see [`AhxEngine::set_hifi`]. Off by default here, and off is the
   * reference render byte for byte. The setting belongs to this player and
   * is kept across `rewind`.
   *
   * Turning it on *prewarms* a song player (see
   * [`AhxEngine::prewarm_hifi`]): every table the song needs is built before
   * this returns, so `render` never builds one. That blocks the caller for
   * the duration (measured in `tests/ahx_hifi.rs`); call it before `play`,
   * or accept one hiccup. A *preview* player has no song to walk: its bank
   * starts empty and locked, and each
   * [`preview_note_on`](Self::preview_note_on) prewarms the pressed
   * instrument at the pressed pitch, in that call, so `render` still never
   * builds -- a table the note reaches that the prewarm did not is a miss
   * ([`hifi_miss_count`](Self::hifi_miss_count)), degraded for that tick.
   * @param {boolean} on
   */
  set_hifi(on) {
    wasm.ahxplayer_set_hifi(this.__wbg_ptr, on);
  }
  /**
   * @returns {string}
   */
  song_name() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.ahxplayer_song_name(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
};
if (Symbol.dispose) AhxPlayer.prototype[Symbol.dispose] = AhxPlayer.prototype.free;
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
   * @param {WasmModulationType | null | undefined} modulation_type
   * @param {ModulationTransformation} modulation_transform
   */
  connect_macro(voice_index, macro_index, target_node, target_port, amount, modulation_type, modulation_transform) {
    const ptr0 = passStringToWasm0(target_node, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.audioengine_connect_macro(this.__wbg_ptr, voice_index, macro_index, ptr0, len0, target_port, amount, isLikeNone(modulation_type) ? 3 : modulation_type, modulation_transform);
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
   * @param {number} bits
   * @param {number} downsample_factor
   * @param {number} mix
   * @param {boolean} active
   * @returns {number}
   */
  add_bitcrusher(bits, downsample_factor, mix, active) {
    const ret = wasm.audioengine_add_bitcrusher(this.__wbg_ptr, bits, downsample_factor, mix, active);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
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
   * @param {number} drive
   * @param {number} mix
   * @param {boolean} active
   * @returns {number}
   */
  add_saturation(drive, mix, active) {
    const ret = wasm.audioengine_add_saturation(this.__wbg_ptr, drive, mix, active);
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
   * @param {number} bits
   * @param {number} downsample_factor
   * @param {number} mix
   * @param {boolean} active
   */
  update_bitcrusher(node_id, bits, downsample_factor, mix, active) {
    wasm.audioengine_update_bitcrusher(this.__wbg_ptr, node_id, bits, downsample_factor, mix, active);
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
   * @param {number} node_id
   * @param {number} drive
   * @param {number} mix
   * @param {boolean} active
   */
  update_saturation(node_id, drive, mix, active) {
    wasm.audioengine_update_saturation(this.__wbg_ptr, node_id, drive, mix, active);
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
if (Symbol.dispose) NoiseUpdateParams.prototype[Symbol.dispose] = NoiseUpdateParams.prototype.free;
var OplRendererFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_oplrenderer_free(ptr >>> 0, 1));
var OplRenderer = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    OplRendererFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_oplrenderer_free(ptr, 0);
  }
  /**
   * Writes applied after their time (a late batch from the main thread).
   * @returns {number}
   */
  late_writes() {
    const ret = wasm.oplrenderer_late_writes(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * The chip's native rate, for callers converting tick timing.
   * @returns {number}
   */
  native_rate() {
    const ret = wasm.oplrenderer_native_rate(this.__wbg_ptr);
    return ret;
  }
  /**
   * How many channels `read_tap` covers (18: every OPL3 channel).
   * @returns {number}
   */
  tap_channels() {
    const ret = wasm.a2player_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  queued_writes() {
    const ret = wasm.oplrenderer_queued_writes(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Output frames rendered so far: the clock `write_at` frames are on.
   * @returns {number}
   */
  frames_rendered() {
    const ret = wasm.oplrenderer_frames_rendered(this.__wbg_ptr);
    return ret;
  }
  /**
   * Bit per channel (0..17): 1 plays, 0 mutes. The chip keeps running.
   * @param {number} mask
   */
  set_channel_mask(mask) {
    wasm.oplrenderer_set_channel_mask(this.__wbg_ptr, mask);
  }
  /**
   * Record per-channel scope taps during `render` (off by default: it is
   * work nobody needs without a scope on screen).
   * @param {boolean} enabled
   */
  set_taps_enabled(enabled) {
    wasm.oplrenderer_set_taps_enabled(this.__wbg_ptr, enabled);
  }
  /**
   * @param {number} sample_rate
   */
  constructor(sample_rate) {
    const ret = wasm.oplrenderer_new(sample_rate);
    this.__wbg_ptr = ret >>> 0;
    OplRendererFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * Drop queued writes and silence the chip: every channel keyed off with
   * its release forced to the fastest rate, rhythm off. Registers other
   * than those keep their values (the next song re-programs them).
   */
  panic() {
    wasm.oplrenderer_panic(this.__wbg_ptr);
  }
  /**
   * Write a register now: before the next native sample.
   * @param {number} reg
   * @param {number} val
   */
  write(reg, val) {
    wasm.oplrenderer_write(this.__wbg_ptr, reg, val);
  }
  /**
   * Render `left.len()` frames (and the same into `right`). Returns frames.
   * @param {Float32Array} left
   * @param {Float32Array} right
   * @returns {number}
   */
  render(left, right) {
    var ptr0 = passArrayF32ToWasm0(left, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    var ptr1 = passArrayF32ToWasm0(right, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    const ret = wasm.oplrenderer_render(this.__wbg_ptr, ptr0, len0, left, ptr1, len1, right);
    return ret >>> 0;
  }
  /**
   * Copy channel `ch`'s tap from the last `render` into `out` (its
   * frames; ±1 is one operator's full swing). Zeros when taps are off.
   * @param {number} ch
   * @param {Float32Array} out
   */
  read_tap(ch, out) {
    var ptr0 = passArrayF32ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    wasm.oplrenderer_read_tap(this.__wbg_ptr, ch, ptr0, len0, out);
  }
  /**
   * @param {number} gain
   */
  set_gain(gain) {
    wasm.oplrenderer_set_gain(this.__wbg_ptr, gain);
  }
  /**
   * Queue a write for output frame `frame` (this renderer's own clock,
   * `frames_rendered`; fractional frames are honoured). Writes for the
   * same frame keep their order.
   * @param {number} frame
   * @param {number} reg
   * @param {number} val
   */
  write_at(frame, reg, val) {
    wasm.oplrenderer_write_at(this.__wbg_ptr, frame, reg, val);
  }
};
if (Symbol.dispose) OplRenderer.prototype[Symbol.dispose] = OplRenderer.prototype.free;
var SidChipPlayerFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_sidchipplayer_free(ptr >>> 0, 1));
var SidChipPlayer = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    SidChipPlayerFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_sidchipplayer_free(ptr, 0);
  }
  /**
   * `"8580"` or `"6581"`.
   * @returns {string}
   */
  chip_model() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.sidchipplayer_chip_model(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * Write register `reg` (0-31) `delay` chip cycles after the start of the next `render`.
   * @param {number} delay
   * @param {number} reg
   * @param {number} value
   */
  write_after(delay, reg, value) {
    wasm.sidchipplayer_write_after(this.__wbg_ptr, delay, reg, value);
  }
  /**
   * Play the 6581 as revision `name` (`DieRevision::name`); `false` for an unknown name.
   * @param {string} name
   * @returns {boolean}
   */
  set_revision(name) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sidchipplayer_set_revision(this.__wbg_ptr, ptr0, len0);
    return ret !== 0;
  }
  /**
   * Bit masks, bit `i` = voice `i`: muted voices, and (when non-zero) the
   * only voices heard. Same rule as `SidPlayer::set_mute_solo`.
   * @param {number} mute
   * @param {number} solo
   */
  set_mute_solo(mute, solo) {
    wasm.sidchipplayer_set_mute_solo(this.__wbg_ptr, mute, solo);
  }
  /**
   * A voice tap's full scale (`Chip::tap_full_scale`) at gain 1.0.
   * @returns {number}
   */
  tap_full_scale() {
    const ret = wasm.sidchipplayer_tap_full_scale(this.__wbg_ptr);
    return ret;
  }
  /**
   * A powered-on chip: an 8580 when `model_8580`, else a 6581, running at
   * `clock_hz` chip cycles per second (985 248 PAL, 1 022 727 NTSC) and
   * rendering at `sample_rate`.
   * @param {boolean} model_8580
   * @param {number} sample_rate
   * @param {number} clock_hz
   */
  constructor(model_8580, sample_rate, clock_hz) {
    const ret = wasm.sidchipplayer_new(model_8580, sample_rate, clock_hz);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    this.__wbg_ptr = ret[0] >>> 0;
    SidChipPlayerFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  /**
   * Write register `reg` now.
   * @param {number} reg
   * @param {number} value
   */
  write(reg, value) {
    wasm.sidchipplayer_write(this.__wbg_ptr, reg, value);
  }
  /**
   * Fills `out` with the mix and `v0`..`v2` with the three voices' taps.
   * Every buffer must be as long as `out`. Returns the frames written.
   * @param {Float32Array} out
   * @param {Float32Array} v0
   * @param {Float32Array} v1
   * @param {Float32Array} v2
   * @returns {number}
   */
  render(out, v0, v1, v2) {
    var ptr0 = passArrayF32ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    var ptr1 = passArrayF32ToWasm0(v0, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    var ptr2 = passArrayF32ToWasm0(v1, wasm.__wbindgen_malloc);
    var len2 = WASM_VECTOR_LEN;
    var ptr3 = passArrayF32ToWasm0(v2, wasm.__wbindgen_malloc);
    var len3 = WASM_VECTOR_LEN;
    const ret = wasm.sidchipplayer_render(this.__wbg_ptr, ptr0, len0, out, ptr1, len1, v0, ptr2, len2, v1, ptr3, len3, v2);
    return ret >>> 0;
  }
  /**
   * @param {number} gain
   */
  set_gain(gain) {
    wasm.sidchipplayer_set_gain(this.__wbg_ptr, gain);
  }
};
if (Symbol.dispose) SidChipPlayer.prototype[Symbol.dispose] = SidChipPlayer.prototype.free;
var SidPlayerFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {
}, unregister: () => {
} } : new FinalizationRegistry((ptr) => wasm.__wbg_sidplayer_free(ptr >>> 0, 1));
var SidPlayer = class {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    SidPlayerFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_sidplayer_free(ptr, 0);
  }
  /**
   * `"8580"` or `"6581"`: the chip this player built from the song's tag.
   * @returns {string}
   */
  chip_model() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.sidplayer_chip_model(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * @returns {boolean}
   */
  is_playing() {
    const ret = wasm.sidplayer_is_playing(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * Play the 6581 as revision `name` (`DieRevision::name`: "gt", "r2",
   * "r3", "r4", "r4ar") from the next sample on, without a reload. An 8580
   * song keeps its chip. `false` for an unknown name, which changes nothing.
   * @param {string} name
   * @returns {boolean}
   */
  set_revision(name) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sidplayer_set_revision(this.__wbg_ptr, ptr0, len0);
    return ret !== 0;
  }
  /**
   * Loops song rows `start..end` (`end` exclusive; `end <= start` plays on).
   * @param {number} start
   * @param {number} end
   */
  set_loop_rows(start, end) {
    wasm.sidplayer_set_loop_rows(this.__wbg_ptr, start, end);
  }
  /**
   * Bit masks, bit `i` = voice `i`: muted voices, and (when non-zero) the
   * only voices heard. Applied to the chip's voice mask.
   * @param {number} mute
   * @param {number} solo
   */
  set_mute_solo(mute, solo) {
    wasm.sidplayer_set_mute_solo(this.__wbg_ptr, mute, solo);
  }
  /**
   * Keyboard-preview mode: the song no longer plays; `preview_note_on`
   * sounds its instruments on one voice. Renders at once.
   */
  enable_preview() {
    wasm.sidplayer_enable_preview(this.__wbg_ptr);
  }
  /**
   * A voice tap's full scale (`Chip::tap_full_scale`) at gain 1.0.
   * @returns {number}
   */
  tap_full_scale() {
    const ret = wasm.sidplayer_tap_full_scale(this.__wbg_ptr);
    return ret;
  }
  clear_loop_rows() {
    wasm.sidplayer_clear_loop_rows(this.__wbg_ptr);
  }
  /**
   * Preview mode: `instrument` (1-based) at note table index `note`
   * (0 = C-0 .. 92 = G#7). `false` outside preview or for a missing instrument.
   * @param {number} instrument
   * @param {number} note
   * @returns {boolean}
   */
  preview_note_on(instrument, note) {
    const ret = wasm.sidplayer_preview_note_on(this.__wbg_ptr, instrument, note);
    return ret !== 0;
  }
  /**
   * @returns {number}
   */
  instrument_count() {
    const ret = wasm.sidplayer_instrument_count(this.__wbg_ptr);
    return ret >>> 0;
  }
  preview_note_off() {
    wasm.sidplayer_preview_note_off(this.__wbg_ptr);
  }
  /**
   * Whether the player has played past the song's last row.
   * @returns {boolean}
   */
  song_end_reached() {
    const ret = wasm.sidplayer_song_end_reached(this.__wbg_ptr);
    return ret !== 0;
  }
  /**
   * Parses a SID song file (`ASID`, what the app's `SidDoc` saves) and
   * builds a paused player for subsong 0 on a chip of the song's model.
   * @param {Uint8Array} bytes
   * @param {number} sample_rate
   */
  constructor(bytes, sample_rate) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sidplayer_new(ptr0, len0, sample_rate);
    if (ret[2]) {
      throw takeFromExternrefTable0(ret[1]);
    }
    this.__wbg_ptr = ret[0] >>> 0;
    SidPlayerFinalization.register(this, this.__wbg_ptr, this);
    return this;
  }
  play() {
    wasm.sidplayer_play(this.__wbg_ptr);
  }
  /**
   * Stops rendering (the output is silence) without losing the position.
   */
  pause() {
    wasm.sidplayer_pause(this.__wbg_ptr);
  }
  /**
   * Ticks per row now (the song's start tempo, or what an F command set).
   * @returns {number}
   */
  tempo() {
    const ret = wasm.sidplayer_tempo(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * Fills `out` with the mix and `v0`..`v2` with the three voices' taps;
   * silence (all four) while paused. Every buffer must be as long as `out`.
   * Returns the frames written.
   * @param {Float32Array} out
   * @param {Float32Array} v0
   * @param {Float32Array} v1
   * @param {Float32Array} v2
   * @returns {number}
   */
  render(out, v0, v1, v2) {
    var ptr0 = passArrayF32ToWasm0(out, wasm.__wbindgen_malloc);
    var len0 = WASM_VECTOR_LEN;
    var ptr1 = passArrayF32ToWasm0(v0, wasm.__wbindgen_malloc);
    var len1 = WASM_VECTOR_LEN;
    var ptr2 = passArrayF32ToWasm0(v1, wasm.__wbindgen_malloc);
    var len2 = WASM_VECTOR_LEN;
    var ptr3 = passArrayF32ToWasm0(v2, wasm.__wbindgen_malloc);
    var len3 = WASM_VECTOR_LEN;
    const ret = wasm.sidplayer_render(this.__wbg_ptr, ptr0, len0, out, ptr1, len1, v0, ptr2, len2, v1, ptr3, len3, v2);
    return ret >>> 0;
  }
  /**
   * @returns {number}
   */
  channels() {
    const ret = wasm.sidplayer_channels(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * The name of the 6581 revision the chip plays (`set_revision`).
   * @returns {string}
   */
  revision() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.sidplayer_revision(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  /**
   * Moves to the start of song row `row`, keeping the play/pause state
   * (`SidSongPlayer::seek_row`).
   * @param {number} row
   */
  seek_row(row) {
    wasm.sidplayer_seek_row(this.__wbg_ptr, row);
  }
  /**
   * @param {number} gain
   */
  set_gain(gain) {
    wasm.sidplayer_set_gain(this.__wbg_ptr, gain);
  }
  /**
   * The row being played, counted from the top of the song.
   * @returns {number}
   */
  song_row() {
    const ret = wasm.sidplayer_song_row(this.__wbg_ptr);
    return ret >>> 0;
  }
  /**
   * The song's length in rows (the longest channel's first pass).
   * @returns {number}
   */
  song_rows() {
    const ret = wasm.sidplayer_song_rows(this.__wbg_ptr);
    return ret >>> 0;
  }
};
if (Symbol.dispose) SidPlayer.prototype[Symbol.dispose] = SidPlayer.prototype.free;
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
  imports.wbg.__wbg_prototypesetcall_5521f1dd01df76fd = function(arg0, arg1, arg2) {
    Float32Array.prototype.set.call(getArrayF32FromWasm0(arg0, arg1), arg2);
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
  cachedUint16ArrayMemory0 = null;
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

// src/audio/tracker/psid/psid-file.ts
var V1_HEADER = 118;
var V2_HEADER = 124;
var TEXT = 32;
function looksLikePsid(bytes) {
  if (bytes.length < 4) return false;
  const m = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  return m === "PSID" || m === "RSID";
}
var word = (b, at) => b[at] << 8 | b[at + 1];
function text(b, at) {
  let s = "";
  for (let i = 0; i < TEXT; i++) {
    const c = b[at + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
var CLOCKS = ["unknown", "pal", "ntsc", "any"];
var MODELS = ["unknown", "6581", "8580", "any"];
function extraSidAddress(v) {
  if (v & 1) return null;
  if (v >= 66 && v <= 127 || v >= 224 && v <= 254) return 53248 | v << 4;
  return null;
}
var hex4 = (v) => `$${v.toString(16).toUpperCase().padStart(4, "0")}`;
function parsePsid(bytes) {
  if (!looksLikePsid(bytes)) return { ok: false, reason: "it is not a SID file (no PSID/RSID magic)" };
  if (bytes.length < V1_HEADER) return { ok: false, reason: `the file is ${bytes.length} bytes, shorter than a SID header` };
  const type = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const version = word(bytes, 4);
  if (version < 1 || version > 4) return { ok: false, reason: `its header is version ${version}; SID files are versions 1-4` };
  if (type === "RSID" && version < 2) return { ok: false, reason: "it is an RSID file of version 1, which the format does not have" };
  const dataOffset = word(bytes, 6);
  const expected = version === 1 ? V1_HEADER : V2_HEADER;
  if (dataOffset !== expected) {
    return { ok: false, reason: `its data starts at ${hex4(dataOffset)}; a version ${version} file's starts at ${hex4(expected)}` };
  }
  if (bytes.length < dataOffset) return { ok: false, reason: "the file ends inside its header" };
  let loadAddress = word(bytes, 8);
  let data = bytes.subarray(dataOffset);
  if (loadAddress === 0) {
    if (data.length < 2) return { ok: false, reason: "the file has no data after its header" };
    loadAddress = data[0] | data[1] << 8;
    data = data.subarray(2);
  }
  if (data.length === 0) return { ok: false, reason: "the file has no C64 data" };
  if (loadAddress + data.length > 65536) {
    return { ok: false, reason: `its ${data.length} bytes load at ${hex4(loadAddress)} and run past the end of the C64's memory` };
  }
  const initAddress = word(bytes, 10) || loadAddress;
  const playAddress = word(bytes, 12);
  const songs = word(bytes, 14);
  if (songs < 1 || songs > 256) return { ok: false, reason: `its header says ${songs} songs; a SID file has 1-256` };
  const start = word(bytes, 16);
  const startSong = start >= 1 && start <= songs ? start : 1;
  const speed = (bytes[18] << 24 | bytes[19] << 16 | bytes[20] << 8 | bytes[21]) >>> 0;
  const flags = version >= 2 ? word(bytes, 118) : 0;
  if (type === "PSID" && flags & 1) {
    return { ok: false, reason: "it holds Compute!'s Sidplayer (MUS) data, not a program to run" };
  }
  if (type === "RSID" && flags & 2) {
    return { ok: false, reason: "it is a C64 BASIC program; running it needs the C64's BASIC ROM, which this importer does not have" };
  }
  const extraSids = [];
  if (version >= 3) {
    const second = extraSidAddress(bytes[122]);
    if (second !== null) {
      extraSids.push(second);
      if (version >= 4) {
        const third = extraSidAddress(bytes[123]);
        if (third !== null && third !== second) extraSids.push(third);
      }
    }
  }
  return {
    ok: true,
    file: {
      type,
      version,
      loadAddress,
      initAddress,
      playAddress,
      songs,
      startSong,
      speed,
      name: text(bytes, 22),
      author: text(bytes, 54),
      released: text(bytes, 86),
      flags,
      clock: CLOCKS[flags >> 2 & 3],
      sidModel: MODELS[flags >> 4 & 3],
      extraSids,
      relocStartPage: version >= 2 ? bytes[120] : 0,
      relocPages: version >= 2 ? bytes[121] : 0,
      data
    }
  };
}
function psidSongUsesCia(file, song) {
  if (file.type === "RSID") return false;
  const bit = Math.min(31, Math.max(0, song - 1));
  return (file.speed >>> bit & 1) === 1;
}

// src/audio/tracker/psid/mos6510.ts
var C = 1;
var Z = 2;
var I = 4;
var D = 8;
var B = 16;
var U = 32;
var V = 64;
var N = 128;
var IMP = 0;
var IMM = 1;
var ZP = 2;
var ZPX = 3;
var ZPY = 4;
var ABS = 5;
var ABX = 6;
var ABY = 7;
var IND = 8;
var IZX = 9;
var IZY = 10;
var REL = 11;
var ACC = 12;
var enumOps = [
  "ADC",
  "AND",
  "ASL",
  "BCC",
  "BCS",
  "BEQ",
  "BIT",
  "BMI",
  "BNE",
  "BPL",
  "BRK",
  "BVC",
  "BVS",
  "CLC",
  "CLD",
  "CLI",
  "CLV",
  "CMP",
  "CPX",
  "CPY",
  "DEC",
  "DEX",
  "DEY",
  "EOR",
  "INC",
  "INX",
  "INY",
  "JMP",
  "JSR",
  "LDA",
  "LDX",
  "LDY",
  "LSR",
  "NOP",
  "ORA",
  "PHA",
  "PHP",
  "PLA",
  "PLP",
  "ROL",
  "ROR",
  "RTI",
  "RTS",
  "SBC",
  "SEC",
  "SED",
  "SEI",
  "STA",
  "STX",
  "STY",
  "TAX",
  "TAY",
  "TSX",
  "TXA",
  "TXS",
  "TYA",
  "SLO",
  "RLA",
  "SRE",
  "RRA",
  "SAX",
  "LAX",
  "DCP",
  "ISC",
  "ANC",
  "ALR",
  "ARR",
  "SBX",
  "LAS",
  "SHA",
  "SHX",
  "SHY",
  "TAS",
  "ANE",
  "LXA",
  "JAM"
];
var OP = Object.fromEntries(enumOps.map((n, i) => [n, i]));
var KIND = new Uint8Array(256).fill(OP.JAM);
var MODE = new Uint8Array(256);
var CYCLES = new Uint8Array(256).fill(2);
var PAGE = new Uint8Array(256);
function op(code, name, mode, cycles, page = 0) {
  KIND[code] = OP[name];
  MODE[code] = mode;
  CYCLES[code] = cycles;
  PAGE[code] = page;
}
function aluGroup(base, name) {
  op(base + 0, name, IZX, 6);
  op(base + 4, name, ZP, 3);
  op(base + 8, name, IMM, 2);
  op(base + 12, name, ABS, 4);
  op(base + 16, name, IZY, 5, 1);
  op(base + 20, name, ZPX, 4);
  op(base + 24, name, ABY, 4, 1);
  op(base + 28, name, ABX, 4, 1);
}
aluGroup(1, "ORA");
aluGroup(33, "AND");
aluGroup(65, "EOR");
aluGroup(97, "ADC");
aluGroup(161, "LDA");
aluGroup(193, "CMP");
aluGroup(225, "SBC");
op(129, "STA", IZX, 6);
op(133, "STA", ZP, 3);
op(141, "STA", ABS, 4);
op(145, "STA", IZY, 6);
op(149, "STA", ZPX, 4);
op(153, "STA", ABY, 5);
op(157, "STA", ABX, 5);
op(137, "NOP", IMM, 2);
function rmwGroup(zp, name, acc) {
  op(zp, name, ZP, 5);
  if (acc) op(zp + 4, name, ACC, 2);
  op(zp + 8, name, ABS, 6);
  op(zp + 16, name, ZPX, 6);
  op(zp + 24, name, ABX, 7);
}
rmwGroup(6, "ASL", true);
rmwGroup(38, "ROL", true);
rmwGroup(70, "LSR", true);
rmwGroup(102, "ROR", true);
rmwGroup(198, "DEC", false);
rmwGroup(230, "INC", false);
function illegalRmwGroup(base, name) {
  op(base + 0, name, IZX, 8);
  op(base + 4, name, ZP, 5);
  op(base + 12, name, ABS, 6);
  op(base + 16, name, IZY, 8);
  op(base + 20, name, ZPX, 6);
  op(base + 24, name, ABY, 7);
  op(base + 28, name, ABX, 7);
}
illegalRmwGroup(3, "SLO");
illegalRmwGroup(35, "RLA");
illegalRmwGroup(67, "SRE");
illegalRmwGroup(99, "RRA");
illegalRmwGroup(195, "DCP");
illegalRmwGroup(227, "ISC");
op(131, "SAX", IZX, 6);
op(135, "SAX", ZP, 3);
op(143, "SAX", ABS, 4);
op(151, "SAX", ZPY, 4);
op(163, "LAX", IZX, 6);
op(167, "LAX", ZP, 3);
op(171, "LXA", IMM, 2);
op(175, "LAX", ABS, 4);
op(179, "LAX", IZY, 5, 1);
op(183, "LAX", ZPY, 4);
op(191, "LAX", ABY, 4, 1);
op(11, "ANC", IMM, 2);
op(43, "ANC", IMM, 2);
op(75, "ALR", IMM, 2);
op(107, "ARR", IMM, 2);
op(139, "ANE", IMM, 2);
op(203, "SBX", IMM, 2);
op(235, "SBC", IMM, 2);
op(147, "SHA", IZY, 6);
op(159, "SHA", ABY, 5);
op(155, "TAS", ABY, 5);
op(156, "SHY", ABX, 5);
op(158, "SHX", ABY, 5);
op(187, "LAS", ABY, 4, 1);
op(162, "LDX", IMM, 2);
op(166, "LDX", ZP, 3);
op(174, "LDX", ABS, 4);
op(182, "LDX", ZPY, 4);
op(190, "LDX", ABY, 4, 1);
op(160, "LDY", IMM, 2);
op(164, "LDY", ZP, 3);
op(172, "LDY", ABS, 4);
op(180, "LDY", ZPX, 4);
op(188, "LDY", ABX, 4, 1);
op(134, "STX", ZP, 3);
op(142, "STX", ABS, 4);
op(150, "STX", ZPY, 4);
op(132, "STY", ZP, 3);
op(140, "STY", ABS, 4);
op(148, "STY", ZPX, 4);
op(224, "CPX", IMM, 2);
op(228, "CPX", ZP, 3);
op(236, "CPX", ABS, 4);
op(192, "CPY", IMM, 2);
op(196, "CPY", ZP, 3);
op(204, "CPY", ABS, 4);
op(36, "BIT", ZP, 3);
op(44, "BIT", ABS, 4);
op(16, "BPL", REL, 2);
op(48, "BMI", REL, 2);
op(80, "BVC", REL, 2);
op(112, "BVS", REL, 2);
op(144, "BCC", REL, 2);
op(176, "BCS", REL, 2);
op(208, "BNE", REL, 2);
op(240, "BEQ", REL, 2);
op(0, "BRK", IMP, 7);
op(32, "JSR", ABS, 6);
op(64, "RTI", IMP, 6);
op(96, "RTS", IMP, 6);
op(76, "JMP", ABS, 3);
op(108, "JMP", IND, 5);
op(8, "PHP", IMP, 3);
op(40, "PLP", IMP, 4);
op(72, "PHA", IMP, 3);
op(104, "PLA", IMP, 4);
op(24, "CLC", IMP, 2);
op(56, "SEC", IMP, 2);
op(88, "CLI", IMP, 2);
op(120, "SEI", IMP, 2);
op(184, "CLV", IMP, 2);
op(216, "CLD", IMP, 2);
op(248, "SED", IMP, 2);
op(136, "DEY", IMP, 2);
op(200, "INY", IMP, 2);
op(202, "DEX", IMP, 2);
op(232, "INX", IMP, 2);
op(138, "TXA", IMP, 2);
op(152, "TYA", IMP, 2);
op(154, "TXS", IMP, 2);
op(168, "TAY", IMP, 2);
op(170, "TAX", IMP, 2);
op(186, "TSX", IMP, 2);
op(234, "NOP", IMP, 2);
for (const c of [26, 58, 90, 122, 218, 250]) op(c, "NOP", IMP, 2);
for (const c of [128, 130, 194, 226]) op(c, "NOP", IMM, 2);
for (const c of [4, 68, 100]) op(c, "NOP", ZP, 3);
for (const c of [20, 52, 84, 116, 212, 244]) op(c, "NOP", ZPX, 4);
op(12, "NOP", ABS, 4);
for (const c of [28, 60, 92, 124, 220, 252]) op(c, "NOP", ABX, 4, 1);
for (const c of [2, 18, 34, 50, 66, 82, 98, 114, 146, 178, 210, 242]) op(c, "JAM", IMP, 2);
var Mos6510 = class {
  constructor(bus) {
    this.bus = bus;
    __publicField(this, "a", 0);
    __publicField(this, "x", 0);
    __publicField(this, "y", 0);
    __publicField(this, "sp", 255);
    __publicField(this, "p", U | I);
    __publicField(this, "pc", 0);
    /** Clock cycles run so far. */
    __publicField(this, "cycles", 0);
    /** A JAM opcode stopped the CPU at `pc`. */
    __publicField(this, "jammed", false);
  }
  push(v) {
    this.bus.write(256 | this.sp, v);
    this.sp = this.sp - 1 & 255;
  }
  pull() {
    this.sp = this.sp + 1 & 255;
    return this.bus.read(256 | this.sp);
  }
  setNZ(v) {
    this.p = this.p & ~(N | Z) | v & N | (v === 0 ? Z : 0);
    return v;
  }
  adc(v) {
    const a = this.a;
    const c = this.p & C;
    if (this.p & D) {
      let lo = (a & 15) + (v & 15) + c;
      if (lo > 9) lo += 6;
      let t = lo <= 15 ? (lo & 15) + (a & 240) + (v & 240) : (lo & 15) + (a & 240) + (v & 240) + 16;
      const zero = (a + v + c & 255) === 0;
      const neg = (t & 128) !== 0;
      const ovf = ((a ^ t) & 128) !== 0 && ((a ^ v) & 128) === 0;
      if ((t & 496) > 144) t += 96;
      const carry = (t & 4080) > 240;
      this.p = this.p & ~(N | V | Z | C) | (neg ? N : 0) | (ovf ? V : 0) | (zero ? Z : 0) | (carry ? C : 0);
      this.a = t & 255;
      return;
    }
    const r = a + v + c;
    this.p = this.p & ~(V | C) | ((~(a ^ v) & (a ^ r) & 128) !== 0 ? V : 0) | (r > 255 ? C : 0);
    this.a = this.setNZ(r & 255);
  }
  sbc(v) {
    const a = this.a;
    const borrow = this.p & C ^ 1;
    const r = a - v - borrow;
    this.p = this.p & ~(V | C) | (((a ^ v) & (a ^ r) & 128) !== 0 ? V : 0) | (r >= 0 ? C : 0);
    this.setNZ(r & 255);
    if (this.p & D) {
      const lo = (a & 15) - (v & 15) - borrow;
      let t = lo & 16 ? lo - 6 & 15 | (a & 240) - (v & 240) - 16 : lo & 15 | (a & 240) - (v & 240);
      if (t & 256) t -= 96;
      this.a = t & 255;
      return;
    }
    this.a = r & 255;
  }
  compare(reg, v) {
    const r = reg - v;
    this.p = this.p & ~C | (r >= 0 ? C : 0);
    this.setNZ(r & 255);
  }
  asl(v) {
    this.p = this.p & ~C | v >> 7;
    return this.setNZ(v << 1 & 255);
  }
  lsr(v) {
    this.p = this.p & ~C | v & 1;
    return this.setNZ(v >> 1);
  }
  rol(v) {
    const r = (v << 1 | this.p & C) & 255;
    this.p = this.p & ~C | v >> 7;
    return this.setNZ(r);
  }
  ror(v) {
    const r = v >> 1 | (this.p & C) << 7;
    this.p = this.p & ~C | v & 1;
    return this.setNZ(r);
  }
  /** Take the IRQ line: false (nothing done) while I is set. */
  irq() {
    if (this.p & I) return false;
    this.interrupt(65534);
    return true;
  }
  /** Take an NMI (edge): always. */
  nmi() {
    this.interrupt(65530);
  }
  interrupt(vector) {
    this.jammed = false;
    this.push(this.pc >> 8);
    this.push(this.pc & 255);
    this.push(this.p & ~B | U);
    this.p |= I;
    this.pc = this.bus.read(vector) | this.bus.read(vector + 1) << 8;
    this.cycles += 7;
  }
  /** Run one instruction; its cycles. A jammed CPU stays put (2 cycles a call, so time still passes). */
  step() {
    if (this.jammed) {
      this.cycles += 2;
      return 2;
    }
    const bus = this.bus;
    const opcode = bus.read(this.pc);
    let pc = this.pc + 1 & 65535;
    let cycles = CYCLES[opcode];
    let addr = 0;
    let high1 = 0;
    switch (MODE[opcode]) {
      case IMM:
        addr = pc;
        pc = pc + 1 & 65535;
        break;
      case ZP:
        addr = bus.read(pc);
        pc = pc + 1 & 65535;
        break;
      case ZPX:
        addr = bus.read(pc) + this.x & 255;
        pc = pc + 1 & 65535;
        break;
      case ZPY:
        addr = bus.read(pc) + this.y & 255;
        pc = pc + 1 & 65535;
        break;
      case ABS:
        addr = bus.read(pc) | bus.read(pc + 1 & 65535) << 8;
        pc = pc + 2 & 65535;
        break;
      case ABX: {
        const base = bus.read(pc) | bus.read(pc + 1 & 65535) << 8;
        addr = base + this.x & 65535;
        if (PAGE[opcode] && (base ^ addr) & 65280) cycles++;
        high1 = (base >> 8) + 1 & 255;
        pc = pc + 2 & 65535;
        break;
      }
      case ABY: {
        const base = bus.read(pc) | bus.read(pc + 1 & 65535) << 8;
        addr = base + this.y & 65535;
        if (PAGE[opcode] && (base ^ addr) & 65280) cycles++;
        high1 = (base >> 8) + 1 & 255;
        pc = pc + 2 & 65535;
        break;
      }
      case IND: {
        const ptr = bus.read(pc) | bus.read(pc + 1 & 65535) << 8;
        addr = bus.read(ptr) | bus.read(ptr & 65280 | ptr + 1 & 255) << 8;
        pc = pc + 2 & 65535;
        break;
      }
      case IZX: {
        const zp = bus.read(pc) + this.x & 255;
        addr = bus.read(zp) | bus.read(zp + 1 & 255) << 8;
        pc = pc + 1 & 65535;
        break;
      }
      case IZY: {
        const zp = bus.read(pc);
        const base = bus.read(zp) | bus.read(zp + 1 & 255) << 8;
        addr = base + this.y & 65535;
        if (PAGE[opcode] && (base ^ addr) & 65280) cycles++;
        high1 = (base >> 8) + 1 & 255;
        pc = pc + 1 & 65535;
        break;
      }
      case REL: {
        const d = bus.read(pc);
        pc = pc + 1 & 65535;
        addr = pc + (d < 128 ? d : d - 256) & 65535;
        break;
      }
      default:
        break;
    }
    this.pc = pc;
    switch (KIND[opcode]) {
      case OP.LDA:
        this.a = this.setNZ(bus.read(addr));
        break;
      case OP.LDX:
        this.x = this.setNZ(bus.read(addr));
        break;
      case OP.LDY:
        this.y = this.setNZ(bus.read(addr));
        break;
      case OP.STA:
        bus.write(addr, this.a);
        break;
      case OP.STX:
        bus.write(addr, this.x);
        break;
      case OP.STY:
        bus.write(addr, this.y);
        break;
      case OP.ADC:
        this.adc(bus.read(addr));
        break;
      case OP.SBC:
        this.sbc(bus.read(addr));
        break;
      case OP.AND:
        this.a = this.setNZ(this.a & bus.read(addr));
        break;
      case OP.ORA:
        this.a = this.setNZ(this.a | bus.read(addr));
        break;
      case OP.EOR:
        this.a = this.setNZ(this.a ^ bus.read(addr));
        break;
      case OP.CMP:
        this.compare(this.a, bus.read(addr));
        break;
      case OP.CPX:
        this.compare(this.x, bus.read(addr));
        break;
      case OP.CPY:
        this.compare(this.y, bus.read(addr));
        break;
      case OP.BIT: {
        const v = bus.read(addr);
        this.p = this.p & ~(N | V | Z) | v & (N | V) | ((this.a & v) === 0 ? Z : 0);
        break;
      }
      case OP.ASL:
      case OP.LSR:
      case OP.ROL:
      case OP.ROR:
      case OP.INC:
      case OP.DEC: {
        const kind = KIND[opcode];
        if (MODE[opcode] === ACC) {
          this.a = this.shift(kind, this.a);
          break;
        }
        const v = bus.read(addr);
        bus.write(addr, v);
        bus.write(addr, this.shift(kind, v));
        break;
      }
      case OP.SLO: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = this.asl(v);
        bus.write(addr, r);
        this.a = this.setNZ(this.a | r);
        break;
      }
      case OP.RLA: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = this.rol(v);
        bus.write(addr, r);
        this.a = this.setNZ(this.a & r);
        break;
      }
      case OP.SRE: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = this.lsr(v);
        bus.write(addr, r);
        this.a = this.setNZ(this.a ^ r);
        break;
      }
      case OP.RRA: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = this.ror(v);
        bus.write(addr, r);
        this.adc(r);
        break;
      }
      case OP.DCP: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = v - 1 & 255;
        bus.write(addr, r);
        this.compare(this.a, r);
        break;
      }
      case OP.ISC: {
        const v = bus.read(addr);
        bus.write(addr, v);
        const r = v + 1 & 255;
        bus.write(addr, r);
        this.sbc(r);
        break;
      }
      case OP.SAX:
        bus.write(addr, this.a & this.x);
        break;
      case OP.LAX:
        this.a = this.x = this.setNZ(bus.read(addr));
        break;
      case OP.LXA:
        this.a = this.x = this.setNZ((this.a | 238) & bus.read(addr));
        break;
      case OP.ANE:
        this.a = this.setNZ((this.a | 238) & this.x & bus.read(addr));
        break;
      case OP.ANC:
        this.a = this.setNZ(this.a & bus.read(addr));
        this.p = this.p & ~C | this.a >> 7;
        break;
      case OP.ALR:
        this.a = this.lsr(this.a & bus.read(addr));
        break;
      case OP.ARR: {
        const t = this.a & bus.read(addr);
        const r = t >> 1 | (this.p & C) << 7;
        this.setNZ(r);
        this.p = this.p & ~(C | V) | r >> 6 & 1 | ((r >> 6 ^ r >> 5) & 1 ? V : 0);
        this.a = r;
        break;
      }
      case OP.SBX: {
        const t = (this.a & this.x) - bus.read(addr);
        this.p = this.p & ~C | (t >= 0 ? C : 0);
        this.x = this.setNZ(t & 255);
        break;
      }
      case OP.LAS:
        this.a = this.x = this.sp = this.setNZ(bus.read(addr) & this.sp);
        break;
      case OP.SHA:
        bus.write(addr, this.a & this.x & high1);
        break;
      case OP.SHX:
        bus.write(addr, this.x & high1);
        break;
      case OP.SHY:
        bus.write(addr, this.y & high1);
        break;
      case OP.TAS:
        this.sp = this.a & this.x;
        bus.write(addr, this.sp & high1);
        break;
      case OP.NOP:
        if (MODE[opcode] !== IMP && MODE[opcode] !== IMM) bus.read(addr);
        break;
      case OP.INX:
        this.x = this.setNZ(this.x + 1 & 255);
        break;
      case OP.INY:
        this.y = this.setNZ(this.y + 1 & 255);
        break;
      case OP.DEX:
        this.x = this.setNZ(this.x - 1 & 255);
        break;
      case OP.DEY:
        this.y = this.setNZ(this.y - 1 & 255);
        break;
      case OP.TAX:
        this.x = this.setNZ(this.a);
        break;
      case OP.TAY:
        this.y = this.setNZ(this.a);
        break;
      case OP.TXA:
        this.a = this.setNZ(this.x);
        break;
      case OP.TYA:
        this.a = this.setNZ(this.y);
        break;
      case OP.TSX:
        this.x = this.setNZ(this.sp);
        break;
      case OP.TXS:
        this.sp = this.x;
        break;
      case OP.PHA:
        this.push(this.a);
        break;
      case OP.PHP:
        this.push(this.p | B | U);
        break;
      case OP.PLA:
        this.a = this.setNZ(this.pull());
        break;
      case OP.PLP:
        this.p = this.pull() & ~B | U;
        break;
      case OP.CLC:
        this.p &= ~C;
        break;
      case OP.SEC:
        this.p |= C;
        break;
      case OP.CLI:
        this.p &= ~I;
        break;
      case OP.SEI:
        this.p |= I;
        break;
      case OP.CLV:
        this.p &= ~V;
        break;
      case OP.CLD:
        this.p &= ~D;
        break;
      case OP.SED:
        this.p |= D;
        break;
      case OP.BPL:
        cycles += this.branch(!(this.p & N), addr);
        break;
      case OP.BMI:
        cycles += this.branch((this.p & N) !== 0, addr);
        break;
      case OP.BVC:
        cycles += this.branch(!(this.p & V), addr);
        break;
      case OP.BVS:
        cycles += this.branch((this.p & V) !== 0, addr);
        break;
      case OP.BCC:
        cycles += this.branch(!(this.p & C), addr);
        break;
      case OP.BCS:
        cycles += this.branch((this.p & C) !== 0, addr);
        break;
      case OP.BNE:
        cycles += this.branch(!(this.p & Z), addr);
        break;
      case OP.BEQ:
        cycles += this.branch((this.p & Z) !== 0, addr);
        break;
      case OP.JMP:
        this.pc = addr;
        break;
      case OP.JSR: {
        const ret = this.pc - 1 & 65535;
        this.push(ret >> 8);
        this.push(ret & 255);
        this.pc = addr;
        break;
      }
      case OP.RTS: {
        const lo = this.pull();
        this.pc = (this.pull() << 8 | lo) + 1 & 65535;
        break;
      }
      case OP.RTI: {
        this.p = this.pull() & ~B | U;
        const lo = this.pull();
        this.pc = this.pull() << 8 | lo;
        break;
      }
      case OP.BRK: {
        const ret = this.pc + 1 & 65535;
        this.push(ret >> 8);
        this.push(ret & 255);
        this.push(this.p | B | U);
        this.p |= I;
        this.pc = bus.read(65534) | bus.read(65535) << 8;
        break;
      }
      case OP.JAM:
        this.jammed = true;
        this.pc = this.pc - 1 & 65535;
        break;
      default:
        break;
    }
    this.cycles += cycles;
    return cycles;
  }
  shift(kind, v) {
    switch (kind) {
      case OP.ASL:
        return this.asl(v);
      case OP.LSR:
        return this.lsr(v);
      case OP.ROL:
        return this.rol(v);
      case OP.ROR:
        return this.ror(v);
      case OP.INC:
        return this.setNZ(v + 1 & 255);
      default:
        return this.setNZ(v - 1 & 255);
    }
  }
  /** A branch to `target` when `taken`: its extra cycles (1, or 2 across a page). */
  branch(taken, target) {
    if (!taken) return 0;
    const extra = (target & 65280) === (this.pc & 65280) ? 1 : 2;
    this.pc = target;
    return extra;
  }
};

// src/audio/tracker/psid/c64.ts
var C64_TIMING = {
  pal: { hz: 985248, cyclesPerLine: 63, lines: 312, kernalCiaLatch: 16421 },
  ntsc: { hz: 1022727, cyclesPerLine: 65, lines: 263, kernalCiaLatch: 17045 }
};
var c64FrameCycles = (t) => t.cyclesPerLine * t.lines;
var KERNAL_IRQ_ENTRY = 65352;
var KERNAL_NMI_ENTRY = 65091;
var KERNAL_IRQ_HANDLER = 59953;
var KERNAL_NMI_HANDLER = 65095;
var KERNAL_BRK_HANDLER = 65126;
var RTS = 96;
function standInKernal() {
  const rom = new Uint8Array(8192).fill(RTS);
  const put = (addr, bytes) => rom.set(bytes, addr - 57344);
  put(KERNAL_IRQ_ENTRY, [72, 138, 72, 152, 72, 186, 189, 4, 1, 41, 16, 240, 3, 108, 22, 3, 108, 20, 3]);
  put(KERNAL_NMI_ENTRY, [120, 108, 24, 3]);
  put(KERNAL_NMI_HANDLER, [72, 173, 13, 221, 104, 64]);
  put(65212, [104, 168, 104, 170, 104, 64]);
  put(KERNAL_IRQ_HANDLER, [76, 126, 234]);
  put(60030, [173, 13, 220, 104, 168, 104, 170, 104, 64]);
  put(64738, [76, 226, 252]);
  put(65530, [KERNAL_NMI_ENTRY & 255, KERNAL_NMI_ENTRY >> 8, 226, 252, KERNAL_IRQ_ENTRY & 255, KERNAL_IRQ_ENTRY >> 8]);
  return rom;
}
var STAND_IN_KERNAL = standInKernal();
var STAND_IN_BASIC = new Uint8Array(8192).fill(RTS);
function zobrist(k, seed) {
  let x = Math.imul(k ^ seed, 2654435761);
  x ^= x >>> 15;
  x = Math.imul(x, 2246822507);
  x ^= x >>> 13;
  x = Math.imul(x, 3266489909);
  x ^= x >>> 16;
  return x | 0;
}
var SEED_A = 625341585;
var SEED_B = 1821285621;
var IO_KEY = 65536;
var CiaTimer = class {
  constructor() {
    __publicField(this, "latch", 65535);
    /** The counter while stopped. */
    __publicField(this, "counter", 65535);
    __publicField(this, "running", false);
    __publicField(this, "oneShot", false);
    /** While running: the cycle of the next underflow. */
    __publicField(this, "nextUnderflow", Infinity);
    /** Timer B only: counts timer A underflows instead of cycles. */
    __publicField(this, "countsA", false);
  }
};
var Cia = class {
  constructor() {
    __publicField(this, "a", new CiaTimer());
    __publicField(this, "b", new CiaTimer());
    __publicField(this, "cra", 0);
    __publicField(this, "crb", 0);
    __publicField(this, "mask", 0);
    __publicField(this, "flags", 0);
    __publicField(this, "portA", 255);
    __publicField(this, "portB", 255);
    __publicField(this, "ddrA", 0);
    __publicField(this, "ddrB", 0);
  }
  /** Bring the timers to cycle `now`, setting the interrupt flags of every underflow up to it. */
  sync(now) {
    const a = this.a;
    const b = this.b;
    while (a.running && a.nextUnderflow <= now) {
      const at = a.nextUnderflow;
      this.flags |= 1;
      if (b.running && b.countsA) this.countB(at);
      if (a.oneShot) {
        a.running = false;
        a.counter = a.latch;
        this.cra &= ~1;
        a.nextUnderflow = Infinity;
      } else {
        a.nextUnderflow = at + a.latch + 1;
      }
    }
    while (b.running && !b.countsA && b.nextUnderflow <= now) {
      const at = b.nextUnderflow;
      this.flags |= 2;
      if (b.oneShot) {
        b.running = false;
        b.counter = b.latch;
        this.crb &= ~1;
        b.nextUnderflow = Infinity;
      } else {
        b.nextUnderflow = at + b.latch + 1;
      }
    }
  }
  countB(_at) {
    const b = this.b;
    if (b.counter === 0) {
      this.flags |= 2;
      b.counter = b.latch;
      if (b.oneShot) {
        b.running = false;
        this.crb &= ~1;
      }
    } else {
      b.counter--;
    }
  }
  /** The counter's value at `now` (after `sync(now)`). */
  counterAt(t, now) {
    if (!t.running || t === this.b && t.countsA) return t.counter;
    return Math.max(0, Math.min(65535, t.nextUnderflow - now - 1));
  }
  /** The next cycle at which an enabled interrupt source fires (Infinity: none). */
  nextInterrupt() {
    let next = Infinity;
    if (this.mask & 1 && this.a.running) next = this.a.nextUnderflow;
    if (this.mask & 2 && this.b.running && !this.b.countsA) next = Math.min(next, this.b.nextUnderflow);
    if (this.mask & 2 && this.b.running && this.b.countsA && this.a.running) next = Math.min(next, this.a.nextUnderflow);
    return next;
  }
  get asserted() {
    return (this.flags & this.mask & 31) !== 0;
  }
  read(reg, now) {
    this.sync(now);
    switch (reg) {
      case 0:
        return (this.portA | ~this.ddrA) & 255;
      case 1:
        return (this.portB | ~this.ddrB) & 255;
      case 2:
        return this.ddrA;
      case 3:
        return this.ddrB;
      case 4:
        return this.counterAt(this.a, now) & 255;
      case 5:
        return this.counterAt(this.a, now) >> 8;
      case 6:
        return this.counterAt(this.b, now) & 255;
      case 7:
        return this.counterAt(this.b, now) >> 8;
      case 13: {
        const v = this.flags & 31 | (this.asserted ? 128 : 0);
        this.flags = 0;
        return v;
      }
      case 14:
        return this.cra & 239;
      case 15:
        return this.crb & 239;
      default:
        return 0;
    }
  }
  write(reg, v, now) {
    this.sync(now);
    const a = this.a;
    const b = this.b;
    switch (reg) {
      case 0:
        this.portA = v;
        break;
      case 1:
        this.portB = v;
        break;
      case 2:
        this.ddrA = v;
        break;
      case 3:
        this.ddrB = v;
        break;
      case 4:
        a.latch = a.latch & 65280 | v;
        break;
      case 5:
        a.latch = a.latch & 255 | v << 8;
        if (!a.running) a.counter = a.latch;
        break;
      case 6:
        b.latch = b.latch & 65280 | v;
        break;
      case 7:
        b.latch = b.latch & 255 | v << 8;
        if (!b.running) b.counter = b.latch;
        break;
      case 13:
        if (v & 128) this.mask |= v & 31;
        else this.mask &= ~(v & 31);
        break;
      case 14:
        this.control(a, v, now, false);
        this.cra = v & ~16;
        break;
      case 15:
        this.control(b, v, now, true);
        this.crb = v & ~16;
        break;
      default:
        break;
    }
  }
  control(t, v, now, isB) {
    const current = this.counterAt(t, now);
    t.counter = v & 16 ? t.latch : current;
    t.oneShot = (v & 8) !== 0;
    const countsCnt = isB ? (v & 96) === 32 : (v & 32) !== 0;
    t.countsA = isB && (v & 64) !== 0;
    t.running = (v & 1) !== 0 && !countsCnt;
    t.nextUnderflow = t.running && !t.countsA ? now + t.counter + 1 : Infinity;
  }
};
var ENV_PERIOD = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];
var Voice3 = class {
  constructor() {
    __publicField(this, "freq", 0);
    __publicField(this, "pw", 0);
    __publicField(this, "ctrl", 0);
    __publicField(this, "ad", 0);
    __publicField(this, "sr", 0);
    __publicField(this, "acc", 0);
    __publicField(this, "lfsr", 8388600);
    /** The cycle `acc` and `lfsr` are at. */
    __publicField(this, "at", 0);
    // Envelope.
    __publicField(this, "env", 0);
    __publicField(this, "state", "release");
    __publicField(this, "envAt", 0);
    __publicField(this, "rateCount", 0);
    __publicField(this, "expCount", 0);
    /** The zero freeze: set by a step that lands on 0, cleared only by a gate-on (reSID's `hold_zero`). */
    __publicField(this, "holdZero", true);
  }
  syncOsc(now) {
    const dt = now - this.at;
    this.at = now;
    if (dt <= 0) return;
    if (this.ctrl & 8) {
      this.acc = 0;
      return;
    }
    const before = this.acc;
    const total = before + this.freq * dt;
    const rises = Math.floor((total + 524288) / 1048576) - Math.floor((before + 524288) / 1048576);
    for (let i = 0; i < Math.min(rises, 8388607); i++) {
      const bit = (this.lfsr >> 22 ^ this.lfsr >> 17) & 1;
      this.lfsr = (this.lfsr << 1 | bit) & 8388607;
    }
    this.acc = total % 16777216;
  }
  osc(now) {
    this.syncOsc(now);
    const acc = this.acc;
    let out = 255;
    let any = false;
    if (this.ctrl & 16) {
      const tri = (acc & 8388608 ? acc ^ 16777215 : acc) >> 15;
      out &= tri & 255;
      any = true;
    }
    if (this.ctrl & 32) {
      out &= acc >> 16;
      any = true;
    }
    if (this.ctrl & 64) {
      out &= acc >> 12 >= (this.pw & 4095) ? 255 : 0;
      any = true;
    }
    if (this.ctrl & 128) {
      const l = this.lfsr;
      const noise = (l >> 22 & 1) << 7 | (l >> 20 & 1) << 6 | (l >> 16 & 1) << 5 | (l >> 13 & 1) << 4 | (l >> 11 & 1) << 3 | (l >> 7 & 1) << 2 | (l >> 4 & 1) << 1 | l >> 2 & 1;
      out &= noise;
      any = true;
    }
    return any ? out : 0;
  }
  /** Step the envelope to `now`, one rate period at a time. */
  syncEnv(now) {
    while (true) {
      const rate = this.state === "attack" ? this.ad >> 4 : this.state === "decay" ? this.ad & 15 : this.sr & 15;
      const period = ENV_PERIOD[rate];
      const next = this.envAt + period - this.rateCount;
      if (next > now) {
        this.rateCount += now - this.envAt;
        this.envAt = now;
        return;
      }
      this.envAt = next;
      this.rateCount = 0;
      if (this.holdZero) {
        this.envAt = now;
        return;
      }
      if (this.state === "attack") {
        this.env = this.env + 1 & 255;
        if (this.env === 0) this.holdZero = true;
        if (this.env === 255) this.state = "decay";
        continue;
      }
      const expPeriod = this.env >= 93 ? 1 : this.env >= 54 ? 2 : this.env >= 26 ? 4 : this.env >= 14 ? 8 : this.env >= 6 ? 16 : 30;
      if (++this.expCount < expPeriod) continue;
      this.expCount = 0;
      const sustain = (this.sr >> 4) * 17;
      if (this.state === "release") this.env = this.env - 1 & 255;
      else if (this.env > sustain) this.env--;
      if (this.env === 0) this.holdZero = true;
      if (this.holdZero || this.state === "decay" && this.env <= sustain) {
        this.envAt = now;
        return;
      }
    }
  }
  writeCtrl(v, now) {
    this.syncOsc(now);
    this.syncEnv(now);
    const gateOn = (v & 1) !== 0 && (this.ctrl & 1) === 0;
    const gateOff = (v & 1) === 0 && (this.ctrl & 1) !== 0;
    if (v & 8) this.acc = 0;
    this.ctrl = v;
    if (gateOn) {
      this.state = "attack";
      this.holdZero = false;
    }
    if (gateOff) this.state = "release";
  }
};
var C64 = class {
  constructor(clock = "pal", extraSids = []) {
    __publicField(this, "ram", new Uint8Array(65536));
    __publicField(this, "cpu");
    __publicField(this, "timing");
    __publicField(this, "cia1", new Cia());
    __publicField(this, "cia2", new Cia());
    /** SID chip base addresses; chip 0 is $D400. */
    __publicField(this, "sidBases");
    /** Every SID write: chip index, register (0-31), value, cycle. */
    __publicField(this, "onSidWrite", null);
    __publicField(this, "basicIn", true);
    __publicField(this, "kernalIn", true);
    __publicField(this, "ioIn", true);
    __publicField(this, "vic", new Uint8Array(64));
    __publicField(this, "rasterCompare", 0);
    __publicField(this, "vicFlags", 0);
    __publicField(this, "vicMask", 0);
    /** Cycle of the next raster interrupt event (Infinity while none can fire). */
    __publicField(this, "nextRaster", Infinity);
    __publicField(this, "nmiAsserted", false);
    /** An NMI edge waits to be taken. */
    __publicField(this, "nmiPending", false);
    __publicField(this, "sidBus", 0);
    __publicField(this, "voice3", new Voice3());
    __publicField(this, "ioShadow", new Uint8Array(4096));
    /** RAM as the state hash has it: the values of the writes made while hashing. */
    __publicField(this, "hashedRam", new Uint8Array(65536));
    __publicField(this, "hashA", 0);
    __publicField(this, "hashB", 0);
    /**
     * While set, writes leave the state hash alone: the capture sets it while
     * an NMI handler runs, whose sample playback is not the music's state (a
     * sample pointer that never repeats would hide the song's loop).
     */
    __publicField(this, "hashPaused", false);
    /** Cycle of the next timer/raster event to look at. */
    __publicField(this, "nextEvent", Infinity);
    this.timing = C64_TIMING[clock];
    this.sidBases = [54272, ...extraSids];
    this.cpu = new Mos6510(this);
    const ram = this.ram;
    ram[0] = 47;
    ram[1] = 55;
    ram.set([KERNAL_IRQ_HANDLER & 255, KERNAL_IRQ_HANDLER >> 8, KERNAL_BRK_HANDLER & 255, KERNAL_BRK_HANDLER >> 8, KERNAL_NMI_HANDLER & 255, KERNAL_NMI_HANDLER >> 8], 788);
    ram[678] = clock === "pal" ? 1 : 0;
    this.hashedRam.set(ram);
    this.updateBanks();
    this.cia1.write(4, this.timing.kernalCiaLatch & 255, 0);
    this.cia1.write(5, this.timing.kernalCiaLatch >> 8, 0);
    this.cia1.write(13, 129, 0);
    this.cia1.write(14, 17, 0);
    this.vic[17] = 27;
    this.scheduleEvents();
  }
  /** The 64-bit state hash as a string key. */
  stateHash() {
    return `${(this.hashA >>> 0).toString(36)}.${(this.hashB >>> 0).toString(36)}`;
  }
  /** Load `data` at `address` (RAM, whatever the banking). */
  load(address, data) {
    for (let i = 0; i < data.length; i++) this.writeRam(address + i & 65535, data[i]);
  }
  /** Set the `$01` banking (as a write to $01). */
  setBanks(value) {
    this.writeRam(1, value);
    this.updateBanks();
  }
  get banks() {
    return this.ram[1];
  }
  updateBanks() {
    const bits = (this.ram[1] | ~this.ram[0]) & 7;
    const lo = (bits & 1) !== 0;
    const hi = (bits & 2) !== 0;
    this.basicIn = lo && hi;
    this.kernalIn = hi;
    this.ioIn = (lo || hi) && (bits & 4) !== 0;
  }
  writeRam(addr, v) {
    this.ram[addr] = v;
    if (this.hashPaused) return;
    const old = this.hashedRam[addr];
    if (old === v) return;
    const k = addr << 8;
    this.hashA ^= zobrist(k | old, SEED_A) ^ zobrist(k | v, SEED_A);
    this.hashB ^= zobrist(k | old, SEED_B) ^ zobrist(k | v, SEED_B);
    this.hashedRam[addr] = v;
  }
  shadowIo(addr, v) {
    if (this.hashPaused) return;
    const i = addr & 4095;
    const old = this.ioShadow[i];
    if (old === v) return;
    const k = (IO_KEY | addr) << 8;
    this.hashA ^= zobrist(k | old, SEED_A) ^ zobrist(k | v, SEED_A);
    this.hashB ^= zobrist(k | old, SEED_B) ^ zobrist(k | v, SEED_B);
    this.ioShadow[i] = v;
  }
  read(addr) {
    if (addr >= 40960) {
      if (addr < 49152) {
        if (this.basicIn) return STAND_IN_BASIC[addr - 40960];
      } else if (addr >= 57344) {
        if (this.kernalIn) return STAND_IN_KERNAL[addr - 57344];
      } else if (addr >= 53248 && this.ioIn) {
        return this.readIo(addr);
      }
    }
    return this.ram[addr];
  }
  write(addr, v) {
    if (addr >= 53248 && addr < 57344 && this.ioIn) {
      this.writeIo(addr, v);
      return;
    }
    this.writeRam(addr, v);
    if (addr < 2) this.updateBanks();
  }
  sidChip(addr) {
    for (let i = this.sidBases.length - 1; i > 0; i--) {
      const base = this.sidBases[i];
      if (addr >= base && addr < base + 32) return i;
    }
    return addr >= 54272 && addr < 55296 ? 0 : -1;
  }
  readIo(addr) {
    const now = this.cpu.cycles;
    if (addr < 54272) return this.readVic(addr & 63, now);
    if (addr < 55296 || addr >= 56832) {
      const chip = this.sidChip(addr);
      if (chip < 0) return 0;
      const reg = addr & 31;
      if (chip === 0 && reg === 27) return this.voice3.osc(now);
      if (chip === 0 && reg === 28) {
        this.voice3.syncEnv(now);
        return this.voice3.env;
      }
      if (reg === 25 || reg === 26) return 255;
      return this.sidBus;
    }
    if (addr < 56320) return this.ram[addr] & 15;
    if (addr < 56576) {
      const v = this.cia1.read(addr & 15, now);
      if ((addr & 15) === 13) this.scheduleEvents();
      return v;
    }
    if (addr < 56832) {
      const v = this.cia2.read(addr & 15, now);
      if ((addr & 15) === 13) {
        this.nmiAsserted = this.cia2.asserted;
        this.scheduleEvents();
      }
      return v;
    }
    return 0;
  }
  writeIo(addr, v) {
    const now = this.cpu.cycles;
    this.shadowIo(addr, v);
    if (addr < 54272) {
      this.writeVic(addr & 63, v, now);
      return;
    }
    if (addr < 55296 || addr >= 56832) {
      const chip = this.sidChip(addr);
      if (chip < 0) return;
      const reg = addr & 31;
      this.sidBus = v;
      if (chip === 0) this.voice3Write(reg, v, now);
      this.onSidWrite?.(chip, reg, v, now);
      return;
    }
    if (addr < 56320) {
      this.writeRam(addr, v & 15);
      return;
    }
    if (addr < 56576) {
      this.cia1.write(addr & 15, v, now);
      this.scheduleEvents();
      return;
    }
    this.cia2.write(addr & 15, v, now);
    this.scheduleEvents();
  }
  voice3Write(reg, v, now) {
    const v3 = this.voice3;
    switch (reg) {
      case 14:
        v3.syncOsc(now);
        v3.freq = v3.freq & 65280 | v;
        break;
      case 15:
        v3.syncOsc(now);
        v3.freq = v3.freq & 255 | v << 8;
        break;
      case 16:
        v3.pw = v3.pw & 3840 | v;
        break;
      case 17:
        v3.pw = v3.pw & 255 | (v & 15) << 8;
        break;
      case 18:
        v3.writeCtrl(v, now);
        break;
      case 19:
        v3.syncEnv(now);
        v3.ad = v;
        break;
      case 20:
        v3.syncEnv(now);
        v3.sr = v;
        break;
      default:
        break;
    }
  }
  // --- VIC-II ---------------------------------------------------------------
  rasterLine(now) {
    return Math.floor(now / this.timing.cyclesPerLine) % this.timing.lines;
  }
  readVic(reg, now) {
    this.syncRaster(now);
    switch (reg) {
      case 17:
        return this.vic[17] & 127 | (this.rasterLine(now) & 256) >> 1;
      case 18:
        return this.rasterLine(now) & 255;
      case 25:
        return this.vicFlags & 15 | 112 | ((this.vicFlags & this.vicMask & 15) !== 0 ? 128 : 0);
      case 26:
        return this.vicMask | 240;
      default:
        return this.vic[reg];
    }
  }
  writeVic(reg, v, now) {
    this.syncRaster(now);
    this.vic[reg] = v;
    switch (reg) {
      case 17:
        this.rasterCompare = this.rasterCompare & 255 | (v & 128) << 1;
        this.scheduleRaster(now);
        break;
      case 18:
        this.rasterCompare = this.rasterCompare & 256 | v;
        this.scheduleRaster(now);
        break;
      case 25:
        this.vicFlags &= ~v & 15;
        break;
      case 26:
        this.vicMask = v & 15;
        break;
      default:
        break;
    }
    this.scheduleEvents();
  }
  /** The start cycle of the next line `rasterCompare` after `now` (Infinity if the line does not exist). */
  scheduleRaster(now) {
    const t = this.timing;
    if (this.rasterCompare >= t.lines) {
      this.nextRaster = Infinity;
      return;
    }
    const lineNow = Math.floor(now / t.cyclesPerLine);
    const inFrame = lineNow % t.lines;
    let delta = (this.rasterCompare - inFrame + t.lines) % t.lines;
    if (delta === 0) delta = t.lines;
    this.nextRaster = (lineNow + delta) * t.cyclesPerLine;
  }
  syncRaster(now) {
    while (this.nextRaster <= now) {
      this.vicFlags |= 1;
      this.nextRaster += c64FrameCycles(this.timing);
    }
  }
  // --- Interrupts and time --------------------------------------------------
  scheduleEvents() {
    const now = this.cpu.cycles;
    if (this.nextRaster === Infinity && this.rasterCompare < this.timing.lines) this.scheduleRaster(now);
    const raster = this.vicMask & 1 ? this.nextRaster : Infinity;
    this.nextEvent = Math.min(raster, this.cia1.nextInterrupt(), this.cia2.nextInterrupt());
  }
  /** Whether the IRQ line is held (CIA 1 or the VIC). */
  get irqLine() {
    return this.cia1.asserted || (this.vicFlags & this.vicMask & 15) !== 0;
  }
  /** Bring the chips to the CPU's cycle: set flags and latch an NMI edge. */
  service() {
    const now = this.cpu.cycles;
    this.syncRaster(now);
    this.cia1.sync(now);
    this.cia2.sync(now);
    const nmi = this.cia2.asserted;
    if (nmi && !this.nmiAsserted) this.nmiPending = true;
    this.nmiAsserted = nmi;
    this.scheduleEvents();
  }
  /** The cycle of the next interrupt event (for idling up to it). */
  get nextEventCycle() {
    return this.nextEvent;
  }
  /**
   * Whether the CPU would take an interrupt before its next instruction: an
   * NMI edge, or the IRQ line held with I clear. An idle CPU must not skip
   * time past one (an IRQ that came while an NMI ran is taken as that NMI
   * returns, not at the next event).
   */
  interruptWaiting() {
    if (this.cpu.cycles >= this.nextEvent) this.service();
    return this.nmiPending || this.irqLine && (this.cpu.p & 4) === 0;
  }
  /**
   * Take a waiting interrupt, if any: 'nmi', 'irq' or null. Call before each
   * instruction (`step` does).
   */
  takeInterrupt() {
    if (this.cpu.cycles >= this.nextEvent) this.service();
    if (this.nmiPending) {
      this.nmiPending = false;
      this.cpu.nmi();
      return "nmi";
    }
    if (this.irqLine && this.cpu.irq()) return "irq";
    return null;
  }
  /** Advance time to `cycle` without running code (an idle CPU). */
  idleTo(cycle) {
    if (cycle > this.cpu.cycles) this.cpu.cycles = cycle;
  }
  /** Run one instruction (taking an interrupt first if one is due). */
  step() {
    const taken = this.takeInterrupt();
    this.cpu.step();
    return taken;
  }
};

// src/audio/tracker/psid/sid-capture.ts
var RETURN_TRAP = 57328;
var IDLE_TRAP = 57336;
var INIT_MAX_CYCLES = 6e7;
var PLAY_MAX_CYCLES = 2e6;
function psidBanksFor(addr) {
  if (addr < 40960) return 55;
  if (addr < 53248) return 54;
  if (addr >= 57344) return 53;
  return 52;
}
var hex42 = (v) => `$${v.toString(16).toUpperCase().padStart(4, "0")}`;
function enterCall(machine, addr, a) {
  const cpu = machine.cpu;
  cpu.a = a;
  cpu.x = 0;
  cpu.y = 0;
  cpu.p = 36;
  machine.write(511, RETURN_TRAP - 1 >> 8);
  machine.write(510, RETURN_TRAP - 1 & 255);
  cpu.sp = 253;
  cpu.pc = addr;
  cpu.jammed = false;
}
function callRoutine(machine, addr, a, maxCycles) {
  const cpu = machine.cpu;
  enterCall(machine, addr, a);
  const limit = cpu.cycles + maxCycles;
  while (cpu.cycles < limit) {
    const pc = cpu.pc;
    if (pc === RETURN_TRAP) return "return";
    if (pc >= 59953 && pc <= 60035 && (machine.banks & 2) !== 0) return "kernal-exit";
    if (pc === KERNAL_BRK_HANDLER && (machine.banks & 2) !== 0) return "brk";
    if (cpu.jammed) return "jam";
    if (machine.read(pc) === 64 && cpu.sp >= 253) return "rti";
    cpu.step();
  }
  return "timeout";
}

// src/audio/tracker/psid/psid-runner.ts
var NEVER = Number.POSITIVE_INFINITY;
var PsidRunner = class _PsidRunner {
  constructor(file, clock, machine, mode, tickCycles) {
    __publicField(this, "machine");
    __publicField(this, "clock");
    __publicField(this, "clockHz");
    /** Cycles between ticks of a host-driven tune (a video frame, or CIA 1 timer A's period). */
    __publicField(this, "tickCycles");
    /** Host-driven (`play`), or left to its own interrupts after init (`irq`). */
    __publicField(this, "mode");
    /** Why the tune stopped (its player jammed the CPU, hit a BRK, ran away), or null while it plays. */
    __publicField(this, "ended", null);
    __publicField(this, "file");
    /** Machine cycle that is cycle 0 of the output. */
    __publicField(this, "origin");
    /** The machine cycle the next host-driven tick is due on. */
    __publicField(this, "next");
    /** Machine cycle before which nothing more will be written. */
    __publicField(this, "horizonCycle");
    /** Writes to the first SID, in order: machine cycle, register, value. */
    __publicField(this, "cycles", new Float64Array(1024));
    __publicField(this, "regs", new Uint8Array(1024));
    __publicField(this, "values", new Uint8Array(1024));
    __publicField(this, "head", 0);
    __publicField(this, "tail", 0);
    /** Writes to a second or third SID, dropped (the chip here is one). */
    __publicField(this, "extraSidWrites", 0);
    this.file = file;
    this.machine = machine;
    this.mode = mode;
    this.clock = clock;
    this.clockHz = machine.timing.hz;
    this.tickCycles = tickCycles;
    this.origin = machine.cpu.cycles;
    this.next = machine.cpu.cycles;
    this.horizonCycle = machine.cpu.cycles;
  }
  /** Subsong `subsong` (0-based) of `file`, initialised and ready to `advance`. Never throws for a tune's behaviour. */
  static create(file, subsong) {
    const clock = file.clock === "ntsc" ? "ntsc" : "pal";
    const machine = new C64(clock, file.extraSids);
    machine.hashPaused = true;
    const cpu = machine.cpu;
    machine.load(file.loadAddress, file.data);
    const song = Math.max(0, Math.min(file.songs - 1, subsong));
    const irqMode = file.type === "RSID" || file.playAddress === 0;
    const early = [];
    let runner = null;
    machine.onSidWrite = (chip, reg, value, cycle) => {
      if (runner === null) {
        if (chip === 0) early.push({ cycle, reg: reg & 31, value });
        return;
      }
      if (chip !== 0) runner.extraSidWrites++;
      else runner.push(cycle, reg & 31, value);
    };
    let tickCycles = c64FrameCycles(machine.timing);
    if (!irqMode) {
      machine.setBanks(psidBanksFor(file.initAddress));
      const end = callRoutine(machine, file.initAddress, song, INIT_MAX_CYCLES);
      if (end === "jam") return { ok: false, reason: `the tune's init routine (${hex42(file.initAddress)}) stopped the CPU (a JAM opcode at ${hex42(cpu.pc)})` };
      if (end === "brk") return { ok: false, reason: `the tune's init routine (${hex42(file.initAddress)}) hit a BRK` };
      if (end === "timeout") {
        return { ok: false, reason: `the tune's init routine (${hex42(file.initAddress)}) did not return in ${INIT_MAX_CYCLES / 1e6} million cycles` };
      }
      if (psidSongUsesCia(file, song + 1)) tickCycles = machine.cia1.a.latch + 1;
    } else {
      if (file.type === "PSID") machine.setBanks(psidBanksFor(file.initAddress));
      enterCall(machine, file.initAddress, song);
    }
    runner = new _PsidRunner(file, clock, machine, irqMode ? "irq" : "play", tickCycles);
    for (const w of early) runner.push(w.cycle, w.reg, w.value);
    return { ok: true, runner };
  }
  /** The cycle (from the start of playback) before which every write is known. */
  get horizon() {
    return this.horizonCycle === NEVER ? NEVER : this.horizonCycle - this.origin;
  }
  /** How many writes wait to be drained. */
  get pending() {
    return this.tail - this.head;
  }
  push(machineCycle, reg, value) {
    if (this.tail === this.cycles.length) this.makeRoom();
    this.cycles[this.tail] = machineCycle;
    this.regs[this.tail] = reg;
    this.values[this.tail] = value;
    this.tail++;
  }
  makeRoom() {
    const live = this.tail - this.head;
    if (this.head > 0 && live <= this.cycles.length >> 1) {
      this.cycles.copyWithin(0, this.head, this.tail);
      this.regs.copyWithin(0, this.head, this.tail);
      this.values.copyWithin(0, this.head, this.tail);
    } else {
      const size = this.cycles.length * 2;
      const c = new Float64Array(size);
      const r = new Uint8Array(size);
      const v = new Uint8Array(size);
      c.set(this.cycles.subarray(this.head, this.tail));
      r.set(this.regs.subarray(this.head, this.tail));
      v.set(this.values.subarray(this.head, this.tail));
      this.cycles = c;
      this.regs = r;
      this.values = v;
    }
    this.tail = live;
    this.head = 0;
  }
  /**
   * Hand over, in order, the writes made before cycle `until` (from the start
   * of playback), each with its cycle (never below 0), register and value.
   * `until` must not be past `horizon`.
   */
  drain(until, sink) {
    const limit = until + this.origin;
    while (this.head < this.tail && this.cycles[this.head] < limit) {
      const i = this.head++;
      sink(Math.max(0, this.cycles[i] - this.origin), this.regs[i], this.values[i]);
    }
    if (this.head === this.tail) this.head = this.tail = 0;
  }
  end(why) {
    this.ended = why;
    this.horizonCycle = NEVER;
  }
  /** Run the tune until emulated time reaches cycle `until` (from the start of playback). */
  advance(until) {
    if (this.ended !== null) return;
    const target = until + this.origin;
    if (this.mode === "play") this.advancePlay(target);
    else this.advanceIrq(target);
  }
  advancePlay(target) {
    const machine = this.machine;
    const cpu = machine.cpu;
    const addr = this.file.playAddress;
    while (this.horizonCycle < target) {
      machine.idleTo(this.next);
      machine.setBanks(psidBanksFor(addr));
      const e = callRoutine(machine, addr, 0, PLAY_MAX_CYCLES);
      if (e === "jam") return this.end(`the tune's play routine (${hex42(addr)}) stopped the CPU (JAM at ${hex42(cpu.pc)})`);
      if (e === "brk") return this.end(`the tune's play routine (${hex42(addr)}) hit a BRK`);
      if (e === "timeout") return this.end(`the tune's play routine (${hex42(addr)}) did not return`);
      this.next += this.tickCycles;
      this.horizonCycle = Math.max(this.next, cpu.cycles);
    }
  }
  advanceIrq(target) {
    const machine = this.machine;
    const cpu = machine.cpu;
    while (cpu.cycles < target) {
      if (cpu.jammed) return this.end(`the tune stopped the CPU (JAM at ${hex42(cpu.pc)})`);
      if (cpu.pc === KERNAL_BRK_HANDLER && (machine.banks & 2) !== 0) return this.end("the tune hit a BRK");
      if (cpu.pc === RETURN_TRAP) {
        cpu.pc = IDLE_TRAP;
        cpu.p &= ~4;
      }
      if (cpu.pc === IDLE_TRAP && !machine.interruptWaiting()) {
        machine.idleTo(Math.min(machine.nextEventCycle, target));
      }
      if (machine.takeInterrupt() !== null) continue;
      if (cpu.pc === IDLE_TRAP) {
        machine.idleTo(target);
        continue;
      }
      cpu.step();
    }
    this.horizonCycle = cpu.cycles;
  }
};

// src/audio/tracker/psid/psid-playback.ts
var PsidPlayback = class _PsidPlayback {
  constructor(runner, chip, sampleRate2) {
    this.runner = runner;
    this.chip = chip;
    this.sampleRate = sampleRate2;
    __publicField(this, "playing", false);
    /** Chip cycles rendered so far (the runner's clock, from the start of playback). */
    __publicField(this, "cycle", 0);
    __publicField(this, "frac", 0);
    __publicField(this, "frames", 0);
    __publicField(this, "cyclesPerSample");
    this.cyclesPerSample = runner.clockHz / sampleRate2;
  }
  /** Subsong `subsong` (0-based) of `file` on a chip of the file's model, paused. */
  static create(file, subsong, Chip, sampleRate2) {
    const made = PsidRunner.create(file, subsong);
    if (!made.ok) return made;
    let chip;
    try {
      chip = new Chip(file.sidModel === "8580", sampleRate2, made.runner.clockHz);
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
    return { ok: true, player: new _PsidPlayback(made.runner, chip, sampleRate2) };
  }
  /** Why the tune stopped (its code jammed the CPU or ran away), or null. */
  get ended() {
    return this.runner.ended;
  }
  play() {
    this.playing = true;
  }
  pause() {
    this.playing = false;
  }
  is_playing() {
    return this.playing;
  }
  set_gain(gain) {
    this.chip.set_gain(gain);
  }
  set_mute_solo(mute, solo) {
    this.chip.set_mute_solo(mute, solo);
  }
  set_revision(name) {
    return this.chip.set_revision(name);
  }
  render(out, v0, v1, v2) {
    const n = Math.min(out.length, v0.length, v1.length, v2.length);
    if (!this.playing) {
      out.fill(0, 0, n);
      v0.fill(0, 0, n);
      v1.fill(0, 0, n);
      v2.fill(0, 0, n);
      return n;
    }
    let total = 0;
    for (let i = 0; i < n; i++) {
      this.frac += this.cyclesPerSample;
      const whole = Math.floor(this.frac);
      this.frac -= whole;
      total += whole;
    }
    const start = this.cycle;
    const end = start + total;
    this.runner.advance(end);
    this.runner.drain(end, (cycle, reg, value) => this.chip.write_after(Math.max(0, cycle - start), reg, value));
    this.cycle = end;
    this.frames += n;
    return this.chip.render(out.subarray(0, n), v0.subarray(0, n), v1.subarray(0, n), v2.subarray(0, n));
  }
  /** Whole seconds played. */
  song_row() {
    return Math.floor(this.frames / this.sampleRate);
  }
  song_rows() {
    return 0;
  }
  /** True once the tune's code has stopped (it jammed the CPU or ran away): the worklet reports it as the song's end. */
  song_end_reached() {
    return this.runner.ended !== null;
  }
  tempo() {
    return 0;
  }
  channels() {
    return 3;
  }
  chip_model() {
    return this.chip.chip_model();
  }
  instrument_count() {
    return 0;
  }
  tap_full_scale() {
    return this.chip.tap_full_scale();
  }
  // A tune has no rows to move to, loop or preview: these are the song player's.
  seek_row(_row) {
  }
  set_loop_rows(_start, _end) {
  }
  clear_loop_rows() {
  }
  enable_preview() {
  }
  preview_note_on(_instrument, _note) {
    return false;
  }
  preview_note_off() {
  }
  free() {
    this.chip.free();
  }
};

// src/audio/worklets/sid-core.ts
var POSITION_INTERVAL_SECONDS = 0.04;
var END_FADE_FRAMES = 32;
function fadeOutTail(buffer) {
  const n = Math.min(END_FADE_FRAMES, buffer.length);
  const start = buffer.length - n;
  for (let i = 0; i < n; i++) buffer[start + i] = (buffer[start + i] ?? 0) * (1 - (i + 1) / n);
}
var SidProcessorCore = class {
  constructor(PlayerCtor, sampleRate2, post, ChipCtor = null) {
    this.PlayerCtor = PlayerCtor;
    this.sampleRate = sampleRate2;
    this.post = post;
    this.ChipCtor = ChipCtor;
    __publicField(this, "player", null);
    __publicField(this, "gain", 1);
    __publicField(this, "stopAtEnd", false);
    __publicField(this, "mute", 0);
    __publicField(this, "solo", 0);
    __publicField(this, "revision", "gt");
    __publicField(this, "preview", false);
    __publicField(this, "loop", null);
    __publicField(this, "framesSincePosition", 0);
    __publicField(this, "lastRow", -1);
    __publicField(this, "songEndReported", false);
    __publicField(this, "lastLoadId", -1);
    __publicField(this, "disposedFlag", false);
    /** Scratch for outputs the node was not given (a mono or tap-less host). */
    __publicField(this, "scratch", []);
  }
  get disposed() {
    return this.disposedFlag;
  }
  handle(command) {
    if (this.disposedFlag) return;
    switch (command.type) {
      case "load-song":
        if (command.id <= this.lastLoadId) break;
        this.lastLoadId = command.id;
        this.loadSong(command.id, command.bytes);
        break;
      case "load-psid":
        if (command.id <= this.lastLoadId) break;
        this.lastLoadId = command.id;
        this.loadPsid(command.id, command.bytes, command.subsong);
        break;
      case "play":
        this.player?.play();
        break;
      case "pause":
        this.player?.pause();
        break;
      case "seek":
        this.seek(command.row);
        break;
      case "set-loop-rows":
        this.loop = command.end > command.start ? { start: command.start, end: command.end } : null;
        this.applyLoop();
        break;
      case "set-gain":
        this.gain = command.gain;
        this.player?.set_gain(command.gain);
        break;
      case "set-stop-at-end":
        this.stopAtEnd = command.enabled;
        break;
      case "set-mute-solo":
        this.mute = command.mute >>> 0;
        this.solo = command.solo >>> 0;
        this.player?.set_mute_solo(this.mute, this.solo);
        break;
      case "set-revision":
        this.revision = command.revision;
        this.player?.set_revision(command.revision);
        break;
      case "set-preview":
        this.preview = command.enabled;
        break;
      case "preview-note-on":
        this.player?.preview_note_on(command.instrument, command.note);
        break;
      case "preview-note-off":
        this.player?.preview_note_off();
        break;
      case "dispose":
        this.disposedFlag = true;
        this.dropPlayer();
        break;
    }
  }
  /**
   * Fills one render quantum: `mix` (and `right`, a copy of it, when the
   * output is stereo) and the three voice taps (any may be absent).
   */
  process(mix, right, taps) {
    const player = this.player;
    const n = mix.length;
    if (!player) {
      mix.fill(0);
      right?.fill(0);
      for (const tap of taps) tap?.fill(0);
      return;
    }
    try {
      const t = [0, 1, 2].map((i) => {
        const given = taps[i];
        if (given && given.length === n) return given;
        if ((this.scratch[i]?.length ?? 0) < n) this.scratch[i] = new Float32Array(n);
        return this.scratch[i].subarray(0, n);
      });
      player.render(mix, t[0], t[1], t[2]);
      if (!this.preview && player.is_playing() && this.report(player, n)) {
        fadeOutTail(mix);
        for (const tap of t) fadeOutTail(tap);
      }
      right?.set(mix);
    } catch (error) {
      this.dropPlayer();
      mix.fill(0);
      right?.fill(0);
      for (const tap of taps) tap?.fill(0);
      this.post({ type: "error", message: `SID render failed: ${String(error)}` });
    }
  }
  loadSong(id, bytes) {
    this.dropPlayer();
    try {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      this.adopt(id, new this.PlayerCtor(data, this.sampleRate));
    } catch (error) {
      this.post({ type: "error", id, message: `SID load failed: ${String(error)}` });
    }
  }
  loadPsid(id, bytes, subsong) {
    this.dropPlayer();
    try {
      if (this.ChipCtor === null) throw new Error("this worklet has no chip to play a .sid on");
      const parsed = parsePsid(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      if (!parsed.ok) throw new Error(parsed.reason);
      const made = PsidPlayback.create(parsed.file, subsong, this.ChipCtor, this.sampleRate);
      if (!made.ok) throw new Error(made.reason);
      this.adopt(id, made.player);
    } catch (error) {
      this.post({ type: "error", id, message: `SID load failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  /** Make `player` the song: the settings that outlive songs, then the answer to the load. */
  adopt(id, player) {
    try {
      player.set_gain(this.gain);
      player.set_mute_solo(this.mute, this.solo);
      player.set_revision(this.revision);
      if (this.preview) player.enable_preview();
    } catch (error) {
      player.free();
      throw error;
    }
    this.player = player;
    this.applyLoop();
    this.resetReporting();
    this.post({
      type: "song-loaded",
      id,
      info: {
        songRows: player.song_rows(),
        channels: player.channels(),
        chipModel: player.chip_model(),
        instrumentCount: player.instrument_count(),
        sampleRate: this.sampleRate,
        voiceFullScale: player.tap_full_scale()
      }
    });
  }
  applyLoop() {
    if (!this.player) return;
    if (this.loop) this.player.set_loop_rows(this.loop.start, this.loop.end);
    else this.player.clear_loop_rows();
  }
  seek(row) {
    const player = this.player;
    if (!player) return;
    player.seek_row(Math.max(0, Math.floor(row)));
    this.resetReporting();
    this.lastRow = player.song_row();
    this.post({ type: "position", row: this.lastRow, tempo: player.tempo(), seek: true });
  }
  /** Returns true when this quantum ended the song and the player was paused. */
  report(player, frames) {
    if (player.song_end_reached() && !this.songEndReported) {
      this.songEndReported = true;
      this.post({ type: "song-end" });
      if (this.stopAtEnd) {
        player.pause();
        return true;
      }
    }
    this.framesSincePosition += frames;
    if (this.framesSincePosition < this.sampleRate * POSITION_INTERVAL_SECONDS) return false;
    this.framesSincePosition = 0;
    const row = player.song_row();
    if (row === this.lastRow) return false;
    this.lastRow = row;
    this.post({ type: "position", row, tempo: player.tempo() });
    return false;
  }
  resetReporting() {
    this.framesSincePosition = 0;
    this.lastRow = -1;
    this.songEndReported = false;
  }
  dropPlayer() {
    if (this.player) {
      try {
        this.player.free();
      } catch {
      }
      this.player = null;
    }
  }
};

// src/audio/worklets/sid-worklet.ts
var SidAudioProcessor = class extends AudioWorkletProcessor {
  constructor() {
    super();
    __publicField(this, "core", null);
    __publicField(this, "wasmReady", false);
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === "wasm-binary" && data.wasmBytes) {
        this.initWasm(data.wasmBytes);
        return;
      }
      if (!this.core) {
        this.port.postMessage({ type: "error", message: "SID worklet received a command before the wasm was ready" });
        return;
      }
      this.core.handle(data);
    };
    this.port.postMessage({ type: "ready" });
  }
  initWasm(wasmBytes) {
    if (this.wasmReady) return;
    try {
      initSync({ module: new Uint8Array(wasmBytes) });
      this.core = new SidProcessorCore(
        SidPlayer,
        sampleRate,
        (event) => this.port.postMessage(event),
        SidChipPlayer
      );
      this.wasmReady = true;
      this.port.postMessage({ type: "wasm-ready" });
    } catch (error) {
      this.port.postMessage({ type: "error", message: `SID wasm init failed: ${String(error)}` });
    }
  }
  process(_inputs, outputs) {
    if (this.core?.disposed) return false;
    const main = outputs[0];
    const mix = main?.[0];
    if (!mix) return true;
    const taps = [outputs[1]?.[0], outputs[2]?.[0], outputs[3]?.[0]];
    if (this.core) {
      this.core.process(mix, main[1], taps);
    } else {
      mix.fill(0);
      main[1]?.fill(0);
      for (const tap of taps) tap?.fill(0);
    }
    return true;
  }
};
registerProcessor("sid-audio-processor", SidAudioProcessor);
