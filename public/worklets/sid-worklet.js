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

// src/audio/worklets/sid-core.ts
var POSITION_INTERVAL_SECONDS = 0.04;
var END_FADE_FRAMES = 32;
function fadeOutTail(buffer) {
  const n = Math.min(END_FADE_FRAMES, buffer.length);
  const start = buffer.length - n;
  for (let i = 0; i < n; i++) buffer[start + i] = (buffer[start + i] ?? 0) * (1 - (i + 1) / n);
}
var SidProcessorCore = class {
  constructor(PlayerCtor, sampleRate2, post) {
    this.PlayerCtor = PlayerCtor;
    this.sampleRate = sampleRate2;
    this.post = post;
    __publicField(this, "player", null);
    __publicField(this, "gain", 1);
    __publicField(this, "stopAtEnd", false);
    __publicField(this, "mute", 0);
    __publicField(this, "solo", 0);
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
      const player = new this.PlayerCtor(data, this.sampleRate);
      player.set_gain(this.gain);
      player.set_mute_solo(this.mute, this.solo);
      if (this.preview) player.enable_preview();
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
    } catch (error) {
      this.post({ type: "error", id, message: `SID load failed: ${String(error)}` });
    }
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
        (event) => this.port.postMessage(event)
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
