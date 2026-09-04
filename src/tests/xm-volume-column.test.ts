import { describe, it, expect } from 'vitest';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { parseVolumeColumnCommand } from 'src/audio/tracker/note-utils';
import {
  createTrackEffectState,
  processEffectTick0,
  processVolumeColumnTick0,
  processVolumeColumnTickN,
  volumeCommandIsTickBased,
  type ProcessorCommand,
  type TrackEffectState,
} from '@another-synth/tracker-playback';
import { XM_PROFILE } from '@another-synth/tracker-playback';
import { buildXm, cell } from './helpers/xm-builder';

/**
 * FastTracker 2's volume column.
 *
 * Only its 0x10-0x50 "set volume" range used to survive import; every command
 * from 0x60 up was dropped. Across a nine-module FT2 corpus that is 9070
 * cells, 5602 of them panning -- so panning was simply absent wherever a song
 * used the volume column for it rather than 8xx.
 */

function importOneCell(volumeColumn: number) {
  const song = importXmToTrackerSong(
    buildXm({
      numChannels: 1,
      patterns: [
        {
          numRows: 4,
          cells: [[cell(49, { instrument: 1, volumeColumn })]],
        },
      ],
      instruments: [{ samples: [{ frames: [0, 1, 0, -1] }] }],
    }).buffer as ArrayBuffer,
  );
  return song.data.patterns[0]!.tracks[0]!.entries.find((e) => e.row === 0);
}

describe('XM import carries volume-column commands', () => {
  it('keeps a command byte as volumeCommand', () => {
    // 0xC8 = set panning, centre.
    expect(importOneCell(0xc8)?.volumeCommand).toBe('C8');
  });

  it('leaves the set-volume range in the volume column', () => {
    // 0x30 = set volume 32 of 64, i.e. half, which is a velocity not a command.
    const entry = importOneCell(0x30);
    expect(entry?.volumeCommand).toBeUndefined();
    expect(entry?.volume).toBe('80');
  });

  it('still applies the sample default volume alongside a command', () => {
    // A note with an instrument and no *set volume* plays at the sample's
    // default, even when the volume column carries a command instead.
    const entry = importOneCell(0xc8);
    expect(entry?.volume).toBeDefined();
  });
});

describe('parseVolumeColumnCommand', () => {
  it('splits the byte into command and parameter', () => {
    expect(parseVolumeColumnCommand('6A')).toEqual({
      type: 'volSlideDown',
      value: 0xa,
    });
    expect(parseVolumeColumnCommand('75')).toEqual({
      type: 'volSlideUp',
      value: 5,
    });
    expect(parseVolumeColumnCommand('83')).toEqual({
      type: 'fineVolDown',
      value: 3,
    });
    expect(parseVolumeColumnCommand('9F')).toEqual({
      type: 'fineVolUp',
      value: 0xf,
    });
    expect(parseVolumeColumnCommand('A4')).toEqual({
      type: 'vibratoSpeed',
      value: 4,
    });
    expect(parseVolumeColumnCommand('B6')).toEqual({
      type: 'vibrato',
      value: 6,
    });
    expect(parseVolumeColumnCommand('C8')).toEqual({ type: 'setPan', value: 8 });
    expect(parseVolumeColumnCommand('D2')).toEqual({
      type: 'panSlideLeft',
      value: 2,
    });
    expect(parseVolumeColumnCommand('E2')).toEqual({
      type: 'panSlideRight',
      value: 2,
    });
  });

  it('scales tone portamento by 16', () => {
    // FT2 keeps the volume column's tone-porta speed in the high nibble, so
    // 0xF3 is speed 0x30, not 3.
    expect(parseVolumeColumnCommand('F3')).toEqual({
      type: 'tonePorta',
      value: 0x30,
    });
  });

  it('rejects the set-volume range and empty input', () => {
    expect(parseVolumeColumnCommand('30')).toBeUndefined();
    expect(parseVolumeColumnCommand('50')).toBeUndefined();
    expect(parseVolumeColumnCommand(undefined)).toBeUndefined();
    expect(parseVolumeColumnCommand('')).toBeUndefined();
  });
});

function xmState(volume = 0.5): TrackEffectState {
  const state = createTrackEffectState(XM_PROFILE);
  state.currentVolume = volume;
  return state;
}

