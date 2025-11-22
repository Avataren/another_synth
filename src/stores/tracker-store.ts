import { defineStore } from 'pinia';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

export const SLOTS_PER_PAGE = 5;
export const TOTAL_PAGES = 5;
export const TOTAL_SLOTS = SLOTS_PER_PAGE * TOTAL_PAGES; // 25 slots

export interface InstrumentSlot {
  slot: number;
  bankId?: string | undefined;
  bankName: string;
  patchId?: string | undefined;
  patchName: string;
  instrumentName: string;
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
  currentInstrumentPage: number;
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

function createDefaultInstrumentSlots(): InstrumentSlot[] {
  return Array.from({ length: TOTAL_SLOTS }, (_, idx) => ({
    slot: idx + 1,
    bankName: '',
    patchName: '',
    instrumentName: '',
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
    instrumentSlots: createDefaultInstrumentSlots(),
    activeInstrumentId: null,
    currentInstrumentPage: 0
  }),
  getters: {
    currentPageSlots(): InstrumentSlot[] {
      const start = this.currentInstrumentPage * SLOTS_PER_PAGE;
      return this.instrumentSlots.slice(start, start + SLOTS_PER_PAGE);
    }
  },
  actions: {
    initializeIfNeeded() {
      if (!this.tracks || this.tracks.length === 0) {
        this.tracks = createDefaultTracks();
      }
      if (!this.instrumentSlots || this.instrumentSlots.length !== TOTAL_SLOTS) {
        this.instrumentSlots = createDefaultInstrumentSlots();
      }
    },
    setActiveInstrument(id: string | null) {
      this.activeInstrumentId = id;
    },
    setInstrumentPage(page: number) {
      if (page >= 0 && page < TOTAL_PAGES) {
        this.currentInstrumentPage = page;
      }
    },
    clearSlot(slotNumber: number) {
      const slot = this.instrumentSlots.find(s => s.slot === slotNumber);
      if (slot) {
        slot.patchId = undefined;
        slot.patchName = '';
        slot.bankId = undefined;
        slot.bankName = '';
        slot.instrumentName = '';
        slot.source = undefined;
      }
    }
  }
});
