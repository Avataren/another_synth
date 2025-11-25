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
  | undefined;

/**
 * Normalize effect command characters
 */
function normalizeMacroChars(macro?: string): [string, string, string] {
  const clean = (macro ?? '').toUpperCase();
  const chars: [string, string, string] = ['.', '.', '.'];
  // Allow 0-3 for macros or F for effect commands
  if (/^[0-3F]$/.test(clean[0] ?? '')) chars[0] = clean[0] as string;
  if (/^[0-9A-F]$/.test(clean[1] ?? '')) chars[1] = clean[1] as string;
  if (/^[0-9A-F]$/.test(clean[2] ?? '')) chars[2] = clean[2] as string;
  return chars;
}

/**
 * Parse effect command field
 * Supports:
 * - 0-3XX: Macro commands (index 0-3, value 00-FF normalized to 0-1)
 * - F01-F1F: Speed commands (value 1-31, where 6 is normal)
 * - F20-FF: Tempo commands (value 32-255 BPM)
 */
export function parseEffectCommand(macro?: string): EffectCommandResult {
  const chars = normalizeMacroChars(macro);
  if (chars[0] === '.') return undefined;

  // Check for F command (speed/tempo)
  if (chars[0] === 'F') {
    const valueHex = `${chars[1] === '.' ? '0' : chars[1]}${chars[2] === '.' ? '0' : chars[2]}`;
    const value = Number.parseInt(valueHex, 16);
    if (!Number.isFinite(value)) return undefined;

    // F01-F1F: Speed command (1-31)
    if (value >= 0x01 && value <= 0x1f) {
      return { type: 'speed', speed: value };
    }

    // F20-FF: Tempo command (32-255)
    if (value >= 0x20 && value <= 0xff) {
      return { type: 'tempo', bpm: value };
    }

    // F00 or out of range: ignore
    return undefined;
  }

  // Regular macro command (0-3)
  const macroIndex = parseInt(chars[0], 16);
  if (!Number.isFinite(macroIndex) || macroIndex < 0 || macroIndex > 3) return undefined;
  const valueHex = `${chars[1] === '.' ? '0' : chars[1]}${chars[2] === '.' ? '0' : chars[2]}`;
  const raw = Number.parseInt(valueHex, 16);
  if (!Number.isFinite(raw)) return undefined;
  const clamped = Math.max(0, Math.min(255, raw));
  return { type: 'macro', index: macroIndex, value: clamped / 255 };
}
