import { describe, it, expect } from 'vitest';
import {
  looksLikeXm,
  parseXm,
  XM_KEY_OFF,
  type XmPatternCell,
} from '../../packages/tracker-playback/src/formats/xm';

/**
 * Builds synthetic XM files so the parser can be checked against the layout
 * without needing a real module checked into the repo. Offsets mirror the
 * XM 1.04 spec; see formats/xm.ts for the same references.
 */
const XM_SIGNATURE = 'Extended Module: ';

interface SampleSpec {
  /** Absolute PCM frames; the builder delta-encodes them. */
  frames: number[];
  bits?: 8 | 16;
  volume?: number;
  finetune?: number;
  relativeNote?: number;
  panning?: number;
  /** 0 none, 1 forward, 2 pingpong */
  loopType?: number;
  loopStartFrames?: number;
  loopLengthFrames?: number;
  name?: string;
}

interface InstrumentSpec {
  name?: string;
  samples?: SampleSpec[];
  keymap?: number[];
  volumeFadeout?: number;
  volumeEnvelope?: { points: Array<[number, number]>; type?: number; sustain?: number };
}

interface XmSpec {
  title?: string;
  numChannels?: number;
  linearFrequency?: boolean;
  speed?: number;
  bpm?: number;
  orders?: number[];
  songLength?: number;
  /** patterns[p][row][channel] */
  patterns?: Array<{ numRows: number; cells: XmPatternCell[][]; packed?: boolean }>;
  instruments?: InstrumentSpec[];
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
  toUint8Array() {
    return new Uint8Array(this.bytes);
  }
}

/** Delta-encode absolute frames the way XM stores them. */
function deltaEncode(frames: number[], bits: 8 | 16): number[] {
  const out: number[] = [];
  let previous = 0;
  for (const frame of frames) {
    const delta = frame - previous;
    previous = frame;
    if (bits === 16) {
      out.push(delta & 0xff, (delta >> 8) & 0xff);
    } else {
      out.push(delta & 0xff);
    }
  }
  return out;
}

function emptyCell(): XmPatternCell {
  return { note: 0, instrument: 0, volumeColumn: 0, effectType: 0, effectParam: 0 };
}

