import type {
  EffectCommand,
  EffectType,
  ExtendedEffectSubtype,
  VolumeColumnCommand,
} from './types';
import type { FormatProfile } from './format-profile';

export interface ParsedNote {
  midi?: number;
  isNoteOff: boolean;
}

const NOTE_BASE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11
};

export function parseTrackerNoteSymbol(input?: string): ParsedNote {
  if (!input) {
    return { isNoteOff: false };
  }

  const normalized = input.trim().toUpperCase();
  if (normalized === '###') {
    return { isNoteOff: true };
  }

  const match = normalized.match(/^([A-G])([#-]?)(-?\d)$/);
  if (!match) {
    return { isNoteOff: false };
  }

  const [, letter, accidental, octaveStr] = match;
  const base = NOTE_BASE[letter as keyof typeof NOTE_BASE];
  if (base === undefined) {
    return { isNoteOff: false };
  }

  let semitone = base;
  if (accidental === '#') semitone += 1;
  // Tracker format uses '-' as a placeholder for naturals; flats are not supported yet

  const octave = Number(octaveStr);
  if (!Number.isFinite(octave)) {
    return { isNoteOff: false };
  }

  const midi = (octave + 1) * 12 + semitone;
  if (!Number.isFinite(midi)) {
    return { isNoteOff: false };
  }

  return { midi, isNoteOff: false };
}

export function parseTrackerVolume(volume?: string): number | undefined {
  if (!volume) return undefined;
  const trimmed = volume.trim();
  const value = Number.parseInt(trimmed, 16);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(255, value));
}

/**
 * Parse a FastTracker 2 volume-column command.
 *
 * The input is the raw XM volume-column byte as two hex characters. Values
 * below 0x60 are not commands -- 0x10-0x50 is "set volume", which travels as
 * the step's ordinary volume/velocity -- so they parse to undefined here.
 *
 * The high nibble selects the command and the low nibble is its parameter,
 * except for 0xFx tone portamento, whose parameter is the nibble scaled by 16
 * (FT2 stores the volume column's tone-porta speed in the high nibble only, so
 * the volume column can express speeds 0x10..0xF0 but nothing finer).
 */
export function parseVolumeColumnCommand(
  volumeCommand?: string,
): VolumeColumnCommand | undefined {
  if (!volumeCommand) return undefined;
  const raw = Number.parseInt(volumeCommand.trim(), 16);
  if (!Number.isFinite(raw) || raw < 0x60 || raw > 0xff) return undefined;

  const value = raw & 0x0f;
  switch (raw >> 4) {
    case 0x6:
      return { type: 'volSlideDown', value };
    case 0x7:
      return { type: 'volSlideUp', value };
    case 0x8:
      return { type: 'fineVolDown', value };
    case 0x9:
      return { type: 'fineVolUp', value };
    case 0xa:
      return { type: 'vibratoSpeed', value };
    case 0xb:
      return { type: 'vibrato', value };
    case 0xc:
      return { type: 'setPan', value };
    case 0xd:
      return { type: 'panSlideLeft', value };
    case 0xe:
      return { type: 'panSlideRight', value };
    case 0xf:
      return { type: 'tonePorta', value: value * 16 };
    default:
      return undefined;
  }
}

/**
 * Result of parsing an effect command field
 */
export type EffectCommandResult =
  | { type: 'macro'; index: number; value: number }
  | { type: 'speed'; speed: number }
  | { type: 'tempo'; bpm: number }
  | { type: 'effect'; effect: EffectCommand }
  | undefined;

/**
 * Normalize effect command characters
 */
function normalizeEffectChars(macro?: string): [string, string, string] {
  const clean = (macro ?? '').toUpperCase();
  const chars: [string, string, string] = ['.', '.', '.'];
  // Allow hex digits for effect commands (0-9, A-Z for extended)
  if (/^[0-9A-Z]$/.test(clean[0] ?? '')) chars[0] = clean[0] as string;
  if (/^[0-9A-F]$/.test(clean[1] ?? '')) chars[1] = clean[1] as string;
  if (/^[0-9A-F]$/.test(clean[2] ?? '')) chars[2] = clean[2] as string;
  return chars;
}

/**
 * Decode a raw, format-native effect byte pair using the module format's
 * profile.
 *
 * This is the decoding path for entries that carry raw bytes
 * (`TrackerEntryData.effectCommand`/`.effectParam`, written by the
 * importers); `parseEffectCommand` remains for hand-authored rows, whose
 * text is authoritative because the raw fields were cleared on edit.
 *
 * The command *numbers* mean whatever the format's profile says: the
 * behaviour table and the three structural command bytes (arpeggio,
 * speed/tempo, extended) all come from the `FormatProfile`, so a format
 * whose numbering collides with MOD/XM's is a data change, never a parser
 * fork (D94).
 */
export function decodeRawEffect(
  command: number,
  param: number,
  profile: FormatProfile,
): EffectCommandResult {
  const cmd = command & 0xff;
  const value = Math.max(0, Math.min(255, param));
  const paramX = value >> 4;
  const paramY = value & 0x0f;

  if (cmd === profile.arpeggioCommandByte) {
    if (paramX !== 0 || paramY !== 0) {
      return {
        type: 'effect',
        effect: { type: 'arpeggio', paramX, paramY },
      };
    }
    return undefined;
  }

  if (
    profile.speedTempoCommandByte !== undefined &&
    cmd === profile.speedTempoCommandByte
  ) {
    // Same split parseEffectCommand applies: 01-1F is speed, 20-FF tempo,
    // and zero is returned as speed 0 so the engine -- which knows the
    // profile -- can apply f00StopsSong.
    if (value >= 0x01 && value <= 0x1f) return { type: 'speed', speed: value };
    if (value >= 0x20) return { type: 'tempo', bpm: value };
    return { type: 'speed', speed: 0 };
  }

  if (profile.tempoCommandByte !== undefined && cmd === profile.tempoCommandByte) {
    // Formats with a dedicated tempo command (S3M's Txx). ST3's manual
    // gives tempo the range 20-FF; smaller parameters have no meaning and
    // decode to nothing rather than a bogus BPM.
    if (value >= 0x20) return { type: 'tempo', bpm: value };
    return undefined;
  }

  if (profile.extendedCommandByte !== undefined && cmd === profile.extendedCommandByte) {
    const extEffect = parseExtendedEffect(paramX, paramY, profile.extendedSubcommandMap);
    if (extEffect) return { type: 'effect', effect: extEffect };
    return undefined;
  }

  const effectType = profile.effectCommands[cmd];
  if (effectType) {
    return {
      type: 'effect',
      effect: { type: effectType, paramX, paramY },
    };
  }

  return undefined;
}

/**
 * The shared MOD/XM Exy subtype map: the default when a profile's
 * extendedSubcommandMap is undefined, so MOD/XM/native decode exactly as
 * they always did. Formats whose extended subcommand numbering differs
 * (S3M's Sxx, per st3play's `ssoncejmp`) carry their own table on the
 * profile instead; subcommands absent from a table decode to undefined
 * rather than a borrowed reading.
 */
const DEFAULT_EXTENDED_SUBTYPE_MAP: Record<number, ExtendedEffectSubtype> = {
  0x0: 'filterToggle',
  0x1: 'finePortaUp',
  0x2: 'finePortaDown',
  0x3: 'glissandoCtrl',
  0x4: 'vibratoWave',
  0x5: 'setFinetune',
  0x6: 'patLoop',
  0x7: 'tremoloWave',
  0x8: 'setPan',
  0x9: 'retrigger',
  0xA: 'fineVolUp',
  0xB: 'fineVolDown',
  0xC: 'noteCut',
  0xD: 'noteDelay',
  0xE: 'patDelay',
  0xF: 'invertLoop'
};

/**
 * Parse extended effects (Exy)
 */
function parseExtendedEffect(
  x: number,
  y: number,
  subtypeMap: Readonly<Record<number, ExtendedEffectSubtype>> = DEFAULT_EXTENDED_SUBTYPE_MAP,
): EffectCommand | undefined {
  const subtype = subtypeMap[x];
  if (!subtype) return undefined;

  // Map subtype to main effect type
  const typeMap: Record<ExtendedEffectSubtype, EffectType> = {
    finePortaUp: 'finePortaUp',
    finePortaDown: 'finePortaDown',
    glissandoCtrl: 'extEffect',
    vibratoWave: 'setVibratoWave',
    setFinetune: 'extEffect',
    patLoop: 'extEffect',
    tremoloWave: 'setTremoloWave',
    setPan: 'setPan',
    retrigger: 'retrigVol',
    fineVolUp: 'volSlide',
    fineVolDown: 'volSlide',
    noteCut: 'noteCut',
    noteDelay: 'noteDelay',
    patDelay: 'patDelay',
    filterToggle: 'extEffect',
    invertLoop: 'extEffect'
  };

  return {
    type: typeMap[subtype],
    paramX: x,
    paramY: y,
    extSubtype: subtype
  };
}

/**
 * Parse effect command field
 * Supports:
 * - Macro commands:
 *   - M0xx-M3xx (explicit macro prefix) - macro index 0-3, value 00-FF
 *   - Mxx / Nxx / Oxx / Pxx (3-char macro shorthands for macro 0-3)
 * - FastTracker 2 effects:
 *   - 0xy: Arpeggio (when xy != 00)
 *   - 1xx: Portamento up
 *   - 2xx: Portamento down
 *   - 3xx: Tone portamento
 *   - 4xy: Vibrato
 *   - 5xy: Tone porta + vol slide
 *   - 6xy: Vibrato + vol slide
 *   - 7xy: Tremolo
 *   - 8xx: Set panning
 *   - 9xx: Sample offset
 *   - Axy: Volume slide
 *   - Bxx: Position jump
 *   - Cxx: Set volume
 *   - Dxx: Pattern break
 *   - Exy: Extended effects
 *   - Fxx: Speed/tempo (existing)
 *   - Gxx: Set global volume
 *   - Hxy: Global volume slide
 *   - Kxx: Key off
 *   - Pxy: Panning slide
 *   - Rxy: Retrigger + vol slide
 *   - Txy: Tremor
 *   - Uxy: Fine vibrato
 */
export function parseEffectCommand(macro?: string): EffectCommandResult {
  if (!macro || macro.trim() === '') return undefined;

  const clean = macro.trim().toUpperCase();

  // Check for explicit macro prefix (M0xx-M3xx)
  if (clean.startsWith('M') && clean.length >= 2) {
    const macroIndex = parseInt(clean[1] ?? '', 16);
    if (Number.isFinite(macroIndex) && macroIndex >= 0 && macroIndex <= 3) {
      const valueStr = clean.slice(2).padEnd(2, '0');
      const raw = Number.parseInt(valueStr.slice(0, 2), 16);
      if (Number.isFinite(raw)) {
        const clamped = Math.max(0, Math.min(255, raw));
        return { type: 'macro', index: macroIndex, value: clamped / 255 };
      }
    }
  }

  // Check for single-letter macro shorthands (M/N/O/P map to macro 0-3)
  const macroLetterMap: Record<string, number> = { M: 0, N: 1, O: 2, P: 3 };
  const macroLetterIndex = macroLetterMap[clean[0] ?? ''];
  if (macroLetterIndex !== undefined) {
    const valueStr = clean
      .slice(1)
      .replace(/\./g, '0')
      .padEnd(2, '0')
      .slice(0, 2);
    const raw = Number.parseInt(valueStr, 16);
    if (Number.isFinite(raw)) {
      const clamped = Math.max(0, Math.min(255, raw));
      return { type: 'macro', index: macroLetterIndex, value: clamped / 255 };
    }
  }

  const chars = normalizeEffectChars(macro);
  if (chars[0] === '.') return undefined;

  const cmd = chars[0];
  const paramHex = `${chars[1] === '.' ? '0' : chars[1]}${chars[2] === '.' ? '0' : chars[2]}`;
  const paramValue = Number.parseInt(paramHex, 16);
  if (!Number.isFinite(paramValue)) return undefined;

  const paramX = parseInt(chars[1] === '.' ? '0' : chars[1], 16);
  const paramY = parseInt(chars[2] === '.' ? '0' : chars[2], 16);

  // Map command letter to effect type
  const effectMap: Record<string, EffectType> = {
    '1': 'portaUp',
    '2': 'portaDown',
    '3': 'tonePorta',
    '4': 'vibrato',
    '5': 'tonePortaVol',
    '6': 'vibratoVol',
    '7': 'tremolo',
    '8': 'setPan',
    '9': 'sampleOffset',
    'A': 'volSlide',
    'B': 'posJump',
    'C': 'setVolume',
    'D': 'patBreak',
    'G': 'setGlobalVol',
    'H': 'globalVolSlide',
    'K': 'keyOff',
    // XM effect 0x15.
    'L': 'setEnvelopePos',
    'P': 'panSlide',
    'R': 'retrigVol',
    'T': 'tremor',
    'U': 'fineVibrato',
    // XM effect 0x21. Continues the alphabet past F the same way
    // xmEffectToMacro numbers them, so 0x10 is G and 0x21 is X.
    'X': 'extraFinePorta'
  };

  // Handle F command (speed/tempo) - preserve existing behavior
  if (cmd === 'F') {
    // F01-F1F: Speed command (1-31)
    if (paramValue >= 0x01 && paramValue <= 0x1f) {
      return { type: 'speed', speed: paramValue };
    }
    // F20-FF: Tempo command (32-255)
    if (paramValue >= 0x20 && paramValue <= 0xff) {
      return { type: 'tempo', bpm: paramValue };
    }
    // F00: ProTracker's stop song (pt2_replayer.c setSpeed: "F00 - stop
    // song; doStopSong = true;"). Returned as speed 0 so the engine -- which
    // knows the format profile -- can decide; returning undefined here (as
    // this used to) dropped the command and the engine clamped a speed that
    // never arrived.
    return { type: 'speed', speed: 0 };
  }

  // Handle E command (extended effects)
  if (cmd === 'E') {
    const extEffect = parseExtendedEffect(paramX, paramY);
    if (extEffect) {
      return { type: 'effect', effect: extEffect };
    }
    return undefined;
  }

  // Handle 0 command - could be arpeggio (0xy where xy != 00) or macro (legacy 0xx)
  if (cmd === '0') {
    // If both nibbles are non-zero, it's arpeggio
    if (paramX !== 0 || paramY !== 0) {
      return {
        type: 'effect',
        effect: {
          type: 'arpeggio',
          paramX,
          paramY
        }
      };
    }
    // 000 is a no-op
    return undefined;
  }

  // Handle other effect commands
  const effectType = effectMap[cmd];
  if (effectType) {
    return {
      type: 'effect',
      effect: {
        type: effectType,
        paramX,
        paramY
      }
    };
  }

  // Legacy: 1-3 without any other match could be macro (for backward compat)
  // This handles the old format where 1xx, 2xx, 3xx were macros
  const legacyMacroIndex = parseInt(cmd, 16);
  if (legacyMacroIndex >= 1 && legacyMacroIndex <= 3) {
    // Check if it looks like a macro value (just a hex number)
    // Effects 1xx, 2xx, 3xx are now portamento/toneporta, so we return effect
    // unless explicitly prefixed with M
    return {
      type: 'effect',
      effect: {
        type: effectMap[cmd] as EffectType,
        paramX,
        paramY
      }
    };
  }

  return undefined;
}

/**
 * The inverse of `parseTrackerNoteSymbol`: a MIDI note as the two-character
 * name plus octave the pattern columns display (`C-4`, `F#3`).
 *
 * Octave numbering matches `parseTrackerNoteSymbol`, so the two round-trip.
 */
export function midiToTrackerNote(midi: number): string {
  const names = [
    'C-', 'C#', 'D-', 'D#', 'E-', 'F-',
    'F#', 'G-', 'G#', 'A-', 'A#', 'B-',
  ];
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const name = names[clamped % 12] ?? 'C-';
  const octave = Math.floor(clamped / 12) - 1;
  return `${name}${octave}`;
}
