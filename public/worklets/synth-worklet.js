var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

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
    __publicField(this, "maxFrequency");
    // Pink and Brownian noise state
    __publicField(this, "pinkNoiseState");
    __publicField(this, "brownNoiseState");
    __publicField(this, "is_enabled");
    // Cached noise function
    __publicField(this, "currentNoiseFunc");
    this.sampleRate = sampleRate2;
    this.maxFrequency = sampleRate2 / 2;
    this.currentNoiseType = 0 /* White */;
    this.setSeed(123);
    this.targetCutoff = 1;
    this.currentCutoff = 1;
    this.previousOutput = 0;
    this.filterCoeff = 0;
    this.dcOffset = 0;
    this.pinkNoiseState = new Float32Array(7);
    this.brownNoiseState = 0;
    this.currentNoiseFunc = this.getWhiteNoise.bind(this);
    this.updateFilterCoefficient();
    this.is_enabled = true;
  }
  updateState(state) {
    this.setNoiseType(state.noiseType);
    this.setCutoff(state.cutoff);
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
    switch (noiseType) {
      case 0 /* White */:
        this.currentNoiseFunc = this.getWhiteNoise.bind(this);
        break;
      case 1 /* Pink */:
        this.currentNoiseFunc = this.getPinkNoise.bind(this);
        break;
      case 2 /* Brownian */:
        this.currentNoiseFunc = this.getBrownianNoise.bind(this);
        break;
    }
  }
  updateFilterCoefficient(cutoffMod = 1) {
    this.currentCutoff += (this.targetCutoff * cutoffMod - this.currentCutoff) * _NoiseGenerator.CUTOFF_SMOOTHING;
    let cutoffFrequency = _NoiseGenerator.MIN_FREQUENCY * Math.exp(Math.log(this.maxFrequency / _NoiseGenerator.MIN_FREQUENCY) * this.currentCutoff);
    cutoffFrequency = Math.max(_NoiseGenerator.MIN_FREQUENCY, Math.min(cutoffFrequency, this.maxFrequency));
    const rc = 1 / (2 * Math.PI * cutoffFrequency);
    const dt = 1 / this.sampleRate;
    this.filterCoeff = dt / (rc + dt);
  }
  generateRandomNumber() {
    const result = (this.state1 * 5 << 7 | this.state1 * 5 >>> 25) * 9;
    const t = this.state1 << 9;
    this.state2 ^= this.state0;
    this.state3 ^= this.state1;
    this.state1 ^= this.state2;
    this.state0 ^= this.state3;
    this.state2 ^= t;
    this.state3 = this.state3 << 11 | this.state3 >>> 21;
    return result >>> 0;
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
    const gain = amplitude * gainParam;
    for (let i = 0; i < output.length; i++) {
      this.updateFilterCoefficient(cutoffMod);
      output[i] = this.applyFilter(this.currentNoiseFunc()) * gain + this.dcOffset;
    }
    return output;
  }
};
__publicField(_NoiseGenerator, "PINK_NOISE_SCALE", 0.25);
__publicField(_NoiseGenerator, "BROWNIAN_NOISE_SCALE", 3.5);
__publicField(_NoiseGenerator, "CUTOFF_SMOOTHING", 0.1);
__publicField(_NoiseGenerator, "MIN_FREQUENCY", 20);
var NoiseGenerator = _NoiseGenerator;

