let wasm;

let WASM_VECTOR_LEN = 0;

let cachedUint8ArrayMemory0 = null;

function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

const cachedTextEncoder = (typeof TextEncoder !== 'undefined' ? new TextEncoder('utf-8') : { encode: () => { throw Error('TextEncoder not available') } } );

const encodeString = (typeof cachedTextEncoder.encodeInto === 'function'
    ? function (arg, view) {
    return cachedTextEncoder.encodeInto(arg, view);
}
    : function (arg, view) {
    const buf = cachedTextEncoder.encode(arg);
    view.set(buf);
    return {
        read: arg.length,
        written: buf.length
    };
});

function passStringToWasm0(arg, malloc, realloc) {

    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
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

let cachedDataViewMemory0 = null;

function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
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

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_export_4.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedFloat32ArrayMemory0 = null;

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
/**
 * Biquad‑specific slope selection.
 * @enum {0 | 1}
 */
export const FilterSlope = Object.freeze({
    Db12: 0, "0": "Db12",
    Db24: 1, "1": "Db24",
});
/**
 * FilterType enum, trait, and biquad implementations follow below.
 * @enum {0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}
 */
export const FilterType = Object.freeze({
    LowPass: 0, "0": "LowPass",
    LowShelf: 1, "1": "LowShelf",
    Peaking: 2, "2": "Peaking",
    HighShelf: 3, "3": "HighShelf",
    Notch: 4, "4": "Notch",
    HighPass: 5, "5": "HighPass",
    Ladder: 6, "6": "Ladder",
    Comb: 7, "7": "Comb",
    BandPass: 8, "8": "BandPass",
});
/**
 * @enum {0 | 1 | 2}
 */
export const LfoLoopMode = Object.freeze({
    Off: 0, "0": "Off",
    Loop: 1, "1": "Loop",
    PingPong: 2, "2": "PingPong",
});
/**
 * @enum {0 | 1 | 2 | 3}
 */
export const ModulationTransformation = Object.freeze({
    None: 0, "0": "None",
    Invert: 1, "1": "Invert",
    Square: 2, "2": "Square",
    Cube: 3, "3": "Cube",
});
/**
 * The type of noise to generate.
 * @enum {0 | 1 | 2}
 */
export const NoiseType = Object.freeze({
    White: 0, "0": "White",
    Pink: 1, "1": "Pink",
    Brownian: 2, "2": "Brownian",
});
/**
 * @enum {0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26}
 */
export const PortId = Object.freeze({
    AudioInput0: 0, "0": "AudioInput0",
    AudioInput1: 1, "1": "AudioInput1",
    AudioInput2: 2, "2": "AudioInput2",
    AudioInput3: 3, "3": "AudioInput3",
    AudioOutput0: 4, "4": "AudioOutput0",
    AudioOutput1: 5, "5": "AudioOutput1",
    AudioOutput2: 6, "6": "AudioOutput2",
    AudioOutput3: 7, "7": "AudioOutput3",
    GlobalGate: 8, "8": "GlobalGate",
    GlobalFrequency: 9, "9": "GlobalFrequency",
    GlobalVelocity: 10, "10": "GlobalVelocity",
    Frequency: 11, "11": "Frequency",
    FrequencyMod: 12, "12": "FrequencyMod",
    PhaseMod: 13, "13": "PhaseMod",
    ModIndex: 14, "14": "ModIndex",
    CutoffMod: 15, "15": "CutoffMod",
    ResonanceMod: 16, "16": "ResonanceMod",
    GainMod: 17, "17": "GainMod",
    EnvelopeMod: 18, "18": "EnvelopeMod",
    StereoPan: 19, "19": "StereoPan",
    FeedbackMod: 20, "20": "FeedbackMod",
    DetuneMod: 21, "21": "DetuneMod",
    WavetableIndex: 22, "22": "WavetableIndex",
    WetDryMix: 23, "23": "WetDryMix",
    AttackMod: 24, "24": "AttackMod",
    ArpGate: 25, "25": "ArpGate",
    CombinedGate: 26, "26": "CombinedGate",
});
/**
 * @enum {0 | 1 | 2}
 */
export const WasmModulationType = Object.freeze({
    VCA: 0, "0": "VCA",
    Bipolar: 1, "1": "Bipolar",
    Additive: 2, "2": "Additive",
});
/**
 * @enum {0 | 1 | 2}
 */
export const WasmNoiseType = Object.freeze({
    White: 0, "0": "White",
    Pink: 1, "1": "Pink",
    Brownian: 2, "2": "Brownian",
});
/**
 * @enum {0 | 1 | 2 | 3 | 4}
 */
export const Waveform = Object.freeze({
    Sine: 0, "0": "Sine",
    Triangle: 1, "1": "Triangle",
    Saw: 2, "2": "Saw",
    Square: 3, "3": "Square",
    Custom: 4, "4": "Custom",
});

const AnalogOscillatorStateUpdateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_analogoscillatorstateupdate_free(ptr >>> 0, 1));

