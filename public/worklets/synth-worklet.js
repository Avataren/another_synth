var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/audio/dsp/variable-comb-filter.ts
var VariableCombFilter = class {
  constructor(sampleRate2, maxDelayMs = 100) {
    __publicField(this, "buffer");
    __publicField(this, "bufferSize");
    __publicField(this, "writeIndex", 0);
    __publicField(this, "delaySamples", 0);
    __publicField(this, "sampleRate");
    __publicField(this, "_cut", 1e4);
    // Default cutoff frequency in Hz
    __publicField(this, "_resonance", 0.5);
    // Default resonance value
    __publicField(this, "is_enabled", false);
    // Filter coefficients and state
    __publicField(this, "filterAlpha", 0);
    __publicField(this, "filterState", 0);
    this.sampleRate = sampleRate2;
    this.bufferSize = Math.floor(maxDelayMs / 1e3 * sampleRate2);
    this.buffer = new Float32Array(this.bufferSize);
    this.clear();
    this.delaySamples = Math.floor(this.bufferSize / 2);
    this.cut = this._cut;
  }
  /**
   * Sets the frequency for keytracking, adjusting the delay length.
   */
  setFrequency(frequency) {
    const delayTimeSec = 1 / frequency;
    this.delaySamples = delayTimeSec * this.sampleRate;
    if (this.delaySamples >= this.bufferSize) {
      this.delaySamples = this.bufferSize - 1;
    }
  }
  updateState(state) {
    this.cut = state.cut;
    this.is_enabled = state.is_enabled;
    this.resonance = state.resonance;
  }
  /**
   * Sets the cutoff frequency for the filter in the feedback loop.
   * @param cut Cutoff frequency in Hz.
   */
  set cut(cut) {
    this._cut = Math.max(20, Math.min(cut, this.sampleRate / 2));
    const omega = 2 * Math.PI * this._cut / this.sampleRate;
    this.filterAlpha = Math.exp(-omega);
  }
  /**
   * Gets the current cutoff frequency.
   */
  get cut() {
    return this._cut;
  }
  /**
   * Sets the resonance parameter.
   * @param resonance Value between 0 (no resonance) and 1 (maximum resonance).
   */
  set resonance(resonance) {
    this._resonance = Math.max(0, Math.min(resonance, 1));
  }
  /**
   * Gets the current resonance value.
   */
  get resonance() {
    return this._resonance;
  }
  /**
   * Processes an input sample through the comb filter.
   * @param input The input sample.
   * @returns The output sample.
   */
  process(input) {
    if (!this.is_enabled) {
      return input;
    }
    const delayInt = Math.floor(this.delaySamples);
    const frac = this.delaySamples - delayInt;
    const readIndex1 = (this.writeIndex - delayInt + this.bufferSize) % this.bufferSize;
    const readIndex2 = (readIndex1 - 1 + this.bufferSize) % this.bufferSize;
    const delayedSample1 = this.buffer[readIndex1];
    const delayedSample2 = this.buffer[readIndex2];
    const delayedSample = delayedSample1 * (1 - frac) + delayedSample2 * frac;
    this.filterState = (1 - this.filterAlpha) * delayedSample + this.filterAlpha * this.filterState;
    const maxFeedbackGain = 0.999;
    const feedbackSample = this.filterState * maxFeedbackGain * this._resonance;
    const output = input + feedbackSample;
    this.buffer[this.writeIndex] = output;
    this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
    return output;
  }
  /**
   * Clears the internal buffer and resets indices.
   */
  clear() {
    this.buffer.fill(0);
    this.writeIndex = 0;
    this.filterState = 0;
  }
};

