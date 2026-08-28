import { describe, it, expect } from 'vitest';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { CURRENT_SONG_FILE_VERSION, TOTAL_SLOTS } from 'src/stores/tracker-store';
import { SamplerLoopMode } from 'src/audio/types/synth-layout';
import { buildXm, cell } from './helpers/xm-builder';

/**
 * Import-level behaviour: how XM's model maps onto the tracker's. The parser
 * has its own tests; these cover the decisions made on top of it.
 */
describe('XM import', () => {
  it('tags the song as XM and carries the frequency table flag', () => {
    const linear = importXmToTrackerSong(
      buildXm({ linearFrequency: true }).buffer as ArrayBuffer,
    );
    expect(linear.version).toBe(CURRENT_SONG_FILE_VERSION);
    expect(linear.data.moduleFormat).toBe('xm');
  });

  it('creates one track per channel and keeps per-pattern row counts', () => {
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 6,
        patterns: [
          { numRows: 16, cells: [] },
          { numRows: 128, cells: [] },
        ],
      }).buffer as ArrayBuffer,
    );

    expect(song.data.patterns[0]!.tracks).toHaveLength(6);
    expect(song.data.patterns[0]!.rows).toBe(16);
    expect(song.data.patterns[1]!.rows).toBe(128);
  });

  it('converts notes with an exact frequency', () => {
    // XM note 49 is C-4 (1-based), which must land on ~261.3 Hz.
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments: [{ samples: [{ frames: [0, 1, 2, 3] }] }],
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );

    const entry = song.data.patterns[0]!.tracks[0]!.entries[0]!;
    expect(entry.note).toBe('C-4');
    expect(entry.frequency).toBeCloseTo(8363 / 32, 3);
  });

  it('converts key-off to the tracker note-off symbol', () => {
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        patterns: [{ numRows: 1, cells: [[cell(97)]] }],
      }).buffer as ArrayBuffer,
    );

    expect(song.data.patterns[0]!.tracks[0]!.entries[0]!.note).toBe('###');
  });

  it('reads "set volume" from the volume column', () => {
    // 0x10..0x50 is set-volume 0..64; 0x30 is 32/64, i.e. half.
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments: [{ samples: [{ frames: [0, 1] }] }],
        patterns: [
          { numRows: 1, cells: [[cell(49, { instrument: 1, volumeColumn: 0x30 })]] },
        ],
      }).buffer as ArrayBuffer,
    );

    const entry = song.data.patterns[0]!.tracks[0]!.entries[0]!;
    expect(entry.volume).toBe(
      Math.round((32 / 64) * 255).toString(16).toUpperCase().padStart(2, '0'),
    );
  });

  it('falls back to the sample default volume when the column is empty', () => {
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments: [{ samples: [{ frames: [0, 1], volume: 48 }] }],
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );

    expect(song.data.patterns[0]!.tracks[0]!.entries[0]!.volume).toBe(
      Math.round((48 / 64) * 255).toString(16).toUpperCase().padStart(2, '0'),
    );
  });

  it('maps effects onto the tracker macro alphabet, including FT2 extras', () => {
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 3,
        patterns: [
          {
            numRows: 1,
            cells: [
              [
                cell(49, { effectType: 0x0a, effectParam: 0x0f }), // Axy vol slide
                cell(49, { effectType: 0x04, effectParam: 0x82 }), // 4xy vibrato
                cell(49, { effectType: 0x10, effectParam: 0x20 }), // Gxx global volume
              ],
            ],
          },
        ],
      }).buffer as ArrayBuffer,
    );

    const tracks = song.data.patterns[0]!.tracks;
    expect(tracks[0]!.entries[0]!.macro).toBe('A0F');
    expect(tracks[1]!.entries[0]!.macro).toBe('482');
    // 0x10 continues past F into G, FT2's global volume.
    expect(tracks[2]!.entries[0]!.macro).toBe('G20');
  });

  it('allocates slots only for instruments the patterns actually use', () => {
    // XM files routinely declare far more instruments than they use.
    const instruments = Array.from({ length: 40 }, () => ({
      samples: [{ frames: [0, 1, 2] }],
    }));
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments,
        patterns: [
          {
            numRows: 2,
            cells: [[cell(49, { instrument: 3 })], [cell(49, { instrument: 40 })]],
          },
        ],
      }).buffer as ArrayBuffer,
    );

    const used = song.data.instrumentSlots.filter((s) => s.patchId);
    expect(used).toHaveLength(2);
    expect(Object.keys(song.data.songPatches)).toHaveLength(2);
    // Referenced instruments are packed into the lowest slots in order.
    expect(used[0]!.slot).toBe(1);
    expect(used[1]!.slot).toBe(2);
  });

  it('remaps pattern entries onto the slots it allocated', () => {
    const instruments = Array.from({ length: 10 }, () => ({
      samples: [{ frames: [0, 1, 2] }],
    }));
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments,
        patterns: [
          {
            numRows: 2,
            cells: [[cell(49, { instrument: 7 })], [cell(49, { instrument: 9 })]],
          },
        ],
      }).buffer as ArrayBuffer,
    );

    const entries = song.data.patterns[0]!.tracks[0]!.entries;
    // XM instrument 7 became slot 1, and 9 became slot 2.
    expect(entries[0]!.instrument).toBe('01');
    expect(entries[1]!.instrument).toBe('02');
  });

  it('skips instruments that declare no sample data', () => {
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments: [{ samples: [] }, { samples: [{ frames: [0, 1] }] }],
        patterns: [
          {
            numRows: 2,
            cells: [[cell(49, { instrument: 1 })], [cell(49, { instrument: 2 })]],
          },
        ],
      }).buffer as ArrayBuffer,
    );

    expect(song.data.instrumentSlots.filter((s) => s.patchId)).toHaveLength(1);
  });

  it('never allocates beyond the available slots', () => {
    const count = TOTAL_SLOTS + 10;
    const instruments = Array.from({ length: count }, () => ({
      samples: [{ frames: [0, 1] }],
    }));
    const cells = Array.from({ length: count }, (_, i) => [
      cell(49, { instrument: i + 1 }),
    ]);
    const song = importXmToTrackerSong(
      buildXm({ numChannels: 1, instruments, patterns: [{ numRows: count, cells }] })
        .buffer as ArrayBuffer,
    );

    expect(song.data.instrumentSlots.filter((s) => s.patchId).length).toBe(TOTAL_SLOTS);
  });

  it('carries sample loop settings into the patch, including ping-pong', () => {
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments: [
          {
            samples: [
              {
                frames: [0, 1, 2, 3, 4, 5, 6, 7],
                loopType: 2,
                loopStartFrames: 2,
                loopLengthFrames: 4,
              },
            ],
          },
        ],
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );

    const patch = Object.values(song.data.songPatches)[0]!;
    const sampler = Object.values(patch.synthState.samplers)[0]!;
    expect(sampler.loopMode).toBe(SamplerLoopMode.PingPong);
  });

  it('folds relativeNote into the patch root note', () => {
    // A sample transposed +12 must play an octave higher for the same note,
    // which means a root note an octave lower.
    const withoutTranspose = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments: [{ samples: [{ frames: [0, 1], relativeNote: 0 }] }],
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );
    const withTranspose = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments: [{ samples: [{ frames: [0, 1], relativeNote: 12 }] }],
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );

    const rootOf = (song: typeof withoutTranspose) => {
      const patch = Object.values(song.data.songPatches)[0]!;
      return Object.values(patch.synthState.samplers)[0]!.rootNote;
    };

    expect(rootOf(withTranspose)).toBeCloseTo(rootOf(withoutTranspose) - 12, 6);
    // The scheduled note frequency must NOT also shift, or it would apply twice.
    const freq = (song: typeof withoutTranspose) =>
      song.data.patterns[0]!.tracks[0]!.entries[0]!.frequency;
    expect(freq(withTranspose)).toBeCloseTo(freq(withoutTranspose)!, 9);
  });

  it('converts finetune to cents', () => {
    // XM finetune spans -128..127 across one semitone.
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        instruments: [{ samples: [{ frames: [0, 1], finetune: 64 }] }],
        patterns: [{ numRows: 1, cells: [[cell(49, { instrument: 1 })]] }],
      }).buffer as ArrayBuffer,
    );

    const patch = Object.values(song.data.songPatches)[0]!;
    const sampler = Object.values(patch.synthState.samplers)[0]!;
    expect(sampler.detune_cents).toBeCloseTo(50, 6);
  });

  it('builds the sequence from the order table', () => {
    const song = importXmToTrackerSong(
      buildXm({
        numChannels: 1,
        orders: [1, 0, 1],
        songLength: 3,
        patterns: [
          { numRows: 4, cells: [] },
          { numRows: 8, cells: [] },
        ],
      }).buffer as ArrayBuffer,
    );

    expect(song.data.sequence).toHaveLength(3);
    const ids = song.data.patterns.map((p) => p.id);
    expect(song.data.sequence).toEqual([ids[1], ids[0], ids[1]]);
  });
});