// src/audio/dsp/flanger-comb-filter.ts
var FlangerCombFilter = class {
  constructor(sampleRate2, maxDelayMs = 100) {
    __publicField(this, "buffer");
    __publicField(this, "bufferSize");
    __publicField(this, "writeIndex", 0);
    __publicField(this, "delaySamples", 0);
    __publicField(this, "sampleRate");
    __publicField(this, "phase", 0);
    // Enhanced DC blocker state
    __publicField(this, "x1", 0);
    __publicField(this, "x2", 0);
    __publicField(this, "y1", 0);
    __publicField(this, "y2", 0);
    __publicField(this, "R", 0.999);
    // Pole radius
    __publicField(this, "SQRT2", Math.sqrt(2));
    // Original flanger parameters
    __publicField(this, "FLANGER_RATE", 0.2);
    __publicField(this, "FLANGER_DEPTH", 0.7);
    __publicField(this, "FLANGER_MIX", 0.5);
    __publicField(this, "_cut", 1e4);
    __publicField(this, "_resonance", 0.5);
    __publicField(this, "is_enabled", false);
    __publicField(this, "filterAlpha", 0);
    __publicField(this, "filterState", 0);
    this.sampleRate = sampleRate2;
    this.bufferSize = Math.floor(maxDelayMs / 1e3 * sampleRate2);
    this.buffer = new Float32Array(this.bufferSize);
    this.clear();
    this.cut = this._cut;
  }
  removeDC(input) {
    const output = input - 2 * this.x1 + this.x2 + 2 * this.R * this.y1 - this.R * this.R * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = output;
    return output / (1 + 2 * this.R + this.R * this.R);
  }
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
  set cut(cut) {
    this._cut = Math.max(20, Math.min(cut, this.sampleRate / 2));
    const omega = 2 * Math.PI * this._cut / this.sampleRate;
    this.filterAlpha = Math.exp(-omega);
  }
  get cut() {
    return this._cut;
  }
  set resonance(resonance) {
    this._resonance = Math.max(0, Math.min(resonance, 1));
  }
  get resonance() {
    return this._resonance;
  }
  getModulatedDelay() {
    const lfoValue = Math.sin(this.phase);
    const modDepth = this.delaySamples * this.FLANGER_DEPTH;
    return this.delaySamples + lfoValue * modDepth;
  }
  process(input) {
    if (!this.is_enabled) {
      return input;
    }
    this.phase += 2 * Math.PI * this.FLANGER_RATE / this.sampleRate;
    if (this.phase >= 2 * Math.PI) {
      this.phase -= 2 * Math.PI;
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
    const feedbackSignal = input + feedbackSample;
    const modDelay = this.getModulatedDelay();
    const modDelayInt = Math.floor(modDelay);
    const modFrac = modDelay - modDelayInt;
    const modReadIndex1 = (this.writeIndex - modDelayInt + this.bufferSize) % this.bufferSize;
    const modReadIndex2 = (modReadIndex1 - 1 + this.bufferSize) % this.bufferSize;
    const modDelayedSample1 = this.buffer[modReadIndex1];
    const modDelayedSample2 = this.buffer[modReadIndex2];
    const modDelayedSample = modDelayedSample1 * (1 - modFrac) + modDelayedSample2 * modFrac;
    this.buffer[this.writeIndex] = feedbackSignal;
    this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
    const output = feedbackSignal * (1 - this.FLANGER_MIX) + modDelayedSample * this.FLANGER_MIX;
    return this.removeDC(output);
  }
  clear() {
    this.buffer.fill(0);
    this.writeIndex = 0;
    this.filterState = 0;
    this.phase = 0;
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
};

// src/audio/dsp/resonator-bank.ts
var AllPassFilter = class {
  constructor(maxDelaySamples, initialDelay, feedback) {
    __publicField(this, "buffer");
    __publicField(this, "bufferSize");
    __publicField(this, "writeIndex", 0);
    __publicField(this, "feedback");
    __publicField(this, "delayLength");
    this.bufferSize = Math.max(1, Math.floor(maxDelaySamples));
    this.buffer = new Float32Array(this.bufferSize);
    this.feedback = feedback;
    this.delayLength = Math.min(this.bufferSize, Math.floor(initialDelay));
  }
  setDelayLength(samples) {
    this.delayLength = Math.min(this.bufferSize, Math.max(1, Math.floor(samples)));
    this.writeIndex = this.writeIndex % this.delayLength;
  }
  setFeedback(value) {
    this.feedback = Math.max(-0.999, Math.min(0.999, value));
  }
  process(input) {
    const readIndex = (this.writeIndex - this.delayLength + this.bufferSize) % this.bufferSize;
    const bufSample = this.buffer[readIndex];
    const output = -input + bufSample;
    this.buffer[this.writeIndex] = input + bufSample * this.feedback;
    this.writeIndex = (this.writeIndex + 1) % this.delayLength;
    return output;
  }
  clear() {
    this.buffer.fill(0);
    this.writeIndex = 0;
  }
};
var ResonatorBank = class {
  constructor(sampleRate2, maxDelayMs = 100, blockSize = 128) {
    __publicField(this, "sampleRate");
    __publicField(this, "resonators", []);
    // DC blocker state
    __publicField(this, "x1", 0);
    __publicField(this, "x2", 0);
    __publicField(this, "y1", 0);
    __publicField(this, "y2", 0);
    __publicField(this, "R", 0.999);
    // Pole radius for DC blocking
    __publicField(this, "_cut", 1e4);
    __publicField(this, "_resonance", 1);
    __publicField(this, "is_enabled", true);
    __publicField(this, "filterAlpha", 0);
    __publicField(this, "bufferSize");
    __publicField(this, "MAX_RESONATORS", 3);
    // Slightly less than 1.0 to prevent runaway feedback
    __publicField(this, "maxFeedbackGain", 0.999);
    __publicField(this, "resonatorOutputs");
    __publicField(this, "outputBuffer");
    __publicField(this, "blockSize");
    // We provide a wide variety of presets with different resonances and dispersion.
    __publicField(this, "presets", [
      {
        name: "string",
        resonators: [
          { ratio: 1, level: 1 },
          { ratio: 2, level: 0.4 },
          { ratio: 3, level: 0.3 }
        ],
        cut: 8e3,
        resonance: 1,
        allpassDelay: 50,
        allpassFeedback: 0.5
      },
      {
        name: "simple-string",
        resonators: [
          { ratio: 1, level: 1 }
        ],
        cut: 8e3,
        resonance: 1,
        allpassDelay: 40,
        allpassFeedback: 0.4
      },
      {
        name: "piano-like",
        resonators: [
          { ratio: 1, level: 1 },
          { ratio: 2, level: 0.5 }
        ],
        cut: 9e3,
        resonance: 1,
        allpassDelay: 60,
        allpassFeedback: 0.3
      },
      {
        name: "bell",
        resonators: [
          { ratio: 1, level: 1 },
          { ratio: 2.5, level: 0.7 },
          { ratio: 5.1, level: 0.3 }
        ],
        cut: 1e4,
        resonance: 1,
        allpassDelay: 100,
        allpassFeedback: 0.6
      },
      {
        name: "harp",
        resonators: [
          { ratio: 1, level: 1 },
          { ratio: 2.04, level: 0.6 },
          { ratio: 3.1, level: 0.3 }
        ],
        cut: 7e3,
        resonance: 1,
        allpassDelay: 45,
        allpassFeedback: 0.45
      },
      {
        name: "guitar",
        resonators: [
          { ratio: 1, level: 1 },
          { ratio: 2.02, level: 0.5 },
          { ratio: 3.99, level: 0.2 }
        ],
        cut: 8e3,
        resonance: 1,
        allpassDelay: 70,
        allpassFeedback: 0.5
      },
      {
        name: "marimba",
        resonators: [
          { ratio: 1, level: 1 },
          { ratio: 2.95, level: 0.4 }
        ],
        cut: 6e3,
        resonance: 1,
        allpassDelay: 30,
        allpassFeedback: 0.35
      },
      {
        name: "wooden",
        resonators: [
          { ratio: 1, level: 1 },
          { ratio: 1.58, level: 0.5 },
          { ratio: 2.46, level: 0.3 }
        ],
        cut: 6e3,
        resonance: 1,
        allpassDelay: 80,
        allpassFeedback: 0.55
      },
      {
        name: "glass",
        resonators: [
          { ratio: 1, level: 1 },
          { ratio: 2.414, level: 0.6 },
          { ratio: 3.414, level: 0.4 }
        ],
        cut: 12e3,
        resonance: 1,
        allpassDelay: 90,
        allpassFeedback: 0.4
      },
      {
        name: "percussion",
        resonators: [
          { ratio: 1, level: 1 },
          { ratio: 1.33, level: 0.7 }
        ],
        cut: 5e3,
        resonance: 1,
        allpassDelay: 20,
        allpassFeedback: 0.5
      },
      {
        name: "drone",
        resonators: [
          { ratio: 1, level: 1 },
          { ratio: 1.2, level: 0.8 },
          { ratio: 2.5, level: 0.6 }
        ],
        cut: 5e3,
        resonance: 1,
        allpassDelay: 100,
        allpassFeedback: 0.5
      }
    ]);
    this.sampleRate = sampleRate2;
    this.bufferSize = Math.floor(maxDelayMs / 1e3 * sampleRate2);
    this.blockSize = blockSize;
    this.outputBuffer = new Float32Array(blockSize);
    this.resonatorOutputs = Array(this.MAX_RESONATORS).fill(null).map(() => new Float32Array(blockSize));
    const defaultAllpassDelay = 50;
    const defaultAllpassFeedback = 0.5;
    for (let i = 0; i < this.MAX_RESONATORS; i++) {
      const buffer = new Float32Array(this.bufferSize);
      const allpass = new AllPassFilter(this.bufferSize, defaultAllpassDelay, defaultAllpassFeedback);
      this.resonators.push({
        ratio: i === 0 ? 1 : i + 1,
        level: i === 0 ? 1 : 0,
        enabled: i === 0,
        delaySamples: 0,
        buffer,
        writeIndex: 0,
        filterState: 0,
        allpass
      });
    }
    this.clear();
    this.cut = this._cut;
  }
  removeDC(input) {
    const output = input - 2 * this.x1 + this.x2 + 2 * this.R * this.y1 - this.R * this.R * this.y2;
    this.x2 = this.x1;
    this.x1 = input;
    this.y2 = this.y1;
    this.y1 = output;
    return output / (1 + 2 * this.R + this.R * this.R);
  }
  setFrequency(frequency) {
    for (let i = 0; i < this.MAX_RESONATORS; i++) {
      const r = this.resonators[i];
      if (!r.enabled) continue;
      const freq = frequency * r.ratio;
      let delaySamples = this.sampleRate / freq;
      if (delaySamples >= this.bufferSize) {
        delaySamples = this.bufferSize - 1;
      }
      r.delaySamples = delaySamples;
    }
  }
  updateState(state) {
    this.cut = state.cut;
    this.is_enabled = state.is_enabled;
    this.resonance = state.resonance;
  }
  set cut(cut) {
    this._cut = Math.max(20, Math.min(cut, this.sampleRate / 2));
    const omega = 2 * Math.PI * this._cut / this.sampleRate;
    this.filterAlpha = Math.exp(-omega);
  }
  get cut() {
    return this._cut;
  }
  set resonance(resonance) {
    this._resonance = Math.max(0, Math.min(resonance, 1));
  }
  get resonance() {
    return this._resonance;
  }
  setResonatorEnabled(index, enabled) {
    if (index === 0 && !enabled) return;
    if (index >= 0 && index < this.MAX_RESONATORS) {
      this.resonators[index].enabled = enabled;
    }
  }
  setResonatorParams(index, ratio, level, enabled) {
    if (index < 0 || index >= this.MAX_RESONATORS) return;
    const r = this.resonators[index];
    r.ratio = ratio;
    r.level = level;
    if (enabled !== void 0 && (index !== 0 || enabled)) {
      r.enabled = enabled;
    }
  }
  setPreset(name) {
    const preset = this.presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!preset) {
      console.log("preset " + name + " not found");
      return;
    }
    console.log("set preset:", name);
    for (let i = 0; i < this.MAX_RESONATORS; i++) {
      const r = this.resonators[i];
      r.enabled = false;
      r.level = 0;
      r.ratio = i + 1;
    }
    const pRes = preset.resonators;
    for (let i = 0; i < pRes.length && i < this.MAX_RESONATORS; i++) {
      const pr = pRes[i];
      const r = this.resonators[i];
      r.ratio = pr.ratio;
      r.level = pr.level;
      r.enabled = pr.enabled !== void 0 ? pr.enabled : i === 0 || pr.level > 0;
    }
    if (preset.cut !== void 0) this.cut = preset.cut;
    if (preset.resonance !== void 0) this.resonance = preset.resonance;
    const allpassDelay = preset.allpassDelay ?? 50;
    const allpassFeedback = preset.allpassFeedback ?? 0.5;
    for (let i = 0; i < this.MAX_RESONATORS; i++) {
      this.resonators[i].allpass.setDelayLength(allpassDelay);
      this.resonators[i].allpass.setFeedback(allpassFeedback);
    }
  }
  process(inputBlock) {
    if (!this.is_enabled) return inputBlock;
    if (inputBlock.length !== this.blockSize) {
      throw new Error(`Input block size ${inputBlock.length} does not match configured block size ${this.blockSize}`);
    }
    this.outputBuffer.fill(0);
    this.resonatorOutputs.forEach((buffer) => buffer.fill(0));
    for (let i = 0; i < this.MAX_RESONATORS; i++) {
      const r = this.resonators[i];
      if (!r.enabled || r.level <= 0) continue;
      const resonatorOutput = this.resonatorOutputs[i];
      const delaySamples = r.delaySamples;
      const delayInt = Math.floor(delaySamples);
      const frac = delaySamples - delayInt;
      for (let n = 0; n < this.blockSize; n++) {
        const readIndex1 = (r.writeIndex - delayInt + this.bufferSize) % this.bufferSize;
        const readIndex2 = (readIndex1 - 1 + this.bufferSize) % this.bufferSize;
        const delayedSample1 = r.buffer[readIndex1];
        const delayedSample2 = r.buffer[readIndex2];
        const delayedSample = delayedSample1 * (1 - frac) + delayedSample2 * frac;
        r.filterState = delayedSample + (r.filterState - delayedSample) * this.filterAlpha;
        const feedbackSample = r.filterState * this.maxFeedbackGain * this._resonance;
        const feedbackSignal = inputBlock[n] + feedbackSample;
        const dispersed = r.allpass.process(feedbackSignal);
        r.buffer[r.writeIndex] = dispersed;
        r.writeIndex = (r.writeIndex + 1) % this.bufferSize;
        resonatorOutput[n] = dispersed * r.level;
      }
    }
    for (let n = 0; n < this.blockSize; n++) {
      let mixedSample = 0;
      for (let i = 0; i < this.MAX_RESONATORS; i++) {
        mixedSample += this.resonatorOutputs[i][n];
      }
      this.outputBuffer[n] = this.removeDC(mixedSample);
    }
    return this.outputBuffer;
  }
  clear() {
    for (let i = 0; i < this.MAX_RESONATORS; i++) {
      const r = this.resonators[i];
      r.buffer.fill(0);
      r.writeIndex = 0;
      r.filterState = 0;
      r.allpass.clear();
    }
    this.x1 = 0;
    this.x2 = 0;
    this.y1 = 0;
    this.y2 = 0;
  }
};

// src/audio/worklets/synth-worklet.ts
var WasmAudioProcessor = class extends AudioWorkletProcessor {
  constructor() {
    super();
    __publicField(this, "envelopes", /* @__PURE__ */ new Map());
    __publicField(this, "oscillators", /* @__PURE__ */ new Map());
    __publicField(this, "resonatorBank", new ResonatorBank(sampleRate));
    __publicField(this, "lastGate", 0);
    __publicField(this, "combFilter", new FlangerCombFilter(sampleRate, 100));
    __publicField(this, "bank", new WaveTableBank());
    __publicField(this, "noise", new NoiseGenerator(sampleRate));
    __publicField(this, "noiseBuffer", new Float32Array(128));
    this.oscillators.set(
      0,
      new WaveTableOscillator(this.bank, "sawtooth", sampleRate)
    );
    this.oscillators.set(
      1,
      new WaveTableOscillator(this.bank, "square", sampleRate)
    );
    this.envelopes.set(0, new Envelope(sampleRate));
    this.envelopes.set(1, new Envelope(sampleRate));
    this.noise.setNoiseType(2 /* Brownian */);
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
      } else if (event.data.type === "updateNoise") {
        const state = event.data.newState;
        this.noise.updateState(state);
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
        if (this.resonatorBank) {
        } else {
          console.error("oscillator doesnt exist: ", state);
        }
      }
    };
    this.resonatorBank.setPreset("marimba");
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
    const gate = parameters.gate;
    const bufferSize = output[0].length;
    this.noise.process(1, 1, 1, this.noiseBuffer);
    this.resonatorBank.setFrequency(frequency[0]);
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
      const envelope0Value = this.envelopes.get(0).process(gateValue);
      this.noiseBuffer[i] *= envelope0Value;
      this.lastGate = gateValue;
    }
    const outputBuf = this.resonatorBank.process(this.noiseBuffer);
    for (let i = 0; i < bufferSize; ++i) {
      outputBuf[i] *= 0.25;
    }
    for (let channel = 0; channel < output.length; ++channel) {
      output[channel].set(outputBuf);
    }
    return true;
  }
};
registerProcessor("synth-audio-processor", WasmAudioProcessor);
