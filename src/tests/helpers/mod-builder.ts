/**
 * Builds 15-sample Soundtracker-layout MOD files for tests.
 *
 * The early Soundtracker layout is the interesting one: it carries no
 * signature, so which tracker wrote it -- and therefore what its commands and
 * sample offsets mean -- has to be inferred from the data. Constructing files
 * with specific evidence in them is the only way to test that inference.
 *
 * Layout: 20-byte title, 15 x 30-byte sample headers, song length, restart,
 * 128 order bytes, then 64-row x 4-channel patterns and sample data.
 */

export interface BuilderSample {
  name?: string;
  /** Sample length in bytes; rounded down to a whole word. */
  lengthBytes: number;
  /** Raw loop-start field, in whatever unit the file is claiming. */
  loopStartRaw: number;
  /** Loop length in bytes; rounded down to a whole word. */
  loopLengthBytes: number;
  volume?: number;
}

export interface BuilderCell {
  period?: number;
  sample?: number;
  effectCmd?: number;
  effectParam?: number;
}

export interface BuilderOptions {
  title?: string;
  samples?: BuilderSample[];
  /** Order list; defaults to a single pattern 0. */
  orders?: number[];
  /** patterns[p][row][channel] */
  patterns?: BuilderCell[][][];
  /** Byte 471. Ultimate Soundtracker stores tempo here, not a restart row. */
  restart?: number;
}

const ST_HEADER_SIZE = 600;
const ROWS = 64;
const CHANNELS = 4;

export function buildSoundtrackerMod(options: BuilderOptions = {}): Uint8Array {
  const samples = options.samples ?? [];
  const orders = options.orders ?? [0];
  const patterns = options.patterns ?? [[]];

  const sampleBytes = samples.reduce(
    (n, s) => n + Math.floor(s.lengthBytes / 2) * 2,
    0,
  );
  const patternBytes = patterns.length * ROWS * CHANNELS * 4;
  const buffer = new Uint8Array(ST_HEADER_SIZE + patternBytes + sampleBytes);
  const view = new DataView(buffer.buffer);

  const writeAscii = (text: string, offset: number, max: number) => {
    for (let i = 0; i < Math.min(text.length, max); i++) {
      buffer[offset + i] = text.charCodeAt(i) & 0x7f;
    }
  };

  writeAscii(options.title ?? 'test', 0, 20);

  for (let i = 0; i < 15; i++) {
    const sample = samples[i];
    const offset = 20 + i * 30;
    if (!sample) continue;
    writeAscii(sample.name ?? `s${i + 1}`, offset, 22);
    view.setUint16(offset + 22, Math.floor(sample.lengthBytes / 2), false);
    buffer[offset + 24] = 0; // finetune
    buffer[offset + 25] = sample.volume ?? 64;
    view.setUint16(offset + 26, sample.loopStartRaw, false);
    view.setUint16(offset + 28, Math.floor(sample.loopLengthBytes / 2), false);
  }

  buffer[470] = orders.length;
  buffer[471] = options.restart ?? 120;
  for (let i = 0; i < orders.length; i++) buffer[472 + i] = orders[i]!;

  let offset = ST_HEADER_SIZE;
  for (const pattern of patterns) {
    for (let row = 0; row < ROWS; row++) {
      for (let ch = 0; ch < CHANNELS; ch++) {
        const cell = pattern[row]?.[ch];
        const period = cell?.period ?? 0;
        const sample = cell?.sample ?? 0;
        const cmd = cell?.effectCmd ?? 0;
        const param = cell?.effectParam ?? 0;

        buffer[offset] = (sample & 0xf0) | ((period >> 8) & 0x0f);
        buffer[offset + 1] = period & 0xff;
        buffer[offset + 2] = ((sample & 0x0f) << 4) | (cmd & 0x0f);
        buffer[offset + 3] = param;
        offset += 4;
      }
    }
  }

  return buffer;
}

/** One cell on channel 0 of row `row`, the rest empty. */
export function cellAt(row: number, cell: BuilderCell): BuilderCell[][] {
  const rows: BuilderCell[][] = [];
  for (let r = 0; r < ROWS; r++) rows.push([{}, {}, {}, {}]);
  rows[row] = [cell, {}, {}, {}];
  return rows;
}
