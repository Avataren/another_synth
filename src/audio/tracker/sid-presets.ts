import {
  DEFAULT_SID_INSTRUMENT,
  SID_MAX_INSTRUMENT_NAME_LENGTH,
  SID_MAX_TABLE_ROWS,
  makeSidDoc,
  newSidGateTimer,
  sidDocProblem,
  type SidDoc,
  type SidInstrument,
  type SidOpResult,
  type SidTableName,
  type SidTableRow,
} from 'src/audio/tracker/sid-doc';

/**
 * Ready-made GoatTracker instruments: a library of basses, leads, arpeggios,
 * pads, keys, drums and effects for SID songs, so a song can be started
 * without knowing the wave, pulse, filter and speed tables by heart.
 *
 * A preset is an instrument plus its OWN table rows, written with local row
 * numbers (a jump to row 2 is the preset's second row). Adding one to a song
 * (`addSidPreset`, `applySidPreset`) relocates the rows to the end of each
 * table, or reuses rows already there that say exactly the same (the same
 * preset added twice shares them), and points the instrument at them.
 *
 * Written for 1x speed: every table row is one frame, so at multispeed the
 * arpeggios, sweeps and drum steps run faster. The gate timer is scaled.
 *
 * The filter is the chip's, one for all three voices: a preset that uses it
 * routes it to one voice (`SidPresetOptions.filterVoice`), and takes it over
 * from whatever else set it.
 */

export type SidPresetCategory = 'Bass' | 'Lead' | 'Arpeggio' | 'Pad' | 'Keys' | 'Drums' | 'FX';

export const SID_PRESET_CATEGORIES: readonly SidPresetCategory[] = ['Bass', 'Lead', 'Arpeggio', 'Pad', 'Keys', 'Drums', 'FX'];

export interface SidPreset {
  readonly id: string;
  /** Up to 16 characters: it becomes the instrument's name. */
  readonly name: string;
  readonly category: SidPresetCategory;
  /** What it sounds like and how it is made, in plain words. */
  readonly description: string;
  readonly instrument: Pick<SidInstrument, 'attack' | 'decay' | 'sustain' | 'release'> &
    Partial<Pick<SidInstrument, 'firstWave' | 'gateTimer' | 'hardRestart' | 'noGateOff' | 'vibratoDelay'>>;
  /** Wave table rows (waveform + note step per frame). Always present. */
  readonly wave: readonly SidTableRow[];
  readonly pulse?: readonly SidTableRow[];
  readonly filter?: readonly SidTableRow[];
  /**
   * Speed table rows: wave-table commands $F1-$F4 name them by local row
   * number, and with `vibrato` the instrument's vibrato is the first one.
   */
  readonly speed?: readonly SidTableRow[];
  readonly vibrato?: boolean;
}

// ---------------------------------------------------------------------------
// Row helpers (the byte meanings are player.rs's header)
// ---------------------------------------------------------------------------

const TRI = 0x10;
const SAW = 0x20;
const PUL = 0x40;
const NOI = 0x80;

/** Waveform `wave` with the gate on, at note step `note` (see `rel`, `abs`, `SAME`). */
const w = (wave: number, note = 0): SidTableRow => ({ left: wave | 0x01, right: note & 0xff });
/** Waveform `wave` with the gate off: the note releases (the classic drum ending). */
const off = (wave: number, note = SAME): SidTableRow => ({ left: wave & 0xfe, right: note & 0xff });
/** Keep the waveform, wait `frames` (1-15) more frames, then set note step `note`. */
const wait = (frames: number, note: number): SidTableRow => ({ left: frames, right: note & 0xff });
/** A note step relative to the played note, in semitones (negative wraps as GT's arithmetic does). */
const rel = (semitones: number): number => semitones & 0x7f;
/** A fixed note whatever is played: 0 = C-0, 48 = C-4, 95 = B-7. */
const abs = (note: number): number => 0x80 | note;
/** Keep the note as it is. */
const SAME = 0x80;
/** Wave-table command `nibble` (1-2 slides, 3 glide, 4 vibrato: its parameter is a local speed row). */
const cmd = (nibble: number, param: number): SidTableRow => ({ left: 0xf0 | nibble, right: param });
const jump = (row: number): SidTableRow => ({ left: 0xff, right: row });
const STOP: SidTableRow = { left: 0xff, right: 0x00 };

/** Pulse width 0x000-0xFFF (0x800 = 50 % square). */
const width = (value: number): SidTableRow => ({ left: 0x80 | ((value >> 8) & 0x0f), right: value & 0xff });
/** Change the pulse width by `delta` a frame for `frames` frames. */
const sweep = (frames: number, delta: number): SidTableRow => ({ left: frames, right: delta & 0xff });

