export interface TrackerEntryData {
  row: number;
  note?: string;
  instrument?: string;
  volume?: string;
  macro?: string;
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