// src/audio/dsp/envelope.ts
var Envelope = class {
  constructor(sampleRate2, config = {
    id: 0,
    attack: 0.01,
    decay: 0.1,
    sustain: 0.5,
    release: 0.3,
    attackCurve: 0,
    decayCurve: 0,
    releaseCurve: 0
  }) {
    __publicField(this, "phase", "idle");
    __publicField(this, "value", 0);
    __publicField(this, "releaseLevel", 0);
    __publicField(this, "sampleRate");
    __publicField(this, "config");
    __publicField(this, "position", 0);
    __publicField(this, "lastGateValue", 0);
    this.sampleRate = sampleRate2;
    this.updateConfig(config);
  }
  updateConfig(config) {
    this.config = config;
  }
  getCurvedValue(position, curve) {
    if (Math.abs(curve) < 1e-3) return position;
    const alpha = Math.exp(Math.abs(curve));
    if (curve > 0) {
      return (Math.exp(position * Math.log(1 + alpha)) - 1) / alpha;
    } else {
      return Math.log(1 + position * alpha) / Math.log(1 + alpha);
    }
  }
  trigger(gate) {
    if (gate > 0) {
      if (this.phase === "idle" || this.phase === "release") {
        this.reset();
        this.phase = "attack";
      }
    } else {
      if (this.phase !== "idle" && this.phase !== "release") {
        this.phase = "release";
        this.releaseLevel = this.value;
        this.position = 0;
      }
    }
    this.lastGateValue = gate;
  }
  process(gateValue) {
    if (gateValue !== this.lastGateValue) {
      this.trigger(gateValue);
    }
    const increment = 1 / this.sampleRate;
    switch (this.phase) {
      case "attack": {
        const attackTime = Math.max(this.config.attack, 1e-4);
        this.position += increment / attackTime;
        if (this.position >= 1) {
          this.position = 0;
          this.value = 1;
          this.phase = "decay";
        } else {
          this.value = this.getCurvedValue(this.position, this.config.attackCurve);
        }
        break;
      }
      case "decay": {
        const decayTime = Math.max(this.config.decay, 1e-4);
        this.position += increment / decayTime;
        if (this.position >= 1) {
          this.position = 0;
          this.value = this.config.sustain;
          this.phase = "sustain";
        } else {
          const decayPos = this.getCurvedValue(this.position, this.config.decayCurve);
          this.value = 1 - decayPos * (1 - this.config.sustain);
        }
        break;
      }
      case "sustain": {
        this.value = this.config.sustain;
        break;
      }
      case "release": {
        const releaseTime = Math.max(this.config.release, 1e-4);
        this.position += increment / releaseTime;
        if (this.position >= 1) {
          this.position = 0;
          this.value = 0;
          this.phase = "idle";
        } else {
          const releasePos = this.getCurvedValue(this.position, this.config.releaseCurve);
          this.value = this.releaseLevel * (1 - releasePos);
        }
        break;
      }
      case "idle": {
        this.value = 0;
        break;
      }
    }
    this.value = Math.max(0, Math.min(this.value, 1));
    return this.value;
  }
  isActive() {
    return this.phase !== "idle";
  }
  reset() {
    this.phase = "idle";
    this.value = 0;
    this.releaseLevel = 0;
    this.position = 0;
    this.lastGateValue = 0;
  }
};

