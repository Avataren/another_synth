export interface EnvelopeConfig {
    id: number;
    active: boolean;
    attack: number;      // seconds
    decay: number;       // seconds
    sustain: number;     // 0-1
    release: number;     // seconds
    attackCurve: number; // -10 to 10: negative = logarithmic, 0 = linear, positive = exponential
    decayCurve: number;  // -10 to 10
    releaseCurve: number;// -10 to 10
}

export interface EnvelopeMessage {
    type: 'updateEnvelope';
    id: number;  // Envelope identifier
    config: EnvelopeConfig
}