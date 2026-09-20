import {
  ahxInstrumentProblem,
  normalizeAhxInstrumentForVersion,
  serializeAhxInstrument,
  type AhxInstrument,
  type AhxSong,
  type AhxStep,
  type AhxTrack,
} from '@another-synth/tracker-playback';

/**
 * AHX (`THX`) and HVL (`HVL`) writer: `parseAhx` read in reverse, byte for
 * byte. Lives here, not in the library, so `packages/tracker-playback` stays
 * a reader; the per-instrument wire form is the library's
 * `serializeAhxInstrument`.
 *
 * Nothing is clamped: a value that does not fit its bits, a model that
 * disagrees with itself (`trackNr` against `tracks.length`), or a step the
 * format cannot hold throws `AhxEncodeError`. The function builds its output
 * in local buffers and returns it only at the end, so a throw never yields
 * partial bytes, and it never mutates `song` or `base`.
 *
 * The model does not carry everything a file has. `base` (the bytes the song
 * was parsed from) fills the two gaps, and only those:
 *  - the blank-first-track flag (header byte 6, bit 7): the parse synthesizes
 *    an empty track 0 and forgets whether the file stored one. Five
 *    version-0 corpus files store an explicit all-zero track 0 with the flag
 *    clear. Without `base` the flag is guessed as "track 0 is all zero";
 *  - the bits the loader ignores in an instrument core (bytes 9..=11 and the
 *    top two bits of byte 19), copied from the same instrument in `base` when
 *    `base` has one. They are inert to the engine, so copying them onto an
 *    edited instrument is harmless.
 * `base` never overrides anything the model does carry.
 *
 * Inherent parse normalizations do not round-trip and are not undone: a
 * restart at or past the position count is stored as the last position, an
 * AHX subsong start past the end as 0, a version-0 AHX filter-toggle
 * parameter loses its high nibble. The writer emits what the model holds
 * (a version-0 filter-toggle parameter is stripped the way the loader does,
 * since the file would play that way anyway).
 */
export class AhxEncodeError extends Error {
  constructor(problem: string) {
    super(`cannot write this AHX/HVL song: ${problem}`);
    this.name = 'AhxEncodeError';
  }
}

export interface AhxWriteOptions {
  /** The bytes `song` was parsed from; see the file header for what it is used for. */
  base?: Uint8Array;
}

const AHX_HEADER_BYTES = 14;
const HVL_HEADER_BYTES = 16;
const MAX_POSITIONS = 1000;
const MAX_TRACK_LENGTH = 64;
const MAX_INSTRUMENTS = 64;
/** `(buf[8] >> 2) + 4` with a byte: the widest an HVL position can be. */
const HVL_MAX_CHANNELS = 67;
const HVL_RESTART_MAX = 0x3ff;
const NAME_OFFSET_MAX = 0xffff;
/** An HVL step that is entirely zero is escaped to this one byte. */
const HVL_BLANK_STEP = 0x3f;

/** Where `base` holds what the model cannot carry (see `walkBase`). */
interface BaseLayout {
  format: 'ahx' | 'hvl';
  blankFirstTrack: boolean;
  /** Byte offset of instrument `n`'s 22-byte core, by `n`; absent when `base` is too short to hold it. */
  instrumentCore: Map<number, number>;
}

function fail(problem: string): never {
  throw new AhxEncodeError(problem);
}

const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function need(value: unknown, min: number, max: number, what: string): number {
  if (!inRange(value, min, max)) fail(`${what} must be an integer in ${min}..${max} (got ${String(value)})`);
  return value as number;
}

/**
 * The layout of `base`, walked with the parser's own field arithmetic, to
 * find each instrument's offset (the parser exposes none). The base's own
 * format governs the walk.
 */
function walkBase(base: Uint8Array): BaseLayout {
  const at = (offset: number): number => base[offset] ?? 0;
  const isAhx = base[0] === 0x54 && base[1] === 0x48 && base[2] === 0x58;
  const isHvl = base[0] === 0x48 && base[1] === 0x56 && base[2] === 0x4c;
  if (base.length < 16 || !(isAhx ? at(3) < 3 : isHvl && at(3) < 2)) {
    fail('base is not an AHX/HVL file');
  }
  const b6 = at(6);
  const positions = ((b6 & 0x0f) << 8) | at(7);
  const trackLength = at(10);
  const trackNr = at(11);
  const instrumentNr = at(12);
  const subsongNr = at(13);
  if (positions > MAX_POSITIONS || trackLength > MAX_TRACK_LENGTH || instrumentNr > MAX_INSTRUMENTS) {
    fail('base has header dimensions the loader rejects');
  }
  const blankFirstTrack = (b6 & 0x80) !== 0;
  const format = isAhx ? 'ahx' : 'hvl';
  const channels = isAhx ? 4 : (at(8) >> 2) + 4;

  let pos = (isAhx ? AHX_HEADER_BYTES : HVL_HEADER_BYTES) + subsongNr * 2 + positions * channels * 2;
  for (let track = 0; track <= trackNr; track++) {
    if (blankFirstTrack && track === 0) continue;
    if (isAhx) {
      pos += trackLength * 3;
      continue;
    }
    for (let row = 0; row < trackLength; row++) pos += at(pos) === HVL_BLANK_STEP ? 1 : 5;
  }

  const entryBytes = isAhx ? 4 : 5;
  const instrumentCore = new Map<number, number>();
  for (let n = 1; n <= instrumentNr; n++) {
    if (pos + 22 > base.length) break;
    instrumentCore.set(n, pos);
    pos += 22 + at(pos + 21) * entryBytes;
  }
  return { format, blankFirstTrack, instrumentCore };
}

