/**
 * Scream Tracker 3 (.s3m) parser.
 *
 * Scope: the structure needed to play a module -- header with its flag set,
 * the S3M run-length packed pattern format (NOT XM's mask-byte packing; see
 * decodePattern below for why nothing is shared), sample/AdLib instrument
 * headers with their 80-byte layout, and PCM sample data (unsigned 8-bit or
 * signed 16-bit little-endian; the DP30AD1F packed-16-bit variant is detected
 * and reported, never silently mis-decoded). It deliberately stays close to
 * the file layout and makes no interpretation decisions; mapping to the
 * tracker's own song model happens later in the import layer.
 *
 * Layout reference: the ST3.01b/ST3.20 format description (modland
 * /pub/documents/format_documentation "Scream Tracker v3.01b (.s3m).txt"),
 * cross-checked against OpenMPT soundlib/S3MTools.h (the S3MFileHeader,
 * S3MSampleHeader and flag enums) and 8bitbubsy/st3play's loader
 * (load.c/digread.c). Offsets below are quoted from those so they can be
 * checked without the documents to hand.
 *
 * ---------------------------------------------------------------------------
 * The header flags word, settled by quote (2026-09-03). The task brief, the
 * P3 decision log and the old s3m.txt spec disagreed about "Amiga slides";
 * both authoritative replayers answer it. OpenMPT soundlib/S3MTools.h:
 *
 *   enum S3MHeaderFlags {
 *       st2Vibrato        = 0x01,  // Vibrato is twice as deep.
 *       zeroVolOptim      = 0x08,  // Volume 0 optimisations
 *       amigaLimits       = 0x10,  // Enforce Amiga limits
 *       fastVolumeSlides  = 0x40,  // Fast volume slides (like in ST3.00)
 *   };
 *
 * st3play dig.c `setmasterflags` (loaded from header.flags):
 *
 *   song.fastvolslide = !!(song.masterflags & 64);
 *   if (song.masterflags & 16) {          // amiga limits
 *       song.amigalimits = true;
 *       song.aspdmin = 453;  song.aspdmax = 3424;
 *   } else {
 *       song.amigalimits = false;
 *       song.aspdmin = 64;   song.aspdmax = 32767;
 *   }
 *
 * and dig.c `loadheaderparms`: `song.oldstvib = !!(song.header.flags & 1);`
 *
 * The settled table:
 *
 *   0x01  st2Vibrato   -- ST2-style vibrato, twice as deep. Parsed and
 *                         recorded; deliberately not modelled (no corpus
 *                         evidence it is audible in our engine yet).
 *   0x04  "AMIGASLIDES" per the s3m.txt spec -- implemented by NEITHER
 *                         replayer. st3play acts on bits 0, 4 and 6 only;
 *                         OpenMPT's enum has no such flag. There is no
 *                         slides-mode bit in S3M: the only flag-driven
 *                         pitch behaviour is the 0x10 Amiga period clamp.
 *                         Recorded (s3mFlags.raw & 0x04) rather than
 *                         invented into behaviour.
 *   0x08  zeroVolOptim -- load-time volume-0 optimisation; playback-neutral.
 *   0x10  amigaLimits  -- per-file Amiga period clamp 453..3424 (default
 *                         64..32767). This is the per-file song data that
 *                         selects S3M_AMIGA_PROFILE (D59 discipline: it must
 *                         reach the engine, not die at the importer).
 *   0x40  fastVolumeSlides -- ST3.00-style volume slides. D96's deliberate
 *                         non-modelling: without it, ST3.20 treats a
 *                         non-fine Dxy as illegal on un-counted songs
 *                         (`else return; // illegal slide` in st3play's
 *                         s_volslide). Parsed and recorded; recorded as a
 *                         known gap, never silently folded into the slide
 *                         arithmetic.
 *
 * The "custom data present" signal the old spec hangs on "bit 6" is not a
 * flag at all: it is the header's `special` field (u16 @ 0x3E) being
 * non-zero (OpenMPT reads it as the pointer to the special custom data).
 * Parsed and recorded as `hasCustomData`.
 */

const S3M_SIGNATURE_OFFSET = 0x2c; // 'SCRM'
/** Header (0x40) + channel table (0x20) + one order + four pointer bytes. */
const S3M_MIN_SIZE = 0x70; // 112 bytes

/** File note byte for a note-off cell (OpenMPT S3MTools.h: s3mNoteOff). */
export const S3M_KEY_OFF = 0xfe;
/** File note byte meaning "no note" on a cell that carries an instrument. */
export const S3M_NO_NOTE = 0xff;
/** Last valid note byte: 0x5B = B-6 (six octaves of twelve semitones). */
export const S3M_MAX_NOTE = 0x5b;

