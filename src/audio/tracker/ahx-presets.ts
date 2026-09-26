import {
  ahxPListCommandsFor,
  normalizeAhxInstrumentForVersion,
  type AhxInstrument,
  type AhxPListEntry,
  type AhxSongFormat,
} from '@another-synth/tracker-playback';

/**
 * Ready-made AHX/HVL instruments: basses, leads, arpeggios, pads, keys, drums
 * and effects, so a song can be made without knowing how an AHX instrument
 * works. Each one says in plain words what it sounds like and how it is made,
 * which is also the shortest way to learn the instrument page.
 *
 * Unlike a SID preset (`sid-presets.ts`) there is nothing shared to relocate:
 * an AHX instrument carries everything it plays (its envelope, its sweeps and
 * its PList, the little per-tick score), so a preset is a whole
 * `AhxInstrument`.
 *
 * What the numbers mean (all from the Rust player, `rust-wasm/src/ahx`):
 *
 * - Pitch. A PList row's note is relative unless the row is fixed: the voice
 *   plays `note + transpose + trackNote - 1` (`voice.rs` `calc_period`), so
 *   relative note 1 is the key played and 13 an octave up; a fixed row plays
 *   note `note` itself (1 = C-1 .. 60 = B-5). Note 0 keeps the pitch the voice
 *   had, which for a fresh voice is one semitone below the key, so every
 *   preset's first row sets a note.
 * - Wave length is an octave switch as well as a timbre one: a cycle is
 *   `4 << waveLength` bytes of the same 640-byte buffer read at the note's
 *   rate (`voice.rs` `set_audio`), so each step down doubles the pitch. At 3
 *   (32 bytes) the notes sound at their written pitch; every preset uses 3.
 * - Waveforms (`waveform - 1`, `voice.rs` WAVEFORM_*): 1 triangle, 2 sawtooth,
 *   3 square, 4 noise. 0 keeps the one before.
 * - The square wave's width is `squarePos`, set by PList command 3 (`plist.rs`
 *   case 3: `param >> (5 - waveLength)`) and walked by the square sweep
 *   between the lower and upper limits (`voice.rs` `SquareSweep`). The duty is
 *   `x / 64` with `x` the width folded at 0x20 (`calc_square`): 0x20 is a 50 %
 *   square, 0x10 a 25 % pulse, 0x08 a thin 12.5 % one. The position survives
 *   from one note to the next on a channel, so a square preset sets it on its
 *   first row.
 * - The "filter" is no filter at run time: it picks one of 63 precomputed
 *   rows of each waveform (`filter_sweep.rs`, `voice.rs` offset
 *   `(pos - 0x20) * FILTER_ROW_SIZE`). 32 is the plain wave, below 32 is
 *   muffled (low-pass, darker the lower), above 32 thinned (high-pass).
 *   Command 0 sets the position; the sweep bounces it between the filter
 *   limits.
 * - Sweeps only run once PList command 4 toggles them (`plist.rs` case 4):
 *   the low nibble toggles the square sweep, the high nibble the filter sweep,
 *   and a nibble of F starts it heading down. Toggling again stops it where it
 *   is. A version-0 AHX file cannot toggle the filter (`ahxFxParamMax`), so
 *   presets that sweep the filter are left out of such a song.
 * - Sweep speeds are delays: the square steps once every `squareSpeed` ticks;
 *   the filter takes `5 - speed` steps a tick below 4, then one step every
 *   `speed - 3` ticks (`filter_sweep.rs` `step`).
 * - PList commands 1 and 2 slide the pitch by the parameter (period units) a
 *   tick for as long as their row is the current one (`voice.rs`: every new
 *   row clears the slide, and a row that sets a waveform resets it). A row
 *   that jumps to itself (command 5) keeps a slide going for ever.
 * - Command 12 sets the note's volume (0-64), command 15 how many ticks each
 *   following row lasts. HVL adds 7/8 (ring modulation with a triangle or a
 *   sawtooth; `0x81 + n` is `n` semitones above the key) and 9 (pan); AHX's
 *   3-bit code cannot hold them (`ahxPListCommandsFor`), so those presets are
 *   HVL's only.
 * - The envelope counts ticks (50 a second at speed x1): attack to the attack
 *   volume, decay to the decay volume, hold for the sustain ticks, release to
 *   the release volume (`envelope.rs`). There is no key-off in a song: a note
 *   rings for attack + decay + sustain + release, or until the channel's next
 *   note. The keyboard preview holds the sustain while the key is down.
 */

export type AhxPresetCategory = 'Bass' | 'Lead' | 'Arpeggio' | 'Pad' | 'Keys' | 'Drums' | 'FX';

