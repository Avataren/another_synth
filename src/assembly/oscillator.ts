import { TWO_PI } from './constants';

@unmanaged
export class OscillatorState {
  constructor(
    public phase: f32 = 0,
    public test: f32 = 0,
  ) {}
}

function centsToRatio(cents: f32): f32 {
  return Mathf.pow(2.0, cents / 1200.0);
}

export class Oscillator {
  processSample(
    oscState: OscillatorState,
    baseFrequency: f32,
    sampleRate: f32,
    detune: f32,
  ): f32 {
    const frequency = baseFrequency * centsToRatio(detune);
    const phaseStep: f32 = (TWO_PI * frequency) / sampleRate;
    const sample = Mathf.sin(oscState.phase);
    oscState.phase += phaseStep;
    while (oscState.phase >= TWO_PI) oscState.phase -= TWO_PI;
    return sample * oscState.test;
  }
}
