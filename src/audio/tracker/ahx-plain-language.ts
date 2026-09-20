/**
 * The plain-language layer of the AHX editor (editor plan E15): one sentence per
 * control that says what it does to the SOUND, and plain names for the PList's
 * commands. No naked jargon: where a term (PList, square, filter) has to be
 * used, the sentence says what it means for the ear.
 *
 * Wording is checked against the replayer, not guessed. In particular the two
 * "speed" fields of the sweeps are DELAYS: a bigger number is a slower sweep
 * (`voice.rs:174` sets `wait = speed`; `filter_sweep.rs:130` sets
 * `wait = max(speed - 3, 1)`).
 */
import type { AhxPListEntry } from '@another-synth/tracker-playback';
import {
  ahxNoteName,
  ahxWaveformKind,
  type AhxWaveformKind,
} from 'src/audio/tracker/ahx-instrument-display';

export type AhxHelpKey =
  | 'volume'
  | 'waveLength'
  | 'vibratoDelay'
  | 'vibratoSpeed'
  | 'vibratoDepth'
  | 'squareLowerLimit'
  | 'squareUpperLimit'
  | 'squareSpeed'
  | 'filterLowerLimit'
  | 'filterUpperLimit'
  | 'filterSpeed'
  | 'filterPosition'
  | 'hardCutRelease'
  | 'hardCutReleaseFrames'
  | 'plistSpeed'
  | 'plistAdd'
  | 'plistRow'
  | 'plistNote'
  | 'plistFixed'
  | 'plistWaveform'
  | 'plistFx'
  | 'plistInsert'
  | 'plistRemove'
  | 'startWaveform'
  | 'envAttackFrames'
  | 'envAttackVolume'
  | 'envDecayFrames'
  | 'envDecayVolume'
  | 'envSustainFrames'
  | 'envReleaseFrames'
  | 'envReleaseVolume';

