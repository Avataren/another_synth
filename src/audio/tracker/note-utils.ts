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
  if (normalized === '--' || normalized === '---' || normalized === '###') {
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
