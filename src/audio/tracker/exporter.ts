type ProgressCallback = (progress: number) => void;

export interface RecordedAudio {
  interleaved: Float32Array;
  sampleRate: number;
}

function clampSampleToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

type LameEncoder = {
  encodeBuffer(left: Int16Array, right: Int16Array): Uint8Array;
  flush(): Uint8Array;
};

type LameJs = {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => LameEncoder;
};

async function loadLame(): Promise<LameJs> {
  const globalLame = (window as unknown as { lamejs?: LameJs }).lamejs;
  if (globalLame?.Mp3Encoder) return globalLame;

  const loadScript = (url: string) =>
    new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${url}`));
      document.body.appendChild(script);
    });

  const cdnUrl = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';
  const localUrl = `${import.meta.env.BASE_URL}vendor/lame.min.js`;

  try {
    await loadScript(cdnUrl);
  } catch (_) {
    await loadScript(localUrl);
  }

  const lame = (window as unknown as { lamejs?: LameJs }).lamejs;
  if (!lame?.Mp3Encoder) {
    throw new Error('MP3 encoder not available');
  }
  return lame;
}

export async function encodeRecordingToMp3(
  recording: RecordedAudio,
  onProgress?: ProgressCallback,
): Promise<Blob> {
  const lame = await loadLame();
  const encoder = new lame.Mp3Encoder(2, recording.sampleRate, 192);
  const samplesPerFrame = 1152;
  const totalSamples = Math.ceil(recording.interleaved.length / 2);
  const totalFrames = Math.ceil(totalSamples / samplesPerFrame);

  const left = new Int16Array(samplesPerFrame);
  const right = new Int16Array(samplesPerFrame);
  const mp3Chunks: Uint8Array[] = [];

  // Encode in small async batches so the UI can update progress.
  const FRAMES_PER_BATCH = 32;

  for (let frame = 0; frame < totalFrames; frame++) {
    const baseSample = frame * samplesPerFrame;
    for (let i = 0; i < samplesPerFrame; i++) {
      const idx = (baseSample + i) * 2;
      if (idx + 1 < recording.interleaved.length) {
        const sampleL = recording.interleaved[idx] ?? 0;
        const sampleR = recording.interleaved[idx + 1] ?? 0;
        left[i] = clampSampleToInt16(sampleL);
        right[i] = clampSampleToInt16(sampleR);
      } else {
        left[i] = 0;
        right[i] = 0;
      }
    }

    const chunk = encoder.encodeBuffer(left, right);
    if (chunk.length > 0) {
      mp3Chunks.push(chunk);
    }

    if (onProgress) {
      onProgress(Math.min(1, (frame + 1) / totalFrames));
    }

    if ((frame + 1) % FRAMES_PER_BATCH === 0) {
      // Yield back to the event loop so the browser can
      // paint progress updates and keep the UI responsive.
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }

  const finalChunk = encoder.flush();
  if (finalChunk.length > 0) {
    mp3Chunks.push(finalChunk);
  }

  return new Blob(mp3Chunks, { type: 'audio/mpeg' });
}
