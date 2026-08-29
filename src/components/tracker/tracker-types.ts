export interface TrackerEntryData {
  row: number;
  note?: string;
  instrument?: string;
  volume?: string;
  macro?: string;
  /** Optional second effect/macro column for the tracker row */
  macro2?: string;
  /**
   * FastTracker 2 volume-column command, as the raw XM byte in hex (0x60-0xFF).
   *
   * Separate from `volume`, which is this tracker's own 00-FF velocity and is
   * what XM's 0x10-0x50 "set volume" range imports to. From 0x60 up the XM
   * volume column holds *commands* (slides, panning, vibrato, tone portamento)
   * that have no velocity meaning, so they need somewhere of their own rather
   * than an overloaded volume byte or a second effect column that a song may
   * already be using.
   */
  volumeCommand?: string;
  /** Optional exact frequency in Hz (for ProTracker MOD imports) */
  frequency?: number;
}

export interface TrackerInterpolationRange {
  startRow: number;
  endRow: number;
  macroIndex: number;
  startValue: number; // normalized 0-1
  endValue: number;   // normalized 0-1
  interpolation: 'linear' | 'exponential';
}

export interface TrackerTrackData {
  id: string;
  name: string;
  color?: string;
  entries: TrackerEntryData[];
  interpolations?: TrackerInterpolationRange[];
}

export interface TrackerSelectionRect {
  rowStart: number;
  rowEnd: number;
  trackStart: number;
  trackEnd: number;
}
