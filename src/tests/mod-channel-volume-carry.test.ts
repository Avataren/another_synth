import { describe, it, expect, vi } from 'vitest';
import { ref } from 'vue';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import {
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN,
  type ProcessorCommand,
} from '@another-synth/tracker-playback';
import { PROTRACKER_PROFILE } from '@another-synth/tracker-playback';
import { deserializePatch } from 'src/audio/serialization/patch-serializer';

/**
 * Channel volume is playback state, and only playback can know it.
 *
 * ProTracker's channel volume is set by a sample number, a Cxx or the volume
 * column, and then walked around by Axy/EAx/EBx over as many rows as the slide
 * lasts. A note carrying no sample number does not touch it at all.
 *
 * The importer used to stamp its own running volume onto those notes, which is
 * a snapshot of the last value written into a *cell* and knows nothing about
 * slides. GSLINGER.MOD pattern 36 is the case that exposed it: the flute swells
 * from the sample's default 8 up to 33 under `A50`, and the next row -- a plain
 * note with no sample number -- reset it to 8, discarding the swell the passage
 * is built on.
 */

const HEADER_SIZE = 1084;
const CHANNELS = 4;
const ROWS = 64;

/** Sample 1's header volume, deliberately far from both 0 and 64. */
const SAMPLE_VOLUME = 8;

interface CellSpec {
  row: number;
  period?: number;
  sampleNumber?: number;
  effectCmd?: number;
  effectParam?: number;
}

function writeAscii(buf: Uint8Array, offset: number, text: string, maxLen: number) {
  for (let i = 0; i < maxLen; i++) {
    buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
  }
}

function createModBuffer(cells: CellSpec[]): Uint8Array {
  const patternSize = ROWS * CHANNELS * 4;
  const sampleLengthWords = 4;
  const buf = new Uint8Array(HEADER_SIZE + patternSize + sampleLengthWords * 2);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  writeAscii(buf, 0, 'SWELL', 20);
  let offset = 20;
  for (let i = 0; i < 31; i++) {
    writeAscii(buf, offset, i === 0 ? 'FLUTE' : '', 22);
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
    const period = cell.period ?? 0;
    const sampleNumber = cell.sampleNumber ?? 0;
    const at = HEADER_SIZE + cell.row * CHANNELS * 4;
    buf[at] = (sampleNumber & 0xf0) | ((period >> 8) & 0x0f);
    buf[at + 1] = period & 0xff;
    buf[at + 2] = ((sampleNumber & 0x0f) << 4) | (cell.effectCmd ?? 0);
    buf[at + 3] = cell.effectParam ?? 0;
  }
  return buf;
}

const PERIOD = 214; // C-3

/** Row 0: note + sample 1 + A50. Row 1: note, no sample number. */
function importSwell() {
  const song = importModToTrackerSong(
    createModBuffer([
      { row: 0, period: PERIOD, sampleNumber: 1, effectCmd: 0xa, effectParam: 0x50 },
      { row: 1, period: PERIOD },
    ]).buffer as ArrayBuffer,
  );
  const entries = song.data.patterns[0]!.tracks[0]!.entries;
  return {
    song,
    row0: entries.find((e) => e.row === 0),
    row1: entries.find((e) => e.row === 1),
  };
}

describe('MOD import leaves the channel volume alone on a note with no sample number', () => {
  it('stamps the sample default on the row that names the sample', () => {
    const { row0 } = importSwell();
    const expected = Math.round((SAMPLE_VOLUME / 64) * 255)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
    expect(row0?.volume).toBe(expected);
  });

  it('stamps no volume at all on the following bare note', () => {
    // Any value here is a guess about what the slide will have done by the
    // time the row plays, and the guess is always the pre-slide value.
    const { row1 } = importSwell();
    expect(row1?.note).toBeDefined();
    expect(row1?.volume).toBeUndefined();
  });
});

