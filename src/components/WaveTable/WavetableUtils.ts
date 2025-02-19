interface Harmonic {
    amplitude: number;
    phase: number;
}

interface WaveWarpParams {
    xAmount: number;
    yAmount: number;
    asymmetric: boolean;
}

interface Keyframe {
    time: number;
    harmonics: Harmonic[];
}

interface WaveWarpKeyframe {
    time: number;
    params: WaveWarpParams;
}

interface KeyframeIndices {
    currentIndex: number;
    morphAmount: number;
}

interface Wavetable {
    real: Float64Array[];
    imag: Float64Array[];
    numWaveforms: number;
    fftSize: number;
}

const findKeyframeIndices = (
    position: number,
    keyframes: (Keyframe | WaveWarpKeyframe)[]
): KeyframeIndices => {
    if (keyframes.length === 0) {
        throw new Error('Keyframes array cannot be empty');
    }

    let currentIndex = 0;

    // Find the last keyframe that starts before or at our position
    while (
        currentIndex < keyframes.length - 1 &&
        keyframes[currentIndex + 1]!.time <= position
    ) {
        currentIndex++;
    }

    // If we're at or past the last keyframe, return last index with no morphing
    if (currentIndex >= keyframes.length - 1) {
        return { currentIndex, morphAmount: 0 };
    }

    const current = keyframes[currentIndex]!;
    const next = keyframes[currentIndex + 1]!;

    // Calculate time range between current and next keyframe
    const timeRange = next.time - current.time;

    // If keyframes are at the same time, no morphing
    if (timeRange === 0) {
        return { currentIndex, morphAmount: 0 };
    }

    // Calculate morph amount based on position within the time range
    const morphAmount = (position - current.time) / timeRange;

    return {
        currentIndex,
        morphAmount: Math.max(0, Math.min(1, morphAmount))
    };
};

const interpolateHarmonics = (
    current: Harmonic[],
    next: Harmonic[],
    amount: number
): Harmonic[] => {
    return current.map((harmonic, index) => ({
        amplitude:
            harmonic.amplitude * (1 - amount) +
            next[index]!.amplitude * amount,
        phase:
            harmonic.phase * (1 - amount) +
            next[index]!.phase * amount
    }));
};

const interpolateWarpParams = (
    current: WaveWarpParams,
    next: WaveWarpParams,
    amount: number
): WaveWarpParams => ({
    xAmount: current.xAmount * (1 - amount) + next.xAmount * amount,
    yAmount: current.yAmount * (1 - amount) + next.yAmount * amount,
    asymmetric: amount < 0.5 ? current.asymmetric : next.asymmetric
});

const generateWaveformFromHarmonics = (
    harmonics: Harmonic[],
    fftSize: number
): Float64Array => {
    const waveform = new Float64Array(fftSize);

    for (let i = 0; i < fftSize; i++) {
        let sample = 0;
        for (let h = 0; h < harmonics.length; h++) {
            const { amplitude, phase } = harmonics[h]!;
            const harmonicNumber = h + 1;
            sample += amplitude *
                Math.sin((2 * Math.PI * harmonicNumber * i) / fftSize + phase);
        }
        waveform[i] = sample;
    }

    return waveform;
};

const applyWaveWarp = (
    waveform: Float64Array,
    params: WaveWarpParams
): Float64Array => {
    if (params.xAmount === 0 && params.yAmount === 0) {
        return waveform;
    }

    const warped = new Float64Array(waveform.length);
    const N = waveform.length;

    for (let i = 0; i < N; i++) {
        const normalizedPos = (i / N) * 2 - 1;

        // Apply X warping
        let xPos = normalizedPos;
        if (params.xAmount !== 0) {
            if (params.asymmetric) {
                if (normalizedPos >= 0) {
                    xPos = Math.pow(normalizedPos, 1 + params.xAmount * 0.2);
                } else {
                    xPos = -Math.pow(-normalizedPos, 1 + params.xAmount * 0.2);
                }
            } else {
                const sign = Math.sign(normalizedPos);
                const absPos = Math.abs(normalizedPos);
                xPos = sign * Math.pow(absPos, 1 + params.xAmount * 0.2);
            }
        }

        const samplePos = (xPos + 1) * 0.5 * (N - 1);
        const index1 = Math.floor(samplePos);
        const index2 = Math.min(index1 + 1, N - 1);
        const frac = samplePos - index1;

        let sample = waveform[index1]! * (1 - frac) + waveform[index2]! * frac;

        // Apply Y warping
        if (params.yAmount !== 0) {
            if (params.asymmetric) {
                if (sample >= 0) {
                    sample = Math.pow(sample, 1 + params.yAmount * 0.2);
                } else {
                    sample = -Math.pow(-sample, 1 + params.yAmount * 0.2);
                }
            } else {
                const sign = Math.sign(sample);
                const absSample = Math.abs(sample);
                sample = sign * Math.pow(absSample, 1 + params.yAmount * 0.2);
            }
        }

        warped[i] = sample;
    }

    return warped;
};

