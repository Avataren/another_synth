/**
 * Per-format playback semantics.
 *
 * ProTracker, FastTracker 2 and Scream Tracker disagree on enough behaviour
 * that a single blended code path degrades all of them. Rather than branching
 * on the format inside effect handlers -- which spreads unauditable
 * conditionals through a 1200-line file -- the differences are enumerated
 * here as data, and the effect processor reads them from the profile attached
 * to each track's state.
 *
 * See PLAN-module-format-support.md (D2) for the reasoning, and section 3 for
 * the full list of behaviours that still need to move behind this.
 */

import type { ModuleFormat } from './types';
import type { EffectType } from './types';
import {
  type PitchModel,
  createAmigaPitchModel,
  createLinearPitchModel,
  createXmAmigaPitchModel,
} from './pitch-model';

export interface FormatProfile {
  /** The format this profile describes. */
  readonly format: ModuleFormat;

  /**
   * Volume change represented by one unit of a volume-slide parameter, as a
   * fraction of full scale.
   *
   * ProTracker and FT2 both use a 0-64 volume range, so one unit is 1/64.
   */
  readonly volumeSlideUnit: number;

  /**
   * How pitch is represented and slid. ProTracker uses Amiga periods against
   * a hand-tuned table; XM defaults to a linear frequency table. Arpeggio's
   * table-overflow behaviour belongs to the model, since it is a consequence
   * of stepping through a table at all.
   */
  readonly pitch: PitchModel;

  /**
   * Whether a volume slide with a zero parameter (A00) reuses the channel's
   * last non-zero slide.
   *
   * FastTracker 2 keeps volume-slide memory; ProTracker does not -- there A00
   * simply means "no volume change". The difference is not academic: across a
   * 20-module sample, 569 of 27378 Axx commands carry a zero parameter, and in
   * one module (resii.mod) it is 27% of them. Treating those as "continue the
   * previous slide" makes volume drift where ProTracker holds it steady.
   *
   * Note this is specifically volume-slide memory. Vibrato's per-nibble memory
   * (4xy, used with a zero parameter in over half of all occurrences) and tone
   * portamento's speed memory (3xx) exist in both formats and are unaffected.
   */
  readonly volumeSlideHasMemory: boolean;

  /**
   * Period units a portamento parameter of 1 moves per tick.
   *
   * ProTracker subtracts the parameter straight from an Amiga period whose
   * C-2 is 428. XM's period scale is four times finer -- its Amiga C-4 is
   * 1712, and its linear table uses 64 units per semitone -- and FastTracker 2
   * correspondingly slides by `param * 4`, so the two formats reach the same
   * musical rate. Using ProTracker's scale for XM slides at a quarter speed,
   * which leaves every slide short of its target and audibly out of tune.
   */
  readonly portamentoUnitScale: number;

  /**
   * ProTracker quirk: an EDx note delay longer than the row's tick count
   * leaks the note into the following row instead of dropping it.
   */
  readonly noteDelayOverflowCarries: boolean;

  /**
   * The finetune offset an E5x nibble asks for, in semitones.
   *
   * The two formats read the same nibble completely differently. ProTracker
   * treats it as a *signed* 4-bit value in eighths of a semitone, so 0-7 tune
   * up and 8-15 tune down. FastTracker 2 treats it as an unsigned position in
   * its -128..127 finetune range (`finetune = x*16 - 128`, and 128 finetune
   * units is one semitone), so 8 is the neutral middle and 0 is a full
   * semitone flat.
   *
   * The upshot is that for every nibble below 8 the two disagree by exactly
   * one semitone -- not a subtle mistuning. All 840 E5x commands in the local
   * XM corpus use nibbles 1 and 6, so reading them ProTracker-style put every
   * one of those notes a semitone sharp.
   */
  readonly finetuneFromNibble: (nibble: number) => number;

