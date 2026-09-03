/**
 * Builds synthetic S3M files to the ST3.01b format description's offsets, so
 * the parser and the importer can both be tested without checking a real
 * (copyrighted) module into the repo. Shared by s3m-parser.test.ts and
 * s3m-import.test.ts.
 *
 * Layout reference: modland "Scream Tracker v3.01b (.s3m).txt" -- header
 * (0x40 bytes) + 32 channel-settings bytes, then the order table, sample
 * parapointers, pattern parapointers, optional panning table, then sample
 * headers, patterns and sample data, each 16-byte aligned.
 */
export interface S3mCellSpec {
  /** Raw file note byte (0x00 = C-1, 0xFE = key off, 0xFF = none). */
  note?: number;
  /** 1-based instrument number. */
  instrument?: number;
  /** Raw volume byte (0..64, 255 = none). */
  volume?: number;
  /** Raw command byte (letter - 0x40). */
  effect?: number;
  param?: number;
}

export interface PcmSampleSpec {
  /** Absolute PCM frames; stored unsigned 8-bit (version 2). */
  frames?: number[];
  /** Signed 16-bit LE frames (16-bit sample flag). */
  frames16?: number[];
  name?: string;
  volume?: number;
  c2spd?: number;
  loop?: boolean;
  loopStart?: number;
  loopEnd?: number;
  /** 16-bit sample flag (bit 2). */
  bits16?: boolean;
  /** Stereo flag (bit 2 / bit 1): warn-and-skip. */
  stereo?: boolean;
  /** DP30AD1F packing flag. */
  packed?: boolean;
}

export interface AdlibSpec {
  name?: string;
  /** D00..D0B register bytes. */
  registers?: number[];
  volume?: number;
  c2spd?: number;
  /** Sample type byte: 2 = melody, 3+ = drum. */
  type?: number;
}

export interface S3mSpec {
  title?: string;
  flags?: number;
  cwtv?: number;
  formatVersion?: number;
  globalVolume?: number;
  speed?: number;
  tempo?: number;
  masterVolume?: number;
  special?: number;
  /** All 32 settings bytes; missing entries stay 0xFF. */
  channelSettings?: number[];
  /** Presence of the table is signalled by byte 0x35 == 0xFC. */
  panningTable?: number[];
  orders?: number[];
  /** patterns[p][row][channel]. Rows beyond the given array are empty. */
  patterns?: Array<Array<Array<S3mCellSpec | undefined>>>;
  instruments?: Array<PcmSampleSpec | AdlibSpec>;
}

class ByteWriter {
  private bytes: number[] = [];

  u8(v: number) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }
  u32(v: number) {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
    return this;
  }
  ascii(text: string, length: number) {
    for (let i = 0; i < length; i++) {
      this.bytes.push(i < text.length ? text.charCodeAt(i) : 0);
    }
    return this;
  }
  raw(values: number[]) {
    for (const v of values) this.bytes.push(v & 0xff);
    return this;
  }
  get length() {
    return this.bytes.length;
  }
  /** Pad to a 16-byte paragraph boundary. */
  align16() {
    while (this.bytes.length % 16 !== 0) this.bytes.push(0);
    return this;
  }
  at(offset: number, value: number) {
    this.bytes[offset] = value & 0xff;
  }
  setU16(offset: number, value: number) {
    this.bytes[offset] = value & 0xff;
    this.bytes[offset + 1] = (value >> 8) & 0xff;
  }
  toUint8Array() {
    return new Uint8Array(this.bytes);
  }
  get currentOffset() {
    return this.bytes.length;
  }
}

function isAdlib(spec: PcmSampleSpec | AdlibSpec): spec is AdlibSpec {
  return (spec as AdlibSpec).registers !== undefined || (spec as AdlibSpec).type !== undefined;
}

/**
 * Pack one pattern's rows into S3M run-length form.
 *
 * Every non-empty cell is written explicitly; every row is terminated by the
 * 0x00 end-of-row marker, and the pattern opens with its u16 packed size.
 */