function buildXm(spec: XmSpec): Uint8Array {
  const numChannels = spec.numChannels ?? 4;
  const patterns = spec.patterns ?? [];
  const instruments = spec.instruments ?? [];
  const orders = spec.orders ?? [0];

  const w = new ByteWriter();
  w.ascii(XM_SIGNATURE, 17);
  w.ascii(spec.title ?? 'TEST XM', 20);
  w.u8(0x1a);
  w.ascii('FastTracker v2.00', 20);
  w.u16(0x0104);
  // Header size is measured from offset 60 and covers through the order table.
  w.u32(20 + 256);
  w.u16(spec.songLength ?? orders.length);
  w.u16(0); // restart position
  w.u16(numChannels);
  w.u16(patterns.length);
  w.u16(instruments.length);
  w.u16(spec.linearFrequency === false ? 0 : 1);
  w.u16(spec.speed ?? 6);
  w.u16(spec.bpm ?? 125);
  for (let i = 0; i < 256; i++) w.u8(orders[i] ?? 0);

  for (const pattern of patterns) {
    const data: number[] = [];
    for (let row = 0; row < pattern.numRows; row++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const cell = pattern.cells[row]?.[ch] ?? emptyCell();
        if (pattern.packed === false) {
          // Unpacked: note byte with the high bit clear, then four more.
          data.push(
            cell.note & 0x7f,
            cell.instrument,
            cell.volumeColumn,
            cell.effectType,
            cell.effectParam,
          );
        } else {
          let flags = 0x80;
          const payload: number[] = [];
          if (cell.note) {
            flags |= 0x01;
            payload.push(cell.note);
          }
          if (cell.instrument) {
            flags |= 0x02;
            payload.push(cell.instrument);
          }
          if (cell.volumeColumn) {
            flags |= 0x04;
            payload.push(cell.volumeColumn);
          }
          if (cell.effectType) {
            flags |= 0x08;
            payload.push(cell.effectType);
          }
          if (cell.effectParam) {
            flags |= 0x10;
            payload.push(cell.effectParam);
          }
          data.push(flags, ...payload);
        }
      }
    }

    w.u32(9); // pattern header length
    w.u8(0); // packing type
    w.u16(pattern.numRows);
    w.u16(data.length);
    w.raw(data);
  }

  for (const instrument of instruments) {
    const samples = instrument.samples ?? [];
    const instrumentHeaderSize = 263;
    const instrumentStart = w.length;

    w.u32(instrumentHeaderSize);
    w.ascii(instrument.name ?? '', 22);
    w.u8(0); // type
    w.u16(samples.length);

    // 29..: only present when the instrument has samples, but the builder
    // always writes the full header so sizes stay predictable.
    w.u32(40); // sample header size
    const keymap = instrument.keymap ?? new Array(96).fill(0);
    for (let n = 0; n < 96; n++) w.u8(keymap[n] ?? 0);

    const volPoints = instrument.volumeEnvelope?.points ?? [];
    for (let i = 0; i < 12; i++) {
      w.u16(volPoints[i]?.[0] ?? 0);
      w.u16(volPoints[i]?.[1] ?? 0);
    }
    for (let i = 0; i < 12; i++) {
      w.u16(0);
      w.u16(0);
    }
    w.u8(volPoints.length); // number of volume points
    w.u8(0); // number of panning points
    w.u8(instrument.volumeEnvelope?.sustain ?? 0);
    w.u8(0); // volume loop start
    w.u8(0); // volume loop end
    w.u8(0); // panning sustain
    w.u8(0); // panning loop start
    w.u8(0); // panning loop end
    w.u8(instrument.volumeEnvelope?.type ?? 0);
    w.u8(0); // panning type
    w.u8(0); // vibrato type
    w.u8(0); // vibrato sweep
    w.u8(0); // vibrato depth
    w.u8(0); // vibrato rate
    w.u16(instrument.volumeFadeout ?? 0);
    w.u16(0); // reserved
    // Pad to the declared instrument header size, measured from where this
    // instrument began rather than from a hand-counted field total.
    while (w.length - instrumentStart < instrumentHeaderSize) w.u8(0);

    const encoded: number[][] = [];
    for (const sample of samples) {
      const bits = sample.bits ?? 8;
      const bytesPerFrame = bits === 16 ? 2 : 1;
      const body = deltaEncode(sample.frames, bits);
      encoded.push(body);

      w.u32(sample.frames.length * bytesPerFrame); // length in bytes
      w.u32((sample.loopStartFrames ?? 0) * bytesPerFrame);
      w.u32((sample.loopLengthFrames ?? 0) * bytesPerFrame);
      w.u8(sample.volume ?? 64);
      w.u8(sample.finetune ?? 0);
      w.u8((sample.loopType ?? 0) | (bits === 16 ? 0x10 : 0));
      w.u8(sample.panning ?? 128);
      w.u8(sample.relativeNote ?? 0);
      w.u8(0); // reserved
      w.ascii(sample.name ?? '', 22);
    }

    for (const body of encoded) w.raw(body);
  }

  return w.toUint8Array();
}

describe('looksLikeXm', () => {
  it('accepts a well-formed XM', () => {
    expect(looksLikeXm(buildXm({}))).toBe(true);
  });

  it('rejects a buffer without the signature', () => {
    const buf = buildXm({});
    buf[0] = 0x00;
    expect(looksLikeXm(buf)).toBe(false);
  });

  it('rejects a buffer missing the 0x1A marker', () => {
    const buf = buildXm({});
    buf[37] = 0x00;
    expect(looksLikeXm(buf)).toBe(false);
  });

  it('rejects a too-short buffer', () => {
    expect(looksLikeXm(new Uint8Array(16))).toBe(false);
  });
});

describe('parseXm header', () => {
  it('reads the module metadata', () => {
    const song = parseXm(
      buildXm({ title: 'MY SONG', numChannels: 8, speed: 3, bpm: 140 }),
    );

    expect(song.title).toBe('MY SONG');
    expect(song.numChannels).toBe(8);
    expect(song.defaultSpeed).toBe(3);
    expect(song.defaultBpm).toBe(140);
    expect(song.trackerName).toBe('FastTracker v2.00');
  });

  it('reads the frequency table flag', () => {
    expect(parseXm(buildXm({ linearFrequency: true })).linearFrequency).toBe(true);
    expect(parseXm(buildXm({ linearFrequency: false })).linearFrequency).toBe(false);
  });

  it('reads the order table and song length', () => {
    const song = parseXm(buildXm({ orders: [0, 1, 1, 0], songLength: 4 }));
    expect(song.songLength).toBe(4);
    expect(song.orders.slice(0, 4)).toEqual([0, 1, 1, 0]);
  });

  it('rejects an out-of-range channel count', () => {
    expect(() => parseXm(buildXm({ numChannels: 64 }))).toThrow(/channel count/);
  });
});

