@unmanaged
export class EnvelopeState {
  constructor(
    public stage: i32 = 0, // 0:idle, 1:attack, 2:decay, 3:sustain, 4:release
    public value: f32 = 0,
    public attackTime: f32 = 0.1,
    public decayTime: f32 = 0.1,
    public sustainLevel: f32 = 0.7,
    public releaseTime: f32 = 0.2,
    public prevGate: boolean = false,
    public increment: f32 = 0,
    public releaseStartValue: f32 = 0, // Add this to store value when release starts
  ) {}
}

export function createEnvelopeState(
  attackTime: f32,
  decayTime: f32,
  sustainLevel: f32,
  releaseTime: f32,
): usize {
  const env = new EnvelopeState(
    0, // stage
    0, // value
    attackTime,
    decayTime,
    sustainLevel,
    releaseTime,
    false, // prevGate
    0, // increment
    0, // releaseStartValue
  );
  return changetype<usize>(env);
}

export function processEnvelope(
  envPtr: usize,
  sampleRate: f32,
  gateOpen: boolean,
): f32 {
  const env = changetype<EnvelopeState>(envPtr);
  const gateChange = gateOpen !== env.prevGate;

  if (gateChange && gateOpen) {
    // Note on - start attack
    env.stage = 1;
    env.value = 0;
    env.increment = 1.0 / (env.attackTime * sampleRate);
  } else if (gateChange && !gateOpen) {
    // Note off - start release
    env.stage = 4;
    env.releaseStartValue = env.value; // Store current value for release
    env.increment = 1.0 / (env.releaseTime * sampleRate);
  }
  env.prevGate = gateOpen;

  switch (env.stage) {
    case 1: // Attack
      env.value += env.increment;
      if (env.value >= 1.0) {
        env.value = 1.0;
        env.stage = 2; // Go to decay
        env.increment = (1.0 - env.sustainLevel) / (env.decayTime * sampleRate);
      }
      break;

    case 2: // Decay
      env.value -= env.increment;
      if (env.value <= env.sustainLevel) {
        env.value = env.sustainLevel;
        env.stage = 3; // Go to sustain
      }
      break;

    case 3: // Sustain
      env.value = env.sustainLevel;
      break;

    case 4: // Release
      // Linear release for predictable decay to zero
      env.value -= env.releaseStartValue * env.increment;
      if (env.value < 0.0001) {
        env.value = 0;
        env.stage = 0; // Back to idle
      }
      break;
  }

  // Ensure value stays in valid range
  return Mathf.max(0.0, Mathf.min(1.0, env.value));
}
