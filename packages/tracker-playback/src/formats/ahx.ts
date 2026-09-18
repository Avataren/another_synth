/**
 * AHX (`.ahx`) and HVL (`.hvl`) parser.
 *
 * Scope: byte-exact header/instrument/track/position/PList decode for both
 * file families, mirroring the P0 Rust reference decoder
 * (`rust-wasm/src/ahx/format.rs`) field-for-field, which was itself checked
 * byte-for-byte against the vendored `.ai/ahx/references/hvl_replay.c`
 * (`hvl_load_ahx`/`hvl_load_hvl`/`hvl_ParseTune`) and cross-checked by hand
 * against two real fixtures (see `.ai/p0-report.md`). D23 discipline: this
 * reports what the file says and does no interpretation -- no waveform
 * generation, no envelope/filter/PList playback semantics, none of the
 * effect-command meanings. Mapping to the tracker's own row model happens in
 * `import/ahx-patterns.ts`.
 *
 * AHX and HVL share one replay engine and auto-detect from magic bytes
 * (`"THX"` + version < 3 is AHX, `"HVL"` + version < 2 is HVL); the two
 * differ starting at header byte 8 (HVL packs a channel count and extra
 * mixgain/stereo bytes in, AHX doesn't) and in their track-step and PList-
 * entry byte widths (AHX: 3-byte steps, 4-byte PList entries, 3-bit FX codes
 * with a remap; HVL: 5-byte steps with a second effect column, 5-byte PList
 * entries, direct 4-bit FX codes). Both are decoded here so a single
 * `parseAhx` covers the whole format family, per `ahx-requirements.md`'s
 * "target AHX 1.x/1.5x with a straight path to HVL, not AHX in isolation."
 *
 * Two corrections to `architecture-map.md`/`verdict.md`, resolved in
 * `.ai/p0-report.md` against the reference source and carried into this
 * decoder: HVL's channel count is NOT always 4 (`(buf[8]>>2)+4`, up to
 * `MAX_CHANNELS = 16`; all 7 vendored `.hvl` fixtures have more than 4), and
 * the note/pitch table (`period_tab`) spans 5 octaves (60 notes), not 3.
 */

/** HVL's reference replayer sizes its voice array to this; AHX itself never
 * exceeds 4 channels, but HVL's packed channel-count field can. */
export const AHX_MAX_CHANNELS = 16;

export type AhxSongFormat = 'ahx' | 'hvl';

export interface AhxEnvelope {
  aFrames: number;
  aVolume: number;
  dFrames: number;
  dVolume: number;
  /** Sustain: hold frames, no ramp. */
  sFrames: number;
  rFrames: number;
  rVolume: number;
}

export interface AhxPListEntry {
  note: number;
  /** 0 = no waveform override; 1..=5 = `waveform - 1` at playback. */
  waveform: number;
  fixed: boolean;
  /** Two FX slots, [first, second] in file order (AHX's 3-bit-with-remap
   * codes are already remapped to the 4-bit command space here). */
  fx: [number, number];
  fxParam: [number, number];
}

export interface AhxPList {
  speed: number;
  entries: AhxPListEntry[];
}

export interface AhxInstrument {
  name: string;
  volume: number;
  waveLength: number;
  filterLowerLimit: number;
  filterUpperLimit: number;
  filterSpeed: number;
  squareLowerLimit: number;
  squareUpperLimit: number;
  squareSpeed: number;
  vibratoDelay: number;
  vibratoSpeed: number;
  vibratoDepth: number;
  hardCutRelease: boolean;
  hardCutReleaseFrames: number;
  envelope: AhxEnvelope;
  plist: AhxPList;
}

export interface AhxStep {
  note: number;
  instrument: number;
  fx: number;
  fxParam: number;
  /** Always 0 for AHX (single effect column); HVL's second effect column. */
  fxb: number;
  fxbParam: number;
}

export type AhxTrack = AhxStep[];

export interface AhxPosition {
  /** One track index per channel. */
  track: number[];
  /** One per-channel transpose value per channel, signed. */
  transpose: number[];
}