const LP = 1;
const BP = 2;
/** Filter mode (LP 1, BP 2, HP 4) and resonance 0-15; the routing is set when the preset is added. */
const mode = (bits: number, resonance: number): SidTableRow => ({ left: 0x80 | (bits << 4), right: (resonance << 4) | 0x01 });
/** Filter cutoff, high byte 0x00-0xFF. */
const cutoff = (value: number): SidTableRow => ({ left: 0x00, right: value });
/** Change the cutoff by `delta` a frame for `frames` frames. */
const fsweep = (frames: number, delta: number): SidTableRow => ({ left: frames, right: delta & 0xff });

/** A vibrato: `speed` frames each way, `depth` added to the frequency register a frame. */
const vib = (speed: number, depth: number): SidTableRow => ({ left: speed, right: depth });
/** A slide speed for commands 1-3: added to the frequency register a frame. */
const slide = (speed: number): SidTableRow => ({ left: (speed >> 8) & 0xff, right: speed & 0xff });

/** A slow pulse-width sweep between `from` and `from + frames * step`, for ever. */
const pwm = (from: number, frames: number, step: number): SidTableRow[] => [width(from), sweep(frames, step), sweep(frames, -step), jump(2)];

/** An arpeggio of `steps` (semitones) on `wave`, one frame each, looping. */
const arp = (wave: number, steps: readonly number[]): SidTableRow[] => [...steps.map((s) => w(wave, rel(s))), jump(1)];
/** An arpeggio holding each step `hold` frames. */
const slowArp = (wave: number, steps: readonly number[], hold: number): SidTableRow[] => [
  w(wave, rel(steps[0] ?? 0)),
  ...steps.slice(1).map((s) => wait(hold - 1, rel(s))),
  wait(hold - 1, rel(steps[0] ?? 0)),
  jump(2),
];

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

const ARP_PULSE = pwm(0x300, 0x40, 0x10);

