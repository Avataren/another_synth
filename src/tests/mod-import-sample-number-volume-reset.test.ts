import { describe, it, expect } from 'vitest';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';

/**
 * ProTracker reloads a sample's default volume into the channel whenever a
 * sample number appears, even with no note. Composers rely on it: PT has a
 * single effect column, so Axy alone can only move volume one way. The
 * standard hand-rolled tremolo alternates "sample number only" rows (reset to
 * full) with Axy rows (slide down).
 *
 * The importer only applied the reset on rows that also carried a note, so
 * the slide walked the volume down with nothing to restore it and the part
 * faded to near silence. musiklinjen.mod pattern 5 channel 2 is the case that
 * exposed it -- a pumping string built from "smp=13 A06" and bare "smp=13".
 */
const HEADER_SIZE = 1084;
const ROWS = 64;
const CHANNELS = 4;

interface CellSpec {
  row: number;
  /** Defaults to channel 0. */
  channel?: number;
  period?: number;
  sampleNumber?: number;
  effectCmd?: number;
  effectParam?: number;
}

function writeAscii(buf: Uint8Array, offset: number, text: string, length: number) {
  for (let i = 0; i < length; i++) {
    buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
  }
}

/** Single-pattern M.K. module; cells go on channel 0. Sample 1 has volume 43. */
function createModBuffer(cells: CellSpec[]): Uint8Array {
  const patternSize = ROWS * CHANNELS * 4;
  const sampleLengthWords = 4;
  const buf = new Uint8Array(HEADER_SIZE + patternSize + sampleLengthWords * 2);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  writeAscii(buf, 0, 'PUMP', 20);
  let offset = 20;
  for (let i = 0; i < 31; i++) {
    writeAscii(buf, offset, i === 0 ? 'STRING' : '', 22);
    view.setUint16(offset + 22, i === 0 ? sampleLengthWords : 0, false);
    buf[offset + 24] = 0;
    buf[offset + 25] = i === 0 ? 43 : 64; // sample 1 default volume 43/64
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

function importTrack0(cells: CellSpec[]) {
  const buf = createModBuffer(cells);
  const song = importModToTrackerSong(buf.buffer as ArrayBuffer);
  return song.data.patterns[0]!.tracks[0]!;
}

/** 43/64 scaled into the 0-255 volume column. */
const SAMPLE_1_VOLUME_HEX = Math.round((43 / 64) * 255)
  .toString(16)
  .toUpperCase()
  .padStart(2, '0');

describe('bare sample number resets channel volume', () => {
  it('sets the sample default volume on a sample-number row with no note', () => {
    const track = importTrack0([
      { row: 0, period: 202, sampleNumber: 1 },
      { row: 1, sampleNumber: 1 },
    ]);

    expect(track.entries.find((e) => e.row === 1)?.volume).toBe(
      SAMPLE_1_VOLUME_HEX,
    );
  });

  it('resets even when the same row carries a volume slide', () => {
    // This is the pump: reset to full, then slide down within the row.
    const track = importTrack0([
      { row: 0, period: 202, sampleNumber: 1 },
      { row: 1, sampleNumber: 1, effectCmd: 0xa, effectParam: 0x06 },
    ]);

    const row1 = track.entries.find((e) => e.row === 1);
    expect(row1?.volume).toBe(SAMPLE_1_VOLUME_HEX);
    expect(row1?.macro).toBe('A06');
  });

  it('keeps resetting across an alternating slide/reset run', () => {
    const track = importTrack0([
      { row: 0, period: 202, sampleNumber: 1, effectCmd: 0xa, effectParam: 0x06 },
      { row: 1, sampleNumber: 1, effectCmd: 0xa, effectParam: 0x06 },
      { row: 2, sampleNumber: 1 },
      { row: 3, effectCmd: 0xa, effectParam: 0x06 },
      { row: 4, sampleNumber: 1 },
    ]);

    for (const row of [0, 1, 2, 4]) {
      expect(track.entries.find((e) => e.row === row)?.volume).toBe(
        SAMPLE_1_VOLUME_HEX,
      );
    }
    // A row with only a slide and no sample number must NOT reset.
    expect(track.entries.find((e) => e.row === 3)?.volume).toBeUndefined();
  });

  it('resets on a tone-portamento row that names a sample', () => {
    // This used to assert the opposite, reasoning that 3xx does not retrigger
    // the sample so the volume must carry over. That conflates two things
    // ProTracker keeps apart: in mt_PlayVoice the sample-number block, which
    // writes n_volume, runs *before* the tone-porta check, and that check only
    // decides whether the sample restarts and how the period is used. A sample
    // number loads its volume into the channel either way -- the same rule the
    // bare-sample-number cases above already assert.
    //
    // nexus_seven.mod pattern 6 is what the old reading cost: channel 1
    // alternates "C-3 12 3F0" against "A06" rows, the pumped portamento
    // bassline, and with no reload the slides only ever subtracted. The
    // channel hit zero by row 3 and every remaining note in the pattern was
    // silent, a tone portamento never retriggering and so never bringing a
    // volume of its own.
    const track = importTrack0([
      { row: 0, period: 202, sampleNumber: 1 },
      { row: 1, period: 180, sampleNumber: 1, effectCmd: 0x3, effectParam: 0x40 },
    ]);

    expect(track.entries.find((e) => e.row === 1)?.volume).toBe(
      SAMPLE_1_VOLUME_HEX,
    );
  });

  it('leaves a tone-portamento row with no sample number alone', () => {
    // No sample number, nothing to load: the channel keeps whatever volume the
    // slides have left it at, which is the whole point of the idiom.
    const track = importTrack0([
      { row: 0, period: 202, sampleNumber: 1 },
      { row: 1, period: 180, effectCmd: 0x3, effectParam: 0x40 },
    ]);

    expect(track.entries.find((e) => e.row === 1)?.volume).toBeUndefined();
  });

  it('still does not stamp an instrument on a tone-portamento row', () => {
    // Reloading the volume must not become a retrigger: the row still has to
    // keep addressing the voice that is already sounding (D29).
    const track = importTrack0([
      { row: 0, period: 202, sampleNumber: 1 },
      { row: 1, period: 180, sampleNumber: 1, effectCmd: 0x3, effectParam: 0x40 },
    ]);

    expect(track.entries.find((e) => e.row === 1)?.instrument).toBeUndefined();
  });

  it('leaves a Cxx on the same row in charge', () => {
    // An explicit volume command overrides the sample default.
    const track = importTrack0([
      { row: 0, sampleNumber: 1, effectCmd: 0xc, effectParam: 0x20 },
    ]);

    expect(track.entries.find((e) => e.row === 0)?.volume).toBe('80');
  });
});

/**
 * A bare sample number must not change which instrument the channel is
 * playing. In ProTracker it selects the sample for the *next* note and
 * reloads the channel volume; the sounding sample carries on.
 *
 * One MOD sample is one instrument here, so stamping the instrument on such a
 * row re-routes every per-voice effect on it to an instrument with nothing
 * playing, and the sounding voice receives none of them.
 *
 * think_twice_iii.mod is the case that exposed it: a C64-style channel holds
 * one note and steps the sample number through 11..18 (header volumes
 * descending 64..13, a hand-made decay envelope) with an arpeggio repeated on
 * every row. The arpeggio was audible for exactly one row and the envelope
 * never applied.
 */
describe('bare sample number does not switch the sounding instrument', () => {
  it('leaves the instrument unstamped on a row with no note', () => {
    const track = importTrack0([
      { row: 0, period: 202, sampleNumber: 1 },
      { row: 1, sampleNumber: 2 },
    ]);

    expect(track.entries.find((e) => e.row === 0)?.instrument).toBe('01');
    // Row 1 must not re-route to instrument 2; sticky tracking keeps 1.
    expect(track.entries.find((e) => e.row === 1)?.instrument).toBeUndefined();
  });

  it('keeps effects on the sounding instrument across a sample-number run', () => {
    // The think_twice_iii shape: one note, then bare sample numbers carrying
    // the same arpeggio on every row.
    const track = importTrack0([
      { row: 0, period: 202, sampleNumber: 1, effectCmd: 0x0, effectParam: 0x5a },
      { row: 1, sampleNumber: 2, effectCmd: 0x0, effectParam: 0x5a },
      { row: 2, sampleNumber: 3, effectCmd: 0x0, effectParam: 0x5a },
    ]);

    for (const row of [0, 1, 2]) {
      expect(track.entries.find((e) => e.row === row)?.macro).toBe('05A');
    }
    // Only the note row addresses an instrument.
    expect(track.entries.find((e) => e.row === 1)?.instrument).toBeUndefined();
    expect(track.entries.find((e) => e.row === 2)?.instrument).toBeUndefined();
  });

  it('still reloads the channel volume from each sample number', () => {
    // The envelope must survive even though the instrument does not change.
    const track = importTrack0([
      { row: 0, period: 202, sampleNumber: 1 },
      { row: 1, sampleNumber: 2 },
    ]);

    // Sample 1 has volume 43; sample 2 keeps the builder default of 64.
    expect(track.entries.find((e) => e.row === 0)?.volume).toBe(
      SAMPLE_1_VOLUME_HEX,
    );
    expect(track.entries.find((e) => e.row === 1)?.volume).toBe('FF');
  });

  it('latches the sample for a later note written without one', () => {
    // ProTracker plays the most recently selected sample.
    const track = importTrack0([
      { row: 0, period: 202, sampleNumber: 1 },
      { row: 1, sampleNumber: 2 },
      { row: 2, period: 202 },
    ]);

    expect(track.entries.find((e) => e.row === 2)?.instrument).toBe('02');
  });

  it('still stamps the instrument on an ordinary note+sample row', () => {
    const track = importTrack0([
      { row: 0, period: 202, sampleNumber: 1 },
      { row: 1, period: 180, sampleNumber: 2 },
    ]);

    expect(track.entries.find((e) => e.row === 1)?.instrument).toBe('02');
  });
});

/**
 * Voice sizing for multi-channel modules.
 *
 * One sample is one instrument, so every channel playing it shares that
 * instrument's voice pool and each channel needs a voice of its own. Four was
 * right for a classic 4-channel module and badly short beyond it: DOPE.MOD has
 * 28 channels and its busiest sample appears on 19 of them, so notes were
 * stolen from channels that were still sounding.
 */
describe('voice count follows the channels that use a sample', () => {
  function voiceCountFor(cells: CellSpec[], channels: number) {
    const patternSize = ROWS * channels * 4;
    const sampleLengthWords = 4;
    const buf = new Uint8Array(HEADER_SIZE + patternSize + sampleLengthWords * 2);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    writeAscii(buf, 0, 'MULTI', 20);
    let offset = 20;
    for (let i = 0; i < 31; i++) {
      writeAscii(buf, offset, i === 0 ? 'S' : '', 22);
      view.setUint16(offset + 22, i === 0 ? sampleLengthWords : 0, false);
      buf[offset + 24] = 0;
      buf[offset + 25] = 64;
      view.setUint16(offset + 26, 0, false);
      view.setUint16(offset + 28, 0, false);
      offset += 30;
    }
    buf[950] = 1;
    buf[952] = 0;
    // Signature form depends on the count: the classic tag for 4, <n>CHN for
    // a single digit, <nn>CH for two.
    const signature =
      channels === 4
        ? 'M.K.'
        : channels < 10
          ? `${channels}CHN`
          : `${channels}CH`;
    writeAscii(buf, 1080, signature, 4);

    for (const cell of cells) {
      const at = HEADER_SIZE + (cell.row * channels + (cell.channel ?? 0)) * 4;
      const period = cell.period ?? 0;
      const sampleNumber = cell.sampleNumber ?? 0;
      buf[at] = (sampleNumber & 0xf0) | ((period >> 8) & 0x0f);
      buf[at + 1] = period & 0xff;
      buf[at + 2] = ((sampleNumber & 0x0f) << 4) | (cell.effectCmd ?? 0);
      buf[at + 3] = cell.effectParam ?? 0;
    }

    const song = importModToTrackerSong(buf.buffer as ArrayBuffer);
    const patch = Object.values(song.data.songPatches)[0]!;
    return patch.synthState.layout.voiceCount;
  }

  it('keeps four voices for a classic four-channel module', () => {
    expect(
      voiceCountFor(
        [
          { row: 0, channel: 0, period: 202, sampleNumber: 1 },
          { row: 1, channel: 1, period: 202, sampleNumber: 1 },
        ],
        4,
      ),
    ).toBe(4);
  });

  it('allocates a voice per channel when a sample is spread widely', () => {
    // Twelve channels all playing sample 1.
    const cells = Array.from({ length: 12 }, (_, channel) => ({
      row: channel,
      channel,
      period: 202,
      sampleNumber: 1,
    }));
    expect(voiceCountFor(cells, 16)).toBe(12);
  });

  it('does not count channels that never play the sample', () => {
    const cells = [
      { row: 0, channel: 0, period: 202, sampleNumber: 1 },
      { row: 1, channel: 5, period: 202, sampleNumber: 1 },
    ];
    // Two channels use it, so the four-voice floor still applies.
    expect(voiceCountFor(cells, 16)).toBe(4);
  });
});