const computeFFT = (timeDomain: Float64Array): {
    real: Float64Array;
    imag: Float64Array;
} => {
    const N = timeDomain.length;
    const numFreqs = Math.floor(N / 2) + 1;
    const realArray = new Float64Array(numFreqs);
    const imagArray = new Float64Array(numFreqs);

    for (let k = 0; k < numFreqs; k++) {
        let realSum = 0;
        let imagSum = 0;

        for (let n = 0; n < N; n++) {
            const angle = (2 * Math.PI * k * n) / N;
            realSum += timeDomain[n]! * Math.cos(angle);
            imagSum -= timeDomain[n]! * Math.sin(angle);
        }

        realArray[k] = realSum / N;
        imagArray[k] = imagSum / N;
    }

    return { real: realArray, imag: imagArray };
};

const generateWaveformAtPosition = (
    position: number,
    keyframes: Keyframe[],
    waveWarpKeyframes: WaveWarpKeyframe[],
    fftSize: number
): { real: Float64Array; imag: Float64Array } => {
    if (!keyframes.length || !waveWarpKeyframes.length) {
        throw new Error('Keyframes arrays cannot be empty');
    }

    // Find current keyframe indices and morph amounts
    const { currentIndex: harmonicIndex, morphAmount: harmonicMorph } =
        findKeyframeIndices(position, keyframes);
    const { currentIndex: warpIndex, morphAmount: warpMorph } =
        findKeyframeIndices(position, waveWarpKeyframes);

    // Get interpolated harmonics
    const currentHarmonics = keyframes[harmonicIndex]!.harmonics;
    const interpolatedHarmonics = harmonicIndex < keyframes.length - 1
        ? interpolateHarmonics(
            currentHarmonics,
            keyframes[harmonicIndex + 1]!.harmonics,
            harmonicMorph
        )
        : currentHarmonics;

    // Get interpolated warp parameters
    const currentWarp = waveWarpKeyframes[warpIndex]!.params;
    const interpolatedWarp = warpIndex < waveWarpKeyframes.length - 1
        ? interpolateWarpParams(
            currentWarp,
            waveWarpKeyframes[warpIndex + 1]!.params,
            warpMorph
        )
        : currentWarp;

    // Generate time-domain waveform
    const timeDomain = generateWaveformFromHarmonics(interpolatedHarmonics, fftSize);

    // Apply wave warping
    const warpedWaveform = applyWaveWarp(timeDomain, interpolatedWarp);

    // Convert to frequency domain
    return computeFFT(warpedWaveform);
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

    // const numFreqs = Math.floor(fftSize / 2) + 1;
    const realArrays: Float64Array[] = new Array(numWaveforms);
    const imagArrays: Float64Array[] = new Array(numWaveforms);

    // Generate each waveform in the wavetable
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

    return {
        real: realArrays,
        imag: imagArrays,
        numWaveforms,
        fftSize
    };
};

interface WavetableWav {
    samples: Float32Array[];
    numWaveforms: number;
    sampleLength: number;
}

const generateWavetableWav = (
    keyframes: Keyframe[],
    waveWarpKeyframes: WaveWarpKeyframe[],
    numWaveforms = 256,
    sampleLength = 2048,
    onProgress?: (progress: number) => void
): WavetableWav => {
    // ... existing validation code ...

    const samplesArray: Float32Array[] = new Array(numWaveforms);

    for (let i = 0; i < numWaveforms; i++) {
        const position = (i / (numWaveforms - 1)) * 100;
        samplesArray[i] = generateWaveformAtPositionForWav(
            position,
            keyframes,
            waveWarpKeyframes,
            sampleLength
        );

        if (onProgress) {
            onProgress(i / numWaveforms);
        }
    }

    return {
        samples: samplesArray,
        numWaveforms,
        sampleLength
    };
};