/** One sentence per control: what changing it does to the sound. */
export const AHX_HELP: Readonly<Record<AhxHelpKey, string>> = {
  volume:
    'How loud this instrument is overall (0 is silent, 64 is full); the volume envelope shapes it over the note.',
  waveLength:
    'How many steps one cycle of the sound is drawn with: short (0) sounds rough and gritty, long (5) sounds smoother and fuller, and the pitch stays the same.',
  vibratoDelay:
    'How long the note stays steady before the pitch starts to wobble (0 wobbles from the very start).',
  vibratoSpeed:
    'How fast the pitch wobbles: from 1 up to about 16 a bigger number is a quicker warble. The number wraps around every 64, so 0, 32, 64, 128 and 192 give no wobble at all, and 33-63 wobble like 64 minus the number, upside down (starting downward): 33 is exactly as fast as 31, and 63 is as slow as 1.',
  vibratoDepth:
    'How far the pitch wobbles either side of the note: 0 is no vibrato at all, 15 is a wide, wobbly warble.',
  squareLowerLimit:
    'The thinnest the sound gets while the square wave sweeps: a thin pulse sounds nasal and buzzy, a wide one sounds full and hollow.',
  squareUpperLimit:
    'The fattest the sound gets while the square wave sweeps: a wide pulse sounds full and hollow, a thin one nasal and buzzy. Keep it above the lower value: the sweep bounces between the two.',
  squareSpeed:
    'How slowly the square wave sweeps between its two widths: it is a delay, so a bigger number is slower and 0 is fastest.',
  filterLowerLimit:
    'The softest point of the brightness sweep: below 32 the sound is muffled (the lower, the darker); 32 leaves it untouched.',
  filterUpperLimit:
    'The brightest point of the brightness sweep: above 32 the low end thins out and the sound gets sharper (the higher, the thinner); 32 leaves it untouched.',
  filterSpeed:
    'How slowly the brightness sweeps between its two limits: it is a delay, so a bigger number is slower and 0 is fastest.',
  filterPosition:
    'Where the brightness sits right now: below 32 is muffled and soft, above 32 is thin and bright, 32 leaves the sound untouched (0 changes nothing).',
  hardCutRelease:
    'When a following row sets an instrument, the note ramps down to its release level shortly before that row starts (not necessarily to silence), so notes end cleanly instead of running into each other. Unticked, a cut time above 0 mutes the note abruptly instead.',
  hardCutReleaseFrames:
    'How many ticks before the next row that sets an instrument the note is cut short (0 means it is never cut; a number above the song\u2019s tempo cuts right from the start of the row). With Hard cut release ticked it ramps to the release level over that time (fewer ticks if the tempo is shorter); unticked it is muted abruptly.',
  plistSpeed:
    'How many ticks each PList row (one step of the sound’s own little score) lasts: from 2 to 127 a smaller number steps through the rows faster, and 0, 1 and 128-255 all step every tick.',
  plistAdd: 'Adds a new empty step at the end of the PList, the little score that changes the sound during a note.',
  plistRow: 'A step of the PList, the little score that changes the sound during a note.',
  plistNote:
    'Changes the pitch on this step: relative steps are semitones above the key you play, fixed ones are an absolute note; 0 keeps the pitch.',
  plistFixed:
    'Ticked, this step plays its own fixed pitch whatever key is played; unticked, its note is an offset above the key you play.',
  plistWaveform:
    'Switches the tone on this step: triangle is soft, sawtooth is bright and buzzy, square is hollow, noise is hiss; Keep leaves the tone as it was.',
  plistFx:
    'An extra effect on this step, such as changing the brightness, sliding the pitch or jumping to another step.',
  plistInsert: 'Adds an empty step after this one.',
  plistRemove: 'Removes this step from the PList.',
  startWaveform:
    'The tone the note starts with: triangle is soft, sawtooth is bright and buzzy, square is hollow, noise is hiss; Keep leaves it as it was.',
  envAttackFrames:
    'How long the note takes to rise from silence to its first level: short is a hard strike, long is a slow fade-in (0 skips the attack \u2014 the note then starts silent).',
  envAttackVolume: 'How loud the note gets at the end of the attack.',
  envDecayFrames:
    'How long the note takes to settle from the attack level to the sustain level (0 skips the decay; with the attack time at 0 it rises from silence to the sustain level instead).',
  envDecayVolume:
    'The level the note settles at (with a non-zero attack and the decay time at 0 it stays at the attack level instead; with the attack and decay times both 0 the note never rises and stays silent); it holds there for the sustain time, then starts to die away (with the release time at 0 nothing dies away).',
  envSustainFrames:
    'How long the note holds its level before it starts to die away (with the release time at 0 nothing dies away).',
  envReleaseFrames:
    'How long the note takes to die away to the final level: short is abrupt, long is a slow fade (0 means it never fades).',
  envReleaseVolume: 'How loud the note is once it has died away (usually 0, which is silence).',
};

/** What a waveform sounds like (the wave picker's caption). */
export const AHX_WAVE_CHARACTER: Readonly<Record<AhxWaveformKind, string>> = {
  triangle: 'Triangle: a soft, mellow, flute-like tone.',
  sawtooth: 'Sawtooth: a bright, buzzy tone, rich in overtones.',
  square: 'Square: a hollow, reedy tone whose pulse width can sweep to thin or fatten it.',
  noise: 'Noise: a hiss with no pitch of its own, used for drums and effects.',
};

// ---------------------------------------------------------------------------
// PList commands
// ---------------------------------------------------------------------------

export type AhxFxKind =
  | 'brightness'
  | 'slide'
  | 'pulse'
  | 'sweep'
  | 'jump'
  | 'ring'
  | 'pan'
  | 'volume'
  | 'speed'
  | 'unused';

export interface AhxFxDescription {
  /** The plain name of what the command does. */
  name: string;
  /** One sentence about this particular use of it. */
  detail: string;
  kind: AhxFxKind;
  /** Raw code as tracker text, e.g. `F04` (small, secondary). */
  code: string;
}

/** Whether a PList step speed moves on every tick: 0, 1 and 128-255 (`voice.rs:541-543` reads the wait as a signed byte). */
export const ahxPListStepsEveryTick = (speed: number): boolean => speed <= 1 || speed >= 128;

const hex = (n: number, width: number): string => n.toString(16).toUpperCase().padStart(width, '0');

/** Every PList command byte 0..=15 has a name here (6, 10, 11, 13 and 14 have no meaning in the engine). */
export const AHX_FX_NAMES: Readonly<Record<number, string>> = {
  0: 'Set brightness',
  1: 'Pitch slide up',
  2: 'Pitch slide down',
  3: 'Set pulse width',
  4: 'Sweep on/off',
  5: 'Jump to step',
  6: 'Unused',
  7: 'Ring mod (triangle)',
  8: 'Ring mod (sawtooth)',
  9: 'Stereo pan',
  10: 'Unused',
  11: 'Unused',
  12: 'Set volume',
  13: 'Unused',
  14: 'Unused',
  15: 'Set step speed',
};