export const AHX_PRESET_CATEGORIES: readonly AhxPresetCategory[] = ['Bass', 'Lead', 'Arpeggio', 'Pad', 'Keys', 'Drums', 'FX'];

/**
 * The longest preset name. The file stores names NUL-terminated with no limit
 * of its own and the reference replayer keeps 128 bytes (`hvl_replay.h`
 * `ins_Name[128]`); the corpus's longest is 34. Kept short so it fits the
 * instrument list.
 */
export const AHX_PRESET_MAX_NAME_LENGTH = 16;

export interface AhxPreset {
  readonly id: string;
  readonly name: string;
  readonly category: AhxPresetCategory;
  /** What it sounds like and how it is made, in plain words. */
  readonly description: string;
  /** The whole instrument; its name is `name`. */
  readonly instrument: Readonly<AhxInstrument>;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const TRI = 1;
const SAW = 2;
const SQR = 3;
const NOI = 4;

type Cmd = readonly [fx: number, param: number];

/** Command 0: the filter position, 1-63 (32 plain, lower muffled, higher thin). */
const tone = (position: number): Cmd => [0, position];
/** Command 1: slide the pitch up by `speed` a tick while this row lasts. */
const up = (speed: number): Cmd => [1, speed];
/** Command 2: slide the pitch down by `speed` a tick while this row lasts. */
const down = (speed: number): Cmd => [2, speed];
/** Command 3: the square wave's width, 0x20 = 50 %, 0x10 = 25 %, 0x08 = 12.5 %. */
const width = (value: number): Cmd => [3, value];
/** Command 4 with the low nibble: start (or stop) the square sweep, heading up. */
const PWM: Cmd = [4, 0x01];
/** Command 4 with the high nibble F: start (or stop) the filter sweep, heading down (darker). */
const FILTER_DOWN: Cmd = [4, 0xf0];
/** Command 4 with the high nibble: start (or stop) the filter sweep, heading up. */
const FILTER_UP: Cmd = [4, 0x10];
/** Command 5: continue at row `row` (0-based). */
const jump = (row: number): Cmd => [5, row];
/** Command 12: the note's volume, 0-64. */
const volume = (value: number): Cmd => [12, value];
/** Command 15: each row from here lasts `ticks` ticks. */
const ticks = (value: number): Cmd => [15, value];
/** HVL command 7/8: ring-modulate with a triangle (7) or sawtooth (8) `semitones` above the key. */
const ring = (fx: 7 | 8, semitones: number): Cmd => [fx, 0x81 + semitones];
/** HVL command 9: pan, -128 (left) .. 127 (right). */
const pan = (value: number): Cmd => [9, value & 0xff];

function entry(note: number, waveform: number, fixed: boolean, cmds: readonly Cmd[]): AhxPListEntry {
  if (cmds.length > 2) throw new Error('an AHX PList row has two command slots');
  const [a = [0, 0], b = [0, 0]] = cmds;
  return { note, waveform, fixed, fx: [a[0], b[0]], fxParam: [a[1], b[1]] };
}

/** Waveform `wave` at `semitones` above the key. */
const play = (wave: number, semitones: number, ...cmds: Cmd[]): AhxPListEntry => entry(semitones + 1, wave, false, cmds);
/** Waveform `wave` at the fixed note `note` (1 = C-1, 25 = C-3, 49 = C-5, 60 = B-5), whatever key is played. */
const fixed = (wave: number, note: number, ...cmds: Cmd[]): AhxPListEntry => entry(note, wave, true, cmds);
/** The same waveform, `semitones` above the key. */
const to = (semitones: number, ...cmds: Cmd[]): AhxPListEntry => entry(semitones + 1, 0, false, cmds);
/** Keep the waveform and pitch; only the commands. */
const keep = (...cmds: Cmd[]): AhxPListEntry => entry(0, 0, false, cmds);

interface Envelope {
  /** Attack ticks (at least 1: with attack and decay both 0 the note never rises) and the level it reaches. */
  a: number;
  av: number;
  d: number;
  dv: number;
  s: number;
  r: number;
  rv?: number;
}

interface Spec {
  volume?: number;
  env: Envelope;
  /** PList ticks per row. */
  speed?: number;
  rows: AhxPListEntry[];
  square?: { lower: number; upper: number; speed: number };
  filter?: { lower: number; upper: number; speed: number };
  vibrato?: { delay: number; speed: number; depth: number };
}

/**
 * The instrument volume a preset gets unless it says: the square tables play
 * about 4 dB louder than the sawtooth and triangle ones (measured through the
 * player at C-4: rms 0.30 against 0.16-0.19), so a preset that starts on the
 * square is turned down to 48 to sit level with the rest.
 */
const levelFor = (rows: readonly AhxPListEntry[]): number => (rows[0]?.waveform === SQR ? 48 : 64);

function instrument(name: string, spec: Spec): AhxInstrument {
  const { env } = spec;
  return {
    name,
    volume: spec.volume ?? levelFor(spec.rows),
    waveLength: 3,
    filterLowerLimit: spec.filter?.lower ?? 0,
    filterUpperLimit: spec.filter?.upper ?? 0,
    filterSpeed: spec.filter?.speed ?? 0,
    squareLowerLimit: spec.square?.lower ?? 0,
    squareUpperLimit: spec.square?.upper ?? 0,
    squareSpeed: spec.square?.speed ?? 0,
    vibratoDelay: spec.vibrato?.delay ?? 0,
    vibratoSpeed: spec.vibrato?.speed ?? 0,
    vibratoDepth: spec.vibrato?.depth ?? 0,
    hardCutRelease: false,
    hardCutReleaseFrames: 0,
    envelope: { aFrames: env.a, aVolume: env.av, dFrames: env.d, dVolume: env.dv, sFrames: env.s, rFrames: env.r, rVolume: env.rv ?? 0 },
    plist: { speed: spec.speed ?? 1, entries: spec.rows },
  };
}

function preset(id: string, name: string, category: AhxPresetCategory, description: string, spec: Spec): AhxPreset {
  return { id, name, category, description, instrument: instrument(name, spec) };
}

/** An arpeggio of `steps` semitones on `wave`, one row each, looping (row 0 also sets things up with `init`). */
function arp(wave: number, steps: readonly number[], ...init: Cmd[]): AhxPListEntry[] {
  const [first = 0, ...rest] = steps;
  // Row 0 plays the root and sets up; the loop is rows 1.., ending on the root and jumping back to row 1.
  return [play(wave, first, ...init), ...rest.map((s) => to(s)), to(first, jump(1))];
}

/** Held sounds: sustain long (a song note rings this long unless the channel plays another), then fade. */
const HELD = { s: 200 };

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

const PRESETS: AhxPreset[] = [
  // --- Bass ---------------------------------------------------------------
  preset('bass-square', 'Square Bass', 'Bass', 'A plain 50 % square wave: the round, hollow bass of countless Amiga tunes.', {
    env: { a: 1, av: 64, d: 12, dv: 48, ...HELD, r: 6 },
    rows: [play(SQR, 0, width(0x20))],
  }),
  preset('bass-saw', 'Saw Bass', 'Bass', 'A plain sawtooth: a buzzy, bright bass that cuts through.', {
    env: { a: 1, av: 64, d: 12, dv: 44, ...HELD, r: 6 },
    rows: [play(SAW, 0)],
  }),
  preset('bass-pluck', 'Plucked Bass', 'Bass', 'One tick an octave up for the pluck, then a short square note that dies away: good for fast bass lines.', {
    env: { a: 1, av: 64, d: 24, dv: 0, s: 0, r: 1 },
    rows: [play(SQR, 12, width(0x10)), to(0, width(0x20))],
  }),
  preset('bass-squelch', 'Squelch Bass', 'Bass', 'A sawtooth whose brightness snaps shut after each note (a filter sweep started and stopped by the PList): the squelchy synth bass.', {
    env: { a: 1, av: 64, d: 20, dv: 48, ...HELD, r: 6 },
    filter: { lower: 6, upper: 31, speed: 3 },
    rows: [play(SAW, 0, tone(31), FILTER_DOWN), keep(ticks(10)), keep(FILTER_DOWN)],
  }),
  preset('bass-octave', 'Octave Bass', 'Bass', 'Flips between the note and the octave above every tick: the busy, buzzing bass of many game tunes.', {
    env: { a: 1, av: 64, d: 12, dv: 44, ...HELD, r: 6 },
    rows: arp(SQR, [0, 12], width(0x18)),
  }),
  preset('bass-kick', 'Kick Bass', 'Bass', 'A bass drum and a bass note in one: a thump that drops in pitch, then the note. Saves a channel for the drums.', {
    env: { a: 1, av: 64, d: 16, dv: 48, ...HELD, r: 6 },
    rows: [fixed(NOI, 45), fixed(TRI, 28, down(0xe0)), keep(down(0xe0)), keep(down(0xe0)), keep(down(0xa0)), play(SQR, 0, width(0x20))],
  }),
  preset('bass-sub', 'Sub Bass', 'Bass', 'A plain triangle wave: soft and deep, a bass you feel more than hear.', {
    env: { a: 1, av: 64, d: 8, dv: 56, ...HELD, r: 8 },
    rows: [play(TRI, 0)],
  }),
  preset('bass-pwm', 'PWM Bass', 'Bass', 'A square wave whose width keeps sweeping between thin and full (the square sweep): a fat, moving bass.', {
    env: { a: 1, av: 64, d: 12, dv: 48, ...HELD, r: 6 },
    square: { lower: 0x08, upper: 0x20, speed: 3 },
    rows: [play(SQR, 0, width(0x20), PWM)],
  }),
  preset('bass-wobble', 'Wobble Bass', 'Bass', 'A held sawtooth whose brightness sweeps down and up about twice a second for as long as it plays: a wobble.', {
    env: { a: 1, av: 64, d: 6, dv: 56, ...HELD, r: 6 },
    filter: { lower: 4, upper: 30, speed: 3 },
    rows: [play(SAW, 0, tone(30), FILTER_DOWN)],
  }),

  // --- Lead ---------------------------------------------------------------
  preset('lead-pwm', 'PWM Lead', 'Lead', 'The classic Amiga lead: a square wave sweeping its width, with vibrato fading in on long notes.', {
    env: { a: 2, av: 64, d: 10, dv: 52, ...HELD, r: 12 },
    square: { lower: 0x08, upper: 0x20, speed: 2 },
    vibrato: { delay: 20, speed: 6, depth: 3 },
    rows: [play(SQR, 0, width(0x20), PWM)],
  }),
  preset('lead-saw', 'Saw Lead', 'Lead', 'A bright, buzzy sawtooth lead with vibrato that starts after a moment.', {
    env: { a: 1, av: 64, d: 12, dv: 50, ...HELD, r: 10 },
    vibrato: { delay: 20, speed: 6, depth: 3 },
    rows: [play(SAW, 0)],
  }),
  preset('lead-square', 'Square Lead', 'Lead', 'A steady 50 % square wave, full and hollow, with a gentle delayed vibrato.', {
    env: { a: 1, av: 64, d: 8, dv: 54, ...HELD, r: 10 },
    vibrato: { delay: 24, speed: 5, depth: 3 },
    rows: [play(SQR, 0, width(0x20))],
  }),
  preset('lead-bright', 'Bright Lead', 'Lead', 'A sawtooth with its low end thinned away (filter above 32): sharp and bright, it cuts through a busy mix.', {
    env: { a: 1, av: 64, d: 10, dv: 52, ...HELD, r: 10 },
    vibrato: { delay: 20, speed: 6, depth: 3 },
    rows: [play(SAW, 0, tone(40))],
  }),
  preset('lead-flute', 'Soft Flute', 'Lead', 'A triangle wave that fades in and has a slow vibrato: soft and breathy, like a flute or an ocarina.', {
    env: { a: 8, av: 56, d: 6, dv: 50, ...HELD, r: 12 },
    vibrato: { delay: 12, speed: 5, depth: 2 },
    rows: [play(TRI, 0)],
  }),
  preset('lead-nasal', 'Nasal Lead', 'Lead', 'A very thin pulse wave (12.5 % width): reedy and nasal, like an oboe or a kazoo.', {
    env: { a: 1, av: 64, d: 10, dv: 50, ...HELD, r: 10 },
    vibrato: { delay: 20, speed: 6, depth: 3 },
    rows: [play(SQR, 0, width(0x08))],
  }),
  preset('lead-chip', 'Chip Lead', 'Lead', 'A 25 % pulse that starts with one tick an octave up: the bouncy lead of chiptune melodies.', {
    env: { a: 1, av: 64, d: 14, dv: 46, ...HELD, r: 8 },
    vibrato: { delay: 16, speed: 7, depth: 3 },
    rows: [play(SQR, 12, width(0x10)), to(0)],
  }),
  preset('lead-wah', 'Wah Lead', 'Lead', 'A sawtooth whose brightness sweeps down and up again and again (the filter sweep): a talking, wah-wah lead.', {
    env: { a: 1, av: 64, d: 8, dv: 54, ...HELD, r: 10 },
    filter: { lower: 6, upper: 31, speed: 4 },
    rows: [play(SAW, 0, tone(31), FILTER_DOWN)],
  }),

  // --- Arpeggio (play the chord's root) -----------------------------------
  preset('arp-major', 'Major Arp', 'Arpeggio', 'A major chord played as a very fast arpeggio (root, third, fifth, one tick each): the happy chord of chip music.', {
    env: { a: 1, av: 60, d: 16, dv: 44, ...HELD, r: 8 },
    rows: arp(SQR, [0, 4, 7], width(0x10)),
  }),
  preset('arp-minor', 'Minor Arp', 'Arpeggio', 'A minor chord as a fast arpeggio (root, minor third, fifth): the sad or moody chord.', {
    env: { a: 1, av: 60, d: 16, dv: 44, ...HELD, r: 8 },
    rows: arp(SQR, [0, 3, 7], width(0x10)),
  }),
  preset('arp-maj7', 'Major 7 Arp', 'Arpeggio', 'A major seventh chord as a fast sawtooth arpeggio: dreamy and jazzy.', {
    env: { a: 1, av: 60, d: 16, dv: 40, ...HELD, r: 8 },
    rows: arp(SAW, [0, 4, 7, 11]),
  }),
  preset('arp-min7', 'Minor 7 Arp', 'Arpeggio', 'A minor seventh chord as a fast arpeggio: soft, soulful and a little melancholy.', {
    env: { a: 1, av: 60, d: 16, dv: 40, ...HELD, r: 8 },
    rows: arp(SQR, [0, 3, 7, 10], width(0x18)),
  }),
  preset('arp-dom7', 'Dom 7 Arp', 'Arpeggio', 'A dominant seventh chord as a fast arpeggio: bluesy, and wants to move on to the next chord.', {
    env: { a: 1, av: 60, d: 16, dv: 40, ...HELD, r: 8 },
    rows: arp(SQR, [0, 4, 7, 10], width(0x14)),
  }),
  preset('arp-sus4', 'Sus4 Arp', 'Arpeggio', 'A suspended chord (root, fourth, fifth) as a fast arpeggio: open and unresolved.', {
    env: { a: 1, av: 60, d: 16, dv: 44, ...HELD, r: 8 },
    rows: arp(SQR, [0, 5, 7], width(0x10)),
  }),
  preset('arp-dim', 'Dim Arp', 'Arpeggio', 'A diminished chord (root, minor third, flat fifth) as a fast arpeggio: tense and spooky.', {
    env: { a: 1, av: 60, d: 16, dv: 44, ...HELD, r: 8 },
    rows: arp(SQR, [0, 3, 6], width(0x10)),
  }),
  preset('arp-power', 'Power Arp', 'Arpeggio', 'Root, fifth and octave as a fast sawtooth arpeggio: a power chord, neither happy nor sad.', {
    env: { a: 1, av: 60, d: 16, dv: 44, ...HELD, r: 8 },
    rows: arp(SAW, [0, 7, 12]),
  }),
  preset('arp-slow-major', 'Slow Major Arp', 'Arpeggio', 'A major chord stepped slowly (three ticks a note) on a soft triangle: you hear each note of the chord.', {
    env: { a: 1, av: 60, d: 16, dv: 48, ...HELD, r: 10 },
    speed: 3,
    rows: arp(TRI, [0, 4, 7, 12]),
  }),
  preset('arp-slow-minor', 'Slow Minor Arp', 'Arpeggio', 'A minor chord stepped slowly (three ticks a note) on a square: a gentle rolling chord.', {
    env: { a: 1, av: 60, d: 16, dv: 44, ...HELD, r: 10 },
    speed: 3,
    rows: arp(SQR, [0, 3, 7, 12], width(0x18)),
  }),

  // --- Pad ----------------------------------------------------------------
  preset('pad-swell', 'Soft Swell', 'Pad', 'A square wave that fades in slowly while its width sweeps: a soft, moving background chord note.', {
    env: { a: 40, av: 48, d: 10, dv: 44, ...HELD, r: 40 },
    square: { lower: 0x0c, upper: 0x20, speed: 4 },
    vibrato: { delay: 30, speed: 4, depth: 1 },
    rows: [play(SQR, 0, width(0x20), PWM)],
  }),
  preset('pad-strings', 'Strings', 'Pad', 'A softened sawtooth (filter below 32) with a slow attack and a light vibrato: a string section.', {
    env: { a: 24, av: 52, d: 10, dv: 46, ...HELD, r: 30 },
    vibrato: { delay: 10, speed: 5, depth: 1 },
    rows: [play(SAW, 0, tone(18))],
  }),
  preset('pad-sweep', 'Sweep Pad', 'Pad', 'A sawtooth that fades in while its brightness slowly opens and closes: the classic filter-sweep pad.', {
    env: { a: 30, av: 52, d: 10, dv: 46, ...HELD, r: 30 },
    filter: { lower: 6, upper: 31, speed: 8 },
    rows: [play(SAW, 0, tone(6), FILTER_UP)],
  }),
  preset('pad-major', 'Major Pad', 'Pad', 'A whole major chord from one note: a fast arpeggio on a soft triangle that fades in, so the notes blur together.', {
    env: { a: 30, av: 48, d: 10, dv: 44, ...HELD, r: 30 },
    rows: arp(TRI, [0, 4, 7]),
  }),
  preset('pad-minor', 'Minor Pad', 'Pad', 'A whole minor chord from one note: a fast, muffled square arpeggio that fades in.', {
    env: { a: 30, av: 48, d: 10, dv: 44, ...HELD, r: 30 },
    rows: arp(SQR, [0, 3, 7], width(0x20), tone(16)),
  }),

  // --- Keys ---------------------------------------------------------------
  preset('keys-pluck', 'Pluck', 'Keys', 'A sawtooth that starts bright and quickly turns dull as it dies away: a plucked string.', {
    env: { a: 1, av: 64, d: 30, dv: 0, s: 0, r: 1 },
    filter: { lower: 4, upper: 32, speed: 4 },
    rows: [play(SAW, 0, tone(32), FILTER_DOWN), keep(ticks(22)), keep(FILTER_DOWN)],
  }),
  preset('keys-harpsichord', 'Harpsichord', 'Keys', 'A thin, bright pulse with an octave-up tick at the start and a quick fade: a plucked, baroque keyboard.', {
    env: { a: 1, av: 64, d: 50, dv: 0, s: 0, r: 1 },
    rows: [play(SQR, 12, width(0x08)), to(0, width(0x0c))],
  }),
  preset('keys-marimba', 'Marimba', 'Keys', 'A tick of bright square for the mallet, then a triangle that dies away quickly: a wooden marimba.', {
    env: { a: 1, av: 64, d: 18, dv: 0, s: 0, r: 1 },
    rows: [play(SQR, 19, width(0x20)), play(TRI, 0)],
  }),
  preset('keys-bell', 'Bell', 'Keys', 'Alternates the note with the twelfth above every tick, over a long fade: a bright, ringing bell.', {
    env: { a: 1, av: 64, d: 100, dv: 0, s: 0, r: 1 },
    rows: arp(TRI, [0, 19]),
  }),
  preset('keys-organ', 'Organ', 'Keys', 'A muffled square wave that starts and stops at once, with a slight fast wobble: an electric organ.', {
    env: { a: 1, av: 56, d: 1, dv: 56, ...HELD, r: 3 },
    vibrato: { delay: 0, speed: 10, depth: 1 },
    rows: [play(SQR, 0, width(0x20), tone(20))],
  }),
  preset('keys-epiano', 'E-Piano', 'Keys', 'A triangle with a soft square tick at the start, fading slowly: a mellow electric piano.', {
    env: { a: 1, av: 64, d: 40, dv: 28, s: 40, r: 30 },
    vibrato: { delay: 20, speed: 4, depth: 1 },
    rows: [play(SQR, 12, width(0x10), tone(20)), play(TRI, 0)],
  }),

  // --- Drums (fixed notes: any key plays the same, except the tom) --------
  preset('drum-kick', 'Kick', 'Drums', 'A click of noise, then a triangle that drops fast in pitch: a punchy bass drum. Any note plays the same.', {
    env: { a: 1, av: 64, d: 12, dv: 0, s: 0, r: 1 },
    rows: [fixed(NOI, 50), fixed(TRI, 30, down(0xe0)), keep(down(0xe0)), keep(down(0xe0)), keep(down(0xe0)), keep(down(0x80)), keep(down(0x40))],
  }),
  preset('drum-deep-kick', 'Deep Kick', 'Drums', 'A longer, lower bass drum: a triangle that falls to a deep boom and rings a little. Any note plays the same.', {
    env: { a: 1, av: 64, d: 24, dv: 0, s: 0, r: 1 },
    rows: [fixed(NOI, 45), fixed(TRI, 25, down(0xe0)), keep(down(0xe0)), keep(down(0xe0)), keep(down(0xe0)), keep(down(0xe0)), keep(down(0xc0)), keep(down(0x80)), keep(down(0x40))],
  }),
  preset('drum-snare', 'Snare', 'Drums', 'Two ticks of a low triangle for the body, then noise for the rattle: a snare drum. Any note plays the same.', {
    env: { a: 1, av: 64, d: 14, dv: 0, s: 0, r: 1 },
    rows: [fixed(TRI, 30, down(0x40)), keep(down(0x40)), fixed(NOI, 56)],
  }),
  preset('drum-noise-snare', 'Noise Snare', 'Drums', 'Pure noise with a quick fade: a crisp, electronic snare. Any note plays the same.', {
    env: { a: 1, av: 64, d: 10, dv: 0, s: 0, r: 1 },
    rows: [fixed(NOI, 52)],
  }),
  preset('drum-clap', 'Clap', 'Drums', 'Noise switched on and off a few times, then a short tail: hands clapping. Any note plays the same.', {
    env: { a: 1, av: 64, d: 14, dv: 0, s: 0, r: 1 },
    rows: [fixed(NOI, 54, tone(40)), keep(volume(8)), keep(volume(64)), keep(volume(8)), keep(volume(64))],
  }),
  preset('drum-hat', 'Closed Hat', 'Drums', 'A tick of high, thinned noise: a closed hi-hat. Any note plays the same.', {
    env: { a: 1, av: 64, d: 4, dv: 0, s: 0, r: 1 },
    rows: [fixed(NOI, 60, tone(52))],
  }),
  preset('drum-open-hat', 'Open Hat', 'Drums', 'High, thinned noise with a longer fade: an open hi-hat. Any note plays the same.', {
    env: { a: 1, av: 64, d: 20, dv: 0, s: 0, r: 1 },
    rows: [fixed(NOI, 60, tone(50))],
  }),
  preset('drum-crash', 'Crash', 'Drums', 'Bright noise fading slowly: a crash cymbal. Any note plays the same.', {
    env: { a: 1, av: 64, d: 10, dv: 44, s: 0, r: 70 },
    rows: [fixed(NOI, 58, tone(44))],
  }),
  preset('drum-rim', 'Rim', 'Drums', 'One tick of high square and one of noise: a dry rim shot or a woodblock. Any note plays the same.', {
    env: { a: 1, av: 64, d: 5, dv: 0, s: 0, r: 1 },
    rows: [fixed(SQR, 48, width(0x20)), fixed(NOI, 56), fixed(SQR, 44)],
  }),
  preset('drum-tom', 'Tom', 'Drums', 'A triangle that drops a little in pitch as it fades: a tom. The note you play sets how high it is.', {
    env: { a: 1, av: 64, d: 18, dv: 0, s: 0, r: 1 },
    rows: [play(NOI, 12), play(TRI, 0, down(0x10)), keep(ticks(12), down(0x10))],
  }),

  // --- FX -----------------------------------------------------------------
  preset('fx-laser', 'Laser', 'FX', 'A thin pulse an octave up, diving down fast: a sci-fi laser shot.', {
    env: { a: 1, av: 64, d: 16, dv: 0, s: 0, r: 1 },
    rows: [play(SQR, 12, width(0x08)), keep(down(0x20), jump(1))],
  }),
  preset('fx-zap', 'Zap', 'FX', 'A sawtooth an octave up, falling steeply in a flash: an electric zap.', {
    env: { a: 1, av: 64, d: 10, dv: 0, s: 0, r: 1 },
    rows: [play(SAW, 12), keep(down(0x60), jump(1))],
  }),
  preset('fx-riser', 'Riser', 'FX', 'A sawtooth that fades in and glides upward for as long as it plays: a build-up.', {
    env: { a: 40, av: 56, d: 1, dv: 56, ...HELD, r: 20 },
    rows: [play(SAW, 0), keep(up(3), jump(1))],
  }),
  preset('fx-drop', 'Drop', 'FX', 'A sawtooth that starts an octave up and falls for as long as it plays: a power-down.', {
    env: { a: 1, av: 60, d: 1, dv: 60, ...HELD, r: 20 },
    rows: [play(SAW, 12), keep(down(3), jump(1))],
  }),
  preset('fx-jump', 'Jump', 'FX', 'A short pulse blip sliding up: a platform-game jump.', {
    env: { a: 1, av: 64, d: 14, dv: 0, s: 0, r: 1 },
    rows: [play(SQR, 0, width(0x10)), keep(up(0x18), jump(1))],
  }),
  preset('fx-coin', 'Coin', 'FX', 'Two quick notes, the second a fourth up: pick-up, collect, score. Best played high (C-4 and up).', {
    env: { a: 1, av: 64, d: 30, dv: 0, s: 0, r: 1 },
    speed: 4,
    rows: [play(SQR, 0, width(0x20)), to(5)],
  }),
  preset('fx-powerup', 'Power Up', 'FX', 'A fast run up a major chord and on into the next octave: level up, extra life.', {
    env: { a: 1, av: 64, d: 8, dv: 56, s: 14, r: 16 },
    speed: 2,
    rows: [play(SQR, 0, width(0x10)), to(4), to(7), to(12), to(16), to(19)],
  }),
  preset('fx-teleport', 'Teleport', 'FX', 'A shimmering loop of notes climbing well over an octave, over and over, with the width sweeping: beam me up.', {
    env: { a: 1, av: 56, d: 10, dv: 48, ...HELD, r: 20 },
    square: { lower: 0x08, upper: 0x20, speed: 1 },
    rows: arp(SQR, [0, 5, 12, 17], width(0x20), PWM),
  }),
  preset('fx-explosion', 'Explosion', 'FX', 'Low noise that rumbles down in pitch and dies away slowly: an explosion. Any note plays the same.', {
    env: { a: 1, av: 64, d: 12, dv: 48, s: 0, r: 90 },
    rows: [fixed(NOI, 36), keep(down(0x10), jump(1))],
  }),
  preset('fx-siren', 'Siren', 'FX', 'A square wave sliding up and down by several semitones, half a second each way, for as long as it plays.', {
    env: { a: 1, av: 56, d: 1, dv: 56, ...HELD, r: 10 },
    rows: [play(SQR, 0, width(0x20)), keep(up(4), ticks(25)), keep(down(4)), keep(up(4), jump(2))],
  }),
  preset('fx-alarm', 'Alarm', 'FX', 'A square wave jumping between the note and its octave, a few times a second: an alarm or a phone.', {
    env: { a: 1, av: 56, d: 1, dv: 56, ...HELD, r: 4 },
    speed: 8,
    rows: arp(SQR, [0, 12], width(0x18)),
  }),
  preset('fx-wind', 'Wind', 'FX', 'Noise that fades in while its brightness slowly rises and falls: wind, surf or breath. Any note plays the same.', {
    env: { a: 40, av: 64, d: 1, dv: 64, ...HELD, r: 40 },
    filter: { lower: 4, upper: 30, speed: 10 },
    rows: [fixed(NOI, 40, tone(12), FILTER_UP)],
  }),

  // --- HVL only: ring modulation and panning (commands 7, 8, 9) -----------
  preset('keys-ring-bell', 'Ring Bell', 'Keys', 'A triangle ring-modulated by a sawtooth a twelfth up, over a long fade: a metallic bell or a gong. HVL songs only.', {
    env: { a: 1, av: 64, d: 60, dv: 12, s: 0, r: 60 },
    rows: [play(TRI, 0, ring(8, 19))],
  }),
  preset('lead-ring', 'Ring Lead', 'Lead', 'A square ring-modulated by a triangle an octave up: a hard, metallic lead with vibrato. HVL songs only.', {
    env: { a: 1, av: 64, d: 10, dv: 52, ...HELD, r: 10 },
    vibrato: { delay: 20, speed: 6, depth: 3 },
    rows: [play(SQR, 0, width(0x20), ring(7, 12))],
  }),
  preset('arp-pingpong', 'Ping-Pong Arp', 'Arpeggio', 'A major chord stepped every two ticks that swings from the left speaker to the right: a stereo arpeggio. HVL songs only.', {
    env: { a: 1, av: 60, d: 16, dv: 44, ...HELD, r: 8 },
    speed: 2,
    rows: [play(SQR, 0, width(0x10), pan(-96)), to(4, pan(-32)), to(7, pan(32)), to(12, pan(96)), to(0, pan(-96)), keep(jump(1))],
  }),
];

export const AHX_PRESETS: readonly AhxPreset[] = PRESETS;

const BY_ID = new Map(AHX_PRESETS.map((p) => [p.id, p]));

export const ahxPreset = (id: string): AhxPreset | undefined => BY_ID.get(id);

/**
 * Whether preset `id` plays as written in a song of `format` and `version`:
 * its PList commands are ones the format holds (AHX has no ring modulation or
 * panning), and a version-0 AHX file loses none of it (it cannot toggle the
 * filter sweep: `normalizeAhxInstrumentForVersion`).
 */
export function ahxPresetFits(id: string, format: AhxSongFormat, version: number): boolean {
  const preset = ahxPreset(id);
  if (!preset) return false;
  const commands = ahxPListCommandsFor(format);
  if (!preset.instrument.plist.entries.every((e) => e.fx.every((fx) => commands.includes(fx)))) return false;
  return normalizeAhxInstrumentForVersion(preset.instrument as AhxInstrument, format, version) === preset.instrument;
}

/** The presets a song of `format` and `version` can play as written. */
export const ahxPresetsFor = (format: AhxSongFormat, version: number): AhxPreset[] =>
  AHX_PRESETS.filter((p) => ahxPresetFits(p.id, format, version));

/** Preset `id`'s instrument, a copy of its own (the caller may keep it). */
export function ahxPresetInstrument(id: string): AhxInstrument | undefined {
  const preset = ahxPreset(id);
  return preset ? (JSON.parse(JSON.stringify(preset.instrument)) as AhxInstrument) : undefined;
}

/** The presets for a song of `format` and `version` as picker options (`PatchPicker`'s flat list: one bank, a folder per category). */
export function ahxPresetOptions(format: AhxSongFormat, version: number): { id: string; name: string; bankId: string; bankName: string; category: string }[] {
  return ahxPresetsFor(format, version).map((p) => ({ id: p.id, name: p.name, bankId: 'ahx-presets', bankName: format === 'hvl' ? 'HVL presets' : 'AHX presets', category: p.category }));
}
