/**
 * P5 -- S3M importer (`s3m-import.ts`), synthetic modules.
 *
 * Pins the invariants the XM importer ships with, carried across to S3M:
 * referenced-only slots (D76 guard), the root-note/c2spd derivation (D96's
 * c2spd finetune), the note anchors, the instrument-stamp exclusions
 * (D29/D55 class), the BCD pattern break, and the AdLib policy: parsed,
 * counted, warned, OPL register data preserved on inactive slots (Morten,
 * 2026-09-03), never played, never silently muted.
 */

import { describe, it, expect, vi } from 'vitest';
import { importS3mToTrackerSong } from '../audio/tracker/s3m-import';
import { buildS3m } from './helpers/s3m-builder';

function importS3m(spec: Parameters<typeof buildS3m>[0]) {
  const built = buildS3m(spec);
  const song = importS3mToTrackerSong(
    built.buffer.slice(0) as ArrayBuffer,
  );
  return { song, bytes: built.bytes };
}

/** The first entry on a pattern's track at a row. */
function entryAt(
  song: ReturnType<typeof importS3mToTrackerSong>,
  patternIndex: number,
  trackIndex: number,
  row: number,
) {
  return song.data.patterns[patternIndex]!.tracks[trackIndex]!.entries.find(
    (e) => e.row === row,
  );
}

const FOUR_PCM_CHANNELS = [0x00, 0x01, 0x08, 0x09];

describe('S3M import: slots and instruments', () => {
  it('allocates slots only for referenced PCM instruments, voice-counted', () => {
    const { song } = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [
        [
          [
            { note: 0x30, instrument: 1, volume: 40 },
            { note: 0x30, instrument: 1, volume: 40 },
            undefined,
            { note: 0x35, instrument: 2, volume: 40 },
          ],
          [{ effect: 0x01, param: 0x02 }],
        ],
      ],
      instruments: [
        { name: 'One', frames: [0, 0.25, -0.25, 0] },
        { name: 'Two', frames: [0, 0.25, -0.25, 0] },
        { name: 'Unused', frames: [0, 0.25, -0.25, 0] },
      ],
    });
    const used = song.data.instrumentSlots.filter((s) => s.patchId);
    expect(used).toHaveLength(2);
    // Instrument 1 is played on two distinct channels, instrument 2 on one.
    expect(used[0]!.patchName).toBe('One');
    // Instrument 1 is played on two distinct channels, instrument 2 on one:
    // one owned voice per channel that ever plays the instrument (D32/D42).
    const voices = Object.values(song.data.songPatches).map(
      (p) => (p as unknown as { synthState: { layout: { voiceCount: number } } }).synthState.layout.voiceCount,
    );
    expect(voices).toContain(2);
    expect(voices).toContain(1);
  });

  it('never maps an AdLib instrument into a playable slot', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { song } = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [
        [
          [
            { note: 0x30, instrument: 1, volume: 40 },
            undefined,
            { note: 0x30, instrument: 2, volume: 40 },
          ],
        ],
      ],
      instruments: [
        { name: 'PCM', frames: [0, 0.25, -0.25, 0] },
        { name: 'FM', registers: [0x20], volume: 40, type: 2 },
      ],
    });
    warn.mockRestore();
    const used = song.data.instrumentSlots.filter((s) => s.patchId);
    expect(used).toHaveLength(1);
    expect(used[0]!.patchName).toBe('PCM');
    // The AdLib slot is inactive (no patch), but its OPL data is preserved
    // for the future OPL instrument type (Morten, 2026-09-03).
    const adlibSlot = song.data.instrumentSlots.find((s) => s.oplData);
    expect(adlibSlot).toBeDefined();
    expect(adlibSlot!.patchId).toBeUndefined();
    expect(adlibSlot!.oplData!.registers[0]).toBe(0x20);
    expect(adlibSlot!.oplData!.registers).toHaveLength(12);
    expect(adlibSlot!.oplData!.kind).toBe('melody');
  });
});