describe('parseXm patterns', () => {
  function cellAt(note: number, extra: Partial<XmPatternCell> = {}): XmPatternCell {
    return { ...emptyCell(), note, ...extra };
  }

  it('decodes packed cells', () => {
    const cells: XmPatternCell[][] = [
      [
        cellAt(49, { instrument: 3, volumeColumn: 0x50, effectType: 0x0a, effectParam: 0x0f }),
        emptyCell(),
      ],
    ];
    const song = parseXm(
      buildXm({ numChannels: 2, patterns: [{ numRows: 1, cells }] }),
    );

    const cell = song.patterns[0]!.rows[0]![0]!;
    expect(cell.note).toBe(49);
    expect(cell.instrument).toBe(3);
    expect(cell.volumeColumn).toBe(0x50);
    expect(cell.effectType).toBe(0x0a);
    expect(cell.effectParam).toBe(0x0f);
    // The untouched channel stays empty.
    expect(song.patterns[0]!.rows[0]![1]).toEqual(emptyCell());
  });

  it('decodes unpacked cells', () => {
    const cells: XmPatternCell[][] = [
      [cellAt(60, { instrument: 1, effectType: 0x0c, effectParam: 0x20 }), emptyCell()],
    ];
    const song = parseXm(
      buildXm({ numChannels: 2, patterns: [{ numRows: 1, cells, packed: false }] }),
    );

    const cell = song.patterns[0]!.rows[0]![0]!;
    expect(cell.note).toBe(60);
    expect(cell.instrument).toBe(1);
    expect(cell.effectType).toBe(0x0c);
    expect(cell.effectParam).toBe(0x20);
  });

  it('supports per-pattern row counts', () => {
    const song = parseXm(
      buildXm({
        numChannels: 1,
        patterns: [
          { numRows: 16, cells: [] },
          { numRows: 128, cells: [] },
        ],
      }),
    );

    expect(song.patterns[0]!.numRows).toBe(16);
    expect(song.patterns[0]!.rows).toHaveLength(16);
    expect(song.patterns[1]!.numRows).toBe(128);
    expect(song.patterns[1]!.rows).toHaveLength(128);
  });

  it('treats a zero-length packed pattern as all-empty', () => {
    const song = parseXm(
      buildXm({ numChannels: 2, patterns: [{ numRows: 4, cells: [] }] }),
    );

    expect(song.patterns[0]!.rows).toHaveLength(4);
    for (const row of song.patterns[0]!.rows) {
      for (const cell of row) expect(cell).toEqual(emptyCell());
    }
  });

  it('carries the key-off note through', () => {
    const song = parseXm(
      buildXm({
        numChannels: 1,
        patterns: [{ numRows: 1, cells: [[cellAt(XM_KEY_OFF)]] }],
      }),
    );

    expect(song.patterns[0]!.rows[0]![0]!.note).toBe(XM_KEY_OFF);
  });
});