export const SID_PRESETS: readonly SidPreset[] = [
  // --- Bass ---------------------------------------------------------------
  {
    id: 'bass-pulse',
    name: 'Pulse Bass',
    category: 'Bass',
    description: 'The workhorse C64 bass: a pulse wave whose width slowly sweeps, which keeps it moving.',
    instrument: { attack: 0, decay: 9, sustain: 6, release: 4 },
    wave: [w(PUL), STOP],
    pulse: pwm(0x300, 0x40, 0x10),
  },
  {
    id: 'bass-pluck',
    name: 'Plucked Bass',
    category: 'Bass',
    description: 'A short, bouncy bass: one frame an octave up for the pluck, then it dies away. Good for fast lines.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 0 },
    wave: [w(PUL, rel(12)), w(PUL), STOP],
    pulse: [width(0x400), sweep(0x30, 0x10), STOP],
  },
  {
    id: 'bass-saw',
    name: 'Filter Saw Bass',
    category: 'Bass',
    description: 'A sawtooth through the resonant low-pass filter, closing after each note: the round, squelchy synth bass.',
    instrument: { attack: 0, decay: 9, sustain: 8, release: 4 },
    wave: [w(SAW), STOP],
    filter: [mode(LP, 10), cutoff(0x70), fsweep(0x30, -2), STOP],
  },
  {
    id: 'bass-acid',
    name: 'Acid Bass',
    category: 'Bass',
    description: 'Sawtooth with the filter at full resonance and a fast snap closed: the 303-style squelch.',
    instrument: { attack: 0, decay: 7, sustain: 9, release: 2 },
    wave: [w(SAW), STOP],
    filter: [mode(LP, 15), cutoff(0x90), fsweep(0x10, -6), STOP],
  },
  {
    id: 'bass-kick',
    name: 'Kick Bass',
    category: 'Bass',
    description: 'A bass drum and a bass note in one: a click and a low thump, then the note. Saves a voice for the drums.',
    instrument: { attack: 0, decay: 9, sustain: 7, release: 3 },
    wave: [w(NOI, abs(60)), w(PUL, abs(36)), w(PUL, abs(30)), w(PUL), STOP],
    pulse: [width(0x800), STOP],
  },
  {
    id: 'bass-sub',
    name: 'Sub Bass',
    category: 'Bass',
    description: 'A plain triangle wave: soft and deep, for a bass you feel more than hear.',
    instrument: { attack: 0, decay: 6, sustain: 12, release: 4 },
    wave: [w(TRI), STOP],
  },
  {
    id: 'bass-octave',
    name: 'Octave Bass',
    category: 'Bass',
    description: 'Flips between the note and the octave above every frame: the buzzy, busy bass of many game tunes.',
    instrument: { attack: 0, decay: 8, sustain: 6, release: 3 },
    wave: arp(PUL, [0, 12]),
    pulse: [width(0x500), STOP],
  },
  {
    id: 'bass-slap',
    name: 'Slap Bass',
    category: 'Bass',
    description: 'A frame of noise and an octave-up blip for the slap, then a pulse that opens up as it decays.',
    instrument: { attack: 0, decay: 9, sustain: 4, release: 3 },
    wave: [w(NOI, rel(24)), w(PUL, rel(12)), w(PUL), STOP],
    pulse: [width(0x200), sweep(0x20, 0x20), STOP],
  },
  {
    id: 'bass-wobble',
    name: 'Wobble Bass',
    category: 'Bass',
    description: 'A held sawtooth with the filter opening and closing in a loop: a slow wobble while the note lasts.',
    instrument: { attack: 0, decay: 0, sustain: 15, release: 3 },
    wave: [w(SAW), STOP],
    filter: [mode(LP, 12), cutoff(0x20), fsweep(0x10, 4), fsweep(0x10, -4), jump(3)],
  },

  // --- Lead ---------------------------------------------------------------
  {
    id: 'lead-pwm',
    name: 'PWM Lead',
    category: 'Lead',
    description: 'The classic C64 lead: a pulse wave sweeping its width, with vibrato fading in on long notes.',
    instrument: { attack: 1, decay: 8, sustain: 10, release: 6, vibratoDelay: 0x10 },
    wave: [w(PUL), STOP],
    pulse: pwm(0x400, 0x30, 0x18),
    speed: [vib(4, 0x28)],
    vibrato: true,
  },
  {
    id: 'lead-saw',
    name: 'Saw Lead',
    category: 'Lead',
    description: 'A bright, buzzy sawtooth lead with delayed vibrato.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 6, vibratoDelay: 0x10 },
    wave: [w(SAW), STOP],
    speed: [vib(4, 0x28)],
    vibrato: true,
  },
  {
    id: 'lead-bright',
    name: 'Bright Lead',
    category: 'Lead',
    description: 'One frame of sawtooth for a sharp attack, then a sweeping pulse: cuts through a busy mix.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 6, vibratoDelay: 0x14 },
    wave: [w(SAW), w(PUL), STOP],
    pulse: pwm(0x600, 0x20, 0x20),
    speed: [vib(4, 0x28)],
    vibrato: true,
  },
  {
    id: 'lead-square',
    name: 'Square Lead',
    category: 'Lead',
    description: 'A steady 50 % square wave, full and hollow, with a gentle vibrato.',
    instrument: { attack: 0, decay: 0, sustain: 15, release: 4, vibratoDelay: 0x18 },
    wave: [w(PUL), STOP],
    pulse: [width(0x800), STOP],
    speed: [vib(5, 0x20)],
    vibrato: true,
  },
  {
    id: 'lead-thin',
    name: 'Thin Lead',
    category: 'Lead',
    description: 'A narrow pulse (12.5 %): nasal and reedy, sits above everything else.',
    instrument: { attack: 0, decay: 8, sustain: 12, release: 6, vibratoDelay: 0x10 },
    wave: [w(PUL), STOP],
    pulse: [width(0x200), STOP],
    speed: [vib(4, 0x28)],
    vibrato: true,
  },
  {
    id: 'lead-flute',
    name: 'Flute',
    category: 'Lead',
    description: 'A soft triangle that fades in, with a slow, late vibrato: breathy and gentle.',
    instrument: { attack: 6, decay: 8, sustain: 11, release: 7, vibratoDelay: 0x14 },
    wave: [w(TRI), STOP],
    speed: [vib(5, 0x18)],
    vibrato: true,
  },
  {
    id: 'lead-legato',
    name: 'Legato Lead',
    category: 'Lead',
    description: 'No gate-off between notes, so a melody flows without re-attacking. Use it with the 3xx glide command.',
    instrument: { attack: 0, decay: 0, sustain: 15, release: 6, hardRestart: false, noGateOff: true, vibratoDelay: 0x10 },
    wave: [w(PUL), STOP],
    pulse: pwm(0x400, 0x30, 0x18),
    speed: [vib(4, 0x28)],
    vibrato: true,
  },
  {
    id: 'lead-filter',
    name: 'Filter Lead',
    category: 'Lead',
    description: 'A sawtooth through a resonant band-pass that slowly opens: vocal, "wah"-like.',
    instrument: { attack: 0, decay: 9, sustain: 11, release: 6, vibratoDelay: 0x18 },
    wave: [w(SAW), STOP],
    filter: [mode(BP, 12), cutoff(0x20), fsweep(0x40, 1), STOP],
    speed: [vib(4, 0x20)],
    vibrato: true,
  },

  // --- Arpeggio -------------------------------------------------------------
  // One note plays a whole chord by cycling through its notes every frame.
  {
    id: 'arp-major',
    name: 'Arp Major',
    category: 'Arpeggio',
    description: 'A major chord from one note (root, +4, +7), cycled every frame. Play the chord\'s root.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 5 },
    wave: arp(PUL, [0, 4, 7]),
    pulse: ARP_PULSE,
  },
  {
    id: 'arp-minor',
    name: 'Arp Minor',
    category: 'Arpeggio',
    description: 'A minor chord from one note (root, +3, +7), cycled every frame. Play the chord\'s root.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 5 },
    wave: arp(PUL, [0, 3, 7]),
    pulse: ARP_PULSE,
  },
  {
    id: 'arp-major7',
    name: 'Arp Major 7',
    category: 'Arpeggio',
    description: 'A major seventh chord (root, +4, +7, +11): dreamy and jazzy.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 5 },
    wave: arp(PUL, [0, 4, 7, 11]),
    pulse: ARP_PULSE,
  },
  {
    id: 'arp-minor7',
    name: 'Arp Minor 7',
    category: 'Arpeggio',
    description: 'A minor seventh chord (root, +3, +7, +10): soft and moody.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 5 },
    wave: arp(PUL, [0, 3, 7, 10]),
    pulse: ARP_PULSE,
  },
  {
    id: 'arp-dom7',
    name: 'Arp Dominant 7',
    category: 'Arpeggio',
    description: 'A dominant seventh chord (root, +4, +7, +10): bluesy, wants to resolve.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 5 },
    wave: arp(PUL, [0, 4, 7, 10]),
    pulse: ARP_PULSE,
  },
  {
    id: 'arp-sus4',
    name: 'Arp Sus4',
    category: 'Arpeggio',
    description: 'A suspended chord (root, +5, +7): open, neither major nor minor.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 5 },
    wave: arp(PUL, [0, 5, 7]),
    pulse: ARP_PULSE,
  },
  {
    id: 'arp-dim',
    name: 'Arp Diminished',
    category: 'Arpeggio',
    description: 'A diminished chord (root, +3, +6): tense and spooky.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 5 },
    wave: arp(PUL, [0, 3, 6]),
    pulse: ARP_PULSE,
  },
  {
    id: 'arp-power',
    name: 'Arp Power',
    category: 'Arpeggio',
    description: 'A power chord (root, +7, +12): big and neutral, fits any key.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 5 },
    wave: arp(PUL, [0, 7, 12]),
    pulse: ARP_PULSE,
  },
  {
    id: 'arp-major-slow',
    name: 'Arp Major Slow',
    category: 'Arpeggio',
    description: 'A major chord cycled every 2 frames: the notes are easier to hear apart.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 5 },
    wave: slowArp(PUL, [0, 4, 7], 2),
    pulse: ARP_PULSE,
  },
  {
    id: 'arp-minor-slow',
    name: 'Arp Minor Slow',
    category: 'Arpeggio',
    description: 'A minor chord cycled every 2 frames: the notes are easier to hear apart.',
    instrument: { attack: 0, decay: 9, sustain: 10, release: 5 },
    wave: slowArp(PUL, [0, 3, 7], 2),
    pulse: ARP_PULSE,
  },
  {
    id: 'arp-saw-major',
    name: 'Arp Saw Major',
    category: 'Arpeggio',
    description: 'A major chord on the sawtooth: brighter and harsher than the pulse arpeggios.',
    instrument: { attack: 0, decay: 9, sustain: 9, release: 5 },
    wave: arp(SAW, [0, 4, 7]),
  },

  // --- Pad ----------------------------------------------------------------
  {
    id: 'pad-soft',
    name: 'Soft Pad',
    category: 'Pad',
    description: 'A pulse wave that swells in and sweeps slowly: a calm bed under a melody.',
    instrument: { attack: 9, decay: 10, sustain: 12, release: 9, vibratoDelay: 0x20 },
    wave: [w(PUL), STOP],
    pulse: pwm(0x200, 0x7f, 0x08),
    speed: [vib(6, 0x10)],
    vibrato: true,
  },
  {
    id: 'pad-strings',
    name: 'Strings',
    category: 'Pad',
    description: 'A sawtooth that fades in with a late, slow vibrato: a string-section feel.',
    instrument: { attack: 8, decay: 8, sustain: 12, release: 10, vibratoDelay: 0x18 },
    wave: [w(SAW), STOP],
    speed: [vib(6, 0x14)],
    vibrato: true,
  },
  {
    id: 'pad-sweep',
    name: 'Sweep Pad',
    category: 'Pad',
    description: 'A sawtooth behind a low-pass filter that opens slowly over the note.',
    instrument: { attack: 10, decay: 9, sustain: 12, release: 10 },
    wave: [w(SAW), STOP],
    filter: [mode(LP, 6), cutoff(0x10), fsweep(0x7f, 1), STOP],
  },
  {
    id: 'pad-warm',
    name: 'Warm Pad',
    category: 'Pad',
    description: 'A triangle that swells in with a slow vibrato: round and warm.',
    instrument: { attack: 9, decay: 8, sustain: 13, release: 10, vibratoDelay: 0x10 },
    wave: [w(TRI), STOP],
    speed: [vib(8, 0x10)],
    vibrato: true,
  },
  {
    id: 'pad-chord',
    name: 'Chord Pad',
    category: 'Pad',
    description: 'A major chord (arpeggio) that swells in slowly: a whole pad on one voice.',
    instrument: { attack: 9, decay: 9, sustain: 12, release: 9 },
    wave: arp(PUL, [0, 4, 7]),
    pulse: pwm(0x200, 0x7f, 0x08),
  },

  // --- Keys and plucks ----------------------------------------------------
  {
    id: 'keys-pluck',
    name: 'Pluck',
    category: 'Keys',
    description: 'A short pulse pluck with an octave-up attack: harp or guitar-like for fast figures.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 0 },
    wave: [w(PUL, rel(12)), w(PUL), STOP],
    pulse: [width(0x400), STOP],
  },
  {
    id: 'keys-harpsichord',
    name: 'Harpsichord',
    category: 'Keys',
    description: 'A sawtooth frame an octave up, then a narrow pulse that decays: a plucked, baroque sound.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 0 },
    wave: [w(SAW, rel(12)), w(PUL), STOP],
    pulse: [width(0x200), STOP],
  },
  {
    id: 'keys-marimba',
    name: 'Marimba',
    category: 'Keys',
    description: 'A two-octave-up pulse tick, then a triangle that fades: a wooden mallet.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 9 },
    wave: [w(PUL, rel(24)), w(TRI), STOP],
    pulse: [width(0x800), STOP],
  },
  {
    id: 'keys-bell',
    name: 'Bell',
    category: 'Keys',
    description: 'A triangle flickering between the note and an octave and a fifth above: a metallic, ringing bell.',
    instrument: { attack: 0, decay: 10, sustain: 0, release: 10 },
    wave: arp(TRI, [0, 19]),
  },
  {
    id: 'keys-organ',
    name: 'Organ',
    category: 'Keys',
    description: 'A square wave flickering with its octave: a full organ tone that holds as long as the note.',
    instrument: { attack: 0, decay: 0, sustain: 15, release: 3 },
    wave: arp(PUL, [0, 12]),
    pulse: [width(0x800), STOP],
  },
  {
    id: 'keys-epiano',
    name: 'E-Piano',
    category: 'Keys',
    description: 'A thin pulse that widens as it decays: a soft electric-piano tine.',
    instrument: { attack: 0, decay: 10, sustain: 4, release: 8 },
    wave: [w(PUL), STOP],
    pulse: [width(0x100), sweep(0x18, 0x30), STOP],
  },

  // --- Drums --------------------------------------------------------------
  // Fixed pitches: any note plays the same drum (except the tom).
  {
    id: 'drum-kick',
    name: 'Kick',
    category: 'Drums',
    description: 'A punchy bass drum: a click of noise, then a pulse falling fast in pitch. Any note plays the same.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 5 },
    wave: [w(NOI, abs(60)), w(PUL, abs(40)), w(PUL, abs(34)), w(PUL, abs(30)), wait(1, abs(27)), wait(1, abs(24)), wait(2, abs(21)), off(PUL), STOP],
    pulse: [width(0x800), STOP],
  },
  {
    id: 'drum-kick-deep',
    name: 'Deep Kick',
    category: 'Drums',
    description: 'A rounder, deeper bass drum on the triangle wave. Any note plays the same.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 0 },
    wave: [w(NOI, abs(55)), w(TRI, abs(36)), w(TRI, abs(31)), w(TRI, abs(28)), w(TRI, abs(26)), w(TRI, abs(24)), w(TRI, abs(22)), STOP],
  },
  {
    id: 'drum-snare',
    name: 'Snare',
    category: 'Drums',
    description: 'Noise, a pulse "body" and noise again: the classic C64 snare. Any note plays the same.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 0 },
    wave: [w(NOI, abs(84)), w(PUL, abs(45)), w(PUL, abs(40)), w(NOI, abs(78)), w(NOI, abs(76)), STOP],
    pulse: [width(0x800), STOP],
  },
  {
    id: 'drum-snare-noise',
    name: 'Noise Snare',
    category: 'Drums',
    description: 'A snare of pure noise falling in pitch: lighter and brushier. Any note plays the same.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 0 },
    wave: [w(NOI, abs(80)), w(NOI, abs(76)), w(NOI, abs(72)), STOP],
  },
  {
    id: 'drum-clap',
    name: 'Clap',
    category: 'Drums',
    description: 'Three quick bursts of noise: a hand clap. Any note plays the same.',
    instrument: { attack: 0, decay: 7, sustain: 0, release: 7 },
    wave: [w(NOI, abs(78)), off(NOI), w(NOI, SAME), off(NOI), w(NOI, SAME), STOP],
  },
  {
    id: 'drum-hat-closed',
    name: 'Closed Hi-hat',
    category: 'Drums',
    description: 'A very short tick of high noise. Any note plays the same.',
    instrument: { attack: 0, decay: 6, sustain: 0, release: 5 },
    wave: [w(NOI, abs(93)), wait(3, SAME), off(NOI), STOP],
  },
  {
    id: 'drum-hat-open',
    name: 'Open Hi-hat',
    category: 'Drums',
    description: 'High noise with a longer ring. Any note plays the same.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 9 },
    wave: [w(NOI, abs(95)), STOP],
  },
  {
    id: 'drum-crash',
    name: 'Crash',
    category: 'Drums',
    description: 'A long wash of high noise: a crash cymbal. Any note plays the same.',
    instrument: { attack: 0, decay: 11, sustain: 0, release: 11 },
    wave: [w(NOI, abs(90)), STOP],
  },
  {
    id: 'drum-rim',
    name: 'Rim Shot',
    category: 'Drums',
    description: 'A noise click and a high, short pulse knock. Any note plays the same.',
    instrument: { attack: 0, decay: 5, sustain: 0, release: 4 },
    wave: [w(NOI, abs(90)), w(PUL, abs(72)), off(PUL), STOP],
    pulse: [width(0x200), STOP],
  },
  {
    id: 'drum-tom',
    name: 'Tom',
    category: 'Drums',
    description: 'A tom that drops in pitch; the note you play is its pitch (C-3 floor tom, C-4 high tom).',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 0 },
    wave: [w(NOI, rel(12)), w(TRI), cmd(2, 1), jump(3)],
    speed: [slide(0x0030)],
  },

  // --- FX -----------------------------------------------------------------
  {
    id: 'fx-laser',
    name: 'Laser',
    category: 'FX',
    description: 'Starts two octaves up and dives fast: pew.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 0 },
    wave: [w(PUL, rel(24)), cmd(2, 1), jump(2)],
    pulse: [width(0x800), STOP],
    speed: [slide(0x0100)],
  },
  {
    id: 'fx-zap',
    name: 'Zap',
    category: 'FX',
    description: 'A thin pulse dropping three octaves in a flash.',
    instrument: { attack: 0, decay: 8, sustain: 0, release: 0 },
    wave: [w(PUL, rel(36)), cmd(2, 1), jump(2)],
    pulse: [width(0x400), STOP],
    speed: [slide(0x0400)],
  },
  {
    id: 'fx-rise',
    name: 'Riser',
    category: 'FX',
    description: 'A sawtooth that glides upward for as long as the note is held: a build-up.',
    instrument: { attack: 8, decay: 0, sustain: 15, release: 8 },
    wave: [w(SAW), cmd(1, 1), jump(2)],
    speed: [slide(0x0020)],
  },
  {
    id: 'fx-drop',
    name: 'Drop',
    category: 'FX',
    description: 'A sawtooth that falls from an octave up while it is held: a power-down.',
    instrument: { attack: 0, decay: 0, sustain: 15, release: 8 },
    wave: [w(SAW, rel(12)), cmd(2, 1), jump(2)],
    speed: [slide(0x0020)],
  },
  {
    id: 'fx-jump',
    name: 'Jump',
    category: 'FX',
    description: 'A short pulse blip sliding up: a platform-game jump.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 0 },
    wave: [w(PUL), cmd(1, 1), jump(2)],
    pulse: [width(0x400), STOP],
    speed: [slide(0x0060)],
  },
  {
    id: 'fx-coin',
    name: 'Coin',
    category: 'FX',
    description: 'Two quick notes, the second a fourth up: pick-up, collect, score.',
    instrument: { attack: 0, decay: 9, sustain: 0, release: 9 },
    wave: [w(PUL), wait(3, rel(5)), STOP],
    pulse: [width(0x800), STOP],
  },
  {
    id: 'fx-powerup',
    name: 'Power Up',
    category: 'FX',
    description: 'A fast run up two octaves of a major chord: level up, extra life.',
    instrument: { attack: 0, decay: 10, sustain: 0, release: 10 },
    wave: [w(PUL), wait(1, rel(4)), wait(1, rel(7)), wait(1, rel(12)), wait(1, rel(16)), wait(1, rel(19)), wait(1, rel(24)), STOP],
    pulse: [width(0x600), STOP],
  },
  {
    id: 'fx-teleport',
    name: 'Teleport',
    category: 'FX',
    description: 'A shimmering loop of notes climbing two octaves, over and over.',
    instrument: { attack: 0, decay: 0, sustain: 15, release: 8 },
    wave: arp(PUL, [0, 5, 12, 17, 24]),
    pulse: pwm(0x200, 0x20, 0x20),
  },
  {
    id: 'fx-explosion',
    name: 'Explosion',
    category: 'FX',
    description: 'Noise that rumbles down in pitch and dies away slowly.',
    instrument: { attack: 0, decay: 12, sustain: 0, release: 12 },
    wave: [w(NOI, abs(72)), cmd(2, 1), jump(2)],
    speed: [slide(0x0010)],
  },
  {
    id: 'fx-siren',
    name: 'Siren',
    category: 'FX',
    description: 'A triangle swooping up and down by several semitones for as long as it is held.',
    instrument: { attack: 0, decay: 0, sustain: 15, release: 6, vibratoDelay: 1 },
    wave: [w(TRI), STOP],
    speed: [vib(0x10, 0x60)],
    vibrato: true,
  },
  {
    id: 'fx-alarm',
    name: 'Alarm',
    category: 'FX',
    description: 'A square wave jumping between the note and its octave, a few times a second.',
    instrument: { attack: 0, decay: 0, sustain: 15, release: 4 },
    wave: slowArp(PUL, [0, 12], 8),
    pulse: [width(0x800), STOP],
  },
  {
    id: 'fx-wind',
    name: 'Wind',
    category: 'FX',
    description: 'Noise through a resonant band-pass filter sweeping up and down: wind, surf, breath.',
    instrument: { attack: 10, decay: 0, sustain: 15, release: 10 },
    wave: [w(NOI), STOP],
    filter: [mode(BP, 8), cutoff(0x20), fsweep(0x40, 1), fsweep(0x40, -1), jump(3)],
  },
];