// src/audio/wavetable/wave-utils.ts
function fft(N, ar, ai) {
  const NV2 = N >> 1;
  const NM1 = N - 1;
  let M = 0;
  let TEMP = N;
  while (TEMP >>= 1) ++M;
  let j = 1;
  for (let i = 1; i <= NM1; i++) {
    if (i < j) {
      const t = ar[j - 1];
      ar[j - 1] = ar[i - 1];
      ar[i - 1] = t;
      const u = ai[j - 1];
      ai[j - 1] = ai[i - 1];
      ai[i - 1] = u;
    }
    let k = NV2;
    while (k < j) {
      j -= k;
      k /= 2;
    }
    j += k;
  }
  let LE = 1;
  for (let L = 1; L <= M; L++) {
    const LE1 = LE;
    LE *= 2;
    let Ur = 1;
    let Ui = 0;
    const Wr = Math.cos(Math.PI / LE1);
    const Wi = -Math.sin(Math.PI / LE1);
    for (let j2 = 1; j2 <= LE1; j2++) {
      for (let i = j2; i <= N; i += LE) {
        const ip = i + LE1;
        const Tr = ar[ip - 1] * Ur - ai[ip - 1] * Ui;
        const Ti = ar[ip - 1] * Ui + ai[ip - 1] * Ur;
        ar[ip - 1] = ar[i - 1] - Tr;
        ai[ip - 1] = ai[i - 1] - Ti;
        ar[i - 1] = ar[i - 1] + Tr;
        ai[i - 1] = ai[i - 1] + Ti;
      }
      const Ur_old = Ur;
      Ur = Ur_old * Wr - Ui * Wi;
      Ui = Ur_old * Wi + Ui * Wr;
    }
  }
}
var WaveTableGenerator = class {
  /**
   * Create wavetables for different frequency ranges from frequency domain data
   */
  static generateWaveTables(freqWaveRe, freqWaveIm, tableLength) {
    freqWaveRe[0] = freqWaveIm[0] = 0;
    freqWaveRe[tableLength >> 1] = freqWaveIm[tableLength >> 1] = 0;
    const tables = [];
    let maxHarmonic = tableLength >> 1;
    const minVal = 1e-6;
    while (Math.abs(freqWaveRe[maxHarmonic]) + Math.abs(freqWaveIm[maxHarmonic]) < minVal && maxHarmonic) {
      --maxHarmonic;
    }
    if (maxHarmonic === 0) {
      throw new Error("No harmonics found in input data");
    }
    let topFreq = 2 / 3 / maxHarmonic;
    const ar = new Float64Array(tableLength);
    const ai = new Float64Array(tableLength);
    let scale = 0;
    while (maxHarmonic) {
      ar.fill(0);
      ai.fill(0);
      for (let idx = 1; idx <= maxHarmonic; idx++) {
        ar[idx] = freqWaveRe[idx];
        ai[idx] = freqWaveIm[idx];
        ar[tableLength - idx] = freqWaveRe[tableLength - idx];
        ai[tableLength - idx] = freqWaveIm[tableLength - idx];
      }
      fft(tableLength, ar, ai);
      if (scale === 0) {
        let max = 0;
        for (let idx = 0; idx < tableLength; idx++) {
          const temp = Math.abs(ai[idx]);
          if (max < temp) max = temp;
        }
        scale = 1 / max * 0.999;
      }
      const wave = new Float32Array(tableLength + 1);
      for (let idx = 0; idx < tableLength; idx++) {
        wave[idx] = ai[idx] * scale;
      }
      wave[tableLength] = wave[0];
      tables.push({
        waveTableLen: tableLength,
        topFreq,
        waveTable: wave
      });
      topFreq *= 2;
      maxHarmonic >>= 1;
    }
    return tables;
  }
  /**
   * Generate frequency domain data for a custom waveform
   */
  static generateCustomWaveform(harmonicAmplitudes, harmonicPhases, tableLength) {
    const freqWaveRe = new Float64Array(tableLength);
    const freqWaveIm = new Float64Array(tableLength);
    const numHarmonics = Math.min(
      harmonicAmplitudes.length,
      harmonicPhases.length,
      tableLength >> 1
    );
    for (let i = 1; i <= numHarmonics; i++) {
      const amplitude = harmonicAmplitudes[i - 1];
      const phase = harmonicPhases[i - 1];
      freqWaveRe[i] = amplitude * Math.cos(phase);
      freqWaveIm[i] = amplitude * Math.sin(phase);
      freqWaveRe[tableLength - i] = freqWaveRe[i];
      freqWaveIm[tableLength - i] = -freqWaveIm[i];
    }
    return { real: freqWaveRe, imag: freqWaveIm };
  }
  /**
   * Helper to convert frequency to normalized frequency
   */
  static freqToNormalized(frequency, sampleRate2) {
    return frequency / sampleRate2;
  }
  /**
   * Helper to convert MIDI note to frequency
   */
  static noteToFrequency(note, detune = 0) {
    return 440 * Math.pow(2, (note - 69 + detune / 100) / 12);
  }
};

