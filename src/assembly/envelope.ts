// envelope.ts
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
        public increment: f32 = 0
    ) { }
}

export function createEnvelopeState(
    attackTime: f32,
    decayTime: f32,
    sustainLevel: f32,
    releaseTime: f32
): usize {
    const env = new EnvelopeState(0, 0, attackTime, decayTime, sustainLevel, releaseTime, false);
    return changetype<usize>(env);
}

export function updateEnvelopeState(
    envPtr: usize,
    attackTime: f32,
    decayTime: f32,
    sustainLevel: f32,
    releaseTime: f32
): void {
    const env = changetype<EnvelopeState>(envPtr);
    env.attackTime = attackTime;
    env.decayTime = decayTime;
    env.sustainLevel = sustainLevel;
    env.releaseTime = releaseTime;
}


export function processEnvelope(
    envPtr: usize,
    sampleRate: f32,
    gateOpen: boolean
): f32 {
    const env = changetype<EnvelopeState>(envPtr);
    const gateChange = gateOpen !== env.prevGate;

    if (gateChange && gateOpen) {
        env.stage = 1;
        env.value = 0;
        env.increment = 1.0 / (env.attackTime * sampleRate);
    } else if (gateChange && !gateOpen) {
        env.stage = 4;
        env.increment = 1.0 / (env.releaseTime * sampleRate);
    }
    env.prevGate = gateOpen;

    switch (env.stage) {
        case 1:
            env.value += env.increment;
            if (env.value >= 1.0) {
                env.value = 1.0;
                env.stage = 2;
                env.increment = (1.0 - env.sustainLevel) / (env.decayTime * sampleRate);
            }
            break;

        case 2:
            env.value -= env.increment;
            if (env.value <= env.sustainLevel) {
                env.value = env.sustainLevel;
                env.stage = 3;
            }
            break;

        case 4:
            env.value -= env.value * env.increment;
            if (env.value < 0.0001) {
                env.value = 0;
                env.stage = 0;
            }
            break;
    }
    //return env.value;
    return gateOpen ? 1.0 : 0.0;
}