describe('S3M import: pitch anchors', () => {
  it('maps file notes to MIDI: 0x00 = C-1, 0x39 = A-4, 0x40 = C-5', () => {
    const { song } = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [
        [
          [
            { note: 0x00, instrument: 1, volume: 40 },
            { note: 0x39, instrument: 1, volume: 40 },
            { note: 0x40, instrument: 1, volume: 40 },
          ],
        ],
      ],
      instruments: [{ frames: [0, 0.25, -0.25, 0] }],
    });
    expect(entryAt(song, 0, 0, 0)!.note).toBe('C-1');
    expect(entryAt(song, 0, 1, 0)!.note).toBe('A-4');
    expect(entryAt(song, 0, 2, 0)!.note).toBe('C-5');
  });

  it('schedules a C-5 note on a c2spd-8363 sample at 522.6 Hz', () => {
    const { song } = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [[[{ note: 0x40, instrument: 1, volume: 40 }]]],
      instruments: [{ frames: [0, 0.25, -0.25, 0], c2spd: 8363 }],
    });
    const entry = entryAt(song, 0, 0, 0)!;
    // 14317056 / 1712 / 16 -- the D96-sourced ST3 tuning.
    expect(entry.frequency).toBeCloseTo(522.66, 1);
  });

  it('folds c2spd into the root note: 16726 is exactly one octave down', () => {
    const base = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [[[{ note: 0x40, instrument: 1, volume: 40 }]]],
      instruments: [{ frames: [0, 0.25, -0.25, 0], c2spd: 8363 }],
    }).song;
    const octave = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [[[{ note: 0x40, instrument: 1, volume: 40 }]]],
      instruments: [{ frames: [0, 0.25, -0.25, 0], c2spd: 16726 }],
    }).song;

    const rootOf = (song: ReturnType<typeof importS3mToTrackerSong>) =>
      (
        Object.values(song.data.songPatches)[0] as unknown as {
          synthState: { samplers: Record<string, { rootNote: number }> };
        }
      ).synthState.samplers[Object.keys((Object.values(song.data.songPatches)[0] as unknown as { synthState: { samplers: Record<string, { rootNote: number }> } }).synthState.samplers)[0]!]!.rootNote;
    // S3M_ROOT_NOTE = 69 + 12*log2(44100/16/440) ~ 100.78, c2spd 8363 adds
    // nothing; 16726 is one octave (12 semitones) lower.
    expect(rootOf(base)).toBeCloseTo(69 + 12 * Math.log2(44100 / 16 / 440), 5);
    expect(rootOf(octave)).toBeCloseTo(rootOf(base) - 12, 5);
  });
});

