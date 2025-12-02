/**
 * Very small ProTracker/Amiga-style MOD parser used by the tracker.
 *
 * Scope (v1):
 * - 4-channel “old Amiga” modules with signatures like M.K., M!K!, M&K!, N.T., FLT4, 4CHN.
 * - 31-sample layout.
 * - 64 rows per pattern.
 *
 * The parser stays deliberately dumb and only exposes enough structure for
 * the tracker bridge to build patterns + sampler instruments.
 */

export interface ModSample {
  name: string;
  /** Length in frames (8-bit mono samples) */
  length: number;
  /** Finetune in semitone steps (-8..7) */
  finetune: number;
  /** Default volume 0..64 */
  volume: number;
  /** Loop start in frames */
  loopStart: number;
  /** Loop length in frames */
  loopLength: number;
  /** Raw 8-bit signed PCM data */
  data: Int8Array;
}

export interface ModPatternCell {
  period: number;
  sampleNumber: number;
  effectCmd: number;
  effectParam: number;
}

export interface ModPattern {
  /** rows[row][channel] */
  rows: ModPatternCell[][];
}

export type ModTrackerFlavor = 'ProTracker' | 'NoiseTracker' | 'Soundtracker' | 'Unknown';

export interface ModSong {
  title: string;
  numChannels: number;
  /** Order list length (song length) */
  songLength: number;
  /** Pattern order table (pattern indices) */
  orders: number[];
  /** Patterns indexed by pattern number */
  patterns: ModPattern[];
  samples: ModSample[];
  /** Raw 4-byte signature at offset 1080 (e.g. M.K., N.T., FLT4), or empty string */
  signature: string;
  /** Heuristic tracker flavor derived from layout/signature */
  trackerFlavor: ModTrackerFlavor;
}

const PT_HEADER_SIZE = 1084;
const PT_NUM_SAMPLES = 31;
const ST_HEADER_SIZE = 600;
const ST_NUM_SAMPLES = 15;
const PATTERN_ROWS = 64;

const VALID_SIGNATURES_4CH = new Set<string>([
  'M.K.',
  'M!K!',
  'M&K!',
  'N.T.',
  'FLT4',
  '4CHN',
]);

function looksLikeProTrackerMod(buffer: Uint8Array): boolean {
  if (buffer.byteLength < PT_HEADER_SIZE) return false;
  const sig = String.fromCharCode(
    buffer[1080] ?? 0,
    buffer[1081] ?? 0,
    buffer[1082] ?? 0,
    buffer[1083] ?? 0,
  );
  return VALID_SIGNATURES_4CH.has(sig);
}

function looksLikeSoundtrackerMod(buffer: Uint8Array): boolean {
  if (buffer.byteLength < ST_HEADER_SIZE) return false;

  // Original Soundtracker/NoiseTracker modules have no ProTracker signature at 1080.
  const sig = String.fromCharCode(
    buffer[1080] ?? 0,
    buffer[1081] ?? 0,
    buffer[1082] ?? 0,
    buffer[1083] ?? 0,
  );
  if (VALID_SIGNATURES_4CH.has(sig)) return false;

  // Basic plausibility checks based on the classic 15-sample layout.
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  // Song length at offset 470 should be 1..128.
  const songLength = buffer[470] ?? 0;
  if (songLength < 1 || songLength > 128) return false;

  // Pattern order table at 472..599, values typically 0..63.
  let maxPatternIndex = 0;
  for (let i = 0; i < 128; i++) {
    const pat = buffer[472 + i] ?? 0;
    if (pat > 63) return false;
    if (pat > maxPatternIndex) maxPatternIndex = pat;
  }

  const numPatterns = maxPatternIndex + 1;
  const patternSize = PATTERN_ROWS * 4 * 4; // rows * channels * 4 bytes
  const patternDataOffset = ST_HEADER_SIZE;
  const sampleDataOffset = patternDataOffset + numPatterns * patternSize;
  if (sampleDataOffset > buffer.byteLength) return false;

  // Sample headers: 15 samples at 20..(20+15*30)
  let headerOffset = 20;
  let totalSampleBytes = 0;
  for (let i = 0; i < ST_NUM_SAMPLES; i++) {
    const lengthWords = view.getUint16(headerOffset + 22, false);
    const lengthBytes = lengthWords * 2;
    totalSampleBytes += lengthBytes;
    headerOffset += 30;
  }

  // Rough check: sample region should fit in file.
  if (sampleDataOffset + totalSampleBytes > buffer.byteLength) return false;

  return true;
}

/**
 * Heuristic check for a 4-channel ProTracker or classic Soundtracker MOD file.
 */
export function looksLikeMod(buffer: Uint8Array): boolean {
  return looksLikeProTrackerMod(buffer) || looksLikeSoundtrackerMod(buffer);
}

