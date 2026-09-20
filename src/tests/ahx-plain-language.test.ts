// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { emptyPListEntry } from 'src/audio/tracker/ahx-instrument-edit';
import {
  AHX_FX_NAMES,
  AHX_HELP,
  AHX_WAVE_CHARACTER,
  ahxDescribeFx,
  ahxFxParamTooltip,
  ahxFxTooltip,
  ahxPListChips,
} from 'src/audio/tracker/ahx-plain-language';

describe('the plain-language layer (E15)', () => {
  it('every help text is one sentence about the sound: non-empty, capitalised, ends with a full stop', () => {
    for (const [key, text] of Object.entries(AHX_HELP)) {
      expect(text.length, key).toBeGreaterThan(20);
      expect(text[0], key).toMatch(/[A-Z]/);
      expect(text, key).toMatch(/[.)]$/);
    }
  });

  it('the fields Morten named are covered, in plain words rather than raw names', () => {
    for (const key of [
      'squareLowerLimit', 'squareUpperLimit', 'squareSpeed',
      'filterLowerLimit', 'filterUpperLimit', 'filterSpeed', 'filterPosition',
      'vibratoDelay', 'vibratoSpeed', 'vibratoDepth',
      'hardCutRelease', 'plistSpeed', 'plistFixed', 'volume',
    ] as const) {
      expect(AHX_HELP[key], key).toBeTruthy();
    }
    expect(AHX_HELP.squareLowerLimit).toMatch(/thin/);
    expect(AHX_HELP.filterPosition).toMatch(/muffled/);
    expect(AHX_HELP.filterPosition).toMatch(/bright/);
    // the sweep "speed" fields are delays: the text must not claim a bigger number is faster
    expect(AHX_HELP.squareSpeed).toMatch(/bigger number is slower/);
    expect(AHX_HELP.filterSpeed).toMatch(/bigger number is slower/);
    // and no help text may promise "equal limits = no sweep": in the engine equal limits run straight past
    for (const text of Object.values(AHX_HELP)) expect(text).not.toMatch(/equal[^.]*nothing sweeps/i);
  });

  it('every waveform has a one-line character', () => {
    for (const kind of ['triangle', 'sawtooth', 'square', 'noise'] as const) {
      expect(AHX_WAVE_CHARACTER[kind]).toMatch(/^[A-Z][a-z]+: /);
    }
  });
});

describe('PList command names cover every command byte 0..15', () => {
  it('has a plain, non-empty name for each of the 16 commands', () => {
    for (let fx = 0; fx < 16; fx++) {
      expect(AHX_FX_NAMES[fx], `command ${fx}`).toBeTruthy();
    }
    expect(Object.keys(AHX_FX_NAMES)).toHaveLength(16);
  });

  it('describes every command (with a parameter), giving name, sentence and the raw code', () => {
    for (let fx = 0; fx < 16; fx++) {
      const d = ahxDescribeFx(fx, 0x11)!;
      expect(d, `command ${fx}`).not.toBeNull();
      expect(d.name).toBe(fx === 4 ? 'Pulse + brightness sweeps on/off' : AHX_FX_NAMES[fx]);
      expect(d.detail.length).toBeGreaterThan(10);
      expect(d.code).toBe(`${fx.toString(16).toUpperCase()}11`);
      expect(ahxFxTooltip(fx, 0x11)).toContain(d.name);
      expect(ahxFxParamTooltip(fx).length).toBeGreaterThan(10);
    }
  });

  it('the unassigned commands say they do nothing', () => {
    for (const fx of [6, 10, 11, 13, 14]) {
      expect(ahxDescribeFx(fx, 1)).toMatchObject({ name: 'Unused', kind: 'unused' });
      expect(ahxDescribeFx(fx, 1)!.detail).toMatch(/does nothing/);
    }
  });

  it('an empty slot (command 0, parameter 0) is not a command', () => {
    expect(ahxDescribeFx(0, 0)).toBeNull();
    expect(ahxFxTooltip(0, 0)).toMatch(/Empty/);
  });

  it('command 4 names the sweep it switches by its nibbles', () => {
    expect(ahxDescribeFx(4, 0)!.name).toBe('Pulse-width sweep on/off');
    expect(ahxDescribeFx(4, 0x01)!.name).toBe('Pulse-width sweep on/off');
    expect(ahxDescribeFx(4, 0x10)!.name).toBe('Brightness sweep on/off');
    expect(ahxDescribeFx(4, 0x1f)!.name).toBe('Pulse + brightness sweeps on/off');
    expect(ahxDescribeFx(4, 0xf0)!.detail).toMatch(/down/);
  });

  it('command details use the real parameter meaning', () => {
    expect(ahxDescribeFx(5, 2)!.detail).toMatch(/step 02/);
    expect(ahxDescribeFx(15, 6)!.detail).toMatch(/6 ticks/);
    expect(ahxDescribeFx(12, 0x30)!.detail).toMatch(/48 of 64/);
    expect(ahxDescribeFx(12, 0x60)!.detail).toMatch(/16 of 64/);
    expect(ahxDescribeFx(12, 0xa5)!.detail).toMatch(/master volume to 5/);
    expect(ahxDescribeFx(9, 0)!.detail).toMatch(/centre/);
    expect(ahxDescribeFx(0, 0x50)!.detail).toMatch(/ignores/);
    expect(ahxDescribeFx(0, 16)!.kind).toBe('brightness');
  });
});

