/**
 * One AHX/HVL instrument as bytes, and a check that a value is one.
 *
 * The wire form is the instrument core (22 bytes) followed by its PList
 * entries in the song format's own layout, with no name (names live in the
 * file's string table). It is the form the Rust engine replaces a live
 * instrument from (`AhxPlayer::replace_instrument` -> `parse_instrument` in
 * `rust-wasm/src/ahx/format.rs`, which decodes with the file loader's own
 * functions) and, for the export phase, what a `.ahx` writer emits per
 * instrument. The layout is `parseAhx`'s and `format.rs`'s read in reverse;
 * `src/tests/ahx-instrument-codec.test.ts` round-trips every demo instrument through it, and
 * `rust-wasm/tests/ahx_replace.rs` does the same through the Rust decode.
 *
 * Nothing here is clamped: a value that does not fit its bits is an error, so
 * that a caller that means to write 70 into a 6-bit field hears about it
 * instead of writing 6.
 */
import type { AhxInstrument, AhxSongFormat } from './ahx';

/** Bytes of the instrument core, identical in AHX and HVL. */
export const AHX_INSTRUMENT_CORE_BYTES = 22;

/** Most PList entries an instrument holds: its length is one byte. */
export const AHX_MAX_PLIST_ENTRIES = 255;

/** Highest note number a PList entry can hold (6 bits): 1 = C-1 .. 60 = B-5. */
export const AHX_PLIST_MAX_NOTE = 0x3f;

/**
 * The PList commands AHX's 3-bit code can express: 0..=5 as they are, and the
 * loader's remap makes the last two codes commands 12 (volume) and 15 (speed).
 * HVL's PList has room for a 4-bit command, so any of 0..=15.
 */
export function ahxPListCommandsFor(format: AhxSongFormat): readonly number[] {
  return format === 'hvl'
    ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    : [0, 1, 2, 3, 4, 5, 12, 15];
}

/** Inclusive ranges of the instrument fields that are not a plain byte. */
export const AHX_FIELD_MAX = {
  waveLength: 7,
  filterLowerLimit: 0x7f,
  filterUpperLimit: 0x3f,
  filterSpeed: 0x3f,
  vibratoDepth: 0x0f,
  hardCutReleaseFrames: 7,
  plistWaveform: 7,
} as const;

const isInt = (value: unknown, max = 255): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;

const isPair = (value: unknown): value is [unknown, unknown] =>
  Array.isArray(value) && value.length === 2;

/**
 * Why `value` is not an instrument this codec can write in `format`, or `null`
 * when it is one. Checks the whole shape (a song file from anywhere can put
 * anything in `ahxData`), so a value that passes cannot make the display,
 * the editor or the serializer throw.
 */
export function ahxInstrumentProblem(value: unknown, format: AhxSongFormat = 'ahx'): string | null {
  if (typeof value !== 'object' || value === null) return 'not an object';
  const ins = value as Partial<Record<keyof AhxInstrument, unknown>>;
  if (typeof ins.name !== 'string') return 'name is not a string';
  const bytes = {
    volume: 255,
    waveLength: AHX_FIELD_MAX.waveLength,
    filterLowerLimit: AHX_FIELD_MAX.filterLowerLimit,
    filterUpperLimit: AHX_FIELD_MAX.filterUpperLimit,
    filterSpeed: AHX_FIELD_MAX.filterSpeed,
    squareLowerLimit: 255,
    squareUpperLimit: 255,
    squareSpeed: 255,
    vibratoDelay: 255,
    vibratoSpeed: 255,
    vibratoDepth: AHX_FIELD_MAX.vibratoDepth,
    hardCutReleaseFrames: AHX_FIELD_MAX.hardCutReleaseFrames,
  } as const;
  for (const [field, max] of Object.entries(bytes)) {
    if (!isInt(ins[field as keyof typeof bytes], max)) return `${field} is not an integer in 0..${max}`;
  }
  if (typeof ins.hardCutRelease !== 'boolean') return 'hardCutRelease is not a boolean';

  const env = ins.envelope as Record<string, unknown> | null | undefined;
  if (typeof env !== 'object' || env === null) return 'envelope is missing';
  for (const field of ['aFrames', 'aVolume', 'dFrames', 'dVolume', 'sFrames', 'rFrames', 'rVolume']) {
    if (!isInt(env[field])) return `envelope.${field} is not a byte`;
  }

  const plist = ins.plist as { speed?: unknown; entries?: unknown } | null | undefined;
  if (typeof plist !== 'object' || plist === null) return 'plist is missing';
  if (!isInt(plist.speed)) return 'plist.speed is not a byte';
  if (!Array.isArray(plist.entries)) return 'plist.entries is not an array';
  if (plist.entries.length > AHX_MAX_PLIST_ENTRIES) return `plist has more than ${AHX_MAX_PLIST_ENTRIES} entries`;
  const commands = ahxPListCommandsFor(format);
  for (let row = 0; row < plist.entries.length; row++) {
    const entry = plist.entries[row] as Record<string, unknown> | null;
    if (typeof entry !== 'object' || entry === null) return `plist row ${row} is not an object`;
    if (!isInt(entry.note, AHX_PLIST_MAX_NOTE)) return `plist row ${row}: note is not in 0..${AHX_PLIST_MAX_NOTE}`;
    if (!isInt(entry.waveform, AHX_FIELD_MAX.plistWaveform)) return `plist row ${row}: waveform is not in 0..7`;
    if (typeof entry.fixed !== 'boolean') return `plist row ${row}: fixed is not a boolean`;
    if (!isPair(entry.fx) || !entry.fx.every((fx) => typeof fx === 'number' && commands.includes(fx))) {
      return `plist row ${row}: a command the ${format} PList cannot hold`;
    }
    if (!isPair(entry.fxParam) || !entry.fxParam.every((p) => isInt(p))) {
      return `plist row ${row}: a command parameter is not a byte`;
    }
  }
  return null;
}