const isBlankStep = (step: AhxStep): boolean =>
  step.note === 0 && step.instrument === 0 && step.fx === 0 && step.fxParam === 0 && step.fxb === 0 && step.fxbParam === 0;

const isBlankTrack = (track: AhxTrack): boolean => track.every(isBlankStep);

/** Latin-1, one byte per char, NUL-terminated (`parseAhx`'s `readCString` in reverse). */
function cString(text: unknown, what: string): number[] {
  if (typeof text !== 'string') fail(`${what} is not a string`);
  const out: number[] = [];
  for (let i = 0; i < (text as string).length; i++) {
    const code = (text as string).charCodeAt(i);
    if (code === 0) fail(`${what} contains a NUL, which would end the string early`);
    if (code > 0xff) fail(`${what} contains a character above U+00FF, which the format cannot store`);
    out.push(code);
  }
  out.push(0);
  return out;
}

function writeStep(out: number[], step: AhxStep, format: 'ahx' | 'hvl', where: string): void {
  if (typeof step !== 'object' || step === null) fail(`${where} is not a step`);
  if (format === 'ahx') {
    const note = need(step.note, 0, 63, `${where} note`);
    const instrument = need(step.instrument, 0, 63, `${where} instrument`);
    const fx = need(step.fx, 0, 15, `${where} effect`);
    const param = need(step.fxParam, 0, 255, `${where} effect parameter`);
    if (step.fxb !== 0 || step.fxbParam !== 0) fail(`${where} has a second effect column, which AHX has no room for`);
    out.push((note << 2) | (instrument >> 4), ((instrument & 15) << 4) | fx, param);
    return;
  }
  const note = need(step.note, 0, 255, `${where} note`);
  const instrument = need(step.instrument, 0, 255, `${where} instrument`);
  const fx = need(step.fx, 0, 15, `${where} effect`);
  const param = need(step.fxParam, 0, 255, `${where} effect parameter`);
  const fxb = need(step.fxb, 0, 15, `${where} second effect`);
  const paramB = need(step.fxbParam, 0, 255, `${where} second effect parameter`);
  if (isBlankStep(step)) {
    out.push(HVL_BLANK_STEP);
    return;
  }
  if (note === HVL_BLANK_STEP) fail(`${where} has note 63 (0x3f), which HVL reserves for a blank step`);
  out.push(note, instrument, (fx << 4) | fxb, param, paramB);
}

