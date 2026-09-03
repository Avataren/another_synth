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
  /**
   * True when this row's velocity came from an XM volume-column set-volume
   * command (0x10-0x50) rather than the sample's default volume.
   *
   * FT2 runs Rxy's tick-0 retrigger count through the volume column *after*
   * its volume handling, and skips the count when that handling consumed the
   * byte -- so an Rxy row that also carries a volume-column volume does not
   * count tick 0 toward its first retrigger. The engine needs to know which
   * kind of volume a row carries to reproduce that, and an imported velocity
   * byte alone cannot: a note with an instrument and no volume column also
   * imports a volume (the sample's default).
   */
  volumeColumnVolume?: boolean;
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