describe('parseXm instruments and samples', () => {
  it('reads instrument metadata and the note keymap', () => {
    const keymap = new Array(96).fill(0);
    keymap[48] = 1; // C-4 plays the second sample
    const song = parseXm(
      buildXm({
        instruments: [
          {
            name: 'PIANO',
            keymap,
            volumeFadeout: 512,
            samples: [{ frames: [0] }, { frames: [0] }],
          },
        ],
      }),
    );

    const instrument = song.instruments[0]!;
    expect(instrument.name).toBe('PIANO');
    expect(instrument.samples).toHaveLength(2);
    expect(instrument.keymap[48]).toBe(1);
    expect(instrument.keymap[0]).toBe(0);
    expect(instrument.volumeFadeout).toBe(512);
  });

  it('decodes 8-bit delta samples back to their absolute values', () => {
    const frames = [0, 10, 40, 30, -20, -100];
    const song = parseXm(
      buildXm({ instruments: [{ samples: [{ frames, bits: 8 }] }] }),
    );

    const data = song.instruments[0]!.samples[0]!.data;
    expect(data).toHaveLength(frames.length);
    frames.forEach((expected, i) => {
      expect(data[i]).toBeCloseTo(expected / 128, 6);
    });
  });

  it('decodes 16-bit delta samples back to their absolute values', () => {
    const frames = [0, 1000, -5000, 32000, -32000];
    const song = parseXm(
      buildXm({ instruments: [{ samples: [{ frames, bits: 16 }] }] }),
    );

    const sample = song.instruments[0]!.samples[0]!;
    expect(sample.bits).toBe(16);
    expect(sample.length).toBe(frames.length);
    frames.forEach((expected, i) => {
      expect(sample.data[i]).toBeCloseTo(expected / 32768, 5);
    });
  });

  it('reads per-sample tuning, volume and loop settings', () => {
    const song = parseXm(
      buildXm({
        instruments: [
          {
            samples: [
              {
                frames: [0, 1, 2, 3, 4, 5, 6, 7],
                volume: 48,
                finetune: -16,
                relativeNote: -12,
                panning: 200,
                loopType: 2,
                loopStartFrames: 2,
                loopLengthFrames: 4,
                name: 'LOOPED',
              },
            ],
          },
        ],
      }),
    );

    const sample = song.instruments[0]!.samples[0]!;
    expect(sample.name).toBe('LOOPED');
    expect(sample.volume).toBe(48);
    expect(sample.finetune).toBe(-16);
    expect(sample.relativeNote).toBe(-12);
    expect(sample.panning).toBe(200);
    expect(sample.loopType).toBe('pingpong');
    expect(sample.loopStart).toBe(2);
    expect(sample.loopLength).toBe(4);
  });

  it('converts 16-bit loop points from bytes to frames', () => {
    // Loop points are stored in bytes, so a 16-bit sample halves them.
    const song = parseXm(
      buildXm({
        instruments: [
          {
            samples: [
              {
                frames: [0, 1, 2, 3, 4, 5, 6, 7],
                bits: 16,
                loopType: 1,
                loopStartFrames: 2,
                loopLengthFrames: 4,
              },
            ],
          },
        ],
      }),
    );

    const sample = song.instruments[0]!.samples[0]!;
    expect(sample.loopStart).toBe(2);
    expect(sample.loopLength).toBe(4);
    expect(sample.length).toBe(8);
  });

  it('reads the volume envelope', () => {
    const song = parseXm(
      buildXm({
        instruments: [
          {
            samples: [{ frames: [0] }],
            volumeEnvelope: {
              points: [
                [0, 64],
                [20, 32],
                [50, 0],
              ],
              // bit0 on, bit1 sustain
              type: 0x03,
              sustain: 1,
            },
          },
        ],
      }),
    );

    const envelope = song.instruments[0]!.volumeEnvelope;
    expect(envelope.enabled).toBe(true);
    expect(envelope.sustainEnabled).toBe(true);
    expect(envelope.loopEnabled).toBe(false);
    expect(envelope.sustainPoint).toBe(1);
    expect(envelope.points).toEqual([
      { frame: 0, value: 64 },
      { frame: 20, value: 32 },
      { frame: 50, value: 0 },
    ]);
  });

  it('handles an instrument with no samples', () => {
    const song = parseXm(buildXm({ instruments: [{ name: 'EMPTY', samples: [] }] }));
    expect(song.instruments[0]!.samples).toHaveLength(0);
    expect(song.instruments[0]!.name).toBe('EMPTY');
  });

  it('reads several instruments in sequence', () => {
    // Each instrument's sample data sits between its header and the next
    // instrument, so a size mistake corrupts everything downstream.
    const song = parseXm(
      buildXm({
        instruments: [
          { name: 'ONE', samples: [{ frames: [0, 5, 10] }] },
          { name: 'TWO', samples: [{ frames: [0, -5], bits: 16 }] },
          { name: 'THREE', samples: [{ frames: [0, 1, 2, 3] }] },
        ],
      }),
    );

    expect(song.instruments.map((i) => i.name)).toEqual(['ONE', 'TWO', 'THREE']);
    expect(song.instruments[0]!.samples[0]!.data).toHaveLength(3);
    expect(song.instruments[1]!.samples[0]!.data).toHaveLength(2);
    expect(song.instruments[2]!.samples[0]!.data).toHaveLength(4);
    expect(song.instruments[2]!.samples[0]!.data[3]).toBeCloseTo(3 / 128, 6);
  });
});