// src/audio/wavetable/wavetable-bank.ts
var WaveTableBank = class {
  constructor() {
    __publicField(this, "tableLength", 2048);
    __publicField(this, "waveforms", /* @__PURE__ */ new Map());
    this.initializeWaveforms();
  }
  initializeWaveforms() {
    this.generateSineWaveTables();
    this.generateTriangleWaveTables();
    this.generateSawtoothWaveTables();
    this.generateSquareWaveTables();
  }
  generateSineWaveTables() {
    const freqWaveRe = new Float64Array(this.tableLength);
    const freqWaveIm = new Float64Array(this.tableLength);
    freqWaveRe[1] = 1;
    freqWaveRe[this.tableLength - 1] = -1;
    const tables = WaveTableGenerator.generateWaveTables(
      freqWaveRe,
      freqWaveIm,
      this.tableLength
    );
    this.waveforms.set("sine", tables);
  }
  generateTriangleWaveTables() {
    const freqWaveRe = new Float64Array(this.tableLength);
    const freqWaveIm = new Float64Array(this.tableLength);
    for (let n = 1; n < this.tableLength >> 1; n += 2) {
      const amplitude = 1 / (n * n);
      if ((n - 1 >> 1) % 2 === 0) {
        freqWaveRe[n] = amplitude;
        freqWaveRe[this.tableLength - n] = -amplitude;
      } else {
        freqWaveRe[n] = -amplitude;
        freqWaveRe[this.tableLength - n] = amplitude;
      }
    }
    const tables = WaveTableGenerator.generateWaveTables(
      freqWaveRe,
      freqWaveIm,
      this.tableLength
    );
    this.waveforms.set("triangle", tables);
  }
  generateSawtoothWaveTables() {
    const freqWaveRe = new Float64Array(this.tableLength);
    const freqWaveIm = new Float64Array(this.tableLength);
    for (let n = 1; n < this.tableLength >> 1; n++) {
      const amplitude = 1 / n;
      freqWaveRe[n] = amplitude;
      freqWaveRe[this.tableLength - n] = -amplitude;
    }
    const tables = WaveTableGenerator.generateWaveTables(
      freqWaveRe,
      freqWaveIm,
      this.tableLength
    );
    this.waveforms.set("sawtooth", tables);
  }
  generateSquareWaveTables() {
    const freqWaveRe = new Float64Array(this.tableLength);
    const freqWaveIm = new Float64Array(this.tableLength);
    for (let n = 1; n < this.tableLength >> 1; n += 2) {
      const amplitude = 1 / n;
      freqWaveRe[n] = amplitude;
      freqWaveRe[this.tableLength - n] = -amplitude;
    }
    const tables = WaveTableGenerator.generateWaveTables(
      freqWaveRe,
      freqWaveIm,
      this.tableLength
    );
    this.waveforms.set("square", tables);
  }
  getWaveform(type) {
    const tables = this.waveforms.get(type);
    if (!tables) {
      throw new Error(`Waveform type ${type} not found in bank`);
    }
    return tables;
  }
  addCustomWaveform(name, harmonicAmplitudes, harmonicPhases) {
    const { real, imag } = WaveTableGenerator.generateCustomWaveform(
      harmonicAmplitudes,
      harmonicPhases,
      this.tableLength
    );
    const tables = WaveTableGenerator.generateWaveTables(
      real,
      imag,
      this.tableLength
    );
    this.waveforms.set(name, tables);
  }
};