const BY_ID = new Map(SID_PRESETS.map((p) => [p.id, p]));

export const sidPreset = (id: string): SidPreset | undefined => BY_ID.get(id);

// ---------------------------------------------------------------------------
// Putting a preset into a song
// ---------------------------------------------------------------------------

export interface SidPresetOptions {
  /** The voice (1-3) a preset's filter is routed to. Default 1. */
  readonly filterVoice?: number;
}

type Starts = Record<SidTableName, number>;

/** `rows` of `table` with their local row numbers moved to start at `starts[table]`. */
function relocate(table: SidTableName, rows: readonly SidTableRow[], starts: Starts, voiceBit: number): SidTableRow[] {
  const base = starts[table] - 1;
  return rows.map((row) => {
    if (table !== 'speed' && row.left === 0xff) return row.right === 0 ? row : { left: 0xff, right: row.right + base };
    if (table === 'wave' && row.left >= 0xf1 && row.left <= 0xf4 && row.right !== 0) return { left: row.left, right: row.right + starts.speed - 1 };
    if (table === 'wave' && row.left === 0xf9 && row.right !== 0) return { left: row.left, right: row.right + starts.pulse - 1 };
    if (table === 'wave' && row.left === 0xfa && row.right !== 0) return { left: row.left, right: row.right + starts.filter - 1 };
    if (table === 'filter' && row.left >= 0x80) return { left: row.left, right: (row.right & 0xf0) | voiceBit };
    return row;
  });
}