export function packS3mPattern(rows: Array<Array<S3mCellSpec | undefined>>): number[] {
  const body: number[] = [];
  for (let row = 0; row < 64; row++) {
    const cells = rows[row] ?? [];
    cells.forEach((cell, channel) => {
      if (!cell) return;
      if (
        cell.note === undefined &&
        !cell.instrument &&
        cell.volume === undefined &&
        !cell.effect
      ) {
        return;
      }
      let flag = channel & 0x1f;
      if (cell.note !== undefined || cell.instrument) flag |= 0x20;
      if (cell.volume !== undefined) flag |= 0x40;
      if (cell.effect || cell.param) flag |= 0x80;
      body.push(flag);
      if (flag & 0x20) {
        body.push(cell.note ?? 0xff);
        body.push(cell.instrument ?? 0);
      }
      if (flag & 0x40) body.push(cell.volume ?? 0xff);
      if (flag & 0x80) {
        body.push(cell.effect ?? 0);
        body.push(cell.param ?? 0);
      }
    });
    body.push(0x00); // end of row
  }
  return body;
}

export interface BuiltS3m {
  buffer: ArrayBuffer;
  bytes: Uint8Array;
}

export function buildS3m(spec: S3mSpec): BuiltS3m {
  const w = new ByteWriter();
  const orders = spec.orders ?? [0];
  const ordNum = orders.length;
  const smpNum = spec.instruments?.length ?? 0;
  const patNum = spec.patterns?.length ?? 0;
  const hasPanning = spec.panningTable !== undefined;

  // --- header (0x40 bytes) ---
  w.ascii(spec.title ?? 'Synthetic S3M', 28);
  w.u8(0x1a); // DOS EOF marker
  w.u8(0x10); // fileType: ST3 module
  w.raw([0, 0]); // reserved1
  w.u16(ordNum);
  w.u16(smpNum);
  w.u16(patNum);
  w.u16(spec.flags ?? 0);
  w.u16(spec.cwtv ?? 0x1320); // ST3.20
  w.u16(spec.formatVersion ?? 2); // new version = unsigned samples
  w.ascii('SCRM', 4);
  w.u8(spec.globalVolume ?? 64);
  w.u8(spec.speed ?? 6);
  w.u8(spec.tempo ?? 125);
  w.u8(spec.masterVolume ?? 0xb0); // stereo bit set, like a default ST3 save
  w.u8(16); // ultraClicks
  w.u8(hasPanning ? 0xfc : 0x00);
  w.raw([0, 0, 0, 0, 0, 0, 0, 0]); // reserved2/3/4
  w.u16(spec.special ?? 0);
  // --- channel settings (32 bytes) ---
  const settings = spec.channelSettings ?? [];
  for (let ch = 0; ch < 32; ch++) {
    w.u8(settings[ch] ?? 0xff);
  }

  // --- order table ---
  for (const order of orders) w.u8(order);

  // --- parapointer placeholders (patched once the sections are laid out) ---
  const samplePointerOffset = w.currentOffset;
  for (let i = 0; i < smpNum; i++) w.u16(0);
  const patternPointerOffset = w.currentOffset;
  for (let i = 0; i < patNum; i++) w.u16(0);
  if (hasPanning) {
    for (let ch = 0; ch < 32; ch++) w.u8(spec.panningTable![ch] ?? 0);
  }
  w.align16();

  // --- sample headers (80 bytes each, 16-byte aligned) ---
  const sampleHeaderOffsets: number[] = [];
  const sampleDataSpecs: Array<PcmSampleSpec | undefined> = [];
  for (const instrument of spec.instruments ?? []) {
    w.align16();
    sampleHeaderOffsets.push(w.currentOffset);
    if (isAdlib(instrument)) {
      w.u8(instrument.type ?? 2); // sampleType
      w.ascii('', 12); // dos filename
      // D00..D0B at 0x0D..0x18, Vol @ 0x19, Dsk @ 0x1A, 2 reserved (ST3.01b
      // format doc, "adlib instrument format") -- same header size as PCM.
      for (let i = 0; i < 12; i++) w.u8((instrument.registers ?? [])[i] ?? 0);
      w.u8(instrument.volume ?? 64); // Vol
      w.u8(0); // Dsk
      w.raw([0, 0, 0, 0, 0]); // 2 reserved + 3 pad: C2Spd sits at 0x20 like PCM
      w.u32(instrument.c2spd ?? 8363);
      w.raw([0, 0, 0, 0]); // reserved2
      w.u16(0); w.u16(0); w.u32(0); // gus/sb/lastUsed
      w.ascii(instrument.name ?? '', 28);
      w.ascii('SCRI', 4);
      sampleDataSpecs.push(undefined);
    } else {
      const s = instrument as PcmSampleSpec;
      const bits16 = s.bits16 ?? s.frames16 !== undefined;
      const frameCount = bits16
        ? (s.frames16?.length ?? 0)
        : (s.frames?.length ?? 0);
      w.u8(1); // sampleType: PCM
      w.ascii('', 12); // dos filename
      w.raw([0, 0, 0]); // memseg (patched below)
      w.u32(frameCount); // length in frames
      w.u32(s.loopStart ?? 0);
      w.u32(s.loopEnd ?? 0);
      w.u8(s.volume ?? 64);
      w.u8(0); // reserved
      w.u8(s.packed ? 1 : 0); // pack
      const flags = (s.loop ? 0x01 : 0) | (s.stereo ? 0x02 : 0) | (bits16 ? 0x04 : 0);
      w.u8(flags);
      w.u32(s.c2spd ?? 8363);
      w.raw([0, 0, 0, 0]); // reserved2
      w.u16(0); w.u16(0); w.u32(0); // gus/sb/lastUsed
      w.ascii(s.name ?? '', 28);
      w.ascii('SCRS', 4);
      sampleDataSpecs.push(s);
    }
  }

  // --- patterns ---
  const patternOffsets: number[] = [];
  for (const rows of spec.patterns ?? []) {
    w.align16();
    patternOffsets.push(w.currentOffset);
    const packed = packS3mPattern(rows);
    w.u16(packed.length);
    w.raw(packed);
  }

  // --- sample data (16-byte aligned paragraphs) ---
  const dataOffsets: number[] = [];
  for (const spec of sampleDataSpecs) {
    if (!spec || isAdlib(spec)) {
      dataOffsets.push(0);
      continue;
    }
    const s = spec as PcmSampleSpec;
    w.align16();
    dataOffsets.push(w.currentOffset);
    if (s.bits16 ?? s.frames16 !== undefined) {
      for (const frame of s.frames16 ?? []) {
        w.u8(frame & 0xff);
        w.u8((frame >> 8) & 0xff);
      }
    } else {
      for (const frame of s.frames ?? []) {
        // unsigned 8-bit, centred on 128; +1.0 clamps to 255 (127/128 after
        // decode -- the format has no exact +1.0 byte).
        w.u8(Math.max(0, Math.min(255, Math.round(frame * 128) + 128)));
      }
    }
  }

  // --- patch the parapointers and memseg bytes ---
  for (let i = 0; i < smpNum; i++) {
    w.setU16(samplePointerOffset + i * 2, Math.floor(sampleHeaderOffsets[i]! / 16));
    const s = sampleDataSpecs[i];
    if (s && !isAdlib(s) && dataOffsets[i]! > 0) {
      // OpenMPT GetSampleOffset packing: (b1 << 4) | (b2 << 12) | (b0 << 20)
      const off = dataOffsets[i]!;
      const b0 = (off >> 20) & 0xff;
      const b1 = (off >> 4) & 0xff;
      const b2 = (off >> 12) & 0xff;
      const base = sampleHeaderOffsets[i]!;
      w.at(base + 13, b0);
      w.at(base + 14, b1);
      w.at(base + 15, b2);
    }
  }
  for (let i = 0; i < patNum; i++) {
    w.setU16(patternPointerOffset + i * 2, Math.floor(patternOffsets[i]! / 16));
  }

  const bytes = w.toUint8Array();

  return { bytes, buffer: bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer };
}

/** A convenience for tests: the empty cell constant. */
export function s3mCell(spec: S3mCellSpec): S3mCellSpec {
  return spec;
}