describe('the PList strip chips (E6)', () => {
  const row = (over: Partial<ReturnType<typeof emptyPListEntry>>) => ({ ...emptyPListEntry(), ...over });

  it('makes one chip per entry, in order, with a hex row label', () => {
    const chips = ahxPListChips([row({}), row({ waveform: 3 }), row({ waveform: 1, note: 13, fixed: true })]);
    expect(chips.map((c) => c.hex)).toEqual(['00', '01', '02']);
    expect(chips.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it('names the tone, the pitch (relative or fixed) and every command in plain words', () => {
    const [chip] = ahxPListChips([
      row({ waveform: 3, note: 13, fixed: false, fx: [4, 0], fxParam: [0, 0] }),
    ]);
    expect(chip!.waveText).toBe('Square');
    expect(chip!.pitchText).toBe('+12 st');
    expect(chip!.fx.map((f) => [f.name, f.code])).toEqual([['Pulse-width sweep on/off', '400']]);
    const [fixed] = ahxPListChips([row({ note: 25, fixed: true })]);
    expect(fixed!.pitchText).toBe('C-3');
    expect(ahxPListChips([row({})])[0]!.pitchText).toBe('keep pitch');
  });

  it('marks a jump with its destination and an empty row with no commands', () => {
    const [jump, none] = ahxPListChips([row({ fx: [5, 0], fxParam: [2, 0] }), row({})]);
    expect(jump!.jumpTo).toBe(2);
    expect(none!.fx).toEqual([]);
    expect(none!.jumpTo).toBeNull();
  });

  it('the summary reads as a sentence with the step number', () => {
    const [chip] = ahxPListChips([row({ waveform: 4, fx: [15, 0], fxParam: [3, 0] })]);
    expect(chip!.summary).toContain('Step 00');
    expect(chip!.summary).toContain('Noise');
    expect(chip!.summary).toContain('Set step speed');
  });

  describe('the wording is true against the engine (B2 review)', () => {
    it('the decay level is held for the sustain time, not while a key is down', () => {
      expect(AHX_HELP.envDecayVolume).not.toMatch(/key/i);
      expect(AHX_HELP.envDecayVolume).toMatch(/sustain time/);
    });

    it('vibrato speed says the number wraps and where nothing wobbles', () => {
      expect(AHX_HELP.vibratoSpeed).toMatch(/wraps around every 64/);
      expect(AHX_HELP.vibratoSpeed).toMatch(/32, 64, 128 and 192/);
      expect(AHX_HELP.vibratoSpeed).toMatch(/64 minus the number, upside down/);
      expect(AHX_HELP.vibratoSpeed).not.toMatch(/slowly/);
    });

    it('the hard cut says what happens with the release box unticked', () => {
      expect(AHX_HELP.hardCutRelease).toMatch(/unticked.*muted? the note abruptly|mutes the note abruptly/i);
      expect(AHX_HELP.hardCutReleaseFrames).toMatch(/unticked it is muted abruptly/);
    });

    it('PList step speeds 0, 1 and 128-255 all step every tick', () => {
      expect(AHX_HELP.plistSpeed).toMatch(/0, 1 and 128-255 all step every tick/);
      for (const speed of [0, 1, 128, 200, 255]) {
        expect(ahxDescribeFx(15, speed)!.detail, `speed ${speed}`).toMatch(/single tick/);
      }
      for (const speed of [2, 6, 127]) {
        expect(ahxDescribeFx(15, speed)!.detail, `speed ${speed}`).toContain(`${speed} ticks`);
      }
      expect(ahxFxParamTooltip(15)).toMatch(/128-255/);
    });
  });
});
