import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseMod } from '@another-synth/tracker-playback';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import { buildSoundtrackerMod, cellAt } from './helpers/mod-builder';

/**
 * Ultimate Soundtracker -- Karsten Obarski's original, 1987 -- differs from
 * every later tracker in two ways that matter, and declares neither: it shares
 * the signature-less 15-sample layout with the other early Soundtrackers.
 *
 *   1. Arpeggio is command 1. ProTracker moved it to 0 and gave 1 to
 *      portamento up.
 *   2. Sample loop start is a byte offset, not a word offset.
 *
 * lepeltheme.mod is the case that exposed it: `137` -- a minor triad -- on all
 * 64 rows of a channel, read as portamento up at 55 units per tick, which runs
 * the pitch off the top of the range instead of playing the chord.
 *
 * The risk in fixing it is over-detection: a *later* Soundtracker module uses
 * command 0 for arpeggio and command 1 for portamento, so misreading one of
 * those would break a file that plays correctly today.
 */

const ARPEGGIO_MINOR_TRIAD = 0x37;

describe('detecting Ultimate Soundtracker', () => {
  it('recognises loop offsets that only make sense as bytes', () => {
    // Doubling loopStart would run the loop past the end of the sample;
    // reading it as bytes fits exactly. That is the file stating its units.
    const mod = parseMod(
      buildSoundtrackerMod({
        samples: [
          { lengthBytes: 8000, loopStartRaw: 3000, loopLengthBytes: 4000 },
        ],
      }),
    );

    expect(mod.trackerFlavor).toBe('UltimateSoundtracker');
    expect(mod.samples[0]!.loopStart).toBe(3000);
  });

  it('recognises arpeggio written on command 1', () => {
    const mod = parseMod(
      buildSoundtrackerMod({
        patterns: [
          cellAt(0, {
            period: 254,
            sample: 1,
            effectCmd: 1,
            effectParam: ARPEGGIO_MINOR_TRIAD,
          }),
        ],
      }),
    );

    expect(mod.trackerFlavor).toBe('UltimateSoundtracker');
  });

  it('does not claim a module that puts arpeggio on command 0', () => {
    // A later Soundtracker. Command 0 carrying a parameter is proof the file
    // uses ProTracker's numbering, whatever else it does.
    const mod = parseMod(
      buildSoundtrackerMod({
        patterns: [
          cellAt(0, {
            period: 254,
            sample: 1,
            effectCmd: 0,
            effectParam: ARPEGGIO_MINOR_TRIAD,
          }),
        ],
      }),
    );

    expect(mod.trackerFlavor).toBe('Soundtracker');
  });

  it('does not claim a module whose loops read fine as words', () => {
    const mod = parseMod(
      buildSoundtrackerMod({
        samples: [
          { lengthBytes: 8000, loopStartRaw: 1000, loopLengthBytes: 4000 },
        ],
      }),
    );

    expect(mod.trackerFlavor).toBe('Soundtracker');
    // Still the later convention: the raw field doubled.
    expect(mod.samples[0]!.loopStart).toBe(2000);
  });

  it('does not claim a ProTracker module', () => {
    // The 31-sample layout is identified by its signature and never inspected
    // for either tell.
    const dope = fs.readFileSync(
      path.resolve(__dirname, '../../public/demos/amiga/GSLINGER.MOD'),
    );
    const mod = parseMod(new Uint8Array(dope));

    expect(mod.trackerFlavor).toBe('ProTracker');
  });
});

describe('translating the Ultimate Soundtracker command set', () => {
  const importFirstCell = (cell: {
    effectCmd: number;
    effectParam: number;
  }) => {
    const bytes = buildSoundtrackerMod({
      // A byte-unit loop marks the file, so the command under test does not
      // also have to be the thing that identifies it.
      samples: [{ lengthBytes: 8000, loopStartRaw: 3000, loopLengthBytes: 4000 }],
      patterns: [cellAt(0, { period: 254, sample: 1, ...cell })],
    });
    const song = importModToTrackerSong(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );
    const track = song.data.patterns[0]!.tracks[0]!;
    return track.entries.find((entry) => entry.row === 0);
  };

  it('reads command 1 as arpeggio', () => {
    const step = importFirstCell({
      effectCmd: 1,
      effectParam: ARPEGGIO_MINOR_TRIAD,
    });

    // ProTracker's arpeggio is command 0, so the macro keeps the parameter
    // and changes the command.
    expect(step?.macro).toBe('037');
  });

  it('drops a parameter on command 0, which carries no effect', () => {
    const step = importFirstCell({
      effectCmd: 0,
      effectParam: ARPEGGIO_MINOR_TRIAD,
    });

    expect(step?.macro).toBeUndefined();
  });

  it('splits command 2 by the nibble that is set', () => {
    // A pitch bend, not a slide at 128 units per tick.
    expect(importFirstCell({ effectCmd: 2, effectParam: 0x80 })?.macro).toBe(
      '208',
    );
    expect(importFirstCell({ effectCmd: 2, effectParam: 0x07 })?.macro).toBe(
      '107',
    );
  });
});

describe('the published Soundtracker modules', () => {
  const dir = path.resolve(__dirname, '../../public/demos/amiga');
  const mods = fs
    .readdirSync(dir)
    .filter((f) => /\.mod$/i.test(f))
    .map((f) => [f, parseMod(new Uint8Array(fs.readFileSync(path.join(dir, f))))] as const);

  it('includes both early flavours, so this stays exercised', () => {
    const flavours = new Set(mods.map(([, mod]) => mod.trackerFlavor));

    expect(flavours.has('UltimateSoundtracker')).toBe(true);
    expect(flavours.has('Soundtracker')).toBe(true);
  });

  it.each(mods)('gives %s a loop inside its sample', (_name, mod) => {
    // The real symptom of reading loop offsets in the wrong unit. Applies
    // whatever the flavour: no module should loop past its own sample data.
    for (const sample of mod.samples) {
      if (sample.loopLength <= 2 || sample.length === 0) continue;
      expect(sample.loopStart + sample.loopLength).toBeLessThanOrEqual(
        sample.length,
      );
    }
  });
});