  /**
   * Which of the three arpeggio notes a given tick of a row plays:
   * 0 = the base note, 1 = the `x` nibble, 2 = the `y` nibble.
   *
   * The two formats disagree, and not subtly. ProTracker counts its tick
   * *up* from 0 and reads `song->tick % 3` (`arpeggio` in pt2_replayer.c), so
   * a row plays base, x, y, base, x, y.
   *
   * FastTracker 2 counts `song.tick` *down* from `song.speed` --
   * `if (--song.tick == 0) song.tick = song.speed;` in `tickReplayer` -- and
   * indexes a table with it: `arpeggioTab[song.tick & 31]`. Row tick `t`
   * therefore sees `song.tick == speed - t`, and at the common speeds 6 and 3
   * that runs the table backwards: base, y, x. `x` and `y` are swapped
   * against ProTracker for the whole row, so a `047` plays root-fifth-third
   * rather than root-third-fifth.
   *
   * The table is only 16 entries long in FT2; the other 16 are bytes that
   * follow it in the binary, which 8bitbubsy reproduces verbatim (see
   * `arpeggioTab` in ft2_tables.c) because speeds above 16 read them. They
   * are large values, so every one of them except the 0 at index 16 selects
   * `y`. That is faithfully reproduced here rather than smoothed over.
   */
  readonly arpeggioStep: (tick: number, ticksPerRow: number) => 0 | 1 | 2;

  /**
   * Whether the fine, single-step slides remember their parameter and repeat
   * it on a zero one: E1x/E2x (fine pitch), EAx/EBx (fine volume) and Xxy
   * (extra-fine pitch).
   *
   * Every one of FT2's fine routines opens with the same two lines --
   *
   *   static void fineVolSlideUp(channel_t *ch, uint8_t param)
   *   {
   *       if (param == 0)
   *           param = ch->fVolSlideUpSpeed;
   *       ch->fVolSlideUpSpeed = param;
   *
   * (finePitchSlideUp and extraFinePitchSlide in ft2_replayer.c are the
   * same shape, each with its own memory byte) -- so an `EA0` after `EB2`
   * slides *down* by 2 again, and a run of `EB0` rows keeps walking the
   * volume down one step per row. an-path.xm is written exactly that way:
   * 2322 of its `EBx` commands carry a zero parameter.
   *
   * ProTracker's volumeFineUp/Down and finePortaUp/Down read the command
   * byte raw with no memory -- a zero parameter is a genuine no-op there --
   * and the native format keeps the no-op reading too, since its songs were
   * written by ear against the old behaviour.
   */
  readonly fineSlideHasMemory: boolean;

  /**
   * Pan distance one pan-slide parameter unit moves per tick, on the
   * processor's -1..1 pan scale.
   *
   * FT2 keeps pan as one 0..255 byte (128 = centre) and slides it by the raw
   * parameter -- `newPan += param` per tick in `panningSlide`, and one unit
   * per tick in the volume column's `v_PanSlideLeft`/`v_PanSlideRight` -- so
   * a unit is 2/255 of full swing. This used to be 1/64, the volume-slide
   * unit, which is almost exactly twice as far: a pan slide crossed the
   * whole stereo field in 64 ticks where FT2 needs 128. The native format
   * keeps 1/64 as its legacy-by-ear value; ProTracker has no pan slides at
   * all, so its value is never read.
   */
  readonly panSlideUnit: number;

  /**
   * Whether F00 stops the song, as ProTracker's setSpeed does (`F00 - stop
   * song; doStopSong = true;`). FT2 instead sets speed 0, which stalls its
   * own replayer; this engine keeps the pre-existing clamp-to-1 reading for
   * formats where the flag is false.
   */
  readonly f00StopsSong: boolean;

  /**
   * How a module's raw effect-command bytes decode into the format-neutral
   * effect behaviours, for entries that carry them (`TrackerEntryData
   * .effectCommand`/`.effectParam`). The numeric command byte is what the
   * module format actually stores, so this table -- not a letter heuristic --
   * is the mapping a new format fills in (D94).
   */
  readonly effectCommands: Readonly<Record<number, EffectType>>;

  /**
   * The command byte whose parameter carries two independent nibbles that
   * select the arpeggio intervals (ProTracker/XM: 0x00). A zero parameter on
   * it is a no-op.
   */
  readonly arpeggioCommandByte: number;

  /**
   * The command byte that sets speed (low range) or tempo (high range).
   * Formats without such a command leave this undefined.
   */
  readonly speedTempoCommandByte: number | undefined;