const sameRows = (a: readonly SidTableRow[], at: number, b: readonly SidTableRow[]): boolean =>
  b.every((row, i) => a[at + i]?.left === row.left && a[at + i]?.right === row.right);

/**
 * Where `rows` (relocated as they would be at a start row) go in `table`: the
 * first place the table already holds exactly them, else the end.
 */
function placeRows(table: readonly SidTableRow[], build: (start: number) => SidTableRow[]): { start: number; rows: SidTableRow[]; fresh: boolean } {
  for (let start = 1; start + build(start).length - 1 <= table.length; start++) {
    const rows = build(start);
    if (rows.length > 0 && sameRows(table, start - 1, rows)) return { start, rows, fresh: false };
  }
  const start = table.length + 1;
  return { start, rows: build(start), fresh: true };
}

/** The instrument `preset` makes in `doc`, and `doc`'s tables with its rows added (or reused). */
function build(doc: SidDoc, preset: SidPreset, options: SidPresetOptions): { instrument: SidInstrument; tables: SidDoc['tables'] } | { error: string } {
  const voice = Math.max(1, Math.min(3, Math.round(options.filterVoice ?? 1)));
  const voiceBit = 1 << (voice - 1);
  const tables = { ...doc.tables };
  const starts: Starts = { wave: 0, pulse: 0, filter: 0, speed: 0 };
  // Speed, pulse and filter first: the wave table's commands name their rows.
  for (const table of ['speed', 'pulse', 'filter', 'wave'] as const) {
    const own = preset[table];
    if (!own || own.length === 0) continue;
    const placed = placeRows(tables[table], (start) => relocate(table, own, { ...starts, [table]: start }, voiceBit));
    if (placed.fresh) {
      if (tables[table].length + placed.rows.length > SID_MAX_TABLE_ROWS) {
        return { error: `The ${table} table has no room for ${placed.rows.length} more rows (${SID_MAX_TABLE_ROWS} at most).` };
      }
      tables[table] = [...tables[table], ...placed.rows];
    }
    starts[table] = placed.start;
  }
  const { firstWave, gateTimer, hardRestart, noGateOff, vibratoDelay, ...envelope } = preset.instrument;
  const mult = doc.speedMultiplier;
  const instrument: SidInstrument = {
    ...DEFAULT_SID_INSTRUMENT,
    ...envelope,
    name: preset.name.slice(0, SID_MAX_INSTRUMENT_NAME_LENGTH),
    firstWave: firstWave ?? DEFAULT_SID_INSTRUMENT.firstWave,
    gateTimer: gateTimer === undefined ? newSidGateTimer(mult) : Math.min(63, gateTimer * mult),
    hardRestart: hardRestart ?? DEFAULT_SID_INSTRUMENT.hardRestart,
    noGateOff: noGateOff ?? DEFAULT_SID_INSTRUMENT.noGateOff,
    vibratoDelay: vibratoDelay ?? 0,
    wavePtr: starts.wave,
    pulsePtr: starts.pulse,
    filterPtr: starts.filter,
    speedPtr: preset.vibrato ? starts.speed : 0,
  };
  return { instrument, tables };
}

