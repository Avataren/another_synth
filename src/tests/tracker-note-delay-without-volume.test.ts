import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ref } from 'vue';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';

/**
 * EDx delays a note; it does not drop it, and it does not bend the note the
 * channel is already playing.
 *
 * Two halves of one row shape, both wrong the same way:
 *
 *  - The delayed note was only recorded when the row also carried a volume.
 *    A note with no sample number deliberately has none -- ProTracker leaves
 *    the channel volume alone on those rows, so mod-import stamps nothing
 *    (see mod-channel-volume-carry) -- so a note with EDx and no sample
 *    number never triggered at all.
 *  - Tick 0 nevertheless moved the channel to the new note's pitch and said
 *    so, even though ProTracker only writes the period when the delay fires.
 *
 * Together they turned a retrigger into a pitch bend: the previous note slid
 * to the delayed note's pitch and carried on there, and nothing restarted.
 *
 * GSLINGER.MOD order 37 channel 4 is the case that exposed it. Sample 27 is a
 * whole melodic phrase, and the part alternates B-2 and C#3 with every C#
 * written as a bare "C#3 ED3" -- no sample number, hence no volume. None of
 * them retriggered, so the phrase never restarted on the C#: it bent
 * mid-phrase and played on, heard as the melody not landing on its notes.
 */

const HEADER_SIZE = 1084;
const CHANNELS = 4;
const ROWS = 64;
/** C-3 and D-3 in the finetune-0 period table. */
const PERIOD_C = 214;
const PERIOD_D = 190;
/** Sample 1's header volume, loaded into the channel by a sample number. */
const SAMPLE_VOLUME = 40;

interface CellSpec {
  row: number;
  period?: number;
  sampleNumber?: number;
  effectCmd?: number;
  effectParam?: number;
}

function writeAscii(
  buf: Uint8Array,
  offset: number,
  text: string,
  maxLen: number,
) {
  for (let i = 0; i < maxLen; i++) {
    buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
  }
}

/** A one-pattern M.K. module with the given cells on channel 0. */
function createModBuffer(cells: CellSpec[]): ArrayBuffer {
  const patternSize = ROWS * CHANNELS * 4;
  const sampleLengthWords = 4;
  const buf = new Uint8Array(HEADER_SIZE + patternSize + sampleLengthWords * 2);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  writeAscii(buf, 0, 'DELAY', 20);
  let offset = 20;
  for (let i = 0; i < 31; i++) {
    writeAscii(buf, offset, i === 0 ? 'PHRASE' : '', 22);
    view.setUint16(offset + 22, i === 0 ? sampleLengthWords : 0, false);
    buf[offset + 24] = 0;
    buf[offset + 25] = i === 0 ? SAMPLE_VOLUME : 64;
    view.setUint16(offset + 26, 0, false);
    view.setUint16(offset + 28, 0, false);
    offset += 30;
  }
  buf[950] = 1;
  buf[952] = 0;
  writeAscii(buf, 1080, 'M.K.', 4);

  for (const cell of cells) {
    const at = HEADER_SIZE + cell.row * CHANNELS * 4;
    const period = cell.period ?? 0;
    const sampleNumber = cell.sampleNumber ?? 0;
    buf[at] = (sampleNumber & 0xf0) | ((period >> 8) & 0x0f);
    buf[at + 1] = period & 0xff;
    buf[at + 2] = ((sampleNumber & 0x0f) << 4) | (cell.effectCmd ?? 0);
    buf[at + 3] = cell.effectParam ?? 0;
  }
  return buf.buffer as ArrayBuffer;
}

function buildFrom(file: ReturnType<typeof importModToTrackerSong>) {
  const patterns = file.data.patterns;
  const ctx: TrackerSongBuilderContext = {
    currentSong: ref(file.data.currentSong),
    moduleFormat: ref(file.data.moduleFormat!),
    initialSpeed: ref(file.data.initialSpeed ?? 6),
    linearFrequency: ref(file.data.linearFrequency ?? true),
    patterns: ref(patterns),
    sequence: ref(file.data.sequence ?? patterns.map((p) => p.id)),
    currentPatternId: ref(patterns[0]!.id),
    currentPattern: ref(patterns[0]!),
    defaultPatternRows: ref(ROWS),
    instrumentSlots: ref(file.data.instrumentSlots),
    songPatches: ref(file.data.songPatches ?? {}),
    songBank: {} as TrackerSongBuilderContext['songBank'],
    normalizeInstrumentId: (id) => (id ? id : undefined),
    formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
  };
  return useTrackerSongBuilder(ctx).buildPlaybackSong('song');
}

