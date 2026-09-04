import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import type { Song as PlaybackSong } from '@another-synth/tracker-playback';
import { songFromImport } from './helpers/imported-song';

/**
 * A row's own volume is set instantly, not ramped into.
 *
 * A step's `velocity` is always a *set-volume*: a Cxx, an XM volume-column
 * set-volume, or the default a sample number loads into the channel. Slides
 * never arrive that way -- they come out of the effect processor as volume
 * commands carrying their own ramp -- so the row-velocity path has no business
 * ramping at all. It nevertheless passed no ramp mode, and an unqualified
 * volume change is a `linearRampToValueAtTime`, which runs from the *previous*
 * automation event: the whole preceding row.
 *
 * jaguar_xj220_title.mod order 6 channel 2 is the case that exposed it. The
 * lead is staccato by construction -- each note is silenced by a bare `C00`
 * one or two rows later, with nothing else on the row -- and every one of
 * those C00s faded its note out across a full row instead of cutting it,
 * which turned a clipped melody into a legato one.
 *
 * See the `rampMode` note on ScheduledVolumeHandler, and the matching 'step'
 * on note cut (ECx) and on a note's own starting level.
 */

const HEADER_SIZE = 1084;
const CHANNELS = 4;
const ROWS = 64;
const PERIOD = 214; // C-3

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

  writeAscii(buf, 0, 'STACCATO', 20);
  let offset = 20;
  for (let i = 0; i < 31; i++) {
    writeAscii(buf, offset, i === 0 ? 'LEAD' : '', 22);
    view.setUint16(offset + 22, i === 0 ? sampleLengthWords : 0, false);
    buf[offset + 24] = 0;
    buf[offset + 25] = 64;
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

interface Scheduled {
  row: number;
  volume: number;
  ramp: string | undefined;
}

/**
 * Play `rows` rows of one order and collect every volume scheduled on a track,
 * tagged with the row it was scheduled from.
 */
function volumesFor(
  song: PlaybackSong,
  order: number,
  track: number,
  rows: number,
): Scheduled[] {
  const scheduled: Scheduled[] = [];
  let currentRow = 0;
  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: () => {},
    scheduledVolumeHandler: (_i, _v, volume, _t, trackIndex, ramp) => {
      if (trackIndex === track)
        scheduled.push({ row: currentRow, volume, ramp });
    },
  });
  engine.loadSong(song, order);
  const internals = engine as unknown as {
    scheduleRow: (row: number, time: number) => void;
  };
  for (currentRow = 0; currentRow < rows; currentRow++) {
    internals.scheduleRow(currentRow, currentRow * 0.1);
  }
  return scheduled;
}

describe('a bare Cxx row cuts, rather than fading across the row before it', () => {
  it('schedules the volume as a step', () => {
    const song = songFromImport(
      importModToTrackerSong(
        createModBuffer([
          { row: 0, period: PERIOD, sampleNumber: 1 },
          // C00 on its own: no note, no sample number.
          { row: 1, effectCmd: 0xc, effectParam: 0x00 },
        ]),
      ),
    );

    const cut = volumesFor(song, 0, 0, 4).find((s) => s.row === 1);
    expect(cut).toBeDefined();
    expect(cut!.volume).toBe(0);
    // Omitting the mode ramps linearly from the note-on a row earlier, i.e.
    // fades the note out over that row instead of cutting it.
    expect(cut!.ramp).toBe('step');
  });

  it('still lets a volume slide ramp', () => {
    // A50: five rows' worth of per-tick slide. This one *must* ramp -- the
    // ramp is the cheap stand-in for stepping every tick.
    const song = songFromImport(
      importModToTrackerSong(
        createModBuffer([
          {
            row: 0,
            period: PERIOD,
            sampleNumber: 1,
            effectCmd: 0xa,
            effectParam: 0x50,
          },
        ]),
      ),
    );

    const ramps = volumesFor(song, 0, 0, 2)
      .filter((s) => s.row === 0)
      .map((s) => s.ramp);
    expect(ramps).toContain('linear');
  });
});

describe('jaguar_xj220_title.mod keeps its staccato lead', () => {
  const song = () => {
    const buf = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../public/demos/amiga/jaguar_xj220_title.mod',
      ),
    );
    return songFromImport(
      importModToTrackerSong(
        buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer,
      ),
    );
  };

  it('cuts channel 2 dead on every gate row instead of fading into it', () => {
    // Order 6, channel 2 (track index 1). Rows 0x1D and 0x28 each carry
    // nothing but C00, gating the note started on 0x1C and 0x26.
    const gates = volumesFor(song(), 6, 1, 0x2b).filter((s) => s.volume === 0);

    expect(gates.map((s) => s.row)).toEqual(
      expect.arrayContaining([0x1d, 0x28]),
    );
    for (const gate of gates) expect(gate.ramp).toBe('step');
  });
});
