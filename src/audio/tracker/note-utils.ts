import type { EffectCommand, EffectType, ExtendedEffectSubtype } from '../../../packages/tracker-playback/src/types';

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
 * Parse extended effects (Exy)
 */
function parseExtendedEffect(x: number, y: number): EffectCommand | undefined {
  const subtypeMap: Record<number, ExtendedEffectSubtype> = {
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
    0xE: 'patDelay'
  };

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
    retrigger: 'extEffect',
    fineVolUp: 'volSlide',
    fineVolDown: 'volSlide',
    noteCut: 'noteCut',
    noteDelay: 'noteDelay',
    patDelay: 'patDelay'
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
 * - Macro commands: M0xx-M3xx (explicit macro prefix) - macro index 0-3, value 00-FF
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
    'P': 'panSlide',
    'R': 'retrigVol',
    'T': 'tremor',
    'U': 'fineVibrato'
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
    return undefined;
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
