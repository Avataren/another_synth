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
import type { ExtendedEffectSubtype } from './types';
import {
  type PitchModel,
  createAmigaPitchModel,
  createLinearPitchModel,
  createS3mPitchModel,
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
   * Whether this format's E0x-class "set filter" command reaches the post-fx
   * rack in AUTO mode (D114/D115).
   *
   * The decode side always decodes the bytes (MOD E0x and S3M S00 both decode
   * to `extEffect/filterToggle` -- decode and dispatch are deliberately
   * decoupled, D94 discipline); this flag alone gates dispatch:
   *
   * - ProTracker: yes. libopenmpt `Snd_fx.cpp` `ExtendedMODCommands` case
   *   0x00 sets `CHN_AMIGAFILTER = !(param & 1)` on every channel.
   * - XM: no. ft2-clone's `EJumpTab_TickZero[0]` is `dummy`.
   * - S3M: no. ST3.21 dummies S0x (`s_setfilt, 0` in st3play's `ssoncejmp`);
   *   libopenmpt's `ExtendedS3MCommands` has no case 0x00 either.
   * - native: yes -- in-app songs may hand-type E0x and it should work.
   *
   * Set explicitly on every profile that spreads PROTRACKER_PROFILE;
   * inheritance never carries it implicitly (plan review M1).
   */
  readonly filterToggleCommand: boolean;

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
   * The command byte that sets tempo outright. ProTracker folds speed and
   * tempo into one byte (Fxx: 01-1F speed, 20-FF tempo), so it leaves this
   * undefined; Scream Tracker 3 has separate commands -- A (0x01) sets the
   * speed, T (0x14) the tempo -- so its tempo byte lives here.
   */
  readonly tempoCommandByte?: number;

  /**
   * The command byte whose high parameter nibble selects an extended
   * subcommand (ProTracker/XM: 0x0E, Exy). Formats without extended effects
   * leave this undefined.
   */
  readonly extendedCommandByte: number | undefined;

  /**
   * Optional per-format table mapping the high parameter nibble of the
   * extended command byte to an extended-effect subtype. When undefined
   * the shared MOD/XM Exy numbering applies (see the default map in
   * parseExtendedEffect, ./note-utils.ts). Formats whose
   * extended subcommand numbering differs -- S3M's Sxx, whose table is
   * st3play's `ssoncejmp` (digcmd.c) rather than MOD/XM's -- carry their
   * own table here. Subcommands with no format-neutral behaviour yet are
   * simply absent from the table and decode to nothing (like M/N), never
   * to a borrowed MOD/XM reading.
   */
  readonly extendedSubcommandMap?: Readonly<Record<number, ExtendedEffectSubtype>>;

  /**
   * S3M only: the E and F portamento commands' high parameters are fine
   * slides, not slide speeds. st3play digcmd.c (quoted in D101): on tick 0,
   * a parameter 0xE1-0xEF slides once by `(param & 0x0F)` raw period units
   * and 0xF1-0xFF by `(param & 0x0F) << 2`; during ticks > 0 such a row
   * slides not at all (`if (ch->info >= 0xE0) return; // no fine slides
   * here`). ProTracker/XM never see parameters that high on 1xx/2xx, so the
   * field is deliberately absent from every other profile and the ordinary
   * per-tick slide path is untouched.
   */
  readonly finePortaHighParameters?: boolean;
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
  // E0x "set filter" drives the post-fx LED filter in AUTO (D115: E00 = on,
  // E01 = off, per libopenmpt's `!(param & 1)`).
  filterToggleCommand: true,
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
  // FT2 dummies E0x (EJumpTab_TickZero[0] = dummy, ft2_replayer.c): set
  // explicitly -- the spread would otherwise inherit ProTracker's true.
  filterToggleCommand: false,
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
  // Explicit per the M1 rule, even though XM_PROFILE already carries false:
  // inheritance from a spread must never be the reason a dispatch gate is
  // what it is.
  filterToggleCommand: false,
};

/**
 * Scream Tracker 3 semantics.
 *
 * Every value below is quoted from a reference in the decision log (D96).
 * The command table is S3M's own numbering -- the file stores the letter
 * minus 0x40 (OpenMPT's S3MConvert switches on `command | 0x40`), so byte
 * 0x01 is 'A' (set speed), not ProTracker's portamento up, and 0x0F is 'O'
 * (sample offset), not the speed command:
 *
 *   case 'A': m.command = CMD_SPEED;          // byte 0x01
 *   case 'B': m.command = CMD_POSITIONJUMP;   // 0x02
 *   case 'C': m.command = CMD_PATTERNBREAK;   // 0x03
 *   case 'D': m.command = CMD_VOLUMESLIDE;    // 0x04
 *   case 'E': m.command = CMD_PORTAMENTODOWN; // 0x05
 *   case 'F': m.command = CMD_PORTAMENTOUP;   // 0x06
 *   case 'G': m.command = CMD_TONEPORTAMENTO; // 0x07
 *   case 'H': m.command = CMD_VIBRATO;        // 0x08
 *   case 'I': m.command = CMD_TREMOR;         // 0x09
 *   case 'J': m.command = CMD_ARPEGGIO;       // 0x0A
 *   case 'K': m.command = CMD_VIBRATOVOL;     // 0x0B
 *   case 'L': m.command = CMD_TONEPORTAVOL;   // 0x0C
 *   case 'M': m.command = CMD_CHANNELVOLUME;  // 0x0D
 *   case 'N': m.command = CMD_CHANNELVOLSLIDE;// 0x0E
 *   case 'O': m.command = CMD_OFFSET;         // 0x0F
 *   case 'P': m.command = CMD_PANNINGSLIDE;   // 0x10
 *   case 'Q': m.command = CMD_RETRIG;         // 0x11
 *   case 'R': m.command = CMD_TREMOLO;        // 0x12
 *   case 'S': m.command = CMD_S3MCMDEX;       // 0x13
 *   case 'T': m.command = CMD_TEMPO;          // 0x14
 *   case 'U': m.command = CMD_FINEVIBRATO;    // 0x15
 *   case 'V': m.command = CMD_GLOBALVOLUME;   // 0x16
 *   case 'W': m.command = CMD_GLOBALVOLSLIDE; // 0x17
 *   case 'X': m.command = CMD_PANNING8;       // 0x18
 *
 * (OpenMPT soundlib/Load_s3m.cpp.) ST3.20 itself supports A-L, O, Q, R, S,
 * T, U and V ("a list of all the effects" in the ST3.20 manual); M, N, P,
 * W and X are dummies in ST3's own replayer (st3play's `sotherjmp` maps
 * them to `s_ret`) but were added by later trackers writing S3M files, and
 * OpenMPT decodes them for every S3M file, so the table carries them too.
 * M and N (per-channel volume commands) have no format-neutral behaviour in
 * the effect union yet, so they are deliberately left unmapped rather than
 * mis-decoded -- P5 gives them homes when the S3M importer lands.
 *
 * The ST3 replayer's semantics the profile fields encode, quoted from
 * 8bitbubsy's st3play (see pitch-model.ts for the full quotes): slides
 * move `info << 2` period units per tick (`s_slidedown`), so ST3 slides
 * are four times finer than ProTracker's; `GET_LAST_NFO`
 * (`if (ch->info == 0) ch->info = ch->alastnfo;`) reuses the last non-zero
 * parameter on every slide command, so volume and fine slides both
 * remember (the ProTracker contrast is its raw-byte-reading fine
 * routines); and pan slides operate on a 0..255 byte exactly like FT2's.
 *
 * Nothing selects this profile until an S3M song carries the format tag,
 * so MOD/XM/native playback is untouched.
 */
export const S3M_PROFILE: FormatProfile = {
  ...PROTRACKER_PROFILE,
  format: 's3m',
  pitch: createS3mPitchModel(),
  // st3play's s_volslide opens with GET_LAST_NFO: a zero parameter
  // reuses the channel's last non-zero slide info.
  volumeSlideHasMemory: true,
  // Every ST3 slide routine moves `info << 2` period units per tick
  // (s_slidedown: `ch->aspd += ch->info << 2`).
  portamentoUnitScale: 4,
  // Same GET_LAST_NFO memory in the fine-slide paths (EFx/FFx fine
  // slides arrive through the porta commands' high parameters).
  fineSlideHasMemory: true,
  // S3M pan is one 0..255 byte like FT2's (OpenMPT's S3M pan slide walks
  // nPan 0..255 by the raw parameter), so one unit is 2/255 of the
  // processor's -1..1 swing. (ST3.20's own replayer dummies the P
  // command; the value is for the MPT-era files that use it.)
  panSlideUnit: 2 / 255,
  // S3M has no song-stop command: its 'F' byte (0x06) is portamento up,
  // not speed (the ST3.20 manual's effect list has no stop reading).
  f00StopsSong: false,
  // S00 decodes to `filterToggle` below (the ssoncejmp table keeps ST3's own
  // numbering), but ST3.21 dummies the command ("s_setfilt, 0"), so dispatch
  // is gated off here -- decode and dispatch stay decoupled (D94/D115).
  // Explicit: the spread from PROTRACKER_PROFILE would otherwise inherit
  // ProTracker's true and make S00 toggle the post-fx LED filter.
  filterToggleCommand: false,
  // S3M's finetune is the sample's own c2spd ("C4Spd", 8363 = no
  // finetune), not a nibble; the one nibble-shaped surface, the S2x
  // set-finetune command, uses ProTracker's signed 16-value table
  // (xfinetune_amiga in st3play's digdata.c: 8363..8757 then 7895..8280),
  // which is the signed-eighth-semitone reading ProTracker_PROFILE
  // already encodes.
  // They also run *alongside* an effect-column command on the same row
  // rather than replacing it, so a row can slide volume from the volume
  // column while sliding pitch from the effect column.
  // S3M's E/F high parameters are fine slides (EFx/FFx), one-shot on tick 0.
  finePortaHighParameters: true,
  arpeggioCommandByte: 0x0a, // 'J'
  speedTempoCommandByte: 0x01, // 'A' -- set speed (manual: "Set speed to xx")
  tempoCommandByte: 0x14, // 'T' -- tempo = xx (manual: "valid values 20 to FF")
  extendedCommandByte: 0x13, // 'S' -- extended commands
  // ST3's Sxx subcommand numbering is NOT the shared MOD/XM Exy numbering.
  // This table is st3play digcmd.c's `ssoncejmp`, quoted verbatim (fetched
  // 2026-09-03):
  //
  //   s_setfilt,     // 0    (dummied in ST3.21 -- the Amiga filter, like MOD's E0x)
  //   s_setgliss,    // 1
  //   s_setfinetune, // 2
  //   s_setvibwave,  // 3
  //   s_settrewave,  // 4
  //   s_ret,         // 5
  //   s_ret,         // 6
  //   s_ret,         // 7
  //   s_setpanpos,   // 8
  //   s_ret,         // 9
  //   s_stereocntr,  // A
  //   s_patloop,     // B
  //   s_notecut,     // C
  //   s_notedelay,   // D
  //   s_patterdelay, // E
  //   s_ret          // F
  //
  // Only 0x0/0x8/0xC/0xD/0xE coincide with the MOD/XM Exy reading; S1x/S2x/
  // S3x/S4x/SBx would silently mis-decode through the shared map (e.g. SBx
  // pattern loop becomes a fine volume slide). s_ret nibbles -- 0x5/0x6/0x7/
  // 0x9/0xA/0xF -- are deliberately absent and decode to undefined, like M/N:
  // they have no format-neutral behaviour yet (SAx stereo control, S9x
  // unknown, SFx unknown), so no union member is spent on a guess.
  extendedSubcommandMap: {
    0x0: 'filterToggle',
    0x1: 'glissandoCtrl',
    0x2: 'setFinetune',
    0x3: 'vibratoWave',
    0x4: 'tremoloWave',
    0x8: 'setPan',
    0xB: 'patLoop',
    0xC: 'noteCut',
    0xD: 'noteDelay',
    0xE: 'patDelay',
  },
  effectCommands: {
    0x02: 'posJump', // B
    0x03: 'patBreak', // C -- parameter is BCD-decoded at import (P5)
    0x04: 'volSlide', // D
    0x05: 'portaDown', // E
    0x06: 'portaUp', // F
    0x07: 'tonePorta', // G
    0x08: 'vibrato', // H
    0x09: 'tremor', // I
    0x0b: 'vibratoVol', // K
    0x0c: 'tonePortaVol', // L
    0x0f: 'sampleOffset', // O
    0x10: 'panSlide', // P (MPT-era; dummied in ST3's own replayer)
    0x11: 'retrigVol', // Q
    0x12: 'tremolo', // R
    0x15: 'fineVibrato', // U
    0x16: 'setGlobalVol', // V
    0x17: 'globalVolSlide', // W (MPT-era)
    0x18: 'setPan', // X -- 8-bit pan, 0..255 (MPT-era)
    // Y (panbrello, 0x19) and Z (MIDI, 0x1A) are left unmapped: OpenMPT's
    // S3MConvert decodes them for every S3M, but ST3's own replayer ignores
    // Y (sotherjmp: s_ret) and dummies Z (s_zinfo, a variable setter), so
    // neither has format-neutral behaviour -- same rationale as M/N.
  },
};

export const S3M_AMIGA_PROFILE: FormatProfile = {
  ...S3M_PROFILE,
  // The per-file amiga-limits header flag (flags & 0x10) selects this
  // profile through the same chain as XM's Amiga mode (D59 discipline):
  // identical to S3M_PROFILE except the pitch model's clamp set, per
  // st3play's setmasterflags (dig.c): aspdmin 453, aspdmax 3424 instead of
  // 64..32767. Note frequencies are the same either way -- only how far a
  // slide can run changes.
  pitch: createS3mPitchModel({ amigaLimits: true }),
  // Explicit per the M1 rule (see XM_AMIGA_PROFILE).
  filterToggleCommand: false,
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
  // In-app songs can hand-type E00/E01 into the effect column
  // (parseEffectCommand decodes it through the same DEFAULT map), so the
  // command works in native songs too -- settled in the task's resolved
  // decisions. Explicit, never inherited (M1).
  filterToggleCommand: true,
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
  /**
   * S3M only: the per-file amiga-limits header flag (flags & 0x10), selecting
   * S3M_AMIGA_PROFILE. Same shape as `linearFrequency` -- a file-level flag
   * masquerading as nothing else (D1/D24) -- and threaded the same way so it
   * reaches the engine's effect arithmetic (D59).
   */
  amigaLimits?: boolean;
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
  if (format === 's3m' && options?.amigaLimits === true) {
    return S3M_AMIGA_PROFILE;
  }
  return PROFILES[format] ?? PROTRACKER_PROFILE;
}
