/**
 * Very small ProTracker/Amiga-style MOD parser used by the tracker.
 *
 * Scope:
 * - Classic 4-channel “old Amiga” modules (M.K., M!K!, M&K!, N.T., FLT4, 4CHN)
 *   and the 15-sample Soundtracker layout.
 * - Multi-channel variants up to 32 channels (`<n>CHN`, `<nn>CH`, `TDZ<n>`,
 *   plus the fixed 8-channel CD81/OKTA/OCTA tags). See `channelsForSignature`.
 * - 31-sample layout (15 for Soundtracker).
 * - 64 rows per pattern.
 *
 * Not supported: Startrekker FLT8, whose 8 channels are stored as two separate
 * 4-channel pattern blocks; `parseMod` rejects it explicitly.
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

export type ModTrackerFlavor =
  | 'ProTracker'
  | 'NoiseTracker'
  | 'Soundtracker'
  | 'UltimateSoundtracker'
  | 'Unknown';

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

/**
 * Ultimate Soundtracker -- Karsten Obarski's original, 1987 -- differs from
 * every later tracker in two ways that matter, and says so nowhere in the
 * file. It has no signature to check (that is the 15-sample layout it shares
 * with the other early Soundtrackers), so both have to be inferred from the
 * data itself.
 *
 *  1. Arpeggio is command 1. ProTracker moved it to 0 and gave 1 to
 *     portamento up, so a UST module read as ProTracker slides the pitch away
 *     on every row that meant to play a chord.
 *  2. Sample loop start is a byte offset, not a word offset. Doubling it
 *     sends the loop past the end of the sample.
 *
 * These are detected separately because a given module only carries evidence
 * for the ones it uses: a module with no looped samples cannot show the second
 * and one with no effects cannot show the first. Either is taken as proof of
 * the format, and both behaviours then apply -- harmlessly, where there is
 * nothing to apply them to.
 */

/**
 * True when a sample's loop only makes sense read as bytes.
 *
 * Word offsets are the later convention, so a loop that runs past the end of
 * its sample when doubled but fits exactly when not is the file telling us
 * which units it was written in.
 */
function loopOffsetsLookLikeBytes(
  samples: Array<{ length: number; loopStart: number; loopLength: number }>,
): boolean {
  return samples.some((sample) => {
    // loopStart is held in bytes here, already doubled from the raw words.
    const asWords = sample.loopStart;
    const asBytes = sample.loopStart / 2;
    if (sample.length === 0 || sample.loopLength <= 2) return false;
    return (
      asWords + sample.loopLength > sample.length &&
      asBytes + sample.loopLength <= sample.length
    );
  });
}

/**
 * True when the module puts arpeggio on command 1 rather than command 0.
 *
 * Both trackers write arpeggio as a pair of semitone offsets, so the
 * parameters look alike; what separates them is which command carries them.
 * Requiring command 0 to be entirely unused is what keeps a later Soundtracker
 * module -- which uses 0 for arpeggio and may use 1 for portamento -- from
 * being mistaken for this one.
 */