describe('the sample default volume is not baked into the patch gain', () => {
  it('builds the sampler at unity', () => {
    // ProTracker's per-sample volume is a channel volume, not a property of
    // the sample, and it already reaches playback through the volume column.
    // Baking it in as well left quiet-headered samples permanently
    // attenuated -- most visibly when auditioning them from the keyboard,
    // where nothing else sets a level. 271 of the 524 samples in the local
    // MOD corpus declare a header volume below 64.
    const { song } = importSwell();
    const patch = Object.values(song.data.songPatches!)[0]!;
    const samplers = [...deserializePatch(patch).samplers.values()];

    expect(samplers.length).toBeGreaterThan(0);
    for (const sampler of samplers) expect(sampler.gain).toBe(1);
  });
});

const volumesOf = (commands: ProcessorCommand[]) =>
  commands.filter((c) => c.kind === 'volume').map((c) => c.volume);

const noteOnVelocityOf = (commands: ProcessorCommand[]) =>
  commands.filter((c) => c.kind === 'noteOn').map((c) => c.velocity);

describe('a note trigger states the channel volume', () => {
  const slide = { type: 'volSlide' as const, paramX: 5, paramY: 0 };

  it('carries a slid volume onto a note that supplies none', () => {
    const state = createTrackEffectState(PROTRACKER_PROFILE);

    // Row 0: note at volume 8/64 with A50 sliding up 5 a tick, five ticks.
    processEffectTick0(state, slide, 60, Math.round((8 / 64) * 255), 261.63, 6);
    for (let tick = 1; tick < 6; tick++) processEffectTickN(state, slide, tick, 6);
    expect(state.currentVolume * 64).toBeCloseTo(33, 1);

    // Row 1: a note with no volume of its own must keep the swell...
    const row1 = processEffectTick0(state, undefined, 60, undefined, 261.63, 6);
    expect(state.currentVolume * 64).toBeCloseTo(33, 1);
    // ...and say so, because the note allocates a fresh voice whose gain does
    // not otherwise know about it.
    expect(volumesOf(row1.commands)).toHaveLength(1);
    expect(volumesOf(row1.commands)[0]! * 64).toBeCloseTo(33, 1);
  });

  it('states the row own volume when it has one', () => {
    const state = createTrackEffectState(PROTRACKER_PROFILE);
    const batch = processEffectTick0(
      state,
      undefined,
      60,
      Math.round((40 / 64) * 255),
      261.63,
      6,
    );
    expect(volumesOf(batch.commands)[0]! * 64).toBeCloseTo(40, 0);
  });

  it('says nothing for a row that starts no note', () => {
    const state = createTrackEffectState(PROTRACKER_PROFILE);
    const batch = processEffectTick0(state, undefined, undefined);
    expect(volumesOf(batch.commands)).toHaveLength(0);
  });
});


describe('a note-on carries the level the note starts at', () => {
  // The follow-up volume command is allowed to fail: SongBank drops one it
  // cannot resolve to a voice on this track, which is correct, because two
  // tracks sharing a sample share a voice pool. So whatever the note-on says
  // is the level the note is heard at whenever that happens, and a hardcoded
  // 127 means full scale.
  //
  // GSLINGER.MOD pattern 2 is the case: channels 1 and 3 play the same flute,
  // channel 3 three rows behind as an echo at volume 11 against the lead's 24.
  // With a hardcoded note-on velocity the echo came out at 64.
  const slide = { type: 'volSlide' as const, paramX: 5, paramY: 0 };

  it('states the row own volume', () => {
    const state = createTrackEffectState(PROTRACKER_PROFILE);
    const batch = processEffectTick0(
      state,
      undefined,
      60,
      Math.round((11 / 64) * 255),
      261.63,
      6,
    );
    const velocity = noteOnVelocityOf(batch.commands)[0]!;
    expect((velocity / 127) * 64).toBeCloseTo(11, 0);
    expect(velocity).toBeLessThan(127);
  });

  it('states an inherited volume on a note that supplies none', () => {
    const state = createTrackEffectState(PROTRACKER_PROFILE);
    processEffectTick0(state, undefined, 60, Math.round((11 / 64) * 255), 261.63, 6);

    const batch = processEffectTick0(state, undefined, 62, undefined, 261.63, 6);
    expect((noteOnVelocityOf(batch.commands)[0]! / 127) * 64).toBeCloseTo(11, 0);
  });

  it('states a volume a slide has moved', () => {
    const state = createTrackEffectState(PROTRACKER_PROFILE);
    processEffectTick0(state, slide, 60, Math.round((8 / 64) * 255), 261.63, 6);
    for (let tick = 1; tick < 6; tick++) processEffectTickN(state, slide, tick, 6);

    const batch = processEffectTick0(state, undefined, 62, undefined, 261.63, 6);
    expect((noteOnVelocityOf(batch.commands)[0]! / 127) * 64).toBeCloseTo(33, 0);
  });
});


