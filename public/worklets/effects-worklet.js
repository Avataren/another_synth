var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// src/audio/dsp/reverb-tunings.ts
var _ReverbTunings = class _ReverbTunings {
};
// Original sample rate used in the tunings (44.1 kHz)
__publicField(_ReverbTunings, "originalSampleRate", 44100);
// Original delay lengths in samples
__publicField(_ReverbTunings, "CombDelayLengths", [
  1116,
  1188,
  1277,
  1356,
  1422,
  1491,
  1557,
  1617,
  1693,
  1781,
  1867,
  1961
]);
__publicField(_ReverbTunings, "AllpassDelayLengths", [556, 441, 341, 225]);
// Stereo spread in samples at original sample rate
__publicField(_ReverbTunings, "StereoSpread", 23);
// Reverb parameters
__publicField(_ReverbTunings, "NumCombs", 12);
__publicField(_ReverbTunings, "NumAllpasses", 4);
__publicField(_ReverbTunings, "Muted", 0);
__publicField(_ReverbTunings, "FixedGain", 0.015);
__publicField(_ReverbTunings, "ScaleWet", 0.25);
__publicField(_ReverbTunings, "ScaleDry", 1);
__publicField(_ReverbTunings, "ScaleDamp", 0.5);
__publicField(_ReverbTunings, "ScaleRoom", 0.3);
__publicField(_ReverbTunings, "OffsetRoom", 0.7);
__publicField(_ReverbTunings, "InitialRoom", 0.6);
__publicField(_ReverbTunings, "InitialDamp", 0.5);
__publicField(_ReverbTunings, "InitialWet", 0.3);
__publicField(_ReverbTunings, "InitialDry", 0.8);
__publicField(_ReverbTunings, "InitialWidth", 1);
__publicField(_ReverbTunings, "InitialMode", 0);
__publicField(_ReverbTunings, "FreezeMode", 0.5);
// Precompute delay times in seconds based on original sample rate
__publicField(_ReverbTunings, "CombDelayTimes", _ReverbTunings.CombDelayLengths.map(
  (samples) => samples / _ReverbTunings.originalSampleRate
));
__publicField(_ReverbTunings, "AllpassDelayTimes", _ReverbTunings.AllpassDelayLengths.map(
  (samples) => samples / _ReverbTunings.originalSampleRate
));
__publicField(_ReverbTunings, "StereoSpreadTime", _ReverbTunings.StereoSpread / _ReverbTunings.originalSampleRate);
var ReverbTunings = _ReverbTunings;

// src/audio/dsp/reverb-comb-filter.ts
var ReverbCombFilter = class {
  constructor(size) {
    __publicField(this, "buffer");
    __publicField(this, "bufferSize");
    __publicField(this, "bufferIndex", 0);
    __publicField(this, "feedback", 0);
    __publicField(this, "filterStore", 0);
    __publicField(this, "damp1", 0);
    __publicField(this, "damp2", 0);
    this.bufferSize = size;
    this.buffer = new Float32Array(this.bufferSize);
  }
  setFeedback(value) {
    this.feedback = value;
  }
  setDamp(value) {
    this.damp1 = value;
    this.damp2 = 1 - value;
  }
  process(input) {
    const output = this.buffer[this.bufferIndex];
    this.filterStore = output * this.damp2 + this.filterStore * this.damp1;
    this.buffer[this.bufferIndex] = input + this.filterStore * this.feedback;
    this.bufferIndex++;
    if (this.bufferIndex >= this.bufferSize) {
      this.bufferIndex = 0;
    }
    return output;
  }
  mute() {
    this.buffer.fill(0);
    this.filterStore = 0;
  }
};

