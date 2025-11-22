import { defineStore } from 'pinia';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

export interface InstrumentSlot {
  slot: number;
  bankId?: string | undefined;
  bankName: string;
  patchId?: string | undefined;
  patchName: string;
  instrumentName: string;
  empty?: boolean;
  source?: 'system' | 'user' | undefined;
}

interface SongMeta {
  title: string;
  author: string;
  bpm: number;
}

interface TrackerStoreState {
  currentSong: SongMeta;
  patternRows: number;
  stepSize: number;
  tracks: TrackerTrackData[];
  instrumentSlots: InstrumentSlot[];
  activeInstrumentId: string | null;
}

const DEFAULT_TRACK_COLORS = [
  '#4df2c5',
  '#9da6ff',
  '#ffde7b',
  '#70c2ff',
  '#ff9db5',
  '#8ef5c5',
  '#ffa95e',
  '#b08bff'
];

function createDefaultTracks(): TrackerTrackData[] {
  return Array.from({ length: 8 }, (_, idx) => ({
    id: `T${(idx + 1).toString().padStart(2, '0')}`,
    name: `Track ${idx + 1}`,
    color: DEFAULT_TRACK_COLORS[idx % DEFAULT_TRACK_COLORS.length] ?? '#4df2c5',
    entries: []
  }));
}

export const useTrackerStore = defineStore('trackerStore', {
  state: (): TrackerStoreState => ({
    currentSong: {
      title: 'Untitled song',
      author: 'Unknown',
      bpm: 120
    },
    patternRows: 64,
    stepSize: 1,
    tracks: createDefaultTracks(),
    instrumentSlots: [],
    activeInstrumentId: null
  }),
  actions: {
    initializeIfNeeded() {
      if (!this.tracks || this.tracks.length === 0) {
        this.tracks = createDefaultTracks();
      }
    },
    setActiveInstrument(id: string | null) {
      this.activeInstrumentId = id;
    }
  }
});