export class AnalogOscillatorStateUpdate {

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
}

const AudioEngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_audioengine_free(ptr >>> 0, 1));

export class AudioEngine {

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
     * @returns {number}
     */
    get_cpu_usage() {
        const ret = wasm.audioengine_get_cpu_usage(this.__wbg_ptr);
        return ret;
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
     * @param {number} node_id
     */
    delete_node(node_id) {
        const ret = wasm.audioengine_delete_node(this.__wbg_ptr, node_id);
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
     * @returns {NodeId}
     */
    get_gate_mixer_node_id() {
        const ret = wasm.audioengine_get_gate_mixer_node_id(this.__wbg_ptr);
        return NodeId.__wrap(ret);
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
    create_arpeggiator() {
        const ret = wasm.audioengine_create_arpeggiator(this.__wbg_ptr);
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
}

const ConnectionIdFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_connectionid_free(ptr >>> 0, 1));

export class ConnectionId {

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
}

const EnvelopeConfigFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_envelopeconfig_free(ptr >>> 0, 1));

export class EnvelopeConfig {

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
        const ret = wasm.__wbg_get_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set decay(arg0) {
        wasm.__wbg_set_analogoscillatorstateupdate_phase_mod_amount(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get sustain() {
        const ret = wasm.__wbg_get_analogoscillatorstateupdate_detune(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set sustain(arg0) {
        wasm.__wbg_set_analogoscillatorstateupdate_detune(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get release() {
        const ret = wasm.__wbg_get_analogoscillatorstateupdate_gain(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set release(arg0) {
        wasm.__wbg_set_analogoscillatorstateupdate_gain(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get attack_curve() {
        const ret = wasm.__wbg_get_analogoscillatorstateupdate_feedback_amount(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set attack_curve(arg0) {
        wasm.__wbg_set_analogoscillatorstateupdate_feedback_amount(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get decay_curve() {
        const ret = wasm.__wbg_get_envelopeconfig_decay_curve(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set decay_curve(arg0) {
        wasm.__wbg_set_envelopeconfig_decay_curve(this.__wbg_ptr, arg0);
    }
    /**
     * @returns {number}
     */
    get release_curve() {
        const ret = wasm.__wbg_get_analogoscillatorstateupdate_spread(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set release_curve(arg0) {
        wasm.__wbg_set_analogoscillatorstateupdate_spread(this.__wbg_ptr, arg0);
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
}

const LfoUpdateParamsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_lfoupdateparams_free(ptr >>> 0, 1));

export class LfoUpdateParams {

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
}

const NodeIdFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_nodeid_free(ptr >>> 0, 1));

export class NodeId {

    static __wrap(ptr) {
        ptr = ptr >>> 0;
        const obj = Object.create(NodeId.prototype);
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
        const ret = wasm.__wbg_get_connectionid_0(this.__wbg_ptr);
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
        return NodeId.__wrap(ret);
    }
}

const NoiseUpdateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_noiseupdate_free(ptr >>> 0, 1));
/**
 * Structure for external updates (e.g., from UI or automation).
 */
export class NoiseUpdate {

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
        const ret = wasm.__wbg_get_noiseupdate_enabled(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {boolean} arg0
     */
    set enabled(arg0) {
        wasm.__wbg_set_noiseupdate_enabled(this.__wbg_ptr, arg0);
    }
}

const NoiseUpdateParamsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_noiseupdateparams_free(ptr >>> 0, 1));

export class NoiseUpdateParams {

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
}

const WavetableOscillatorStateUpdateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wavetableoscillatorstateupdate_free(ptr >>> 0, 1));

export class WavetableOscillatorStateUpdate {

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
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);

            } catch (e) {
                if (module.headers.get('Content-Type') != 'application/wasm') {
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
    imports.wbg.__wbg_call_672a4d21634d4a24 = function() { return handleError(function (arg0, arg1) {
        const ret = arg0.call(arg1);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_crypto_12576cd66246998b = function() { return handleError(function (arg0) {
        const ret = arg0.crypto;
        return ret;
    }, arguments) };
    imports.wbg.__wbg_error_524f506f44df1645 = function(arg0) {
        console.error(arg0);
    };
    imports.wbg.__wbg_getRandomValues_5754b82ca6952f9b = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = arg0.getRandomValues(getArrayU8FromWasm0(arg1, arg2));
        return ret;
    }, arguments) };
    imports.wbg.__wbg_getRandomValues_78e016fdd1d721cf = function() { return handleError(function (arg0, arg1) {
        globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
    }, arguments) };
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
    imports.wbg.__wbg_now_807e54c39636c349 = function() {
        const ret = Date.now();
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
    imports.wbg.__wbg_set_bb8cecf6a62b9f46 = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = Reflect.set(arg0, arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbg_setindex_4e73afdcd9bb95cd = function(arg0, arg1, arg2) {
        arg0[arg1 >>> 0] = arg2;
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_88a902d13a557d07 = function() {
        const ret = typeof global === 'undefined' ? null : global;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_GLOBAL_THIS_56578be7e9f832b0 = function() {
        const ret = typeof globalThis === 'undefined' ? null : globalThis;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_SELF_37c5d418e4bf5819 = function() {
        const ret = typeof self === 'undefined' ? null : self;
        return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    };
    imports.wbg.__wbg_static_accessor_WINDOW_5de37043a91a9c40 = function() {
        const ret = typeof window === 'undefined' ? null : window;
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
        const ret = typeof(v) === 'boolean' ? (v ? 1 : 0) : 2;
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
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
        ;
    };
    imports.wbg.__wbindgen_is_object = function(arg0) {
        const val = arg0;
        const ret = typeof(val) === 'object' && val !== null;
        return ret;
    };
    imports.wbg.__wbindgen_is_undefined = function(arg0) {
        const ret = arg0 === undefined;
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
        const ret = typeof(obj) === 'number' ? obj : undefined;
        getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
        getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
    };
    imports.wbg.__wbindgen_number_new = function(arg0) {
        const ret = arg0;
        return ret;
    };
    imports.wbg.__wbindgen_string_get = function(arg0, arg1) {
        const obj = arg1;
        const ret = typeof(obj) === 'string' ? obj : undefined;
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
    if (wasm !== undefined) return wasm;


    if (typeof module !== 'undefined') {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
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
    if (wasm !== undefined) return wasm;


    if (typeof module_or_path !== 'undefined') {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (typeof module_or_path === 'undefined') {
        module_or_path = new URL('audio_processor_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    __wbg_init_memory(imports);

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync };
export default __wbg_init;