/** File volume byte meaning "no volume" (st3play's clearnotes sentinel). */
export const S3M_NO_VOLUME = 0xff;

export type S3mInstrumentKind = 'pcm' | 'adlib';

export interface S3mPatternCell {
  /**
   * Raw file note byte when the cell carries a note field (bit 0x20 set):
   * 0x00..0x5B are notes (hi nibble = octave, lo = semitone, 0x00 = C-1),
   * 0xFE = note off, 0xFF = "no note" (an instrument-only cell). Absent
   * (undefined) when the cell has no note field at all.
   */
  note?: number;
  /** 0 = none, else the 1-based instrument (sample) number. */
  instrument: number;
  /**
   * Raw file volume byte when present (bit 0x40): 0..64 volume, 128..192 a
   * panning value (OpenMPT reads those as VOLCMD_PANNING), 0xFF "no volume".
   */
  volume?: number;
  /** 0 = none, else the raw S3M command byte (letter minus 0x40). */
  effectCommand: number;
  effectParam: number;
}

export interface S3mPattern {
  numRows: number;
  /** S3M patterns always address 32 channels. */
  rows: S3mPatternCell[][];
}

export interface S3mInstrument {
  name: string;
  /** DOS filename from the header (useful diagnostics, rarely set). */
  dosFilename: string;
  kind: S3mInstrumentKind;
  /** 'melody' (type 2) or 'drum' (type 3+) for AdLib instruments. */
  adlibKind?: 'melody' | 'drum';
  /** Sample length in frames (0 for AdLib instruments). */
  length: number;
  loopStart: number;
  /** Points one byte AFTER the last played byte (ST3.01b format doc). */
  loopEnd: number;
  loopEnabled: boolean;
  /** 0..64. */
  volume: number;
  /** Pack byte: 0 = unpacked, 1 = DP30AD1F packed 16-bit (see decode). */
  packed: boolean;
  stereo: boolean;
  bits16: boolean;
  /** "Herz for middle C"; ST3 only uses the lower 16 bits. */
  c2spd: number;
  /**
   * Raw OPL2 register/timbre bytes D00..D0B from an AdLib instrument header,
   * preserved in file order exactly as stored for the future OPL playback
   * task (Morten, 2026-09-03): parse and keep, mark inactive, never play
   * here. The future consumer is a dedicated WASM OPL core (standalone OPL
   * emulator, own worklet/voice path -- not the main synth); these raw bytes
   * are its natural patch format, so no mapping layer is built toward the
   * existing synth's FM primitives.
   */
  oplRegisters?: number[];
  /** AdLib default volume (0..64), from the AdLib header's own byte. */
  adlibVolume?: number;
  /**
   * Decoded PCM, normalised to -1..1. Empty for AdLib instruments, for
   * stereo samples (warn-and-skip; no stereo sampler path exists) and for
   * DP30AD1F-packed samples (see the module comment: no reference player
   * implements the packing, so decoding would be a guess).
   */
  data: Float32Array;
  /** Set when the sample was deliberately not decoded (with the reason). */
  notDecoded?: 'stereo' | 'dp30ad1f-packed';
}

export interface S3mSong {
  title: string;
  /** "Made with" tracker version word (cwtv), e.g. 0x1320 = ST3.20. */
  trackerVersion: number;
  /** Format version: 1 = old (SIGNED 8-bit samples), 2 = unsigned. */
  formatVersion: number;
  /** S3M always addresses 32 channels; the settings say which are used. */
  numChannels: number;
  /** Raw 32 channel-settings bytes (0xFF = disabled; hi bit = muted). */
  channelSettings: number[];
  /** The 32 default-pan bytes; present only when `hasPanningTable`. */
  defaultPans?: number[];
  hasPanningTable: boolean;
  orders: number[];
  songLength: number;
  patterns: S3mPattern[];
  instruments: S3mInstrument[];
  /** Raw header flags word; see the settled table in the module comment. */
  flags: number;
  /** flags & 0x10 -- the per-file Amiga period clamp (453..3424). */
  amigaLimits: boolean;
  /** flags & 0x40 -- ST3.00-style fast volume slides (recorded, unmodelled). */
  fastVolumeSlides: boolean;
  /** flags & 0x01 -- ST2-style vibrato, twice as deep (recorded, unmodelled). */
  st2Vibrato: boolean;
  /** flags & 0x04 -- the s3m.txt "AMIGASLIDES" bit no replayer implements. */
  amigaSlidesBitSet: boolean;
  /** Header global volume 0..64 (255 = "unset"; OpenMPT clamps to 64). */
  globalVolume: number;
  /** Default speed (ticks per row); raw byte. */
  initialSpeed: number;
  /** Default tempo (BPM); raw byte. */
  initialTempo: number;
  masterVolume: number;
  /** masterVolume bit 0x80 (OpenMPT: `fileHeader.masterVolume & 0x80`). */
  masterStereo: boolean;
  /** Header `special` field non-zero (custom data present). */
  hasCustomData: boolean;
}