/** The empty command slot: command 0 with nothing set. */
export const ahxFxIsEmpty = (fx: number, param: number): boolean => fx === 0 && param === 0;

function sweepDetail(param: number): { name: string; detail: string } {
  const lowSign = (param & 0x0f) === 0x0f ? 'down' : 'up';
  const highSign = (param & 0xf0) === 0xf0 ? 'down' : 'up';
  if (param === 0) {
    return { name: 'Pulse-width sweep on/off', detail: 'Starts (or stops) the square wave’s pulse width sweeping, heading up.' };
  }
  const square = (param & 0x0f) !== 0;
  const filter = (param & 0xf0) !== 0;
  if (square && filter) {
    return {
      name: 'Pulse + brightness sweeps on/off',
      detail: `Starts (or stops) both the pulse width (heading ${lowSign}) and the brightness (heading ${highSign}) sweeping.`,
    };
  }
  if (square) {
    return { name: 'Pulse-width sweep on/off', detail: `Starts (or stops) the square wave’s pulse width sweeping, heading ${lowSign}.` };
  }
  return { name: 'Brightness sweep on/off', detail: `Starts (or stops) the brightness sweeping, heading ${highSign}.` };
}

function ringDetail(param: number): string {
  if (param >= 1 && param <= 0x3c) return `Blends in a metallic ring-modulated tone at the fixed note ${ahxNoteName(param)}.`;
  if (param >= 0x81 && param <= 0xbc) return 'Blends in a metallic ring-modulated tone at a pitch relative to the note played.';
  return 'Switches the metallic ring-modulated tone off.';
}

function volumeDetail(param: number): string {
  if (param <= 0x40) return `Sets this note’s volume to ${param} of 64.`;
  if (param >= 0x50 && param <= 0x90) return `Scales the note’s volume to ${param - 0x50} of 64 (the step-volume tier).`;
  if (param >= 0xa0 && param <= 0xe0) return `Sets this channel’s master volume to ${param - 0xa0} of 64.`;
  return 'A volume the engine ignores (it only uses 0-40, 50-90 and A0-E0).';
}

/**
 * A PList command in plain words, or `null` for an empty slot. The name says what
 * happens to the sound; the detail is one sentence about this parameter.
 */
export function ahxDescribeFx(fx: number, param: number): AhxFxDescription | null {
  if (ahxFxIsEmpty(fx, param)) return null;
  const code = `${hex(fx, 1)}${hex(param, 2)}`;
  const base = AHX_FX_NAMES[fx] ?? 'Unused';
  const make = (kind: AhxFxKind, detail: string, name = base): AhxFxDescription => ({ name, detail, kind, code });
  switch (fx) {
    case 0:
      return param < 0x40
        ? make('brightness', `Sets the brightness to ${param}: below 32 muffles the sound, above 32 thins and sharpens it, 32 leaves it untouched.`)
        : make('brightness', 'A brightness the engine ignores (it only uses 1-63).');
    case 1:
      return make('slide', `Glides the pitch up, faster the bigger the number (${param}).`);
    case 2:
      return make('slide', `Glides the pitch down, faster the bigger the number (${param}).`);
    case 3:
      return make('pulse', `Sets the square wave’s pulse width to position ${param}: small is thin and nasal, larger is fatter and hollow.`);
    case 4: {
      const sweep = sweepDetail(param);
      return make('sweep', sweep.detail, sweep.name);
    }
    case 5:
      return make('jump', `Jumps back (or ahead) to step ${hex(param, 2)}, so the sound loops there.`);
    case 7:
    case 8:
      return make('ring', ringDetail(param));
    case 9: {
      const signed = param > 127 ? param - 256 : param;
      const side = signed === 0 ? 'the centre' : signed < 0 ? `the left (${-signed})` : `the right (${signed})`;
      return make('pan', `Moves the sound to ${side} of the stereo picture.`);
    }
    case 12:
      return make('volume', volumeDetail(param));
    case 15:
      return make(
        'speed',
        ahxPListStepsEveryTick(param)
          ? 'From here every step lasts a single tick, so the sound changes as fast as it can (0, 1 and 128-255 all do this).'
          : `From here each step lasts ${param} ticks, so the sound changes more slowly the bigger the number.`,
      );
    default:
      return make('unused', 'This command does nothing in the engine.');
  }
}