// src/audio/wavetable/wavetable-oscillator.ts
var WaveTableOscillator = class {
  constructor(bank, initialType = "sine", sampleRate2 = 44100) {
    this.bank = bank;
    __publicField(this, "phasor", 0);
    __publicField(this, "phaseInc", 0);
    __publicField(this, "gain", 1);
    __publicField(this, "detune", 0);
    __publicField(this, "curWaveTable", 0);
    __publicField(this, "currentWaveTables", []);
    __publicField(this, "currentType");
    __publicField(this, "sampleRate");
    __publicField(this, "hardSyncEnabled", false);
    __publicField(this, "is_active", true);
    this.currentType = initialType;
    this.sampleRate = sampleRate2;
    this.setWaveform(initialType);
  }
  updateState(state) {
    this.hardSync = state.hardsync;
    this.detune = state.detune;
    this.gain = state.gain;
    this.setWaveform(state.waveform);
    this.is_active = state.is_active;
  }
  get hardSync() {
    return this.hardSyncEnabled;
  }
  set hardSync(val) {
    this.hardSyncEnabled = val;
  }
  reset() {
    this.phasor = 0;
  }
  setWaveform(type) {
    this.currentWaveTables = this.bank.getWaveform(type);
    this.currentType = type;
    this.updateWaveTableSelector();
  }
  setFrequency(frequency) {
    this.phaseInc = WaveTableGenerator.freqToNormalized(frequency, this.sampleRate);
    this.updateWaveTableSelector();
  }
  setNote(note, detune = 0) {
    const frequency = WaveTableGenerator.noteToFrequency(note, detune);
    this.setFrequency(frequency);
  }
  setSampleRate(sampleRate2) {
    this.sampleRate = sampleRate2;
    if (this.phaseInc > 0) {
      const frequency = this.phaseInc * this.sampleRate;
      this.setFrequency(frequency);
    }
  }
  getFrequency(baseFreq, detune) {
    return baseFreq * Math.pow(2, detune / 1200);
  }
  updateWaveTableSelector() {
    let curWaveTable = 0;
    while (curWaveTable < this.currentWaveTables.length - 1 && this.phaseInc >= this.currentWaveTables[curWaveTable].topFreq) {
      ++curWaveTable;
    }
    this.curWaveTable = curWaveTable;
  }
  process(frequency) {
    if (!this.is_active) {
      return 0;
    }
    const tunedFrequency = this.getFrequency(frequency, this.detune);
    this.setFrequency(tunedFrequency);
    this.phasor += this.phaseInc;
    if (this.phasor >= 1) {
      this.phasor -= 1;
    }
    const waveTable = this.currentWaveTables[this.curWaveTable];
    const temp = this.phasor * waveTable.waveTableLen;
    const intPart = Math.floor(temp);
    const fracPart = temp - intPart;
    const samp0 = waveTable.waveTable[intPart];
    const samp1 = waveTable.waveTable[intPart + 1];
    return (samp0 + (samp1 - samp0) * fracPart) * this.gain;
  }
  getWaveform() {
    return this.currentType;
  }
  getCurrentFrequency() {
    return this.phaseInc * this.sampleRate;
  }
};