/** The `parseAhx` inverse: `song` as AHX or HVL file bytes. Throws `AhxEncodeError`. */
export function serializeAhx(song: AhxSong, options: AhxWriteOptions = {}): Uint8Array {
  const format = song.format;
  if (format !== 'ahx' && format !== 'hvl') fail(`unknown format ${String(format)}`);
  const isAhx = format === 'ahx';
  const layout = options.base === undefined ? undefined : walkBase(options.base);
  if (layout !== undefined && layout.format !== format) {
    fail(`base is an ${layout.format.toUpperCase()} file but the song is ${format.toUpperCase()}`);
  }

  const version = need(song.version, 0, isAhx ? 2 : 1, 'version');
  const speedMultiplier = need(song.speedMultiplier, 1, 4, 'speedMultiplier');
  const positionNr = need(song.positionNr, 0, MAX_POSITIONS, 'positionNr');
  const trackLength = need(song.trackLength, 0, MAX_TRACK_LENGTH, 'trackLength');
  const trackNr = need(song.trackNr, 0, 255, 'trackNr');
  const instrumentNr = need(song.instrumentNr, 0, MAX_INSTRUMENTS, 'instrumentNr');
  const subsongNr = need(song.subsongNr, 0, 255, 'subsongNr');
  const channels = isAhx ? 4 : need(song.channels, 4, HVL_MAX_CHANNELS, 'channels');
  if (isAhx && song.channels !== 4) fail(`AHX has exactly 4 channels (got ${String(song.channels)})`);
  const restart = need(song.restart, 0, isAhx ? 0xffff : HVL_RESTART_MAX, 'restart');

  if (!Array.isArray(song.positions) || song.positions.length !== positionNr) {
    fail(`positionNr is ${positionNr} but the song has ${Array.isArray(song.positions) ? song.positions.length : 'no'} positions`);
  }
  if (!Array.isArray(song.tracks) || song.tracks.length !== trackNr + 1) {
    fail(`trackNr is ${trackNr} (${trackNr + 1} tracks) but the song has ${Array.isArray(song.tracks) ? song.tracks.length : 'no'} tracks`);
  }
  if (!Array.isArray(song.instruments) || song.instruments.length !== instrumentNr + 1) {
    fail(`instrumentNr is ${instrumentNr} but the song has ${Array.isArray(song.instruments) ? song.instruments.length : 'no'} instrument slots (index 0 is a placeholder)`);
  }
  if (!Array.isArray(song.subsongs) || song.subsongs.length !== subsongNr) {
    fail(`subsongNr is ${subsongNr} but the song has ${Array.isArray(song.subsongs) ? song.subsongs.length : 'no'} subsong starts`);
  }
  if (isAhx && (song.mixgainRaw !== undefined || song.defstereo !== undefined)) {
    fail('mixgainRaw/defstereo are HVL fields; AHX has no room for them');
  }

  // Blank-first-track flag: the base's when there is one, else "track 0 is all zero".
  const track0 = song.tracks[0];
  if (!Array.isArray(track0)) fail('track 0 is missing');
  const track0Blank = isBlankTrack(track0 as AhxTrack);
  const blankFirstTrack = layout === undefined ? track0Blank : layout.blankFirstTrack;
  if (blankFirstTrack && !track0Blank) {
    fail('the blank-first-track flag is set but track 0 has content, which the file would drop');
  }

  // Body: everything from the position table on, written in file order.
  const body: number[] = [];
  for (let i = 0; i < subsongNr; i++) {
    const start = need(song.subsongs[i], 0, 0xffff, `subsong ${i} start`);
    body.push(start >> 8, start & 0xff);
  }
  song.positions.forEach((position, index) => {
    const where = `position ${index}`;
    if (
      typeof position !== 'object' || position === null ||
      !Array.isArray(position.track) || position.track.length !== channels ||
      !Array.isArray(position.transpose) || position.transpose.length !== channels
    ) {
      fail(`${where} does not have exactly ${channels} channels of track and transpose`);
    }
    for (let ch = 0; ch < channels; ch++) {
      body.push(need(position.track[ch], 0, 255, `${where} channel ${ch} track`));
      body.push(need(position.transpose[ch], -128, 127, `${where} channel ${ch} transpose`) & 0xff);
    }
  });
  song.tracks.forEach((track, index) => {
    if (!Array.isArray(track) || track.length !== trackLength) {
      fail(`track ${index} does not have trackLength (${trackLength}) steps`);
    }
    if (blankFirstTrack && index === 0) return;
    track.forEach((step, row) => writeStep(body, step, format, `track ${index} row ${row}`));
  });

  const names = cString(song.name, 'song name');
  for (let n = 1; n <= instrumentNr; n++) {
    const ins = song.instruments[n] as AhxInstrument;
    const problem = ahxInstrumentProblem(ins, format);
    if (problem !== null) fail(`instrument ${n}: ${problem}`);
    names.push(...cString(ins.name, `instrument ${n} name`));

    const wire = serializeAhxInstrument(normalizeAhxInstrumentForVersion(ins, format, version), format);
    const baseAt = layout?.instrumentCore.get(n);
    if (baseAt !== undefined && options.base !== undefined) {
      // The inert bits the model does not carry, copied from the same instrument in `base`.
      for (const byte of [9, 10, 11]) wire[byte] = options.base[baseAt + byte] ?? 0;
      wire[19] = (wire[19] ?? 0) | ((options.base[baseAt + 19] ?? 0) & 0xc0);
    }
    for (const byte of wire) body.push(byte);
  }

  const headerBytes = isAhx ? AHX_HEADER_BYTES : HVL_HEADER_BYTES;
  const nameOffset = headerBytes + body.length;
  if (nameOffset > NAME_OFFSET_MAX) fail(`song too large: the string table would start at byte ${nameOffset}, past the 16-bit limit of ${NAME_OFFSET_MAX}`);

  const out = new Uint8Array(nameOffset + names.length);
  out.set([isAhx ? 0x54 : 0x48, isAhx ? 0x48 : 0x56, isAhx ? 0x58 : 0x4c, version, nameOffset >> 8, nameOffset & 0xff]);
  out[6] = (blankFirstTrack ? 0x80 : 0) | ((speedMultiplier - 1) << 5) | (positionNr >> 8);
  out[7] = positionNr & 0xff;
  if (isAhx) {
    out[8] = restart >> 8;
    out[9] = restart & 0xff;
  } else {
    out[8] = ((channels - 4) << 2) | (restart >> 8);
    out[9] = restart & 0xff;
  }
  out[10] = trackLength;
  out[11] = trackNr;
  out[12] = instrumentNr;
  out[13] = subsongNr;
  if (!isAhx) {
    out[14] = need(song.mixgainRaw, 0, 255, 'mixgainRaw');
    out[15] = need(song.defstereo, 0, 255, 'defstereo');
  }
  out.set(body, headerBytes);
  out.set(names, nameOffset);
  return out;
}