/** The text for a PList command select's tooltip: the command's plain meaning, or a prompt for the empty slot. */
export function ahxFxTooltip(fx: number, param: number): string {
  const described = ahxDescribeFx(fx, param);
  if (described) return `${described.name}: ${described.detail}`;
  return `${AHX_HELP.plistFx} (Empty: this slot does nothing.)`;
}

/** What each command's parameter means, for the parameter field's tooltip. */
export function ahxFxParamTooltip(fx: number): string {
  switch (fx) {
    case 0:
      return 'Brightness position 1-63: below 32 muffles the sound, above 32 thins and sharpens it, 32 leaves it untouched, 0 changes nothing.';
    case 1:
    case 2:
      return 'How fast the pitch glides: a bigger number is a faster slide.';
    case 3:
      return 'The pulse-width position of the square wave: small is thin and nasal, larger is fatter and hollow.';
    case 4:
      return 'Which sweeps to switch: the low digit is the pulse width, the high digit the brightness; F in a digit sends it downwards, any other digit upwards; 0 alone toggles the pulse width.';
    case 5:
      return 'The step to jump to.';
    case 7:
    case 8:
      return 'A note (1-3C) for a fixed ring-mod pitch, or 81-BC for one relative to the key played; anything else turns it off.';
    case 9:
      return 'Stereo position: 0 is the centre, 1-7F moves right, 80-FF moves left.';
    case 12:
      return 'Volume: 0-40 is this note’s volume, 50-90 the step-volume tier, A0-E0 the channel’s master volume.';
    case 15:
      return 'How many ticks each step lasts from here on (2-127; 0, 1 and 128-255 all step every tick).';
    default:
      return 'The value the command works on; this command does nothing in the engine.';
  }
}

// ---------------------------------------------------------------------------
// The PList strip's chips (E6)
// ---------------------------------------------------------------------------

export interface AhxPListChip {
  index: number;
  hex: string;
  /** The row's waveform: a kind, or `keep` when it leaves the tone alone. */
  wave: AhxWaveformKind | 'keep' | 'unknown';
  waveText: string;
  /** The pitch this row sets: `keep pitch`, a fixed note name, or semitones above the key played. */
  pitchText: string;
  pitchTitle: string;
  fx: AhxFxDescription[];
  /** The step a jump on this row goes to, if it has one. */
  jumpTo: number | null;
  /** Plain-language summary for the chip's tooltip / aria-label. */
  summary: string;
}

export function ahxPListChips(entries: readonly AhxPListEntry[]): AhxPListChip[] {
  return entries.map((entry, index) => {
    const wave = ahxWaveformKind(entry.waveform);
    const waveText =
      wave === 'keep' ? 'same tone' : wave === 'unknown' ? `tone ?${entry.waveform}` : wave[0]!.toUpperCase() + wave.slice(1);
    const pitchText =
      entry.note === 0 ? 'keep pitch' : entry.fixed ? ahxNoteName(entry.note) : `+${entry.note - 1} st`;
    const pitchTitle =
      entry.note === 0
        ? 'This step leaves the pitch as it was.'
        : entry.fixed
          ? `A fixed pitch, ${ahxNoteName(entry.note)}, whatever key is played.`
          : `${entry.note - 1} semitones above the key played.`;
    const fx: AhxFxDescription[] = [];
    let jumpTo: number | null = null;
    entry.fx.forEach((command, slot) => {
      const described = ahxDescribeFx(command, entry.fxParam[slot] ?? 0);
      if (!described) return;
      fx.push(described);
      if (command === 5) jumpTo = entry.fxParam[slot] ?? 0;
    });
    const parts = [`Step ${hex(index, 2)}`, waveText, pitchText, ...fx.map((f) => f.name)];
    return {
      index,
      hex: hex(index, 2),
      wave,
      waveText,
      pitchText,
      pitchTitle,
      fx,
      jumpTo,
      summary: `${parts.join(', ')}. ${fx.map((f) => f.detail).join(' ')}`.trim(),
    };
  });
}