/**
 * End to end, through the song builder and the engine.
 *
 * The unit-level checks above pass whether or not `useTrackerSongBuilder` is
 * doing the right thing, because they hand `processEffectTick0` a velocity
 * directly. That gap is not hypothetical: the first attempt at this fix was
 * verified exactly that way and shipped a regression, because the builder was
 * quietly resetting these very rows to full velocity. Anything about note
 * volume has to be asserted from a `Step` the builder actually produced.
 */
function noteOnLevelsThroughEngine(cells: CellSpec[]) {
  const file = importModToTrackerSong(
    createModBuffer(cells).buffer as ArrayBuffer,
  );
  const pattern = file.data.patterns[0]!;
  const ctx: TrackerSongBuilderContext = {
    currentSong: ref(file.data.currentSong),
    moduleFormat: ref(file.data.moduleFormat!),
    patterns: ref([pattern]),
    sequence: ref([pattern.id]),
    currentPatternId: ref(pattern.id),
    currentPattern: ref(pattern),
    defaultPatternRows: ref(ROWS),
    instrumentSlots: ref(file.data.instrumentSlots),
    songPatches: ref(file.data.songPatches ?? {}),
    songBank: {} as TrackerSongBuilderContext['songBank'],
    normalizeInstrumentId: (id) => (id ? id : undefined),
    formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
  };
  const song = useTrackerSongBuilder(ctx).buildPlaybackSong('song');

  const levels = new Map<number, number>();
  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: (e) => {
      if (e.type === 'noteOn' && e.trackIndex === 0) {
        levels.set(e.row, ((e.velocity ?? 0) / 127) * 64);
      }
    },
  });
  engine.loadSong(song);
  const internals = engine as unknown as {
    scheduleRow: (row: number, time: number) => void;
  };
  for (let row = 0; row < 8; row++) internals.scheduleRow(row, row * 0.1);
  return levels;
}

describe('note levels survive the song builder', () => {
  it('keeps a bare note at the channel volume instead of resetting it to full', () => {
    // The importer stamps `entry.instrument` onto every row so the builder
    // knows which instrument a naked effect addresses, so "has an instrument
    // id" cannot mean "named an instrument". Reading it that way reset every
    // sample-number-less note to velocity 255 -- full scale -- which is what
    // made GSLINGER.MOD pattern 2's flute echo blare over its own lead.
    const levels = noteOnLevelsThroughEngine([
      { row: 0, period: PERIOD, sampleNumber: 1 },
      { row: 1, period: PERIOD },
    ]);

    expect(levels.get(0)).toBeCloseTo(SAMPLE_VOLUME, 0);
    expect(levels.get(1)).toBeCloseTo(SAMPLE_VOLUME, 0);
  });

  it('keeps a swell a volume slide has built', () => {
    const levels = noteOnLevelsThroughEngine([
      { row: 0, period: PERIOD, sampleNumber: 1, effectCmd: 0xa, effectParam: 0x50 },
      { row: 1, period: PERIOD },
    ]);

    // 8 + 5 a tick for five ticks.
    expect(levels.get(1)).toBeCloseTo(33, 0);
  });

  it('still resets to the sample default when the row names the sample', () => {
    const levels = noteOnLevelsThroughEngine([
      { row: 0, period: PERIOD, sampleNumber: 1, effectCmd: 0xa, effectParam: 0x50 },
      { row: 1, period: PERIOD, sampleNumber: 1 },
    ]);

    expect(levels.get(1)).toBeCloseTo(SAMPLE_VOLUME, 0);
  });
});
