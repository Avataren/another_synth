export interface TrackerEntryData {
  row: number;
  note?: string;
  instrument?: string;
  volume?: string;
  macro?: string;
}

export interface TrackerTrackData {
  id: string;
  name: string;
  color?: string;
  entries: TrackerEntryData[];
}
