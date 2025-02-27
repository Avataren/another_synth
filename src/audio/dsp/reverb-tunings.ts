// ReverbTunings.ts

export class ReverbTunings {
    // Original sample rate used in the tunings (44.1 kHz)
    static readonly originalSampleRate = 44100;

    // Original delay lengths in samples
    static readonly CombDelayLengths = [
        1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617, 1693, 1781, 1867, 1961,
    ];

    static readonly AllpassDelayLengths = [556, 441, 341, 225];

    // Stereo spread in samples at original sample rate
    static readonly StereoSpread = 23;

    // Reverb parameters
    static readonly NumCombs = 12;
    static readonly NumAllpasses = 4;
    static readonly Muted = 0;
    static readonly FixedGain = 0.015;
    static readonly ScaleWet = 0.25;
    static readonly ScaleDry = 1;
    static readonly ScaleDamp = 0.5;
    static readonly ScaleRoom = 0.3;
    static readonly OffsetRoom = 0.7;
    static readonly InitialRoom = 0.6;
    static readonly InitialDamp = 0.5;
    static readonly InitialWet = 0.3;
    static readonly InitialDry = 0.8;
    static readonly InitialWidth = 1;
    static readonly InitialMode = 0;
    static readonly FreezeMode = 0.5;

    // Precompute delay times in seconds based on original sample rate
    static readonly CombDelayTimes = ReverbTunings.CombDelayLengths.map(
        (samples) => samples / ReverbTunings.originalSampleRate
    );

    static readonly AllpassDelayTimes = ReverbTunings.AllpassDelayLengths.map(
        (samples) => samples / ReverbTunings.originalSampleRate
    );

    static readonly StereoSpreadTime =
        ReverbTunings.StereoSpread / ReverbTunings.originalSampleRate;
}