function readAscii(buffer: Uint8Array, offset: number, length: number): string {
  let result = '';
  const end = Math.min(offset + length, buffer.length);
  for (let i = offset; i < end; i++) {
    const code = buffer[i] ?? 0;
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result.trimEnd();
}

/** Heuristic check for an S3M file; `parseS3m` throws the real error. */
export function looksLikeS3m(buffer: Uint8Array): boolean {
  if (buffer.byteLength < S3M_MIN_SIZE) return false;
  if (readAscii(buffer, S3M_SIGNATURE_OFFSET, 4) !== 'SCRM') return false;
  // Byte 0x1D (fileType) is 0x10 = "ST3 module" in every valid S3M.
  return buffer[0x1d] === 0x10;
}

/**
 * Decode one S3M packed pattern.
 *
 * S3M packing is row-major with an explicit end-of-row byte and run-length
 * on the *cell* level -- structurally nothing like XM's per-cell presence
 * mask, which is why no code is shared with xm.ts's decoder:
 *
 *   size   = u16 at pattern start (packed size; OpenMPT skips it -- some
 *            files carry a wrong value -- and we follow, using it only as a
 *            soft bound on truncation)
 *   loop:
 *     b = next byte
 *     b == 0x00      -> end of row
 *     ch = b & 0x1F
 *     b & 0x20 (note):  note byte, instrument byte
 *     b & 0x40 (vol):   volume byte
 *     b & 0x80 (cmd):   command byte, parameter byte
 *
 * (ST3.01b format doc, "packed pattern format"; OpenMPT's s3mNotePresent/
 * s3mVolumePresent/s3mEffectPresent/s3mChannelMask constants agree.)
 *
 * A truncated pattern (data ends before 64 end-of-row markers) yields
 * predictable empty rows, the same policy as the XM decoder's
 * `packedSize == 0` path.
 */
function decodePattern(
  buffer: Uint8Array,
  dataOffset: number,
  packedSize: number,
  numRows: number,
): S3mPattern {
  const rows: S3mPatternCell[][] = [];
  let at = dataOffset;
  // The u16 length is a soft bound (see above): some files understate it, so
  // truncation is detected by the buffer end as well.
  const hardEnd = Math.min(
    buffer.byteLength,
    packedSize > 0 ? dataOffset + packedSize : buffer.byteLength,
  );

  for (let row = 0; row < numRows; row++) {
    const cells: S3mPatternCell[] = [];
    for (let ch = 0; ch < 32; ch++) {
      cells.push({ instrument: 0, effectCommand: 0, effectParam: 0 });
    }

    // Read cells until the end-of-row marker (or the data runs out).
    while (at < hardEnd) {
      const flag = buffer[at++] ?? 0;
      if (flag === 0) break; // end of row
      const channel = flag & 0x1f;
      const cell = cells[channel] ?? {
        instrument: 0,
        effectCommand: 0,
        effectParam: 0,
      };
      if (flag & 0x20) {
        cell.note = buffer[at++] ?? 0;
        cell.instrument = buffer[at++] ?? 0;
      }
      if (flag & 0x40) {
        cell.volume = buffer[at++] ?? 0;
      }
      if (flag & 0x80) {
        cell.effectCommand = buffer[at++] ?? 0;
        cell.effectParam = buffer[at++] ?? 0;
      }
    }

    rows.push(cells);
  }

  return { numRows, rows };
}

/**
 * Decode PCM sample data.
 *
 * 8-bit samples are UNSIGNED (centre 128) in format version 2 -- the
 * format's own "new version = unsigned samples" (OpenMPT S3MFormatVersion).
 * Old-version (version 1) files store signed 8-bit, which OpenMPT reads via
 * `GetSampleFormat((fileHeader.formatVersion == oldVersion))`.
 *
 * 16-bit samples are signed little-endian. ST3 itself never wrote them
 * ("+2/+4 not supported by ST3.01", ST3.01b format doc) -- they come from
 * later trackers -- and no reference player documents an unsigned 16-bit
 * reading, so signed LE is the only sourced one. The corpus tests pin the
 * decode statistically (roughness/DC) on a real 16-bit file.
 *
 * DP30AD1F-packed 16-bit samples (pack byte 1) are detected and *not*
 * decoded: neither OpenMPT (whose S3MSampleHeader::SamplePacking calls the
 * packing "Unused") nor st3play nor Schism Tracker implements it, so any
 * unpacker here would be guesswork. The header survives with `data` empty
 * and `notDecoded: 'dp30ad1f-packed'`; the importer counts and warns.
 */
function decodeSample(
  buffer: Uint8Array,
  offset: number,
  instrument: S3mInstrument,
  signed8Bit: boolean,
): Float32Array {
  if (instrument.length === 0) return new Float32Array(0);
  if (instrument.stereo) {
    instrument.notDecoded = 'stereo';
    return new Float32Array(0);
  }
  if (instrument.packed) {
    instrument.notDecoded = 'dp30ad1f-packed';
    return new Float32Array(0);
  }

  if (instrument.bits16) {
    const frames = Math.min(
      instrument.length,
      Math.floor((buffer.byteLength - offset) / 2),
    );
    const out = new Float32Array(frames);
    const view = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    );
    for (let i = 0; i < frames; i++) {
      out[i] = view.getInt16(offset + i * 2, true) / 32768;
    }
    return out;
  }

  const frames = Math.min(instrument.length, buffer.byteLength - offset);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const raw = buffer[offset + i] ?? 0;
    if (signed8Bit) {
      const signed = raw >= 0x80 ? raw - 0x100 : raw;
      out[i] = signed / 128;
    } else {
      out[i] = (raw - 128) / 128;
    }
  }
  return out;
}