function finish(fields: SidDoc): SidOpResult {
  const problem = sidDocProblem(fields);
  return problem === null ? { ok: true, doc: makeSidDoc(fields) } : { ok: false, reason: `That preset would break the song: ${problem}.` };
}

/** `doc` with preset `id` added as a new instrument (the last). */
export function addSidPreset(doc: SidDoc, id: string, options: SidPresetOptions = {}): SidOpResult {
  const preset = sidPreset(id);
  if (!preset) return { ok: false, reason: `There is no SID preset "${id}".` };
  const built = build(doc, preset, options);
  if ('error' in built) return { ok: false, reason: built.error };
  return finish({ ...doc, instruments: [...doc.instruments, built.instrument], tables: built.tables });
}

/**
 * `doc` with instrument `n` (1-based) replaced by preset `id`. Rows the old
 * instrument pointed at stay in the tables (another instrument or a pattern
 * command may use them); exports keep only the rows something reaches.
 */
export function applySidPreset(doc: SidDoc, n: number, id: string, options: SidPresetOptions = {}): SidOpResult {
  const preset = sidPreset(id);
  if (!preset) return { ok: false, reason: `There is no SID preset "${id}".` };
  if (!doc.instruments[n - 1]) return { ok: false, reason: `There is no instrument ${n}.` };
  const built = build(doc, preset, options);
  if ('error' in built) return { ok: false, reason: built.error };
  const instruments = doc.instruments.slice();
  instruments[n - 1] = built.instrument;
  return finish({ ...doc, instruments, tables: built.tables });
}

/** Whether preset `id` uses the filter (it then needs a voice to route to). */
export const sidPresetUsesFilter = (id: string): boolean => (sidPreset(id)?.filter?.length ?? 0) > 0;

/** The presets as picker options (`PatchPicker`'s flat list: one bank, a folder per category). */
export function sidPresetOptions(): { id: string; name: string; bankId: string; bankName: string; category: string }[] {
  return SID_PRESETS.map((p) => ({ id: p.id, name: p.name, bankId: 'sid-presets', bankName: 'SID presets', category: p.category }));
}