/** `value` as an `AhxInstrument` (a deep copy), or `undefined` when it is not one. */
export function sanitizeAhxInstrument(value: unknown, format: AhxSongFormat = 'ahx'): AhxInstrument | undefined {
  if (ahxInstrumentProblem(value, format) !== null) return undefined;
  return JSON.parse(JSON.stringify(value)) as AhxInstrument;
}

export class AhxInstrumentEncodeError extends Error {
  constructor(problem: string) {
    super(`cannot write this AHX instrument: ${problem}`);
    this.name = 'AhxInstrumentEncodeError';
  }
}

/**
 * The instrument's wire form in `format`'s layout (default AHX; an HVL song's
 * instruments are written in HVL's wider PList entries). Throws
 * `AhxInstrumentEncodeError` for a value that is not a valid instrument. The
 * three core bytes the loader skips are written as zero.
 */
export function serializeAhxInstrument(ins: AhxInstrument, format: AhxSongFormat = 'ahx'): Uint8Array {
  const problem = ahxInstrumentProblem(ins, format);
  if (problem !== null) throw new AhxInstrumentEncodeError(problem);
  const entryBytes = format === 'hvl' ? 5 : 4;
  const out = new Uint8Array(AHX_INSTRUMENT_CORE_BYTES + ins.plist.entries.length * entryBytes);
  const e = ins.envelope;
  out[0] = ins.volume;
  out[1] = (ins.waveLength & 7) | ((ins.filterSpeed & 0x1f) << 3);
  out.set([e.aFrames, e.aVolume, e.dFrames, e.dVolume, e.sFrames, e.rFrames, e.rVolume], 2);
  // Bytes 9..=11 are not read by the loader.
  out[12] = ins.filterLowerLimit | ((ins.filterSpeed & 0x20) << 2);
  out[13] = ins.vibratoDelay;
  out[14] = ((ins.hardCutRelease ? 1 : 0) << 7) | (ins.hardCutReleaseFrames << 4) | ins.vibratoDepth;
  out[15] = ins.vibratoSpeed;
  out[16] = ins.squareLowerLimit;
  out[17] = ins.squareUpperLimit;
  out[18] = ins.squareSpeed;
  out[19] = ins.filterUpperLimit;
  out[20] = ins.plist.speed;
  out[21] = ins.plist.entries.length;

  // The inverse of the loader's 3-bit remap (`6 -> 12`, `7 -> 15`).
  const ahxCode = (fx: number): number => (fx === 12 ? 6 : fx === 15 ? 7 : fx);
  ins.plist.entries.forEach((entry, row) => {
    const at = AHX_INSTRUMENT_CORE_BYTES + row * entryBytes;
    const fixed = entry.fixed ? 1 : 0;
    if (format === 'hvl') {
      out[at] = entry.fx[0];
      out[at + 1] = entry.waveform | (entry.fx[1] << 3);
      out[at + 2] = (fixed << 6) | entry.note;
      out[at + 3] = entry.fxParam[0];
      out[at + 4] = entry.fxParam[1];
    } else {
      out[at] = (ahxCode(entry.fx[1]) << 5) | (ahxCode(entry.fx[0]) << 2) | (entry.waveform >> 1);
      out[at + 1] = ((entry.waveform & 1) << 7) | (fixed << 6) | entry.note;
      out[at + 2] = entry.fxParam[0];
      out[at + 3] = entry.fxParam[1];
    }
  });
  return out;
}
