// Exported interfaces
export interface Harmonic {
    amplitude: number;
    phase: number;
}

export interface WaveWarpParams {
    xAmount: number;
    yAmount: number;
    asymmetric: boolean;
}

export interface Keyframe {
    time: number;
    harmonics: Harmonic[];
}

export interface WaveWarpKeyframe {
    time: number;
    params: WaveWarpParams;
}

export interface KeyframeIndices {
    currentIndex: number;
    morphAmount: number;
}

export interface Wavetable {
    real: Float64Array[];
    imag: Float64Array[];
    numWaveforms: number;
    fftSize: number;
}

export interface WavetableWav {
    samples: Float32Array[];
    numWaveforms: number;
    sampleLength: number;
}

// Find keyframe indices and calculate morph amount.
export const findKeyframeIndices = (
    position: number,
    keyframes: (Keyframe | WaveWarpKeyframe)[]
): KeyframeIndices => {
    if (keyframes.length === 0) {
        throw new Error('Keyframes array cannot be empty');
    }
    let currentIndex = 0;
    while (
        currentIndex < keyframes.length - 1 &&
        keyframes[currentIndex + 1]!.time <= position
    ) {
        currentIndex++;
    }
    if (currentIndex >= keyframes.length - 1) {
        return { currentIndex, morphAmount: 0 };
    }
    const current = keyframes[currentIndex]!;
    const next = keyframes[currentIndex + 1]!;
    const timeRange = next.time - current.time;
    if (timeRange === 0) return { currentIndex, morphAmount: 0 };

    const morphAmount = (position - current.time) / timeRange;
    return {
        currentIndex,
        morphAmount: Math.max(0, Math.min(1, morphAmount))
    };
};

export const interpolateHarmonics = (
    current: Harmonic[],
    next: Harmonic[],
    amount: number
): Harmonic[] =>
    current.map((h, i) => ({
        amplitude: h.amplitude * (1 - amount) + next[i]!.amplitude * amount,
        phase: h.phase * (1 - amount) + next[i]!.phase * amount
    }));

export const interpolateWarpParams = (
    current: WaveWarpParams,
    next: WaveWarpParams,
    amount: number
): WaveWarpParams => ({
    xAmount: current.xAmount * (1 - amount) + next.xAmount * amount,
    yAmount: current.yAmount * (1 - amount) + next.yAmount * amount,
    asymmetric: amount < 0.5 ? current.asymmetric : next.asymmetric
});

export const generateWaveformFromHarmonics = (
    harmonics: Harmonic[],
    size: number
): Float64Array => {
    const waveform = new Float64Array(size);
    const twoPi = 2 * Math.PI;
    for (let i = 0; i < size; i++) {
        let sample = 0;
        for (let h = 0; h < harmonics.length; h++) {
            const { amplitude, phase } = harmonics[h]!;
            sample += amplitude * Math.sin((twoPi * (h + 1) * i) / size + phase);
        }
        waveform[i] = sample;
    }
    return waveform;
};

export const applyWaveWarp = (
    waveform: Float64Array,
    params: WaveWarpParams
): Float64Array => {
    if (params.xAmount === 0 && params.yAmount === 0) return waveform;
    const warped = new Float64Array(waveform.length);
    const N = waveform.length;
    const xExp = 1 + params.xAmount * 0.2;
    const yExp = 1 + params.yAmount * 0.2;
    for (let i = 0; i < N; i++) {
        const normalizedPos = (i / N) * 2 - 1;
        let xPos = normalizedPos;
        if (params.xAmount !== 0) {
            xPos =
                params.asymmetric
                    ? normalizedPos >= 0
                        ? Math.pow(normalizedPos, xExp)
                        : -Math.pow(-normalizedPos, xExp)
                    : Math.sign(normalizedPos) *
                    Math.pow(Math.abs(normalizedPos), xExp);
        }
        const samplePos = (xPos + 1) * 0.5 * (N - 1);
        const index1 = Math.floor(samplePos);
        const index2 = Math.min(index1 + 1, N - 1);
        const frac = samplePos - index1;
        let sample =
            waveform[index1]! * (1 - frac) +
            waveform[index2]! * frac;
        if (params.yAmount !== 0) {
            sample =
                params.asymmetric
                    ? sample >= 0
                        ? Math.pow(sample, yExp)
                        : -Math.pow(-sample, yExp)
                    : Math.sign(sample) * Math.pow(Math.abs(sample), yExp);
        }
        warped[i] = sample;
    }
    return warped;
};