// src/audio/dsp/reverb-allpass-filter.ts
var ReverbAllPassFilter = class {
  constructor(size, feedback) {
    __publicField(this, "buffer");
    __publicField(this, "bufferSize");
    __publicField(this, "bufferIndex", 0);
    __publicField(this, "feedback", 0);
    this.bufferSize = size;
    this.buffer = new Float32Array(this.bufferSize);
    this.feedback = feedback;
  }
  setFeedback(value) {
    this.feedback = value;
  }
  process(input) {
    const bufOut = this.buffer[this.bufferIndex];
    const output = -input + bufOut;
    this.buffer[this.bufferIndex] = input + bufOut * this.feedback;
    this.bufferIndex++;
    if (this.bufferIndex >= this.bufferSize) {
      this.bufferIndex = 0;
    }
    return output;
  }
  mute() {
    this.buffer.fill(0);
  }
};

// src/audio/dsp/reverb-model.ts
var ReverbModel = class {
  constructor(sampleRate2) {
    __publicField(this, "gain", ReverbTunings.FixedGain);
    __publicField(this, "roomSize", 0);
    __publicField(this, "roomSize1", 0);
    __publicField(this, "damp", 0);
    __publicField(this, "damp1", 0);
    __publicField(this, "wet", 0);
    __publicField(this, "wet1", 0);
    __publicField(this, "wet2", 0);
    __publicField(this, "dry", 0);
    __publicField(this, "width", 0);
    __publicField(this, "mode", 0);
    __publicField(this, "combL", []);
    __publicField(this, "combR", []);
    __publicField(this, "allpassL", []);
    __publicField(this, "allpassR", []);
    __publicField(this, "sampleRate");
    this.sampleRate = sampleRate2;
    this.initializeFilters();
    this.allpassL.forEach((ap) => ap.setFeedback(0.5));
    this.allpassR.forEach((ap) => ap.setFeedback(0.5));
    this.setWet(ReverbTunings.InitialWet);
    this.setRoomSize(ReverbTunings.InitialRoom);
    this.setDry(ReverbTunings.InitialDry);
    this.setDamp(ReverbTunings.InitialDamp);
    this.setWidth(ReverbTunings.InitialWidth);
    this.setMode(ReverbTunings.InitialMode);
    this.mute();
  }
  initializeFilters() {
    const {
      CombDelayTimes,
      AllpassDelayTimes,
      StereoSpreadTime,
      NumCombs,
      NumAllpasses
    } = ReverbTunings;
    const stereoSpreadInSamples = Math.round(StereoSpreadTime * this.sampleRate);
    for (let i = 0; i < NumCombs; i++) {
      const delayTime = CombDelayTimes[i % CombDelayTimes.length];
      const delayInSamplesL = Math.round(delayTime * this.sampleRate);
      const delayInSamplesR = delayInSamplesL + stereoSpreadInSamples;
      this.combL.push(new ReverbCombFilter(delayInSamplesL));
      this.combR.push(new ReverbCombFilter(delayInSamplesR));
    }
    for (let i = 0; i < NumAllpasses; i++) {
      const delayTime = AllpassDelayTimes[i % AllpassDelayTimes.length];
      const delayInSamplesL = Math.round(delayTime * this.sampleRate);
      const delayInSamplesR = delayInSamplesL + stereoSpreadInSamples;
      this.allpassL.push(new ReverbAllPassFilter(delayInSamplesL, 0.5));
      this.allpassR.push(new ReverbAllPassFilter(delayInSamplesR, 0.5));
    }
  }
  softClip(input) {
    const threshold = 0.6;
    if (input > threshold) {
      return threshold + (input - threshold) / (1 + Math.pow(input - threshold, 2));
    } else if (input < -threshold) {
      return -threshold + (input + threshold) / (1 + Math.pow(-input - threshold, 2));
    } else {
      return input;
    }
  }
  mute() {
    if (this.mode >= ReverbTunings.FreezeMode) return;
    this.combL.forEach((comb) => comb.mute());
    this.combR.forEach((comb) => comb.mute());
    this.allpassL.forEach((ap) => ap.mute());
    this.allpassR.forEach((ap) => ap.mute());
  }
  processReplace(inputL, inputR, outputL, outputR, numSamples, skip) {
    let outL, outR, input;
    for (let i = 0; i < numSamples; i++) {
      outL = 0;
      outR = 0;
      input = (inputL[i * skip] + inputR[i * skip]) * this.gain;
      for (let j = 0; j < this.combL.length; j++) {
        outL += this.combL[j].process(input);
        outR += this.combR[j].process(input);
      }
      for (let j = 0; j < this.allpassL.length; j++) {
        outL = this.allpassL[j].process(outL);
        outR = this.allpassR[j].process(outR);
      }
      outputL[i * skip] = outL * this.wet1 + outR * this.wet2 + inputL[i * skip] * this.dry;
      outputR[i * skip] = outR * this.wet1 + outL * this.wet2 + inputR[i * skip] * this.dry;
      const phaseShift = 0.02;
      outputR[i * skip] += outputL[i * skip] * phaseShift;
      outputL[i * skip] -= outputR[i * skip] * phaseShift;
      outputL[i * skip] = this.softClip(outputL[i * skip]);
      outputR[i * skip] = this.softClip(outputR[i * skip]);
    }
  }
  update() {
    this.wet1 = this.wet * (this.width / 2 + 0.5);
    this.wet2 = this.wet * ((1 - this.width) / 2);
    if (this.mode >= ReverbTunings.FreezeMode) {
      this.roomSize1 = 1;
      this.damp1 = 0;
      this.gain = ReverbTunings.Muted;
    } else {
      this.roomSize1 = this.roomSize;
      this.damp1 = this.damp;
      this.gain = ReverbTunings.FixedGain;
    }
    this.combL.forEach((comb) => {
      comb.setFeedback(this.roomSize1);
      comb.setDamp(this.damp1);
    });
    this.combR.forEach((comb) => {
      comb.setFeedback(this.roomSize1);
      comb.setDamp(this.damp1);
    });
  }
  // Getters and Setters
  getRoomSize() {
    return (this.roomSize - ReverbTunings.OffsetRoom) / ReverbTunings.ScaleRoom;
  }
  setRoomSize(value) {
    this.roomSize = value * ReverbTunings.ScaleRoom + ReverbTunings.OffsetRoom;
    this.update();
  }
  getDamp() {
    return this.damp / ReverbTunings.ScaleDamp;
  }
  setDamp(value) {
    this.damp = value * ReverbTunings.ScaleDamp;
    this.update();
  }
  getWet() {
    return this.wet / ReverbTunings.ScaleWet;
  }
  setWet(value) {
    this.wet = value * ReverbTunings.ScaleWet;
    this.update();
  }
  getDry() {
    return this.dry / ReverbTunings.ScaleDry;
  }
  setDry(value) {
    this.dry = value * ReverbTunings.ScaleDry;
  }
  getWidth() {
    return this.width;
  }
  setWidth(value) {
    this.width = value;
    this.update();
  }
  getMode() {
    return this.mode >= ReverbTunings.FreezeMode ? 1 : 0;
  }
  setMode(value) {
    this.mode = value;
    this.update();
  }
};

// src/audio/worklets/effects-worklet.ts
var WasmAudioProcessor = class extends AudioWorkletProcessor {
  constructor() {
    super();
    __publicField(this, "reverb", new ReverbModel(sampleRate));
    this.port.onmessage = async (event) => {
      if (event.data.type === "initialize") {
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
  process(inputs, outputs, _parameters) {
    const bufferSize = 128;
    const input = inputs[0];
    const output = outputs[0];
    const inputL = input[0] || new Float32Array(bufferSize);
    const inputR = input[1] || new Float32Array(bufferSize);
    const outputL = output[0] || new Float32Array(bufferSize);
    const outputR = output[1] || new Float32Array(bufferSize);
    this.reverb.processReplace(inputL, inputR, outputL, outputR, bufferSize, 1);
    return true;
  }
};
registerProcessor("effects-audio-processor", WasmAudioProcessor);