function usesUltimateSoundtrackerCommands(patterns: ModPattern[]): boolean {
  let sawCommandOne = false;
  for (const pattern of patterns) {
    for (const row of pattern.rows) {
      for (const cell of row) {
        if (cell.effectParam === 0) continue;
        if (cell.effectCmd === 0) return false;
        if (cell.effectCmd === 1) sawCommandOne = true;
      }
    }
  }
  return sawCommandOne;
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

/** Fixed 8-channel signatures (Oktalyzer / Atari Falcon variants). */
const SIGNATURES_8CH = new Set<string>(['CD81', 'OKTA', 'OCTA']);

export const MAX_MOD_CHANNELS = 32;

/**
 * Channel count implied by a 4-byte signature, or undefined if unrecognised.
 *
 * Beyond the classic 4-channel tags, the multi-channel conventions are:
 *   `<n>CHN`  single digit, 1-9 channels (6CHN, 8CHN)
 *   `<nn>CH`  two digits, 10-32 channels (16CH, 32CH)
 *   `TDZ<n>`  TakeTracker, 1-3 channels
 * plus the fixed 8-channel tags above.
 *
 * FLT8 is deliberately absent -- see `parseMod`.
 */
export function channelsForSignature(signature: string): number | undefined {
  if (VALID_SIGNATURES_4CH.has(signature)) return 4;
  if (SIGNATURES_8CH.has(signature)) return 8;

  // <n>CHN
  const chn = /^(\d)CHN$/.exec(signature);
  if (chn) {
    const n = Number(chn[1]);
    return n >= 1 ? n : undefined;
  }

  // <nn>CH — also seen as <nn>CN in the wild.
  const ch = /^(\d{2})C[HN]$/.exec(signature);
  if (ch) {
    const n = Number(ch[1]);
    return n >= 1 && n <= MAX_MOD_CHANNELS ? n : undefined;
  }

  // TDZ<n> (TakeTracker, 1-3 channels)
  const tdz = /^TDZ(\d)$/.exec(signature);
  if (tdz) {
    const n = Number(tdz[1]);
    return n >= 1 && n <= 3 ? n : undefined;
  }

  return undefined;
}

function readSignature(buffer: Uint8Array): string {
  return String.fromCharCode(
    buffer[1080] ?? 0,
    buffer[1081] ?? 0,
    buffer[1082] ?? 0,
    buffer[1083] ?? 0,
  );
}

function looksLikeProTrackerMod(buffer: Uint8Array): boolean {
  if (buffer.byteLength < PT_HEADER_SIZE) return false;
  const sig = readSignature(buffer);
  // FLT8 is a recognised signature we cannot yet decode (see parseMod), but
  // reporting it as "not a MOD" would be misleading -- accept it here so the
  // caller reaches parseMod's explicit error instead of a generic one.
  if (sig === 'FLT8') return true;
  return channelsForSignature(sig) !== undefined;
}

function looksLikeSoundtrackerMod(buffer: Uint8Array): boolean {
  if (buffer.byteLength < ST_HEADER_SIZE) return false;

  // Original Soundtracker/NoiseTracker modules have no ProTracker signature at 1080.
  const sig = readSignature(buffer);
  if (sig === 'FLT8' || channelsForSignature(sig) !== undefined) return false;

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
  const signature = readSignature(buffer);

  // Startrekker FLT8 stores an 8-channel pattern as two consecutive 4-channel
  // blocks, and its order table indexes those blocks rather than patterns.
  // Decoding it as a flat 8-channel pattern would silently interleave the
  // wrong data, so refuse it outright rather than play something wrong.
  if (signature === 'FLT8') {
    throw new Error(
      'Startrekker FLT8 modules are not supported yet (split 4+4 channel pattern layout)',
    );
  }

  const signatureChannels = channelsForSignature(signature);
  const isProTracker = signatureChannels !== undefined;
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

  // Channel count comes from the signature; Soundtracker is always 4 channels.
  const numChannels = signatureChannels ?? 4;

  if (numChannels < 1 || numChannels > MAX_MOD_CHANNELS) {
    throw new Error(
      `Unsupported MOD channel count ${numChannels} (signature "${signature}")`,
    );
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

  // Ultimate Soundtracker can only be recognised now: one of its two tells is
  // in the pattern data. Both behaviours follow from either tell (see above).
  if (
    !isProTracker &&
    (loopOffsetsLookLikeBytes(samples) ||
      usesUltimateSoundtrackerCommands(patterns))
  ) {
    trackerFlavor = 'UltimateSoundtracker';
    for (const sample of samples) {
      // Undo the word doubling applied when the header was read.
      sample.loopStart = Math.floor(sample.loopStart / 2);
    }
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