export function parseMod(buffer: Uint8Array): ModSong {
  if (!looksLikeMod(buffer)) {
    throw new Error('Unsupported or invalid MOD file');
  }

  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  // Title (0..19)
  const title = readAscii(buffer, 0, 20).trimEnd();

  // Determine layout: ProTracker (31 samples, header at 1084) or Soundtracker (15 samples, header at 600)
  const signature = String.fromCharCode(
    buffer[1080] ?? 0,
    buffer[1081] ?? 0,
    buffer[1082] ?? 0,
    buffer[1083] ?? 0,
  );

  const isProTracker = VALID_SIGNATURES_4CH.has(signature);
  const numSamples = isProTracker ? PT_NUM_SAMPLES : ST_NUM_SAMPLES;
  const headerSize = isProTracker ? PT_HEADER_SIZE : ST_HEADER_SIZE;
  const songLengthOffset = isProTracker ? 950 : 470;
  const ordersOffset = isProTracker ? 952 : 472;

  // Sample headers
  const samples: Omit<ModSample, 'data'>[] = [];
  let headerOffset = 20;

  for (let i = 0; i < numSamples; i++) {
    const name = readAscii(buffer, headerOffset, 22).trimEnd();

    const lengthWords = view.getUint16(headerOffset + 22, false); // big-endian
    const lengthBytes = lengthWords * 2;

    const finetuneByte = (buffer[headerOffset + 24] ?? 0) & 0x0f;
    const finetune = finetuneByte < 8 ? finetuneByte : finetuneByte - 16;

    const volume = buffer[headerOffset + 25] ?? 0;

    const loopStartWords = view.getUint16(headerOffset + 26, false);
    const loopLengthWords = view.getUint16(headerOffset + 28, false);
    const loopStartBytes = loopStartWords * 2;
    const loopLengthBytes = loopLengthWords * 2;

    samples.push({
      name,
      length: lengthBytes,
      finetune,
      volume,
      loopStart: loopStartBytes,
      loopLength: loopLengthBytes,
    });

    headerOffset += 30;
  }

  // Song length + order table
  const songLength = buffer[songLengthOffset] ?? 1;
  const orders: number[] = [];
  let maxPatternIndex = 0;
  for (let i = 0; i < 128; i++) {
    const pat = buffer[ordersOffset + i] ?? 0;
    orders.push(pat);
    if (pat > maxPatternIndex) maxPatternIndex = pat;
  }
  const numPatterns = maxPatternIndex + 1;

  // Determine channel count from signature (ProTracker variants); Soundtracker is always 4 channels.
  let numChannels = 4;
  if (signature === '6CHN') numChannels = 6;
  else if (signature === '8CHN') numChannels = 8;

  if (numChannels !== 4) {
    throw new Error(`Only 4-channel MODs are supported (got ${numChannels})`);
  }

  // Heuristic tracker flavor for import-time behavior.
  let trackerFlavor: ModTrackerFlavor = 'Unknown';
  if (!isProTracker) {
    trackerFlavor = 'Soundtracker';
  } else if (signature === 'N.T.') {
    trackerFlavor = 'NoiseTracker';
  } else {
    // Treat known ProTracker-style signatures (M.K., FLT4, 4CHN, etc.) as ProTracker family.
    trackerFlavor = 'ProTracker';
  }

  // Pattern data
  const patternSize = PATTERN_ROWS * numChannels * 4;
  const patterns: ModPattern[] = [];
  let patternDataOffset = headerSize;

  for (let p = 0; p < numPatterns; p++) {
    const rows: ModPatternCell[][] = [];
    for (let row = 0; row < PATTERN_ROWS; row++) {
      const rowCells: ModPatternCell[] = [];
      for (let ch = 0; ch < numChannels; ch++) {
        const idx =
          patternDataOffset + (row * numChannels + ch) * 4;
        if (idx + 4 > buffer.byteLength) {
          rowCells.push({
            period: 0,
            sampleNumber: 0,
            effectCmd: 0,
            effectParam: 0,
          });
          continue;
        }

        const b0 = buffer[idx] ?? 0;
        const b1 = buffer[idx + 1] ?? 0;
        const b2 = buffer[idx + 2] ?? 0;
        const b3 = buffer[idx + 3] ?? 0;

        // Sample number is stored as:
        // - High nibble in b0 (bits 4-7)
        // - Low nibble in b2 (bits 4-7)
        const sampleNumber =
          (b0 & 0xf0) | ((b2 & 0xf0) >> 4);
        const period = ((b0 & 0x0f) << 8) | b1;
        const effectCmd = b2 & 0x0f;
        const effectParam = b3;

        rowCells.push({
          period,
          sampleNumber,
          effectCmd,
          effectParam,
        });
      }
      rows.push(rowCells);
    }

    patterns.push({ rows });
    patternDataOffset += patternSize;
  }

  // Sample data region
  let sampleDataOffset = patternDataOffset;
  const samplesWithData: ModSample[] = samples.map((meta) => {
    const length = meta.length;
    let data: Int8Array;

    if (
      length > 0 &&
      sampleDataOffset + length <= buffer.byteLength
    ) {
      data = new Int8Array(
        buffer.buffer,
        buffer.byteOffset + sampleDataOffset,
        length,
      );
    } else {
      data = new Int8Array(0);
    }

    sampleDataOffset += length;

    return {
      ...meta,
      data,
    };
  });

  return {
    title,
    numChannels,
    songLength,
    orders,
    patterns,
    samples: samplesWithData,
    signature,
    trackerFlavor,
  };
}

function readAscii(buffer: Uint8Array, offset: number, length: number): string {
  let result = '';
  const end = offset + length;
  for (let i = offset; i < end && i < buffer.length; i++) {
    const code = buffer[i] ?? 0;
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}