export function parseS3m(buffer: Uint8Array): S3mSong {
  if (!looksLikeS3m(buffer)) {
    throw new Error('Unsupported or invalid S3M file');
  }

  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );

  const title = readAscii(buffer, 0, 28);
  // Layout: 28-byte title @ 0x00, 0x1A marker @ 0x1C, fileType 0x10 @ 0x1D,
  // 2 reserved bytes, then ordNum @ 0x20 (OpenMPT S3MFileHeader).
  const ordNum = view.getUint16(0x20, true);
  const smpNum = view.getUint16(0x22, true);
  const patNum = view.getUint16(0x24, true);
  const flags = view.getUint16(0x26, true);
  const trackerVersion = view.getUint16(0x28, true);
  const formatVersion = view.getUint16(0x2a, true);
  const globalVolume = buffer[0x30] ?? 0;
  const initialSpeed = buffer[0x31] ?? 0;
  const initialTempo = buffer[0x32] ?? 0;
  const masterVolume = buffer[0x33] ?? 0;
  const usePanningTable = buffer[0x35] ?? 0;
  const special = view.getUint16(0x3e, true);

  const channelSettings = Array.from({ length: 32 }, (_, i) => buffer[0x40 + i] ?? 0xff);

  const songLength = ordNum;
  const orders: number[] = [];
  for (let i = 0; i < ordNum; i++) {
    orders.push(buffer[0x60 + i] ?? 255);
  }

  // After the order table: instrument and pattern parapointers (u16 each),
  // then the optional 32-byte default-pan table (byte 0x35 == 0xFC).
  // Each parapointer is a paragraph number (byte offset / 16).
  const orderTableSize = ordNum;
  const instrumentPointerBase = 0x60 + orderTableSize;
  const instrumentPointers: number[] = [];
  for (let i = 0; i < smpNum; i++) {
    instrumentPointers.push(view.getUint16(instrumentPointerBase + i * 2, true) * 16);
  }
  const patternPointerBase = instrumentPointerBase + smpNum * 2;
  const patternPointers: number[] = [];
  for (let i = 0; i < patNum; i++) {
    patternPointers.push(view.getUint16(patternPointerBase + i * 2, true) * 16);
  }

  const hasPanningTable = usePanningTable === 0xfc;
  const defaultPans = hasPanningTable
    ? Array.from(
        { length: 32 },
        (_, i) => buffer[patternPointerBase + patNum * 2 + i] ?? 0,
      )
    : undefined;

  const patterns: S3mPattern[] = [];
  for (const pointer of patternPointers) {
    // A zero parapointer is an empty pattern (OpenMPT: "A zero parapointer
    // indicates an empty pattern").
    if (pointer === 0 || pointer + 2 > buffer.byteLength) {
      patterns.push({ numRows: 64, rows: [] });
      continue;
    }
    const packedSize = view.getUint16(pointer, true);
    patterns.push(decodePattern(buffer, pointer + 2, packedSize, 64));
  }

  const instruments: S3mInstrument[] = [];
  for (const pointer of instrumentPointers) {
    if (pointer + 80 > buffer.byteLength) {
      instruments.push({
        name: '',
        dosFilename: '',
        kind: 'pcm',
        length: 0,
        loopStart: 0,
        loopEnd: 0,
        loopEnabled: false,
        volume: 0,
        packed: false,
        stereo: false,
        bits16: false,
        c2spd: 0,
        data: new Float32Array(0),
      });
      continue;
    }

    const typeByte = buffer[pointer] ?? 0;
    const kind: S3mInstrumentKind = typeByte === 1 ? 'pcm' : 'adlib';
    const name = readAscii(buffer, pointer + 48, 28);
    const dosFilename = readAscii(buffer, pointer + 1, 12);
    // length/loopBegin/loopEnd are dwords in FRAMES (the format doc's "32
    // bit parameters"; OpenMPT reads them as sample counts).
    const length = view.getUint32(pointer + 16, true);
    const loopStart = view.getUint32(pointer + 20, true);
    const loopEnd = view.getUint32(pointer + 24, true);
    const volume = Math.min(buffer[pointer + 28] ?? 0, 64);
    const packed = (buffer[pointer + 30] ?? 0) === 1;
    const sampleFlags = buffer[pointer + 31] ?? 0;
    // "C2Spd = Herz for middle C. ST3 only uses lower 16 bits" (format doc);
    // st3play reads it as a uint16 and clamps at 65535.
    const c2spd = Math.min(view.getUint32(pointer + 32, true) & 0xffff, 65535);

    const instrument: S3mInstrument = {
      name,
      dosFilename,
      kind,
      ...(kind === 'adlib'
        ? {
            adlibKind: typeByte === 2 ? ('melody' as const) : ('drum' as const),
            // D00..D0B at offsets 0x0D..0x18, then Vol @0x19, Dsk @0x1A
            // (ST3.01b format doc, "adlib instrument format").
            oplRegisters: Array.from({ length: 12 }, (_, i) => buffer[pointer + 13 + i] ?? 0),
            adlibVolume: buffer[pointer + 25] ?? 0,
          }
        : {}),
      length,
      loopStart,
      loopEnd,
      // Bit 0 = loop on (OpenMPT smpLoop). S3M has no ping-pong loop.
      loopEnabled: kind === 'pcm' && (sampleFlags & 0x01) !== 0,
      volume,
      packed,
      stereo: (sampleFlags & 0x02) !== 0,
      bits16: (sampleFlags & 0x04) !== 0,
      c2spd,
      data: new Float32Array(0),
    };

    // Sample data is decoded in a second pass below, once every header is
    // parsed: the data position comes from each header's own memseg bytes,
    // so headers must all be read first (sequential layout: headers, then
    // data -- the format doc's "practical standard order").
    instruments.push(instrument);
  }

  // Second pass for sample data: decodeSample above needs the real data
  // offset (memseg), not the header offset. Walk sequentially like the XM
  // importer does and assert parity in tests; here read memseg directly.
  for (let i = 0; i < instruments.length; i++) {
    const instrument = instruments[i]!;
    if (instrument.kind !== 'pcm') continue;
    const pointer = instrumentPointers[i]!;
    if (pointer + 80 > buffer.byteLength) continue;
    const b0 = buffer[pointer + 13] ?? 0;
    const b1 = buffer[pointer + 14] ?? 0;
    const b2 = buffer[pointer + 15] ?? 0;
    // OpenMPT S3MSampleHeader::GetSampleOffset.
    const dataOffset = (b1 << 4) | (b2 << 12) | (b0 << 20);
    instrument.data = decodeSample(
      buffer,
      dataOffset,
      instrument,
      formatVersion === 1,
    );
  }

  return {
    title,
    trackerVersion,
    formatVersion,
    numChannels: 32,
    channelSettings,
    ...(defaultPans ? { defaultPans } : {}),
    hasPanningTable,
    orders,
    songLength,
    patterns,
    instruments,
    flags,
    amigaLimits: (flags & 0x10) !== 0,
    fastVolumeSlides: (flags & 0x40) !== 0,
    st2Vibrato: (flags & 0x01) !== 0,
    amigaSlidesBitSet: (flags & 0x04) !== 0,
    globalVolume,
    initialSpeed,
    initialTempo,
    masterVolume,
    masterStereo: (masterVolume & 0x80) !== 0,
    hasCustomData: special !== 0,
  };
}
