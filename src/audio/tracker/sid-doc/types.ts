/**
 * The SID song model (plan-sid-tracking.md S3): what a C64 SID song is, as the
 * editor edits it and the Rust player (`rust-wasm/src/sid/player.rs`) plays it.
 *
 * Its shape is GoatTracker's (plan §3 "What GT songs contain"), so the S5
 * `.sng` importer maps onto it without inventing structure: per-channel
 * orderlists over a shared pool of variable-length patterns, 4-byte rows
 * (note, instrument, command, parameter), instruments that point into four
 * shared step tables (wave, pulse, filter, speed). S3 models the data; no GT
 * file is parsed here. What the player does with each byte is documented in
 * `player.rs`'s header, and mirrored for the TS side in `SID_PROFILE`.
 *
 * Immutable, like `AhxDoc`: every op returns a new doc that shares whatever it
 * did not touch, every doc is `markRaw`-ed and frozen at the top level, and
 * every field is readonly.
 */

/** Which SID revision the song is written for: the Rust `SidModel` (`Sid8580` / `Sid6581`). */
export type SidChipModel = '8580' | '6581';
/** The default model: the plan's decision 1 (8580 first). */
export const SID_DEFAULT_CHIP_MODEL: SidChipModel = '8580';

/** Voices of one SID chip. Dual SID (6) is S7, behind its own flag. */
export const SID_CHANNELS = 3;

/** Rows of a pattern: 1..128 (GoatTracker's limit). */
export const SID_MIN_PATTERN_ROWS = 1;
export const SID_MAX_PATTERN_ROWS = 128;
/** Patterns a song holds: 1..208 (GoatTracker's limit). */
export const SID_MAX_PATTERNS = 208;
/** Instruments a song holds: 0..63; row instrument 0 means "none". */
export const SID_MAX_INSTRUMENTS = 63;
/** Rows of one step table: 0..255, since a pointer is a byte and 0 means "no table". */
export const SID_MAX_TABLE_ROWS = 255;
/** Entries of one orderlist: 1..254. */
export const SID_MAX_ORDER_ENTRIES = 254;
/** Subsongs: 1..32. */
export const SID_MAX_SUBSONGS = 32;
/** An orderlist entry's transpose, in semitones. */
export const SID_MIN_TRANSPOSE = -64;
export const SID_MAX_TRANSPOSE = 63;
/** How many times an orderlist entry plays its pattern: 1..16. */
export const SID_MAX_REPEAT = 16;
/** Frames per second is 50 times this: 1..16 (GoatTracker multispeed). */
export const SID_MAX_SPEED_MULTIPLIER = 16;
/** Ticks per row: 1..127. GoatTracker's default is 6. */
export const SID_MAX_TEMPO = 127;
export const SID_DEFAULT_TEMPO = 6;
/** Longest song name, author and copyright text (latin-1 characters). */
export const SID_MAX_TEXT_LENGTH = 32;
/** Longest instrument name (latin-1 characters). */
export const SID_MAX_INSTRUMENT_NAME_LENGTH = 16;

/** Row note: 0 is an empty cell. */
export const SID_NOTE_NONE = 0;
/** Row notes 1..93 are C-0..G#7: note table index + 1 (`sidNoteFreqReg`). */
export const SID_NOTE_FIRST = 1;
export const SID_NOTE_LAST = 93;
/** Row note: gate off (release), keeps the pitch. */
export const SID_NOTE_KEY_OFF = 126;
/** Row note: gate on again, no retrigger of pitch or tables. */
export const SID_NOTE_KEY_ON = 127;

/** Filter mode bits of `SidInstrumentFilter.mode` (the chip's $D418 bits 4..6, shifted down). */
export const SID_FILTER_LP = 1;
export const SID_FILTER_BP = 2;
export const SID_FILTER_HP = 4;

/** One pattern row. Never edited in place: an edit makes a new one. */
export interface SidDocRow {
  /** `SID_NOTE_NONE`, `SID_NOTE_FIRST..SID_NOTE_LAST`, `SID_NOTE_KEY_OFF` or `SID_NOTE_KEY_ON`. */
  readonly note: number;
  /** 0 (none) or 1..63. */
  readonly instrument: number;
  /** The command nibble, 0x0..0xF. */
  readonly command: number;
  /** The command's parameter byte. */
  readonly param: number;
}

/** A pattern: 1..128 rows. Patterns are shared between channels and subsongs. */
export interface SidDocPattern {
  readonly rows: readonly SidDocRow[];
}

/** One orderlist step: play `pattern` `repeat` times, every note shifted by `transpose`. */
export interface SidOrderEntry {
  /** Index into `SidDoc.patterns`. */
  readonly pattern: number;
  /** Semitones, `SID_MIN_TRANSPOSE..SID_MAX_TRANSPOSE`. */
  readonly transpose: number;
  /** 1..16. */
  readonly repeat: number;
}

/** A channel's orderlist: the patterns it plays in order, then it loops from `restart`. */
export interface SidOrderlist {
  /** 1..254 entries. */
  readonly entries: readonly SidOrderEntry[];
  /** Always below `entries.length`. */
  readonly restart: number;
}

/** A subsong: one orderlist per channel. The channels run independently, as in GoatTracker. */
export interface SidSubsong {
  readonly orderlists: readonly SidOrderlist[];
}