describe('S3M import: entry rules', () => {
  it('does not stamp the instrument on tone-portamento rows', () => {
    const { song } = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [
        [
          [{ note: 0x30, instrument: 1, volume: 40 }],
          [{ note: 0x35, effect: 0x07, param: 0x20 }], // G20 tone porta
          [{ note: 0x35, effect: 0x0c, param: 0x20 }], // L20 tone porta + vol
        ],
      ],
      instruments: [{ frames: [0, 0.25, -0.25, 0] }],
    });
    expect(entryAt(song, 0, 0, 0)!.instrument).toBeDefined();
    expect(entryAt(song, 0, 0, 1)!.instrument).toBeUndefined();
    expect(entryAt(song, 0, 0, 2)!.instrument).toBeUndefined();
  });

  it('latches the instrument across an empty note for the next note row', () => {
    const { song } = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [
        [
          [{ note: 0x30, instrument: 1, volume: 40 }],
          [{ note: 0xff, instrument: 1 }], // instrument-only: latch
          [{ note: 0x35 }], // note without instrument: uses the latch
        ],
      ],
      instruments: [{ frames: [0, 0.25, -0.25, 0] }],
    });
    expect(entryAt(song, 0, 0, 2)!.instrument).toBeDefined();
  });

  it('imports the 0xFE key-off byte as the tracker note-off', () => {
    const { song } = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [[[{ note: 0xfe, instrument: 1 }]]],
      instruments: [{ frames: [0, 0.25, -0.25, 0] }],
    });
    expect(entryAt(song, 0, 0, 0)!.note).toBe('###');
  });

  it('decodes the BCD Cxx pattern break and drops out-of-range parameters', () => {
    const { song } = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [
        [
          [{ effect: 0x03, param: 0x20 }], // C20: ST3 BCD -> row 20
          [{ effect: 0x03, param: 0xff }], // CFF: hi/lo nibbles invalid -> ignored
          [{ effect: 0x03, param: 0x63 }], // C63: valid BCD -> row 63
        ],
      ],
      instruments: [],
    });
    const c20 = entryAt(song, 0, 0, 0)!;
    // The engine's patBreak reads paramX*10+paramY (decimal digits), which
    // the raw BCD byte already is: 0x20 -> 2*10+0 = row 20.
    expect(c20.effectCommand).toBe(0x03);
    expect(c20.effectParam).toBe(0x20);
    expect(entryAt(song, 0, 0, 1)).toBeUndefined();
    expect(entryAt(song, 0, 0, 2)!.effectParam).toBe(0x63);
  });

  it('derives the display macro from the raw byte (letter + param)', () => {
    const { song } = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [[[
        // A03: byte 0x01 = ST3 speed command, NOT ProTracker's portamento up.
        { effect: 0x01, param: 0x03 },
      ]]],
      instruments: [],
    });
    const entry = entryAt(song, 0, 0, 0)!;
    expect(entry.effectCommand).toBe(0x01);
    expect(entry.effectParam).toBe(0x03);
    expect(entry.macro).toBe('A03');
  });
});

describe('S3M import: song shape', () => {
  it('carries the header speed/tempo and walks orders with 254/255 policy', () => {
    const { song } = importS3m({
      channelSettings: FOUR_PCM_CHANNELS,
      speed: 5,
      tempo: 140,
      orders: [0, 254, 1, 255, 2],
      patterns: [[[]], [[{ effect: 0x01, param: 0x03 }]], [[]]],
    });
    expect(song.data.initialSpeed).toBe(5);
    expect(song.data.currentSong.bpm).toBe(140);
    // 255 terminates before the out-of-range order 2 is consulted.
    expect(song.data.sequence).toHaveLength(2);
  });

  it('carries the amiga-limits flag and the header global volume', () => {
    const { song } = importS3m({
      flags: 0x10,
      globalVolume: 32,
      channelSettings: FOUR_PCM_CHANNELS,
      cwtv: 0x1320,
      orders: [0],
      patterns: [[[]]],
      instruments: [],
    });
    expect(song.data.moduleFormat).toBe('s3m');
    expect(song.data.amigaLimits).toBe(true);
    expect(song.data.initialGlobalVolume).toBeCloseTo(0.5, 5);
  });

  it('treats a zero global volume on a pre-ST3.20 file as full (OpenMPT quirk)', () => {
    const { song } = importS3m({
      globalVolume: 0,
      cwtv: 0x1301,
      channelSettings: FOUR_PCM_CHANNELS,
      orders: [0],
      patterns: [[]],
    });
    // Absent means the default, full volume.
    expect(song.data.initialGlobalVolume ?? 1).toBe(1);
  });
});

