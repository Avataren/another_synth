import { describe, it, expect } from 'vitest';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import {
  looksLikeMod,
  parseMod,
} from '../../packages/tracker-playback/src/mod-parser';
import { AudioAssetType } from 'src/audio/types/preset-types';
import fs from 'node:fs';

function createMinimalModBuffer(): Uint8Array {
  const NUM_CHANNELS = 4;
  const ROWS = 64;
  const HEADER_SIZE = 1084;
  const patternSize = ROWS * NUM_CHANNELS * 4;

  const sample1LengthWords = 4; // 8 bytes
  const sample1LengthBytes = sample1LengthWords * 2;
  const totalSize = HEADER_SIZE + patternSize + sample1LengthBytes;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Title
  writeAscii(buf, 0, 'TEST MOD', 20);

  // Sample headers (31 samples, 30 bytes each)
  let offset = 20;
  for (let i = 0; i < 31; i++) {
    const isFirst = i === 0;

    const name = isFirst ? 'SAMPLE1' : '';
    writeAscii(buf, offset, name, 22);

    const lengthWords = isFirst ? sample1LengthWords : 0;
    view.setUint16(offset + 22, lengthWords, false); // big-endian

    // Finetune and volume
    buf[offset + 24] = 0; // finetune
    buf[offset + 25] = 64; // max volume

    // Loop points (disabled by default)
    view.setUint16(offset + 26, 0, false); // loop start
    view.setUint16(offset + 28, 0, false); // loop length

    offset += 30;
  }

  // Song length and restart position
  buf[950] = 1; // song length
  buf[951] = 0; // restart (unused)

  // Pattern order table
  buf[952] = 0; // first pattern index

  // Signature "M.K."
  writeAscii(buf, 1080, 'M.K.', 4);

  // Pattern data: one pattern, 64 rows * 4 channels * 4 bytes
  const patternDataOffset = HEADER_SIZE;

  // Put a single note in row 0, channel 0 using sample 1
  {
    const row = 0;
    const ch = 0;
    const cellOffset =
      patternDataOffset + (row * NUM_CHANNELS + ch) * 4;

    const period = 0x0358; // arbitrary legal period
    const sampleNumber = 1;

    const sampleHighNibble = (sampleNumber & 0xf0);
    const sampleLowNibble = (sampleNumber & 0x0f) << 4;

    const b0High = sampleHighNibble;
    const b0Low = (period >> 8) & 0x0f;

    const b0 = b0High | b0Low;
    const b1 = period & 0xff;
    const b2 = sampleLowNibble | 0x0; // effect cmd 0
    const b3 = 0x00; // effect param

    buf[cellOffset] = b0;
    buf[cellOffset + 1] = b1;
    buf[cellOffset + 2] = b2;
    buf[cellOffset + 3] = b3;
  }

  // Sample data for sample 1: 8 bytes of silence
  const sampleDataOffset = HEADER_SIZE + patternSize;
  for (let i = 0; i < sample1LengthBytes; i++) {
    buf[sampleDataOffset + i] = 0;
  }

  return buf;
}

function writeAscii(
  buf: Uint8Array,
  offset: number,
  text: string,
  maxLen: number,
) {
  for (let i = 0; i < maxLen; i++) {
    buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
  }
}

describe('MOD import bridge', () => {
  it('builds a tracker song file from a MOD buffer', () => {
    const buf = createMinimalModBuffer();

    // Sanity: parser should see this as a valid MOD
    expect(looksLikeMod(buf)).toBe(true);
    const parsed = parseMod(buf);
    expect(parsed.samples[0]?.length).toBe(8);

    const songFile = importModToTrackerSong(buf.buffer);

    expect(songFile.version).toBe(1);
    const data = songFile.data;

    expect(data.currentSong.title).toBe('TEST MOD');
    expect(data.patternRows).toBe(64);
    expect(data.patterns.length).toBe(1);
    expect(data.sequence.length).toBeGreaterThan(0);

    // First pattern / first track should contain a note at row 0
    const firstPattern = data.patterns[0];
    expect(firstPattern).toBeDefined();
    if (!firstPattern) return;

    const firstTrack = firstPattern.tracks[0];
    expect(firstTrack).toBeDefined();
    if (!firstTrack) return;
    expect(firstTrack.entries.length).toBeGreaterThan(0);
    const firstEntry = firstTrack.entries.find((e) => e.row === 0);
    expect(firstEntry).toBeDefined();
    if (!firstEntry) return;

    expect(firstEntry.instrument).toBe('01');
    expect(firstEntry.note).toBeTypeOf('string');

    // Slot 1 should have a sampler-based patch assigned
    const slot1 = data.instrumentSlots[0];
    expect(slot1).toBeDefined();
    if (!slot1) return;
    expect(slot1.slot).toBe(1);
    expect(slot1.patchId).toBeTypeOf('string');
    expect(slot1.instrumentName).toBe('SAMPLE1');

    const patchId = slot1.patchId as string;
    const patch = data.songPatches[patchId];
    expect(patch).toBeDefined();
    if (!patch) return;

    const samplerIds = Object.keys(patch.synthState.samplers);
    expect(samplerIds.length).toBe(1);

    // There should be one sample audio asset associated with the sampler
    const assetIds = Object.keys(patch.audioAssets);
    expect(assetIds.length).toBe(1);
    const firstAssetId = assetIds[0];
    expect(firstAssetId).toBeDefined();
    if (!firstAssetId) return;
    const asset = patch.audioAssets[firstAssetId];
    expect(asset).toBeDefined();
    if (!asset) return;
    expect(asset.type).toBe(AudioAssetType.Sample);
  });

  it('imports a real MOD file without throwing', () => {
    const buf = fs.readFileSync('misc/peacedroid.mod');

    expect(looksLikeMod(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))).toBe(true);

    const song = parseMod(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    expect(song.patterns.length).toBeGreaterThan(0);
    expect(song.samples.length).toBe(31);

    const songFile = importModToTrackerSong(buf.buffer);
    const data = songFile.data;

    expect(data.patterns.length).toBeGreaterThan(0);
    const usedSlots = data.instrumentSlots.filter((s) => s.patchId);
    expect(usedSlots.length).toBeGreaterThan(0);

    const firstSlot = usedSlots[0];
    expect(firstSlot).toBeDefined();
    if (!firstSlot) return;

    const patch = data.songPatches[firstSlot.patchId as string];
    expect(patch).toBeDefined();
    if (!patch) return;

    const samplerIds = Object.keys(patch.synthState.samplers);
    expect(samplerIds.length).toBe(1);
  });
});