const volumeOf = (commands: ProcessorCommand[]) => {
  const hits = commands.filter((c) => c.kind === 'volume');
  return hits[hits.length - 1]?.volume;
};
const panOf = (commands: ProcessorCommand[]) => {
  const hits = commands.filter((c) => c.kind === 'pan');
  return hits[hits.length - 1]?.pan;
};

describe('volume-column playback', () => {
  it('applies a fine volume slide once, on tick 0', () => {
    const state = xmState(0.5);
    const batch = processVolumeColumnTick0(state, {
      type: 'fineVolDown',
      value: 4,
    });

    expect(volumeOf(batch.commands)).toBeCloseTo(0.5 - 4 / 64, 6);
    expect(volumeCommandIsTickBased({ type: 'fineVolDown', value: 4 })).toBe(
      false,
    );
  });

  it('slides volume on every tick after the first', () => {
    const state = xmState(0.5);
    const command = { type: 'volSlideDown', value: 4 } as const;
    processVolumeColumnTick0(state, command);

    // Tick 0 only emits the starting point; the slide itself starts at tick 1.
    expect(state.currentVolume).toBeCloseTo(0.5, 6);
    processVolumeColumnTickN(state, command);
    expect(state.currentVolume).toBeCloseTo(0.5 - 4 / 64, 6);
    processVolumeColumnTickN(state, command);
    expect(state.currentVolume).toBeCloseTo(0.5 - 8 / 64, 6);
  });

  it('sets panning with FT2 scaling', () => {
    const centre = xmState();
    expect(panOf(processVolumeColumnTick0(centre, { type: 'setPan', value: 8 }).commands)).toBe(0);

    const left = xmState();
    expect(panOf(processVolumeColumnTick0(left, { type: 'setPan', value: 0 }).commands)).toBe(-1);

    // FT2 stores this as x<<4, so the top of the range is 240 not 255 and
    // hard right is unreachable from the volume column.
    const right = xmState();
    expect(
      panOf(processVolumeColumnTick0(right, { type: 'setPan', value: 15 }).commands),
    ).toBeCloseTo(240 / 128 - 1, 6);
  });

  it('slides panning per tick', () => {
    const state = xmState();
    state.currentPan = 0;
    const command = { type: 'panSlideRight', value: 8 } as const;
    processVolumeColumnTick0(state, command);
    processVolumeColumnTickN(state, command);

    // FT2 pans in units of its own 0..255 byte (v_PanSlideRight:
    // `ch->outPan + (ch->volColumnVol & 0x0F)`), so one unit is 2/255 of the
    // processor's -1..1 swing -- not the volume-slide 1/64 this asserted
    // before it was checked against the C (D89).
    expect(state.currentPan).toBeCloseTo((8 * 2) / 255, 6);
  });

  it('vibrato takes its depth from the column and its speed from the channel', () => {
    const state = xmState();
    // 0xA4 sets the speed without starting a vibrato...
    processVolumeColumnTick0(state, { type: 'vibratoSpeed', value: 4 });
    expect(state.vibratoSpeed).toBe(4);

    // ...and 0xB6 then runs one at depth 6 using that speed.
    processVolumeColumnTick0(state, { type: 'vibrato', value: 6 });
    expect(state.vibratoDepth).toBe(6);
    expect(state.vibratoSpeed).toBe(4);
    expect(volumeCommandIsTickBased({ type: 'vibrato', value: 6 })).toBe(true);
  });

  it('arms tone portamento without needing a 3xx in the effect column', () => {
    const state = xmState();
    // A note is already playing...
    processEffectTick0(state, undefined, 60, 255, 261.63, 6);
    // ...and the row's note is the target, with the column supplying the speed.
    // The ninth argument is how the note handling is told the volume column
    // carries an Mx, since the column itself is processed after it.
    processEffectTick0(
      state,
      undefined,
      67,
      255,
      392.0,
      6,
      undefined,
      undefined,
      true,
    );
    processVolumeColumnTick0(state, { type: 'tonePorta', value: 0x30 });

    expect(state.tonePortaSpeed).toBe(0x30);
    expect(state.tonePortaActive).toBe(true);
    // The note set the target and left the playing pitch alone.
    expect(state.targetFrequency).toBeCloseTo(392.0, 6);
    expect(state.currentFrequency).toBeCloseTo(261.63, 6);
  });

  /**
   * Mx is a tone portamento in every respect the note cares about: FT2 reads
   * the volume column while setting the note up, so the row's note becomes the
   * slide's target rather than retriggering the sample. Because the column is
   * processed after the note here, processEffectTick0 has to be told about it
   * separately -- without that it saw an empty effect column, retriggered the
   * note at its own pitch, and left the slide with nothing to travel: target
   * and current were the same frequency, so nothing ever moved.
   */
  it('does not retrigger the note it is meant to bend towards', () => {
    const state = xmState();
    const first = processEffectTick0(state, undefined, 60, 255, 261.63, 6);
    expect(first.commands.some((c) => c.kind === 'noteOn')).toBe(true);

    const second = processEffectTick0(
      state,
      undefined,
      67,
      255,
      392.0,
      6,
      undefined,
      undefined,
      true,
    );
    expect(second.commands.some((c) => c.kind === 'noteOn')).toBe(false);
    processVolumeColumnTick0(state, { type: 'tonePorta', value: 0x30 });

    // And the slide actually travels: each tick moves the pitch up towards
    // G4, and it never overshoots.
    let previous = state.currentFrequency;
    for (let tick = 1; tick < 6 && previous < 392.0; tick++) {
      const batch = processVolumeColumnTickN(state, {
        type: 'tonePorta',
        value: 0x30,
      });
      const pitch = batch.commands.find((c) => c.kind === 'pitch');
      expect(pitch).toBeDefined();
      expect(pitch!.frequency).toBeGreaterThan(previous);
      expect(pitch!.frequency).toBeLessThanOrEqual(392.0 + 1e-9);
      previous = pitch!.frequency;
    }
    expect(previous).toBeGreaterThan(261.63);
    expect(previous).toBeLessThanOrEqual(392.0 + 1e-9);
  });

  /**
   * A following row with an Mx but no note keeps sliding towards the target
   * the last note set, exactly as a bare 3xx row does.
   */
  it('keeps sliding on a later row that carries no note', () => {
    const state = xmState();
    processEffectTick0(state, undefined, 60, 255, 261.63, 6);
    processEffectTick0(
      state,
      undefined,
      67,
      255,
      392.0,
      6,
      undefined,
      undefined,
      true,
    );
    processVolumeColumnTick0(state, { type: 'tonePorta', value: 0x30 });
    processVolumeColumnTickN(state, { type: 'tonePorta', value: 0x30 });

    // Next row: no note, and F0 (speed 0) reuses the remembered speed.
    processEffectTick0(state, undefined, undefined, undefined, undefined, 6);
    processVolumeColumnTick0(state, { type: 'tonePorta', value: 0 });
    expect(state.tonePortaSpeed).toBe(0x30);
    expect(state.targetFrequency).toBeCloseTo(392.0, 6);

    const before = state.currentFrequency;
    const batch = processVolumeColumnTickN(state, {
      type: 'tonePorta',
      value: 0,
    });
    const pitch = batch.commands.find((c) => c.kind === 'pitch');
    expect(pitch).toBeDefined();
    expect(pitch!.frequency).toBeGreaterThan(before);
  });

  it('re-arms its slides each row rather than remembering them', () => {
    // Unlike the effect column's Axy under FT2, the volume column's slides
    // have no parameter memory: a row without one simply does not slide.
    const state = xmState(0.5);
    processVolumeColumnTick0(state, { type: 'volSlideDown', value: 4 });
    processVolumeColumnTickN(state, { type: 'volSlideDown', value: 4 });
    const afterFirstRow = state.currentVolume;

    processVolumeColumnTick0(state, undefined);
    expect(state.volumeColumnSlide).toBe(0);
    expect(state.currentVolume).toBeCloseTo(afterFirstRow, 6);
  });

  it('does not disturb the effect column volume slide', () => {
    // Both columns can slide at once; they must not share an accumulator.
    const state = xmState(0.5);
    processEffectTick0(
      state,
      { type: 'volSlide', paramX: 2, paramY: 0 },
      60,
      undefined,
      261.63,
      6,
    );
    processVolumeColumnTick0(state, { type: 'volSlideDown', value: 4 });

    expect(state.volumeSlide.delta).toBeCloseTo(2 / 64, 6);
    expect(state.volumeColumnSlide).toBeCloseTo(-4 / 64, 6);
  });
});