// src/audio/dsp/noise-generator.ts
var _NoiseGenerator = class _NoiseGenerator {
  constructor(sampleRate2) {
    // Random number generator state
    __publicField(this, "state0", 0);
    __publicField(this, "state1", 0);
    __publicField(this, "state2", 0);
    __publicField(this, "state3", 0);
    // Noise parameters
    __publicField(this, "currentNoiseType");
    __publicField(this, "dcOffset");
    // Filter parameters
    __publicField(this, "targetCutoff");
    __publicField(this, "currentCutoff");
    __publicField(this, "previousOutput");
    __publicField(this, "filterCoeff");
    __publicField(this, "sampleRate");
    // Pink and Brownian noise state
    __publicField(this, "pinkNoiseState");
    __publicField(this, "brownNoiseState");
    this.sampleRate = sampleRate2;
    this.currentNoiseType = 0 /* White */;
    this.setSeed(123);
    this.targetCutoff = 1;
    this.currentCutoff = 1;
    this.previousOutput = 0;
    this.filterCoeff = 0;
    this.dcOffset = 0;
    this.pinkNoiseState = new Float32Array(7);
    this.brownNoiseState = 0;
    this.updateFilterCoefficient();
  }
  setCutoff(value) {
    this.targetCutoff = Math.max(0, Math.min(value, 1));
  }
  setDCOffset(value) {
    this.dcOffset = Math.max(-1, Math.min(value, 1));
  }
  setSeed(seed) {
    this.state0 = seed;
    this.state1 = 362436069;
    this.state2 = 521288629;
    this.state3 = 88675123;
  }
  setNoiseType(noiseType) {
    this.currentNoiseType = noiseType;
  }
  updateFilterCoefficient(cutoffMod = 1) {
    this.currentCutoff += (this.targetCutoff * cutoffMod - this.currentCutoff) * _NoiseGenerator.CUTOFF_SMOOTHING;
    const maxFrequency = this.sampleRate / 2;
    let cutoffFrequency = _NoiseGenerator.MIN_FREQUENCY * Math.exp(Math.log(maxFrequency / _NoiseGenerator.MIN_FREQUENCY) * this.currentCutoff);
    cutoffFrequency = Math.max(_NoiseGenerator.MIN_FREQUENCY, Math.min(cutoffFrequency, maxFrequency));
    const rc = 1 / (2 * Math.PI * cutoffFrequency);
    const dt = 1 / this.sampleRate;
    this.filterCoeff = dt / (rc + dt);
  }
  generateRandomNumber() {
    const result = this.rotateLeft(this.state1 * 5, 7) * 9;
    const t = this.state1 << 9;
    this.state2 ^= this.state0;
    this.state3 ^= this.state1;
    this.state1 ^= this.state2;
    this.state0 ^= this.state3;
    this.state2 ^= t;
    this.state3 = this.rotateLeft(this.state3, 11);
    return result >>> 0;
  }
  rotateLeft(n, d) {
    return n << d | n >>> 32 - d;
  }
  getWhiteNoise() {
    return this.generateRandomNumber() / 4294967295 * 2 - 1;
  }
  getPinkNoise() {
    const white = this.getWhiteNoise();
    this.pinkNoiseState[0] = 0.99886 * this.pinkNoiseState[0] + white * 0.0555179;
    this.pinkNoiseState[1] = 0.99332 * this.pinkNoiseState[1] + white * 0.0750759;
    this.pinkNoiseState[2] = 0.969 * this.pinkNoiseState[2] + white * 0.153852;
    this.pinkNoiseState[3] = 0.8665 * this.pinkNoiseState[3] + white * 0.3104856;
    this.pinkNoiseState[4] = 0.55 * this.pinkNoiseState[4] + white * 0.5329522;
    this.pinkNoiseState[5] = -0.7616 * this.pinkNoiseState[5] - white * 0.016898;
    const pink = this.pinkNoiseState[0] + this.pinkNoiseState[1] + this.pinkNoiseState[2] + this.pinkNoiseState[3] + this.pinkNoiseState[4] + this.pinkNoiseState[5] + this.pinkNoiseState[6] + white * 0.5362;
    this.pinkNoiseState[6] = white * 0.115926;
    return pink * _NoiseGenerator.PINK_NOISE_SCALE;
  }
  getBrownianNoise() {
    const white = this.getWhiteNoise();
    this.brownNoiseState = (this.brownNoiseState + 0.02 * white) / 1.02;
    return this.brownNoiseState * _NoiseGenerator.BROWNIAN_NOISE_SCALE;
  }
  applyFilter(inputNoise) {
    const output = this.filterCoeff * inputNoise + (1 - this.filterCoeff) * this.previousOutput;
    this.previousOutput = output;
    return output;
  }
  process(amplitude, gainParam, cutoffMod, output) {
    for (let i = 0; i < output.length; i++) {
      this.updateFilterCoefficient(cutoffMod);
      let noiseValue;
      switch (this.currentNoiseType) {
        case 0 /* White */:
          noiseValue = this.getWhiteNoise();
          break;
        case 1 /* Pink */:
          noiseValue = this.getPinkNoise();
          break;
        case 2 /* Brownian */:
          noiseValue = this.getBrownianNoise();
          break;
        default:
          noiseValue = 0;
      }
      output[i] = this.applyFilter(noiseValue) * amplitude * gainParam + this.dcOffset;
    }
    return output;
  }
};
__publicField(_NoiseGenerator, "PINK_NOISE_SCALE", 0.25);
__publicField(_NoiseGenerator, "BROWNIAN_NOISE_SCALE", 3.5);
__publicField(_NoiseGenerator, "CUTOFF_SMOOTHING", 0.1);
__publicField(_NoiseGenerator, "MIN_FREQUENCY", 20);
var NoiseGenerator = _NoiseGenerator;