  /**
   * The command byte whose high parameter nibble selects an extended
   * subcommand (ProTracker/XM: 0x0E, Exy). Formats without extended effects
   * leave this undefined.
   */
  readonly extendedCommandByte: number | undefined;
}

/**
 * FT2's `arpeggioTab`, quoted from ft2_tables.c including the sixteen
 * overflow bytes:
 *
 *   const uint8_t arpeggioTab[32] =
 *   {
 *       0,1,2,0,1,2,0,1,2,0,1,2,0,1,2,0,
 *       0x00,0x18,0x31,0x4A,0x61,0x78,0x8D,0xA1,
 *       0xB4,0xC5,0xD4,0xE0,0xEB,0xF4,0xFA,0xFD
 *   };
 */
const FT2_ARPEGGIO_TAB = [
  0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 0x00, 0x18, 0x31, 0x4a, 0x61,
  0x78, 0x8d, 0xa1, 0xb4, 0xc5, 0xd4, 0xe0, 0xeb, 0xf4, 0xfa, 0xfd,
] as const;

/** ProTracker: `song->tick % 3`, with the tick counting up from 0. */
function protrackerArpeggioStep(tick: number): 0 | 1 | 2 {
  return (tick % 3) as 0 | 1 | 2;
}

/** FT2: `arpeggioTab[song.tick & 31]`, with `song.tick == speed - rowTick`. */
function ft2ArpeggioStep(tick: number, ticksPerRow: number): 0 | 1 | 2 {
  const entry = FT2_ARPEGGIO_TAB[(ticksPerRow - tick) & 31]!;
  // FT2 branches `if (tick == 0) base; else if (tick == 1) x; else y`, so
  // every overflow byte other than the 0 at index 16 lands on y.
  if (entry === 0) return 0;
  if (entry === 1) return 1;
  return 2;
}

/**
 * ProTracker / classic MOD semantics. This is also the behaviour the engine
 * had before profiles existed, so it doubles as the compatibility baseline.
 */
export const PROTRACKER_PROFILE: FormatProfile = {
  format: 'protracker',
  volumeSlideUnit: 1 / 64,
  pitch: createAmigaPitchModel({ arpeggioWrapsToDC: true }),
  volumeSlideHasMemory: false,
  portamentoUnitScale: 1,
  noteDelayOverflowCarries: true,
  // Signed 4-bit, in eighths of a semitone.
  finetuneFromNibble: (nibble) => (nibble < 8 ? nibble : nibble - 16) / 8,
  arpeggioStep: protrackerArpeggioStep,
  // ProTracker's fine routines read the command byte raw: a zero parameter
  // moves nothing and is remembered by nothing.
  fineSlideHasMemory: false,
  // Never read: ProTracker has no pan slides. Kept at the legacy unit.
  panSlideUnit: 1 / 64,
  f00StopsSong: true,
  // ProTracker's own command numbering; FT2 continues the alphabet past 0x0F
  // with G(0x10), K(0x14), L(0x15), P(0x19), R(0x1B), T(0x1D), U(0x1E) and
  // X(0x21) -- the same numbers the XM parser reads from the file.
  effectCommands: {
    0x01: 'portaUp',
    0x02: 'portaDown',
    0x03: 'tonePorta',
    0x04: 'vibrato',
    0x05: 'tonePortaVol',
    0x06: 'vibratoVol',
    0x07: 'tremolo',
    0x08: 'setPan',
    0x09: 'sampleOffset',
    0x0a: 'volSlide',
    0x0b: 'posJump',
    0x0c: 'setVolume',
    0x0d: 'patBreak',
    0x10: 'setGlobalVol',
    0x11: 'globalVolSlide',
    0x14: 'keyOff',
    0x15: 'setEnvelopePos',
    0x19: 'panSlide',
    0x1b: 'retrigVol',
    0x1d: 'tremor',
    0x1e: 'fineVibrato',
    0x21: 'extraFinePorta',
  },
  arpeggioCommandByte: 0x00,
  speedTempoCommandByte: 0x0f,
  extendedCommandByte: 0x0e,
};