describe('S3M import: the AdLib policy', () => {
  it('warns with the counts, keeps the rest intact, never mutes silently', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { song } = importS3m({
      // Channels 0/1 PCM, channel 2 = AdLib melody (type 16), channel 3 PCM.
      channelSettings: [0x00, 0x01, 0x10, 0x09],
      orders: [0],
      patterns: [
        [
          [
            { note: 0x30, instrument: 1, volume: 40 },
            { note: 0x30, instrument: 1, volume: 40 },
            { note: 0x30, instrument: 2, volume: 40 }, // FM note
            { note: 0x35, instrument: 1, volume: 40 },
          ],
        ],
      ],
      instruments: [
        { name: 'PCM', frames: [0, 0.25, -0.25, 0] },
        { name: 'FM', registers: [0x20, 0x11], volume: 33, type: 2 },
      ],
    });
    // 1. The warning carries the instrument count and note count.
    const warnings = warnSpy.mock.calls.map((args) => args.join(' '));
    warnSpy.mockRestore();
    const adlibWarning = warnings.find((w) => w.includes('AdLib instruments ignored'));
    expect(adlibWarning).toBeDefined();
    expect(adlibWarning).toContain('1 AdLib instruments ignored');
    expect(adlibWarning).toContain('1 notes on 1 AdLib channels');

    // 2. The rest of the module still imports: the PCM notes survive.
    const pcmEntries = song.data.patterns[0]!.tracks
      .flatMap((t) => t.entries);
    expect(pcmEntries).toHaveLength(3); // the FM cell is dropped after counting
    expect(entryAt(song, 0, 3, 0)!.instrument).toBeDefined();

    // 4. Not silently muted: the AdLib channel's track is EMPTY (no
    //    volume-0 rows, no entries at all).
    const adlibTrack = song.data.patterns[0]!.tracks[2]!;
    expect(adlibTrack.entries).toHaveLength(0);
  });
});

describe('a sample number reloads the channel volume, retrigger or not', () => {
  /**
   * Reported (Morten, 2026-09-04) as satellite_one.s3m's lead sounding "too
   * low volume and a bit muffled" on its Pattern 4. Channel 5 there is the
   * classic pumped lead: a note carrying instrument 4 and no volume byte,
   * against volume rows that walk the channel down between notes. Every one
   * of those notes is a tone portamento, so the reload never happened and the
   * lead sat 10 dB under where it was written.
   *
   * D55's rule, re-derived wrongly in both directions: `entry.instrument` is
   * deliberately absent on a tone-portamento row (D77) and deliberately
   * present on a bare note via the channel latch (D56), so it cannot stand in
   * for "the row named an instrument". mod-import and xm-import both key off
   * the instrument number itself.
   */
  const SAMPLE_VOLUME = 32; // 32/64 -> 0x80 of 255

  it('a tone portamento carrying a sample number reloads its volume', () => {
    const { song } = importS3m({
      channelSettings: [0x00],
      orders: [0],
      patterns: [
        [
          [{ note: 0x30, instrument: 1, volume: 64 }],
          [{ volume: 8 }], // the channel is walked down
          // ...and the next note reloads the sample's own volume, even though
          // a tone portamento starts no note.
          [{ note: 0x34, instrument: 1, effect: 0x07, param: 0x20 }],
        ],
      ],
      instruments: [{ frames: [0, 0.25, -0.25, 0], volume: SAMPLE_VOLUME }],
    });

    const porta = entryAt(song, 0, 0, 2)!;
    expect(porta.volume).toBe('80');
    // ...but it still must not become the channel's instrument (D77).
    expect(porta.instrument).toBeUndefined();
  });

  it('a note with no sample number keeps the channel volume', () => {
    const { song } = importS3m({
      channelSettings: [0x00],
      orders: [0],
      patterns: [
        [
          [{ note: 0x30, instrument: 1, volume: 64 }],
          [{ volume: 8 }],
          [{ note: 0x34 }], // bare note: nothing reloads
        ],
      ],
      instruments: [{ frames: [0, 0.25, -0.25, 0], volume: SAMPLE_VOLUME }],
    });

    // The channel latch still resolves which instrument plays it (D56)...
    const bare = entryAt(song, 0, 0, 2)!;
    expect(bare.instrument).toBeDefined();
    // ...but that is not the row naming one, so no volume is stamped and the
    // channel keeps the 8 the previous row left it at.
    expect(bare.volume).toBeUndefined();
  });

  it('an explicit volume byte still wins over the sample default', () => {
    const { song } = importS3m({
      channelSettings: [0x00],
      orders: [0],
      patterns: [
        [[{ note: 0x30, instrument: 1, volume: 16 }]],
      ],
      instruments: [{ frames: [0, 0.25, -0.25, 0], volume: SAMPLE_VOLUME }],
    });

    expect(entryAt(song, 0, 0, 0)!.volume).toBe('40'); // 16/64, not 32/64
  });
});