const generateWaveformAtPositionForWav = (
    position: number,
    keyframes: Keyframe[],
    waveWarpKeyframes: WaveWarpKeyframe[],
    sampleLength: number
): Float32Array => {
    if (!keyframes.length || !waveWarpKeyframes.length) {
        throw new Error('Keyframes arrays cannot be empty');
    }

    // Find current keyframe indices and morph amounts
    const { currentIndex: harmonicIndex, morphAmount: harmonicMorph } =
        findKeyframeIndices(position, keyframes);
    const { currentIndex: warpIndex, morphAmount: warpMorph } =
        findKeyframeIndices(position, waveWarpKeyframes);

    // Get interpolated harmonics
    const currentHarmonics = keyframes[harmonicIndex]!.harmonics;
    const interpolatedHarmonics = harmonicIndex < keyframes.length - 1
        ? interpolateHarmonics(
            currentHarmonics,
            keyframes[harmonicIndex + 1]!.harmonics,
            harmonicMorph
        )
        : currentHarmonics;

    // Get interpolated warp parameters
    const currentWarp = waveWarpKeyframes[warpIndex]!.params;
    const interpolatedWarp = warpIndex < waveWarpKeyframes.length - 1
        ? interpolateWarpParams(
            currentWarp,
            waveWarpKeyframes[warpIndex + 1]!.params,
            warpMorph
        )
        : currentWarp;

    // Generate time-domain waveform
    const timeDomain = generateWaveformFromHarmonics(interpolatedHarmonics, sampleLength);

    // Apply wave warping
    return new Float32Array(applyWaveWarp(timeDomain, interpolatedWarp));
};

const encodeWavFile = (wavetable: WavetableWav): ArrayBuffer => {
    const numChannels = 1;
    const sampleRate = 44100;
    const bitsPerSample = 32;
    const bytesPerSample = bitsPerSample / 8;

    // Calculate total number of samples and file size
    const totalSamples = wavetable.numWaveforms * wavetable.sampleLength;
    const dataSize = totalSamples * bytesPerSample;
    const fileSize = 44 + dataSize; // 44 bytes for WAV header

    // Create buffer for the entire WAV file
    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);

    // Write WAV header
    // "RIFF" chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, fileSize - 8, true);
    writeString(view, 8, 'WAVE');

    // "fmt " sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Sub-chunk size (16 for PCM)
    view.setUint16(20, 3, true);  // Audio format (3 for IEEE float)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // Byte rate
    view.setUint16(32, numChannels * bytesPerSample, true); // Block align
    view.setUint16(34, bitsPerSample, true);

    // "data" sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write sample data
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

const writeString = (view: DataView, offset: number, string: string): void => {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
};

export const exportWavetableToWav = (
    keyframes: Keyframe[],
    waveWarpKeyframes: WaveWarpKeyframe[],
    numWaveforms = 256,
    sampleLength = 2048,
    onProgress?: (progress: number) => void
): Promise<ArrayBuffer> => {
    return new Promise((resolve, reject) => {
        try {
            // Generate wavetable with progress updates
            const wavetable = generateWavetableWav(
                keyframes,
                waveWarpKeyframes,
                numWaveforms,
                sampleLength,
                (genProgress) => {
                    if (onProgress) {
                        // Generation is 80% of the process, encoding is 20%
                        onProgress(genProgress * 0.8);
                    }
                }
            );

            // Encode to WAV with progress updates
            const result = encodeWavFile(wavetable);
            if (onProgress) {
                onProgress(1); // Complete
            }
            resolve(result);
        } catch (error) {
            reject(error);
        }
    });
};

// export const exportWavetableToWav = (
//     keyframes: Keyframe[],
//     waveWarpKeyframes: WaveWarpKeyframe[],
//     numWaveforms = 256,
//     sampleLength = 2048
// ): ArrayBuffer => {
//     const wavetable = generateWavetableWav(keyframes, waveWarpKeyframes, numWaveforms, sampleLength);
//     return encodeWavFile(wavetable);
// };


export type { WavetableWav };

// Export interfaces for use in other files
export type {
    Harmonic,
    WaveWarpParams,
    Keyframe,
    WaveWarpKeyframe,
    Wavetable
};