/**
 * FastTracker 2 semantics, using XM's default linear frequency table.
 *
 * XM can also be flagged into Amiga mode, which needs its own profile with an
 * Amiga-style model; that arrives with the XM parser in Phase 3, since only
 * the file header says which mode a song wants.
 *
 * The remaining fields still hold ProTracker values and are corrected as each
 * behaviour is migrated -- see PLAN-module-format-support.md Phase 2. Nothing
 * selects this profile yet, so MOD playback is unaffected either way.
 */
export const XM_PROFILE: FormatProfile = {
  ...PROTRACKER_PROFILE,
  format: 'xm',
  pitch: createLinearPitchModel(),
  volumeSlideHasMemory: true,
  portamentoUnitScale: 4,
  // Unsigned position in FT2's -128..127 finetune range: finetune = x*16-128,
  // and 128 finetune units is one semitone.
  finetuneFromNibble: (nibble) => (nibble - 8) / 8,
  arpeggioStep: ft2ArpeggioStep,
  // Every FT2 fine routine remembers its parameter: `if (param == 0)
  // param = ch->f<...>Speed; ch->f<...>Speed = param;`
  fineSlideHasMemory: true,
  // FT2 pan is one 0..255 byte, so one parameter unit is 2/255 of the
  // processor's -1..1 swing.
  panSlideUnit: 2 / 255,
  // FT2's setSpeed with a parameter below 32 sets speed 0, which stalls the
  // song rather than stopping it cleanly; keep the engine's old clamp.
  f00StopsSong: false,
};

/**
 * FastTracker 2 with the Amiga frequency table selected in the module header.
 *
 * Not a rare variant: 4 of the 9 modules in the local corpus use it (see
 * PLAN-module-format-support.md section 6c). Identical to XM_PROFILE apart
 * from the pitch model, since the flag only changes how pitch is represented
 * and slid.
 */
export const XM_AMIGA_PROFILE: FormatProfile = {
  ...XM_PROFILE,
  pitch: createXmAmigaPitchModel(),
};

/** Scream Tracker 3 semantics. Placeholder, as for XM_PROFILE.
 *
 * The command tables still hold the ProTracker/XM values; filling them with
 * S3M's own numbering (where byte 0x01 is 'A' -- set speed, not portamento
 * up) is P5 work alongside the S3M parser, not a placeholder fix.
 */
export const S3M_PROFILE: FormatProfile = {
  ...PROTRACKER_PROFILE,
  format: 's3m',
};

/**
 * Songs authored in this tracker.
 *
 * Deliberately keeps the ProTracker values for now: songs written against the
 * current engine were composed by ear with those behaviours in place, so
 * changing them here would alter existing work. Revisit once the legacy
 * quirks are genuinely optional.
 */
export const NATIVE_PROFILE: FormatProfile = {
  ...PROTRACKER_PROFILE,
  format: 'native',
  // Songs written against this engine were composed with volume-slide memory
  // in place, so keep it rather than silently altering existing work.
  volumeSlideHasMemory: true,
  // Same legacy rationale: keep the no-memory fine slides and the old pan
  // slide unit that native songs were written against, and let F00 keep its
  // old clamp-to-speed-1 reading rather than stopping the song.
  fineSlideHasMemory: false,
  panSlideUnit: 1 / 64,
  f00StopsSong: false,
};

const PROFILES: Record<ModuleFormat, FormatProfile> = {
  native: NATIVE_PROFILE,
  protracker: PROTRACKER_PROFILE,
  xm: XM_PROFILE,
  s3m: S3M_PROFILE,
};

export interface ProfileOptions {
  /**
   * XM only: which frequency table the module header selected. XM songs carry
   * this per file, so it cannot be folded into the ModuleFormat tag.
   * Defaults to linear, XM's own default.
   */
  linearFrequency?: boolean;
}

/** The playback semantics to apply for a given module format. */
export function profileForFormat(
  format: ModuleFormat | undefined,
  options?: ProfileOptions,
): FormatProfile {
  if (!format) return PROTRACKER_PROFILE;
  if (format === 'xm' && options?.linearFrequency === false) {
    return XM_AMIGA_PROFILE;
  }
  return PROFILES[format] ?? PROTRACKER_PROFILE;
}