// src/audio/worklets/synth-worklet.ts
var WasmAudioProcessor = class extends AudioWorkletProcessor {
  constructor() {
    super();
    __publicField(this, "envelopes", /* @__PURE__ */ new Map());
    __publicField(this, "oscillators", /* @__PURE__ */ new Map());
    __publicField(this, "lastGate", 0);
    __publicField(this, "combFilter", new VariableCombFilter(sampleRate, 100));
    __publicField(this, "bank", new WaveTableBank());
    __publicField(this, "noise", new NoiseGenerator(sampleRate));
    __publicField(this, "noiseBuffer", new Float32Array(128));
    this.oscillators.set(0, new WaveTableOscillator(this.bank, "sawtooth", sampleRate));
    this.oscillators.set(1, new WaveTableOscillator(this.bank, "square", sampleRate));
    this.envelopes.set(0, new Envelope(sampleRate));
    this.noise.setNoiseType(1 /* Pink */);
    this.port.onmessage = async (event) => {
      if (event.data.type === "initialize") {
      }
      if (event.data.type === "updateEnvelope") {
        const msg = event.data;
        const envelope = this.envelopes.get(msg.id);
        if (envelope) {
          envelope.updateConfig(msg.config);
        } else {
          this.envelopes.set(msg.id, new Envelope(sampleRate, msg.config));
        }
      } else if (event.data.type === "updateOscillator") {
        const state = event.data.newState;
        const oscillator = this.oscillators.get(state.id);
        if (oscillator) {
          oscillator.updateState(state);
        } else {
          console.error("oscillator doesnt exist: ", state);
        }
      } else if (event.data.type === "updateFilter") {
        const state = event.data.newState;
        if (this.combFilter) {
          this.combFilter.updateState(state);
        } else {
          console.error("oscillator doesnt exist: ", state);
        }
      }
    };
    this.port.postMessage({ type: "ready" });
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
        name: "detune",
        defaultValue: 0,
        minValue: -1200,
        maxValue: 1200,
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
  getFrequency(baseFreq, detune) {
    return baseFreq * Math.pow(2, detune / 1200);
  }
  softClip(sample) {
    const threshold = 0.95;
    if (sample > threshold) {
      return threshold + (sample - threshold) / (1 + Math.pow((sample - threshold) / (1 - threshold), 2));
    } else if (sample < -threshold) {
      return -threshold + (sample + threshold) / (1 + Math.pow((sample + threshold) / (1 - threshold), 2));
    } else {
      return sample;
    }
  }
  process(_inputs, outputs, parameters) {
    const output = outputs[0];
    const frequency = parameters.frequency;
    const detune = parameters.detune;
    const gate = parameters.gate;
    const bufferSize = output[0].length;
    const detuneValue = detune[0];
    this.noise.process(1, 1, 1, this.noiseBuffer);
    for (let i = 0; i < bufferSize; ++i) {
      const freq = frequency[i] ?? frequency[0];
      const gateValue = gate[i] ?? gate[0];
      if (gateValue > 0 && this.lastGate <= 0) {
        this.combFilter.clear();
        this.combFilter.setFrequency(freq);
        this.oscillators.forEach((oscillator, _id) => {
          if (oscillator.hardSync) {
            oscillator.reset();
          }
        });
      }
      const envelopeValue = this.envelopes.get(0).process(gateValue);
      let oscillatorSample = 0;
      this.oscillators.forEach((oscillator, _id) => {
        oscillatorSample += oscillator.process(this.getFrequency(freq, detuneValue));
      });
      oscillatorSample = this.noiseBuffer[i] * envelopeValue * 0.25;
      this.combFilter.setFrequency(freq);
      let sample = this.combFilter.process(oscillatorSample);
      sample = this.softClip(sample);
      for (let channel = 0; channel < output.length; ++channel) {
        output[channel][i] = sample;
      }
      this.lastGate = gateValue;
    }
    return true;
  }
};
registerProcessor("synth-audio-processor", WasmAudioProcessor);
