export interface TrackerEntryData {
  row: number;
  note?: string;
  instrument?: string;
  volume?: string;
  effect?: string;
}

export interface TrackerTrackData {
  id: string;
  name: string;
  color?: string;
  entries: TrackerEntryData[];
}