export interface AhxSong {
  format: AhxSongFormat;
  /** Raw version byte (`buf[3]`). AHX: 0..=2. HVL: 0..=1. */
  version: number;
  name: string;
  /** Fixed at 4 for AHX; `(buf[8]>>2)+4` for HVL (can exceed 4). */
  channels: number;
  positionNr: number;
  restart: number;
  /** 1..=4; the 50 Hz PAL base divides by this to get the frame rate
   * (`.ai/p0-report.md`: 50/100/150/200 Hz, never 125 Hz). */
  speedMultiplier: number;
  trackLength: number;
  trackNr: number;
  instrumentNr: number;
  subsongNr: number;
  subsongs: number[];
  positions: AhxPosition[];
  /** Index 0..=trackNr, addressed directly by `AhxPosition.track` entries. */
  tracks: AhxTrack[];
  /** Index 0 is an unused placeholder (AHX/HVL instrument numbering starts
   * at 1); indices 1..=instrumentNr are real. */
  instruments: AhxInstrument[];
  /** HVL only (`buf[14]`); absent for AHX. */
  mixgainRaw?: number;
  /** HVL only (`buf[15]`); absent for AHX. */
  defstereo?: number;
}

function magicAt(buffer: Uint8Array, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if ((buffer[i] ?? 0) !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** Heuristic check for an AHX or HVL file; `parseAhx` throws the real error. */
export function looksLikeAhx(buffer: Uint8Array): boolean {
  if (buffer.byteLength < 4) return false;
  const version = buffer[3] ?? 0;
  if (magicAt(buffer, 'THX')) return version < 3;
  if (magicAt(buffer, 'HVL')) return version < 2;
  return false;
}

function u16be(buffer: Uint8Array, offset: number): number {
  const hi = buffer[offset] ?? 0;
  const lo = buffer[offset + 1] ?? 0;
  return (hi << 8) | lo;
}

function toI8(byte: number): number {
  return byte >= 0x80 ? byte - 0x100 : byte;
}

/** Reads a NUL-terminated string starting at `offset`; empty if `offset` runs
 * off the end (a truncated file's instrument names, not a fatal error). */
function readCString(buffer: Uint8Array, offset: number): string {
  if (offset < 0 || offset >= buffer.length) return '';
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) end++;
  let out = '';
  for (let i = offset; i < end; i++) out += String.fromCharCode(buffer[i] ?? 0);
  return out;
}

function defaultStep(): AhxStep {
  return { note: 0, instrument: 0, fx: 0, fxParam: 0, fxb: 0, fxbParam: 0 };
}

function defaultInstrument(): AhxInstrument {
  return {
    name: '',
    volume: 0,
    waveLength: 0,
    filterLowerLimit: 0,
    filterUpperLimit: 0,
    filterSpeed: 0,
    squareLowerLimit: 0,
    squareUpperLimit: 0,
    squareSpeed: 0,
    vibratoDelay: 0,
    vibratoSpeed: 0,
    vibratoDepth: 0,
    hardCutRelease: false,
    hardCutReleaseFrames: 0,
    envelope: {
      aFrames: 0,
      aVolume: 0,
      dFrames: 0,
      dVolume: 0,
      sFrames: 0,
      rFrames: 0,
      rVolume: 0,
    },
    plist: { speed: 0, entries: [] },
  };
}

interface AhxInstrumentCore {
  volume: number;
  waveLength: number;
  filterLowerLimit: number;
  filterUpperLimit: number;
  filterSpeed: number;
  squareLowerLimit: number;
  squareUpperLimit: number;
  squareSpeed: number;
  vibratoDelay: number;
  vibratoSpeed: number;
  vibratoDepth: number;
  hardCutRelease: boolean;
  hardCutReleaseFrames: number;
  envelope: AhxEnvelope;
  plistSpeed: number;
  plistLength: number;
}

/** Shared 22-byte instrument core, identical byte layout in AHX and HVL
 * (`hvl_load_ahx:270-293` / `hvl_load_hvl:505-528`). Only the trailing
 * PList entries differ in size/bit-layout between the two formats. */
function parseInstrumentCore(buffer: Uint8Array, pos: number): AhxInstrumentCore {
  const b = (offset: number): number => buffer[pos + offset] ?? 0;
  const b0 = b(0);
  const b1 = b(1);
  const b2 = b(2);
  const b3 = b(3);
  const b4 = b(4);
  const b5 = b(5);
  const b6 = b(6);
  const b7 = b(7);
  const b8 = b(8);
  const b12 = b(12);
  const b13 = b(13);
  const b14 = b(14);
  const b15 = b(15);
  const b16 = b(16);
  const b17 = b(17);
  const b18 = b(18);
  const b19 = b(19);
  const b20 = b(20);
  const b21 = b(21);

  return {
    volume: b0,
    filterSpeed: ((b1 >> 3) & 0x1f) | ((b12 >> 2) & 0x20),
    waveLength: b1 & 0x07,
    envelope: {
      aFrames: b2,
      aVolume: b3,
      dFrames: b4,
      dVolume: b5,
      sFrames: b6,
      rFrames: b7,
      rVolume: b8,
    },
    filterLowerLimit: b12 & 0x7f,
    vibratoDelay: b13,
    hardCutReleaseFrames: (b14 >> 4) & 0x07,
    hardCutRelease: (b14 & 0x80) !== 0,
    vibratoDepth: b14 & 0x0f,
    vibratoSpeed: b15,
    squareLowerLimit: b16,
    squareUpperLimit: b17,
    squareSpeed: b18,
    filterUpperLimit: b19 & 0x3f,
    plistSpeed: b20,
    plistLength: b21,
  };
}

function finishInstrument(
  core: AhxInstrumentCore,
  name: string,
  entries: AhxPListEntry[],
): AhxInstrument {
  return {
    name,
    volume: core.volume,
    waveLength: core.waveLength,
    filterLowerLimit: core.filterLowerLimit,
    filterUpperLimit: core.filterUpperLimit,
    filterSpeed: core.filterSpeed,
    squareLowerLimit: core.squareLowerLimit,
    squareUpperLimit: core.squareUpperLimit,
    squareSpeed: core.squareSpeed,
    vibratoDelay: core.vibratoDelay,
    vibratoSpeed: core.vibratoSpeed,
    vibratoDepth: core.vibratoDepth,
    hardCutRelease: core.hardCutRelease,
    hardCutReleaseFrames: core.hardCutReleaseFrames,
    envelope: core.envelope,
    plist: { speed: core.plistSpeed, entries },
  };
}

/** AHX PList entry: 4 bytes, `hvl_load_ahx:299-323`. The FX nibble codes are
 * packed into 3 bits with a remap (`6 -> 12`, `7 -> 15`) to reach 4-bit
 * command space -- unlike HVL's PList entry, which has room for a direct
 * 4-bit code (see `parsePListEntryHvl`). */
function parsePListEntryAhx(
  b0: number,
  b1: number,
  b2: number,
  b3: number,
  ahxVersion: number,
): AhxPListEntry {
  const remap = (v: number): number => (v === 6 ? 12 : v === 7 ? 15 : v);
  const k = remap((b0 >> 5) & 7);
  const l = remap((b0 >> 2) & 7);
  const waveform = ((b0 << 1) & 6) | (b1 >> 7);
  const fixed = ((b1 >> 6) & 1) !== 0;
  const note = b1 & 0x3f;

  let fxParam0 = b2;
  let fxParam1 = b3;
  // 1.6: strip "toggle filter" (FX 4) params down to the low nibble on
  // version-0 (pre-filter) AHX files, matching `hvl_load_ahx:315-320`.
  if (ahxVersion === 0 && l === 4 && (b2 & 0xf0) !== 0) fxParam0 &= 0x0f;
  if (ahxVersion === 0 && k === 4 && (b3 & 0xf0) !== 0) fxParam1 &= 0x0f;

  return { note, waveform, fixed, fx: [l, k], fxParam: [fxParam0, fxParam1] };
}

/** HVL PList entry: 5 bytes, `hvl_load_hvl:536-542`. Direct 4-bit FX codes,
 * no remap and no version-0 filter-strip quirk (AHX-only). */
function parsePListEntryHvl(
  b0: number,
  b1: number,
  b2: number,
  b3: number,
  b4: number,
): AhxPListEntry {
  return {
    note: b2 & 0x3f,
    waveform: b1 & 7,
    fixed: ((b2 >> 6) & 1) !== 0,
    fx: [b0 & 0xf, (b1 >> 3) & 0xf],
    fxParam: [b3, b4],
  };
}

/** Header dimensions the reference loader itself rejects
 * (`hvl_replay.c`'s own "Do some validation" block), not a clamp this
 * decoder invented -- a file failing this is invalid to the real replayer
 * too. */
function validateDimensions(posn: number, trkl: number, insn: number): void {
  if (posn > 1000 || trkl > 64 || insn > 64) {
    throw new Error(
      `Invalid AHX/HVL header dimensions: positions=${posn}, trackLength=${trkl}, instruments=${insn}`,
    );
  }
}

function parseAhxBody(buffer: Uint8Array): AhxSong {
  const version = buffer[3] ?? 0;
  const b6 = buffer[6] ?? 0;
  const posn = ((b6 & 0x0f) << 8) | (buffer[7] ?? 0);
  const insn = buffer[12] ?? 0;
  const ssn = buffer[13] ?? 0;
  const trkl = buffer[10] ?? 0;
  const trkn = buffer[11] ?? 0;

  validateDimensions(posn, trkl, insn);

  const restartRaw = u16be(buffer, 8);
  const speedMultiplier = ((b6 >> 5) & 3) + 1;
  const blankFirstTrack = (b6 & 0x80) !== 0;

  const nameOffset = u16be(buffer, 4);
  const name = readCString(buffer, nameOffset);
  let nptr = nameOffset + name.length + 1;

  let pos = 14;

  const subsongs: number[] = [];
  for (let i = 0; i < ssn; i++) {
    let v = u16be(buffer, pos);
    if (v >= posn) v = 0;
    subsongs.push(v);
    pos += 2;
  }

  const positions: AhxPosition[] = [];
  for (let i = 0; i < posn; i++) {
    const track: number[] = [];
    const transpose: number[] = [];
    for (let ch = 0; ch < 4; ch++) {
      track.push(buffer[pos] ?? 0);
      pos += 1;
      transpose.push(toI8(buffer[pos] ?? 0));
      pos += 1;
    }
    positions.push({ track, transpose });
  }

  const tracks: AhxTrack[] = [];
  for (let i = 0; i <= trkn; i++) {
    if (blankFirstTrack && i === 0) {
      tracks.push(Array.from({ length: trkl }, () => defaultStep()));
      continue;
    }
    const steps: AhxStep[] = [];
    for (let r = 0; r < trkl; r++) {
      const b0 = buffer[pos] ?? 0;
      const b1 = buffer[pos + 1] ?? 0;
      const b2 = buffer[pos + 2] ?? 0;
      pos += 3;
      steps.push({
        note: (b0 >> 2) & 0x3f,
        instrument: ((b0 & 0x3) << 4) | (b1 >> 4),
        fx: b1 & 0xf,
        fxParam: b2,
        fxb: 0,
        fxbParam: 0,
      });
    }
    tracks.push(steps);
  }

  const instruments: AhxInstrument[] = [defaultInstrument()];
  for (let i = 1; i <= insn; i++) {
    let iname = '';
    if (nptr < buffer.length) {
      iname = readCString(buffer, nptr);
      nptr += iname.length + 1;
    }

    const core = parseInstrumentCore(buffer, pos);
    pos += 22;

    const entries: AhxPListEntry[] = [];
    for (let e = 0; e < core.plistLength; e++) {
      const b0 = buffer[pos] ?? 0;
      const b1 = buffer[pos + 1] ?? 0;
      const b2 = buffer[pos + 2] ?? 0;
      const b3 = buffer[pos + 3] ?? 0;
      pos += 4;
      entries.push(parsePListEntryAhx(b0, b1, b2, b3, version));
    }

    instruments.push(finishInstrument(core, iname, entries));
  }

  const restart = restartRaw >= posn ? Math.max(0, posn - 1) : restartRaw;

  return {
    format: 'ahx',
    version,
    name,
    channels: 4,
    positionNr: posn,
    restart,
    speedMultiplier,
    trackLength: trkl,
    trackNr: trkn,
    instrumentNr: insn,
    subsongNr: ssn,
    subsongs,
    positions,
    tracks,
    instruments,
  };
}

function parseHvlBody(buffer: Uint8Array): AhxSong {
  const version = buffer[3] ?? 0;
  const b6 = buffer[6] ?? 0;
  const b8 = buffer[8] ?? 0;
  const posn = ((b6 & 0x0f) << 8) | (buffer[7] ?? 0);
  const insn = buffer[12] ?? 0;
  const ssn = buffer[13] ?? 0;
  const channels = (b8 >> 2) + 4;
  const trkl = buffer[10] ?? 0;
  const trkn = buffer[11] ?? 0;

  validateDimensions(posn, trkl, insn);

  const speedMultiplier = ((b6 >> 5) & 3) + 1;
  const blankFirstTrack = (b6 & 0x80) !== 0;
  const restartRaw = ((b8 & 3) << 8) | (buffer[9] ?? 0);
  const mixgainRaw = buffer[14] ?? 0;
  const defstereo = buffer[15] ?? 0;

  const nameOffset = u16be(buffer, 4);
  const name = readCString(buffer, nameOffset);
  let nptr = nameOffset + name.length + 1;

  let pos = 16;

  const subsongs: number[] = [];
  for (let i = 0; i < ssn; i++) {
    subsongs.push(u16be(buffer, pos));
    pos += 2;
  }

  const positions: AhxPosition[] = [];
  for (let i = 0; i < posn; i++) {
    const track: number[] = [];
    const transpose: number[] = [];
    for (let ch = 0; ch < channels; ch++) {
      track.push(buffer[pos] ?? 0);
      pos += 1;
      transpose.push(toI8(buffer[pos] ?? 0));
      pos += 1;
    }
    positions.push({ track, transpose });
  }

  const tracks: AhxTrack[] = [];
  for (let i = 0; i <= trkn; i++) {
    if (blankFirstTrack && i === 0) {
      tracks.push(Array.from({ length: trkl }, () => defaultStep()));
      continue;
    }
    const steps: AhxStep[] = [];
    for (let r = 0; r < trkl; r++) {
      const b0 = buffer[pos] ?? 0;
      // A blank step is escaped to 1 byte (`hvl_load_hvl:470-488`).
      if (b0 === 0x3f) {
        pos += 1;
        steps.push(defaultStep());
        continue;
      }
      const b1 = buffer[pos + 1] ?? 0;
      const b2 = buffer[pos + 2] ?? 0;
      const b3 = buffer[pos + 3] ?? 0;
      const b4 = buffer[pos + 4] ?? 0;
      pos += 5;
      steps.push({
        note: b0,
        instrument: b1,
        fx: b2 >> 4,
        fxParam: b3,
        fxb: b2 & 0xf,
        fxbParam: b4,
      });
    }
    tracks.push(steps);
  }

  const instruments: AhxInstrument[] = [defaultInstrument()];
  for (let i = 1; i <= insn; i++) {
    let iname = '';
    if (nptr < buffer.length) {
      iname = readCString(buffer, nptr);
      nptr += iname.length + 1;
    }

    const core = parseInstrumentCore(buffer, pos);
    pos += 22;

    const entries: AhxPListEntry[] = [];
    for (let e = 0; e < core.plistLength; e++) {
      const b0 = buffer[pos] ?? 0;
      const b1 = buffer[pos + 1] ?? 0;
      const b2 = buffer[pos + 2] ?? 0;
      const b3 = buffer[pos + 3] ?? 0;
      const b4 = buffer[pos + 4] ?? 0;
      pos += 5;
      entries.push(parsePListEntryHvl(b0, b1, b2, b3, b4));
    }

    instruments.push(finishInstrument(core, iname, entries));
  }

  const restart = restartRaw >= posn ? Math.max(0, posn - 1) : restartRaw;

  return {
    format: 'hvl',
    version,
    name,
    channels,
    positionNr: posn,
    restart,
    speedMultiplier,
    trackLength: trkl,
    trackNr: trkn,
    instrumentNr: insn,
    subsongNr: ssn,
    subsongs,
    positions,
    tracks,
    instruments,
    mixgainRaw,
    defstereo,
  };
}

/**
 * Parses an AHX or HVL file from raw bytes. Auto-detects the format from its
 * magic bytes, mirroring `hvl_ParseTune`: `"THX"` + version < 3 is AHX,
 * `"HVL"` + version < 2 is HVL, anything else throws.
 */
export function parseAhx(buffer: Uint8Array): AhxSong {
  if (buffer.byteLength < 16 || !looksLikeAhx(buffer)) {
    throw new Error('Unsupported or invalid AHX/HVL file');
  }
  if (magicAt(buffer, 'THX')) return parseAhxBody(buffer);
  return parseHvlBody(buffer);
}
