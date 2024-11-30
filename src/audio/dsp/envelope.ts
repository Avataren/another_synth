export interface EnvelopeMessage {
    type: 'updateEnvelope';
    id: number;  // Envelope identifier
    config: {
        attack: number;
        decay: number;
        sustain: number;
        release: number;
        attackCurve: number;
        decayCurve: number;
        releaseCurve: number;
    }
}

export interface EnvelopeConfig {
    attack: number;      // seconds
    decay: number;       // seconds
    sustain: number;     // 0-1
    release: number;     // seconds
    attackCurve: number; // -10 to 10: negative = logarithmic, 0 = linear, positive = exponential
    decayCurve: number;  // -10 to 10
    releaseCurve: number;// -10 to 10
}

export default class Envelope {
    private phase: 'idle' | 'attack' | 'decay' | 'sustain' | 'release' = 'idle';
    private value: number = 0;
    private releaseLevel: number = 0;
    private sampleRate: number;
    private config!: EnvelopeConfig;
    private position: number = 0;
    private lastGateValue: number = 0;

    constructor(sampleRate: number, config: EnvelopeConfig = {
        attack: 0.01,
        decay: 0.1,
        sustain: 0.5,
        release: 0.3,
        attackCurve: 0,
        decayCurve: 0,
        releaseCurve: 0
    }) {
        this.sampleRate = sampleRate;
        this.updateConfig(config);
    }

    updateConfig(config: EnvelopeConfig) {
        this.config = config;
    }

    private getCurvedValue(position: number, curve: number): number {
        if (Math.abs(curve) < 0.001) return position; // Linear when curve is close to 0

        const alpha = Math.exp(Math.abs(curve));

        if (curve > 0) {
            // Exponential curve
            return (Math.exp(position * Math.log(1 + alpha)) - 1) / alpha;
        } else {
            // Logarithmic curve
            return Math.log(1 + position * alpha) / Math.log(1 + alpha);
        }
    }

    trigger(gate: number) {
        if (gate > 0) {
            if (this.phase === 'idle' || this.phase === 'release') {
                this.reset(); // Reset the envelope state
                this.phase = 'attack';
            }
        } else {
            if (this.phase !== 'idle' && this.phase !== 'release') {
                this.phase = 'release';
                this.releaseLevel = this.value;
                this.position = 0;
            }
        }
        this.lastGateValue = gate;
    }

    process(gateValue: number): number {
        if (gateValue !== this.lastGateValue) {
            this.trigger(gateValue);
        }

        const increment = 1.0 / this.sampleRate;

        switch (this.phase) {
            case 'attack': {
                const attackTime = Math.max(this.config.attack, 0.0001);
                this.position += increment / attackTime;
                if (this.position >= 1.0) {
                    this.position = 0;
                    this.value = 1.0;
                    this.phase = 'decay';
                } else {
                    this.value = this.getCurvedValue(this.position, this.config.attackCurve);
                }
                break;
            }

            case 'decay': {
                const decayTime = Math.max(this.config.decay, 0.0001);
                this.position += increment / decayTime;
                if (this.position >= 1.0) {
                    this.position = 0;
                    this.value = this.config.sustain;
                    this.phase = 'sustain';
                } else {
                    const decayPos = this.getCurvedValue(this.position, this.config.decayCurve);
                    this.value = 1.0 - (decayPos * (1.0 - this.config.sustain));
                }
                break;
            }

            case 'sustain': {
                this.value = this.config.sustain;
                break;
            }

            case 'release': {
                const releaseTime = Math.max(this.config.release, 0.0001);
                this.position += increment / releaseTime;
                if (this.position >= 1.0) {
                    this.position = 0;
                    this.value = 0;
                    this.phase = 'idle';
                } else {
                    const releasePos = this.getCurvedValue(this.position, this.config.releaseCurve);
                    this.value = this.releaseLevel * (1.0 - releasePos);
                }
                break;
            }

            case 'idle': {
                this.value = 0;
                break;
            }
        }

        // Clamp the value to [0, 1]
        this.value = Math.max(0, Math.min(this.value, 1));

        return this.value;
    }

    isActive(): boolean {
        return this.phase !== 'idle';
    }

    reset() {
        this.phase = 'idle';
        this.value = 0;
        this.releaseLevel = 0;
        this.position = 0;
        this.lastGateValue = 0;
    }
}