interface Played {
  row: number;
  midi: number | undefined;
  velocity: number | undefined;
  time: number;
}

interface Bent {
  row: number;
  frequency: number;
  time: number;
}

const ROW_SECONDS = 0.1;

/** Every note-on and pitch command scheduled on one track of one order. */
function play(
  song: ReturnType<typeof buildFrom>,
  order: number,
  track: number,
  rows: number,
) {
  const notes: Played[] = [];
  const pitches: Bent[] = [];
  let row = 0;
  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: (e) => {
      if (e.trackIndex !== track || e.type !== 'noteOn') return;
      notes.push({ row, midi: e.midi, velocity: e.velocity, time: e.time });
    },
    scheduledPitchHandler: (_i, _v, frequency, time, trackIndex) => {
      if (trackIndex === track) pitches.push({ row, frequency, time });
    },
  });
  engine.loadSong(song, order);
  const internals = engine as unknown as {
    scheduleRow: (r: number, t: number) => void;
  };
  for (row = 0; row < rows; row++)
    internals.scheduleRow(row, row * ROW_SECONDS);
  return { notes, pitches };
}

describe('a delayed note on a row with no volume of its own', () => {
  /**
   * Row 0 starts C-3 with sample 1; row 1 is "D-3 ED3" -- a note, a delay, and
   * nothing else. The importer stamps no volume there, which is correct.
   */
  const song = () =>
    buildFrom(
      importModToTrackerSong(
        createModBuffer([
          { row: 0, period: PERIOD_C, sampleNumber: 1 },
          { row: 1, period: PERIOD_D, effectCmd: 0xe, effectParam: 0xd3 },
        ]),
      ),
    );

  it('still triggers, three ticks into the row', () => {
    const built = song();
    const { notes } = play(built, 0, 0, 3);

    const delayed = notes.find((n) => n.row === 1);
    expect(delayed).toBeDefined();
    // D-3, a tone above the C-3 on row 0.
    expect(delayed!.midi).toBe(notes.find((n) => n.row === 0)!.midi! + 2);
    // Three ticks past the row it is written on, at the song's own tempo.
    const tickSeconds = 2.5 / built.bpm;
    expect(delayed!.time).toBeCloseTo(ROW_SECONDS + 3 * tickSeconds, 5);
  });

  it('starts at the channel volume, since the row supplies none', () => {
    const { notes } = play(song(), 0, 0, 3);

    expect(notes.find((n) => n.row === 1)!.velocity).toBe(
      notes.find((n) => n.row === 0)!.velocity,
    );
  });

  it('leaves the sounding note at its own pitch until it fires', () => {
    const { notes, pitches } = play(song(), 0, 0, 3);

    const trigger = notes.find((n) => n.row === 1)!;
    // Nothing may move the pitch between the row starting and the note
    // arriving: that would bend the note still sounding from row 0.
    expect(pitches.filter((p) => p.row === 1 && p.time < trigger.time)).toEqual(
      [],
    );
  });
});

describe('GSLINGER.MOD retriggers its flute phrase on every note', () => {
  const song = () => {
    const buf = fs.readFileSync(
      path.resolve(__dirname, '../../public/demos/amiga/GSLINGER.MOD'),
    );
    return buildFrom(
      importModToTrackerSong(
        buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer,
      ),
    );
  };

  it('plays the C# of every B/C# pair instead of bending the B into it', () => {
    // Order 37, channel 4 (track index 3). Rows 7, 0x0A and 0x10 are each a
    // bare "C#3 ED3"; rows 6, 9 and 0x0F are the B-2s they answer.
    const { notes } = play(song(), 37, 3, 0x17);

    expect(notes.map((n) => n.row)).toEqual(
      expect.arrayContaining([0x06, 0x07, 0x09, 0x0a, 0x0f, 0x10]),
    );

    // Every one of them is the same phrase sample, a tone apart.
    const b = notes.find((n) => n.row === 0x06)!;
    for (const row of [0x07, 0x0a, 0x10]) {
      expect(notes.find((n) => n.row === row)!.midi).toBe(b.midi! + 2);
    }
    for (const row of [0x09, 0x0f]) {
      expect(notes.find((n) => n.row === row)!.midi).toBe(b.midi);
    }
  });
});