export const computeFFT = (
    timeDomain: Float64Array
): { real: Float64Array; imag: Float64Array } => {
    const N = timeDomain.length;
    const numFreqs = Math.floor(N / 2) + 1;
    const realArray = new Float64Array(numFreqs);
    const imagArray = new Float64Array(numFreqs);
    const twoPiOverN = (2 * Math.PI) / N;
    for (let k = 0; k < numFreqs; k++) {
        let realSum = 0,
            imagSum = 0;
        for (let n = 0; n < N; n++) {
            const angle = twoPiOverN * k * n;
            realSum += timeDomain[n]! * Math.cos(angle);
            imagSum -= timeDomain[n]! * Math.sin(angle);
        }
        realArray[k] = realSum / N;
        imagArray[k] = imagSum / N;
    }
    return { real: realArray, imag: imagArray };
};

// Internal helper: generate a warped waveform.
// Not exported because it’s only used internally.
const generateWarpedWaveform = (
    position: number,
    keyframes: Keyframe[],
    waveWarpKeyframes: WaveWarpKeyframe[],
    length: number
): Float64Array => {
    const { currentIndex: harmonicIndex, morphAmount: harmonicMorph } =
        findKeyframeIndices(position, keyframes);
    const { currentIndex: warpIndex, morphAmount: warpMorph } =
        findKeyframeIndices(position, waveWarpKeyframes);

    const currentHarmonics = keyframes[harmonicIndex]!.harmonics;
    const harmonics =
        harmonicIndex < keyframes.length - 1
            ? interpolateHarmonics(
                currentHarmonics,
                keyframes[harmonicIndex + 1]!.harmonics,
                harmonicMorph
            )
            : currentHarmonics;

    const currentWarp = waveWarpKeyframes[warpIndex]!.params;
    const warpParams =
        warpIndex < waveWarpKeyframes.length - 1
            ? interpolateWarpParams(
                currentWarp,
                waveWarpKeyframes[warpIndex + 1]!.params,
                warpMorph
            )
            : currentWarp;

    const timeDomain = generateWaveformFromHarmonics(harmonics, length);
    return applyWaveWarp(timeDomain, warpParams);
};

export const generateWaveformAtPosition = (
    position: number,
    keyframes: Keyframe[],
    waveWarpKeyframes: WaveWarpKeyframe[],
    fftSize: number
): { real: Float64Array; imag: Float64Array } => {
    const warped = generateWarpedWaveform(
        position,
        keyframes,
        waveWarpKeyframes,
        fftSize
    );
    return computeFFT(warped);
};

export const generateWavetable = (
    keyframes: Keyframe[],
    waveWarpKeyframes: WaveWarpKeyframe[],
    numWaveforms = 256,
    fftSize = 1024
): Wavetable => {
    if (!keyframes.length || !waveWarpKeyframes.length) {
        throw new Error('Keyframes arrays cannot be empty');
    }
    if (numWaveforms < 1 || fftSize < 1) {
        throw new Error('numWaveforms and fftSize must be positive integers');
    }
    if (keyframes.length === 1 && waveWarpKeyframes.length === 1) {
        const singleResult = generateWaveformAtPosition(
            0,
            keyframes,
            waveWarpKeyframes,
            fftSize
        );
        const realArrays = new Array(numWaveforms).fill(singleResult.real);
        const imagArrays = new Array(numWaveforms).fill(singleResult.imag);
        return { real: realArrays, imag: imagArrays, numWaveforms, fftSize };
    }
    const realArrays: Float64Array[] = new Array(numWaveforms);
    const imagArrays: Float64Array[] = new Array(numWaveforms);
    for (let i = 0; i < numWaveforms; i++) {
        const position = (i / (numWaveforms - 1)) * 100;
        const { real, imag } = generateWaveformAtPosition(
            position,
            keyframes,
            waveWarpKeyframes,
            fftSize
        );
        realArrays[i] = real;
        imagArrays[i] = imag;
    }
    return { real: realArrays, imag: imagArrays, numWaveforms, fftSize };
};

