import { describe, it, expect } from 'vitest';
import {
  looksLikeXm,
  parseXm,
  XM_KEY_OFF,
  type XmPatternCell,
} from '@another-synth/tracker-playback';
import { buildXm, emptyCell } from './helpers/xm-builder';

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
