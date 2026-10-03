/**
 * ProTracker MOD writer: the inverse of `parseMod`.
 *
 * Takes the same `ModSong` the parser produces and emits the 31-sample
 * layout. What the parser does not keep (the restart byte, anything past the
 * order list) is written as ProTracker itself writes it, so a file that went
 * through `parseMod` -> `writeMod` -> `parseMod` is field-for-field identical.
 */
import {
  channelsForSignature,
  MAX_MOD_CHANNELS,
  type ModSong,
} from './mod-parser';

const HEADER_SIZE = 1084;
const NUM_SAMPLES = 31;
const PATTERN_ROWS = 64;
const MAX_SAMPLE_BYTES = 0x1fffe;

/** The signature a module of this many channels is written with. */
export function signatureForChannels(channels: number): string {
  if (channels === 4) return 'M.K.';
  if (channels < 10) return `${channels}CHN`;
  return `${channels}CH`;
}

/**
 * The signature to write: the module's own when it still names its channel
 * count, otherwise the conventional one. A Soundtracker module's empty
 * signature (and an FLT4/N.T. one for a changed channel count) is replaced,
 * since the 31-sample layout needs one.
 */
function chooseSignature(song: ModSong): string {
  const channels = song.numChannels;
  if (channelsForSignature(song.signature) === channels) return song.signature;
  return signatureForChannels(channels);
}

function writeAscii(
  out: Uint8Array,
  offset: number,
  length: number,
  text: string,
): void {
  for (let i = 0; i < length; i++) {
    const code = text.charCodeAt(i);
    out[offset + i] = i < text.length && code > 0 && code < 256 ? code : 0;
  }
}

export function writeMod(song: ModSong): Uint8Array {
  const channels = song.numChannels;
  if (channels < 1 || channels > MAX_MOD_CHANNELS) {
    throw new Error(`A MOD holds 1-${MAX_MOD_CHANNELS} channels, not ${channels}`);
  }
  if (song.patterns.length < 1 || song.patterns.length > 128) {
    throw new Error(`A MOD holds 1-128 patterns, not ${song.patterns.length}`);
  }

  const sampleBytes = Array.from({ length: NUM_SAMPLES }, (_, i) => {
    const length = song.samples[i]?.data.length ?? 0;
    return Math.min(MAX_SAMPLE_BYTES, (length + 1) & ~1);
  });
  const patternSize = PATTERN_ROWS * channels * 4;
  const total =
    HEADER_SIZE +
    song.patterns.length * patternSize +
    sampleBytes.reduce((a, b) => a + b, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  writeAscii(out, 0, 20, song.title);

  for (let i = 0; i < NUM_SAMPLES; i++) {
    const sample = song.samples[i];
    const at = 20 + i * 30;
    if (!sample) continue;
    const words = sampleBytes[i]! >> 1;
    writeAscii(out, at, 22, sample.name);
    view.setUint16(at + 22, words, false);
    out[at + 24] = sample.finetune & 0x0f;
    out[at + 25] = Math.max(0, Math.min(64, Math.round(sample.volume)));
    const looping = sample.loopLength > 2 && words > 0;
    const loopStartWords = looping ? Math.min(words - 1, sample.loopStart >> 1) : 0;
    const loopLengthWords = looping
      ? Math.max(2, Math.min(words - loopStartWords, sample.loopLength >> 1))
      : 1;
    view.setUint16(at + 26, loopStartWords, false);
    view.setUint16(at + 28, loopLengthWords, false);
  }

  const length = Math.max(1, Math.min(128, song.songLength || song.orders.length));
  out[950] = length;
  out[951] = 0x7f; // restart position; ProTracker writes 127
  for (let i = 0; i < 128; i++) out[952 + i] = song.orders[i] ?? 0;
  writeAscii(out, 1080, 4, chooseSignature(song));

  let at = HEADER_SIZE;
  for (const pattern of song.patterns) {
    for (let row = 0; row < PATTERN_ROWS; row++) {
      for (let ch = 0; ch < channels; ch++) {
        const cell = pattern.rows[row]?.[ch];
        if (cell) {
          const period = cell.period & 0x0fff;
          const sampleNumber = cell.sampleNumber & 0xff;
          out[at] = (sampleNumber & 0xf0) | (period >> 8);
          out[at + 1] = period & 0xff;
          out[at + 2] = ((sampleNumber & 0x0f) << 4) | (cell.effectCmd & 0x0f);
          out[at + 3] = cell.effectParam & 0xff;
        }
        at += 4;
      }
    }
  }

  for (let i = 0; i < NUM_SAMPLES; i++) {
    const data = song.samples[i]?.data;
    if (data) {
      const count = Math.min(data.length, sampleBytes[i]!);
      for (let j = 0; j < count; j++) out[at + j] = data[j]! & 0xff;
    }
    at += sampleBytes[i]!;
  }
  return out;
}