export const processWaveform = (
    waveform: Float32Array,
    removeDC: boolean,
    normalize: boolean
): Float32Array => {
    const processed = new Float32Array(waveform);
    if (removeDC || normalize) {
        let sum = 0,
            max = 0;
        for (let i = 0; i < processed.length; i++) {
            const sample = processed[i]!;
            if (removeDC) sum += sample;
            if (normalize) {
                const absVal = Math.abs(sample);
                if (absVal > max) max = absVal;
            }
        }
        if (removeDC) {
            const mean = sum / processed.length;
            for (let i = 0; i < processed.length; i++) {
                processed[i] = processed[i]! - mean;
            }
        }
        if (normalize && max > 0) {
            for (let i = 0; i < processed.length; i++) {
                processed[i] = processed[i]! / max;
            }
        }
    }
    return processed;
};

export const generateWaveformAtPositionForWav = (
    position: number,
    keyframes: Keyframe[],
    waveWarpKeyframes: WaveWarpKeyframe[],
    sampleLength: number
): Float32Array => {
    const warped = generateWarpedWaveform(
        position,
        keyframes,
        waveWarpKeyframes,
        sampleLength
    );
    return new Float32Array(warped);
};

const generateWavetableWav = (
    keyframes: Keyframe[],
    waveWarpKeyframes: WaveWarpKeyframe[],
    numWaveforms = 256,
    sampleLength = 2048,
    removeDC: boolean,
    normalize: boolean,
    onProgress?: (progress: number) => void
): WavetableWav => {
    if (!keyframes.length || !waveWarpKeyframes.length) {
        throw new Error('Keyframes arrays cannot be empty');
    }
    if (keyframes.length === 1 && waveWarpKeyframes.length === 1) {
        let singleWaveform = generateWaveformAtPositionForWav(
            0,
            keyframes,
            waveWarpKeyframes,
            sampleLength
        );
        singleWaveform = processWaveform(singleWaveform, removeDC, normalize);
        const samplesArray = new Array(numWaveforms).fill(singleWaveform);
        onProgress && onProgress(1);
        return { samples: samplesArray, numWaveforms, sampleLength };
    }
    const samplesArray: Float32Array[] = new Array(numWaveforms);
    for (let i = 0; i < numWaveforms; i++) {
        const position = (i / (numWaveforms - 1)) * 100;
        let waveform = generateWaveformAtPositionForWav(
            position,
            keyframes,
            waveWarpKeyframes,
            sampleLength
        );
        waveform = processWaveform(waveform, removeDC, normalize);
        samplesArray[i] = waveform;
        onProgress && onProgress(i / numWaveforms);
    }
    return { samples: samplesArray, numWaveforms, sampleLength };
};

const writeString = (view: DataView, offset: number, str: string): void => {
    for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
    }
};

export const encodeWavFile = (wavetable: WavetableWav): ArrayBuffer => {
    const numChannels = 1;
    const sampleRate = 44100;
    const bitsPerSample = 32;
    const bytesPerSample = bitsPerSample / 8;
    const totalSamples = wavetable.numWaveforms * wavetable.sampleLength;
    const dataSize = totalSamples * bytesPerSample;
    const fileSize = 44 + dataSize;
    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);
    writeString(view, 0, 'RIFF');
    view.setUint32(4, fileSize - 8, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    let offset = 44;
    for (let i = 0; i < wavetable.numWaveforms; i++) {
        const waveform = wavetable.samples[i]!;
        for (let j = 0; j < wavetable.sampleLength; j++) {
            view.setFloat32(offset, waveform[j]!, true);
            offset += bytesPerSample;
        }
    }
    return buffer;
};

export const exportWavetableToWav = (
    keyframes: Keyframe[],
    waveWarpKeyframes: WaveWarpKeyframe[],
    numWaveforms = 256,
    sampleLength = 2048,
    removeDC: boolean,
    normalize: boolean,
    onProgress?: (progress: number) => void
): Promise<ArrayBuffer> => {
    return new Promise((resolve, reject) => {
        try {
            // Note: we explicitly type the parameter "genProgress" as number.
            const wavetable = generateWavetableWav(
                keyframes,
                waveWarpKeyframes,
                numWaveforms,
                sampleLength,
                removeDC,
                normalize,
                (genProgress: number) => onProgress && onProgress(genProgress * 0.8)
            );
            const result = encodeWavFile(wavetable);
            onProgress && onProgress(1);
            resolve(result);
        } catch (error) {
            reject(error);
        }
    });
};