/**
 * One row of a step table: GoatTracker's uniform left/right byte pair. Every
 * table has the same shape; what the two bytes mean is the table's:
 *  - wave table: left = waveform (or delay / command / jump), right = the
 *    note step (relative or absolute). The right column IS the arpeggio
 *    table: GT keeps them in one table so a waveform step and its note step
 *    always advance together, and so does this model;
 *  - pulse table: left = set width / modulation time / jump, right = the
 *    width's low byte or the modulation speed;
 *  - filter table: left = set cutoff / modulation time / set mode / jump,
 *    right = the value, speed or resonance+routing;
 *  - speed table: left/right = a vibrato (speed, depth) or a 16-bit
 *    portamento speed.
 * `0xFF` in the left column is a jump to the (1-based) row in the right, 0 = stop.
 */
export interface SidTableRow {
  readonly left: number;
  readonly right: number;
}

export type SidTable = readonly SidTableRow[];

/** The four shared step tables. An instrument or command points into them 1-based; 0 means "none". */
export interface SidTables {
  readonly wave: SidTable;
  readonly pulse: SidTable;
  readonly filter: SidTable;
  readonly speed: SidTable;
}

export type SidTableName = keyof SidTables;
export const SID_TABLE_NAMES: readonly SidTableName[] = ['wave', 'pulse', 'filter', 'speed'];

/** The instrument's own filter setting, used when it has no filter table (`filterPtr` 0). */
export interface SidInstrumentFilter {
  /** Whether a note of this instrument routes its voice through the filter. */
  readonly enabled: boolean;
  /** The 11-bit cutoff register, 0..2047. */
  readonly cutoff: number;
  /** 0..15. */
  readonly resonance: number;
  /** `SID_FILTER_LP | SID_FILTER_BP | SID_FILTER_HP` bits, 0..7. */
  readonly mode: number;
}

export interface SidInstrument {
  /** Up to 16 latin-1 characters. */
  readonly name: string;
  /** The envelope nibbles, 0..15 each (the chip's $05/$06 registers). */
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
  /**
   * The control register's waveform and modulation bits (noise 0x80, pulse
   * 0x40, saw 0x20, triangle 0x10, test 0x08, ring 0x04, sync 0x02), used
   * when the instrument has no wave table. The gate bit (0x01) is the
   * player's, so it is always clear here.
   */
  readonly waveform: number;
  /** The 12-bit pulse width, 0..4095, set on every note (the pulse table then moves it). */
  readonly pulseWidth: number;
  readonly filter: SidInstrumentFilter;
  /**
   * The control byte written on a note's first frame, before the waveform
   * (GoatTracker's "first frame waveform", commonly 0x09 = test + gate, which
   * restarts the oscillator). 0 = none: the first frame plays the waveform.
   */
  readonly firstWave: number;
  /**
   * Frames before the next note at which the gate is cleared (GoatTracker's
   * gate timer), 0..63. 0 = never early.
   */
  readonly gateTimer: number;
  /** Whether the early gate-off also zeroes the envelope (hard restart), as GT does by default. */
  readonly hardRestart: boolean;
  /**
   * GoatTracker's gate-timer bit $40: a note of THIS instrument (the one the
   * next row names) is not preceded by the early gate-off or hard restart.
   * The gate timer still sets when the next row is read (its key off/on).
   */
  readonly noGateOff: boolean;
  /** Frames after a note before the instrument's vibrato starts, 0..255. */
  readonly vibratoDelay: number;
  /** 1-based rows of the four tables this instrument starts on; 0 = none. */
  readonly wavePtr: number;
  readonly pulsePtr: number;
  readonly filterPtr: number;
  /** The instrument vibrato: a speed-table row (speed, depth); 0 = no vibrato. */
  readonly speedPtr: number;
}

/**
 * A SID song. Instrument `n` is `instruments[n - 1]`; row instrument 0 means
 * "keep the channel's". The channels are `SID_CHANNELS` wide.
 */
export interface SidDoc {
  readonly format: 'sid';
  /** The codec version the doc was read with or will be written as (`SID_FILE_VERSION`). */
  readonly version: number;
  /** Up to 32 latin-1 characters each; edge whitespace survives a round trip. */
  readonly songName: string;
  readonly author: string;
  readonly copyright: string;
  /** The per-song chip model (S2 deferred it here). */
  readonly chipModel: SidChipModel;
  /** Voices: `SID_CHANNELS`. */
  readonly channels: number;
  /** 1..16: the player ticks at 50 * speedMultiplier Hz (PAL frames, GT multispeed). */
  readonly speedMultiplier: number;
  /** 1..127: ticks per row at the start of every subsong. */
  readonly tempo: number;
  /** 1..32. The editor and the player show and play subsong 0 unless told otherwise. */
  readonly subsongs: readonly SidSubsong[];
  /** 1..208, each 1..128 rows. */
  readonly patterns: readonly SidDocPattern[];
  /** 0..63. */
  readonly instruments: readonly SidInstrument[];
  readonly tables: SidTables;
}

export type SidOpResult =
  | { readonly ok: true; readonly doc: SidDoc }
  | { readonly ok: false; readonly reason: string };
