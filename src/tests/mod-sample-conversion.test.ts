import { describe, it, expect } from 'vitest';
import {
  parseMod,
  type ModSample,
} from '../../packages/tracker-playback/src/mod-parser';
import { convertSampleToFloat32 } from 'src/audio/tracker/mod-import';
import {
  encodeFloat32ArrayToBase64,
  decodeAudioAssetToFloat32Array,
} from 'src/audio/serialization/audio-asset-encoder';
import { AudioAssetType } from 'src/audio/types/preset-types';
import fs from 'node:fs';

describe('MOD sample conversion', () => {
  it('converts signed 8-bit PCM to normalized Float32', () => {
    const sample: ModSample = {
      name: 'test',
      length: 5,
      finetune: 0,
      volume: 64,
      loopStart: 0,
      loopLength: 0,
      data: new Int8Array([-128, -64, 0, 64, 127]),
    };

    const floats = convertSampleToFloat32(sample);

    expect(Array.from(floats)).toEqual([
      -1,
      -0.5,
      0,
      0.5,
      127 / 128,
    ]);
  });

  it('keeps converted samples within [-1, 1] for a real MOD sample', () => {
    const buf = fs.readFileSync('misc/peacedroid.mod');
    const mod = parseMod(
      new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    );
    const sample = mod.samples.find((s) => s.length > 0) as ModSample | undefined;
    expect(sample).toBeDefined();
    if (!sample) return;

    const floats = convertSampleToFloat32(sample);
    expect(floats.length).toBe(sample.data.length);

    let min = 1;
    let max = -1;
    for (let i = 0; i < floats.length; i++) {
      const v = floats[i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }

    expect(min).toBeGreaterThanOrEqual(-1);
    expect(max).toBeLessThanOrEqual(1);
  });

  it('round-trips converted samples through WAV asset encoding/decoding', () => {
    const sample: ModSample = {
      name: 'roundtrip',
      length: 4,
      finetune: 0,
      volume: 64,
      loopStart: 0,
      loopLength: 0,
      data: new Int8Array([-128, 0, 64, 127]),
    };

    const floats = convertSampleToFloat32(sample);

    const asset = encodeFloat32ArrayToBase64(
      floats,
      44100,
      1,
      AudioAssetType.Sample,
      'test-node',
      sample.name,
      60,
    );

    const decoded = decodeAudioAssetToFloat32Array(asset);

    expect(decoded.length).toBe(floats.length);
    for (let i = 0; i < floats.length; i++) {
      const decodedVal = decoded[i] ?? 0;
      const originalVal = floats[i] ?? 0;
      // Allow tiny quantization error from 16-bit WAV encode/decode
      expect(Math.abs(decodedVal - originalVal)).toBeLessThan(1e-3);
    }
  });
});
