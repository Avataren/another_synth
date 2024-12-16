let wasm;

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

let cachedUint8ArrayMemory0 = null;

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

const cachedTextDecoder = (typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }) : { decode: () => { throw Error('TextDecoder not available') } } );

if (typeof TextDecoder !== 'undefined') { cachedTextDecoder.decode(); };

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedFloat32ArrayMemory0 = null;

function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let WASM_VECTOR_LEN = 0;

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
/**
 * @enum {0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17}
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
    Gate: 8, "8": "Gate",
    GlobalFrequency: 9, "9": "GlobalFrequency",
    Frequency: 10, "10": "Frequency",
    FrequencyMod: 11, "11": "FrequencyMod",
    PhaseMod: 12, "12": "PhaseMod",
    ModIndex: 13, "13": "ModIndex",
    CutoffMod: 14, "14": "CutoffMod",
    ResonanceMod: 15, "15": "ResonanceMod",
    GainMod: 16, "16": "GainMod",
    EnvelopeMod: 17, "17": "EnvelopeMod",
});

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
     */
    update_envelope(voice_index, node_id, attack, decay, sustain, release) {
        const ret = wasm.audioengine_update_envelope(this.__wbg_ptr, voice_index, node_id, attack, decay, sustain, release);
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
        const ret = wasm.__wbg_get_envelopeconfig_attack_curve(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set attack_curve(arg0) {
        wasm.__wbg_set_envelopeconfig_attack_curve(this.__wbg_ptr, arg0);
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
        const ret = wasm.__wbg_get_envelopeconfig_release_curve(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} arg0
     */
    set release_curve(arg0) {
        wasm.__wbg_set_envelopeconfig_release_curve(this.__wbg_ptr, arg0);
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

const OscillatorStateUpdateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_oscillatorstateupdate_free(ptr >>> 0, 1));

export class OscillatorStateUpdate {

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
    imports.wbg.__wbg_set_4e647025551483bd = function() { return handleError(function (arg0, arg1, arg2) {
        const ret = Reflect.set(arg0, arg1, arg2);
        return ret;
    }, arguments) };
    imports.wbg.__wbindgen_copy_to_typed_array = function(arg0, arg1, arg2) {
        new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
    };
    imports.wbg.__wbindgen_init_externref_table = function() {
        const table = wasm.__wbindgen_export_2;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
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
