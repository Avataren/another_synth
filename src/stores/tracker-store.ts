import { defineStore } from 'pinia';
import { uid } from 'quasar';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';
import type { Patch } from 'src/audio/types/preset-types';

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
  source?: 'system' | 'user' | 'song' | undefined;
}

interface SongMeta {
  title: string;
  author: string;
  bpm: number;
}

export interface TrackerPattern {
  id: string;
  name: string;
  tracks: TrackerTrackData[];
}

interface TrackerSnapshot {
  currentSong: SongMeta;
  patternRows: number;
  stepSize: number;
  baseOctave: number;
  patterns: TrackerPattern[];
  sequence: string[];
  currentPatternId: string | null;
  instrumentSlots: InstrumentSlot[];
  activeInstrumentId: string | null;
  currentInstrumentPage: number;
  songPatches: Record<string, Patch>;
}

interface TrackerStoreState {
  currentSong: SongMeta;
  patternRows: number;
  stepSize: number;
  baseOctave: number;
  patterns: TrackerPattern[];
  sequence: string[];
  currentPatternId: string | null;
  instrumentSlots: InstrumentSlot[];
  activeInstrumentId: string | null;
  currentInstrumentPage: number;
  /** Patches owned by this song (copies from banks, or new patches) */
  songPatches: Record<string, Patch>;
  /** Slot number currently being edited in the synth page, or null */
  editingSlot: number | null;
  /** Undo history stack (oldest at index 0) */
  undoStack: TrackerSnapshot[];
  /** Redo history stack */
  redoStack: TrackerSnapshot[];
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

function createDefaultPattern(): TrackerPattern {
  return {
    id: uid(),
    name: 'Pattern 1',
    tracks: createDefaultTracks()
  };
}

export interface TrackerSongFile {
  version: 1;
  data: {
    currentSong: SongMeta;
    patternRows: number;
    stepSize: number;
    patterns: TrackerPattern[];
    sequence: string[];
    currentPatternId: string | null;
    instrumentSlots: InstrumentSlot[];
    activeInstrumentId: string | null;
    currentInstrumentPage: number;
    songPatches: Record<string, Patch>;
  };
}

export const useTrackerStore = defineStore('trackerStore', {
  state: (): TrackerStoreState => {
    const defaultPattern = createDefaultPattern();
    return {
      currentSong: {
        title: 'Untitled song',
        author: 'Unknown',
        bpm: 120
      },
      baseOctave: 4,
      patternRows: 64,
      stepSize: 1,
      patterns: [defaultPattern],
      sequence: [defaultPattern.id],
      currentPatternId: defaultPattern.id,
      instrumentSlots: createDefaultInstrumentSlots(),
      activeInstrumentId: null,
      currentInstrumentPage: 0,
      songPatches: {},
      editingSlot: null,
      undoStack: [],
      redoStack: []
    };
  },
  getters: {
    currentPageSlots(): InstrumentSlot[] {
      const start = this.currentInstrumentPage * SLOTS_PER_PAGE;
      return this.instrumentSlots.slice(start, start + SLOTS_PER_PAGE);
    },
    /** Get patch for a slot from song patches */
    getPatchForSlot(): (slotNumber: number) => Patch | undefined {
      return (slotNumber: number) => {
        const slot = this.instrumentSlots.find(s => s.slot === slotNumber);
        if (!slot?.patchId) return undefined;
        return this.songPatches[slot.patchId];
      };
    },
    /** Check if we're currently editing a song patch */
    isEditingSongPatch(): boolean {
      return this.editingSlot !== null;
    },
    currentPattern(): TrackerPattern | undefined {
      return this.patterns.find(p => p.id === this.currentPatternId);
    }
  },
  actions: {
    /** Create a deep snapshot of the current tracker song state (for undo/redo). */
    createSnapshot(): TrackerSnapshot {
      return {
        currentSong: { ...this.currentSong },
        patternRows: this.patternRows,
        stepSize: this.stepSize,
        baseOctave: this.baseOctave,
        patterns: JSON.parse(JSON.stringify(this.patterns)),
        sequence: [...this.sequence],
        currentPatternId: this.currentPatternId,
        instrumentSlots: JSON.parse(JSON.stringify(this.instrumentSlots)),
        activeInstrumentId: this.activeInstrumentId,
        currentInstrumentPage: this.currentInstrumentPage,
        songPatches: JSON.parse(JSON.stringify(this.songPatches))
      };
    },
    /** Apply a snapshot back into the store state. */
    applySnapshot(snapshot: TrackerSnapshot) {
      this.currentSong = { ...snapshot.currentSong };
      this.patternRows = snapshot.patternRows;
      this.stepSize = snapshot.stepSize;
      this.baseOctave = snapshot.baseOctave;

      this.patterns = JSON.parse(JSON.stringify(snapshot.patterns));

      const patternIds = new Set(this.patterns.map((p) => p.id));
      const sequence = (snapshot.sequence ?? []).filter((id) => patternIds.has(id));
      const firstPatternId = this.patterns[0]?.id;
      this.sequence = sequence.length > 0 ? sequence : firstPatternId ? [firstPatternId] : [];

      this.currentPatternId = patternIds.has(snapshot.currentPatternId ?? '')
        ? snapshot.currentPatternId
        : this.sequence[0] ?? this.patterns[0]?.id ?? null;

      const slots =
        Array.isArray(snapshot.instrumentSlots) && snapshot.instrumentSlots.length === TOTAL_SLOTS
          ? snapshot.instrumentSlots
          : createDefaultInstrumentSlots();
      this.instrumentSlots = JSON.parse(JSON.stringify(slots));

      this.activeInstrumentId = snapshot.activeInstrumentId ?? null;
      this.currentInstrumentPage = snapshot.currentInstrumentPage ?? 0;
      this.songPatches = JSON.parse(JSON.stringify(snapshot.songPatches ?? {}));

      // Editing slot is only meaningful while on the patch page; reset on snapshot apply.
      this.editingSlot = null;
    },
    /** Push the current state onto the undo stack and clear redo history. */
    pushHistory() {
      const snapshot = this.createSnapshot();
      this.undoStack.push(snapshot);
      const MAX_HISTORY = 100;
      if (this.undoStack.length > MAX_HISTORY) {
        this.undoStack.shift();
      }
      this.redoStack = [];
    },
    undo() {
      if (this.undoStack.length === 0) return;
      const snapshot = this.undoStack.pop() as TrackerSnapshot;
      const current = this.createSnapshot();
      this.redoStack.push(current);
      this.applySnapshot(snapshot);
    },
    redo() {
      if (this.redoStack.length === 0) return;
      const snapshot = this.redoStack.pop() as TrackerSnapshot;
      const current = this.createSnapshot();
      this.undoStack.push(current);
      this.applySnapshot(snapshot);
    },
    setBaseOctave(octave: number) {
      const clamped = Math.max(0, Math.min(8, Math.round(octave)));
      this.baseOctave = clamped;
    },
    addTrack(): boolean {
      const maxTracks = 32;
      if (!this.patterns.length) return false;
      const currentCount = this.patterns[0]?.tracks.length ?? 0;
      if (currentCount >= maxTracks) return false;

      const makeTrack = (idx: number): TrackerTrackData => ({
        id: `T${(idx + 1).toString().padStart(2, '0')}`,
        name: `Track ${idx + 1}`,
        color: DEFAULT_TRACK_COLORS[idx % DEFAULT_TRACK_COLORS.length] ?? '#4df2c5',
        entries: []
      });

      this.patterns.forEach((pattern) => {
        const nextIndex = pattern.tracks.length;
        pattern.tracks.push(makeTrack(nextIndex));
      });

      return true;
    },
    removeTrack(trackIndex: number): boolean {
      const minTracks = 1;
      if (!this.patterns.length) return false;
      const currentCount = this.patterns[0]?.tracks.length ?? 0;
      if (currentCount <= minTracks) return false;
      const idx = Math.max(0, Math.min(currentCount - 1, trackIndex));

      this.patterns.forEach((pattern) => {
        pattern.tracks = pattern.tracks
          .filter((_, i) => i !== idx)
          .map((track, i) => ({
            ...track,
            id: `T${(i + 1).toString().padStart(2, '0')}`,
            name: `Track ${i + 1}`
          }));
      });

      return true;
    },
    initializeIfNeeded() {
      if (!this.patterns || this.patterns.length === 0) {
        const defaultPattern = createDefaultPattern();
        this.patterns = [defaultPattern];
        this.sequence = [defaultPattern.id];
        this.currentPatternId = defaultPattern.id;
      }
      if (!this.instrumentSlots || this.instrumentSlots.length !== TOTAL_SLOTS) {
        this.instrumentSlots = createDefaultInstrumentSlots();
      }
    },
    createPattern() {
      const newPattern: TrackerPattern = {
        id: uid(),
        name: `Pattern ${this.patterns.length + 1}`,
        tracks: createDefaultTracks()
      };
      this.patterns.push(newPattern);
      return newPattern.id;
    },
    deletePattern(patternId: string) {
      if (this.patterns.length <= 1) {
        // eslint-disable-next-line no-console
        console.warn('Cannot delete the last pattern');
        return;
      }
      this.patterns = this.patterns.filter(p => p.id !== patternId);
      this.sequence = this.sequence.filter(id => id !== patternId);
      if (this.currentPatternId === patternId) {
        this.currentPatternId = this.patterns[0]?.id ?? null;
      }
    },
    setCurrentPatternId(patternId: string) {
      if (this.patterns.some(p => p.id === patternId)) {
        this.currentPatternId = patternId;
      }
    },
    addPatternToSequence(patternId: string) {
      this.sequence.push(patternId);
    },
    removePatternFromSequence(index: number) {
      if (index >= 0 && index < this.sequence.length) {
        this.sequence.splice(index, 1);
      }
    },
    setPatternName(patternId: string, name: string) {
      const pattern = this.patterns.find(p => p.id === patternId);
      if (pattern) {
        pattern.name = name;
      }
    },
    moveSequenceItem(fromIndex: number, toIndex: number) {
      if (
        fromIndex < 0 ||
        fromIndex >= this.sequence.length ||
        toIndex < 0 ||
        toIndex >= this.sequence.length
      ) {
        return;
      }
      const [item] = this.sequence.splice(fromIndex, 1);
      if (item !== undefined) {
        this.sequence.splice(toIndex, 0, item);
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
        // Remove patch from song patches if no other slot uses it
        if (slot.patchId) {
          const otherSlotsUsingPatch = this.instrumentSlots.filter(
            s => s.slot !== slotNumber && s.patchId === slot.patchId
          );
          if (otherSlotsUsingPatch.length === 0) {
            delete this.songPatches[slot.patchId];
          }
        }
        slot.patchId = undefined;
        slot.patchName = '';
        slot.bankId = undefined;
        slot.bankName = '';
        slot.instrumentName = '';
        slot.source = undefined;
      }
    },
    /** Add or update a patch in the song's patch library */
    setSongPatch(patch: Patch) {
      if (!patch.metadata?.id) return;
      this.songPatches[patch.metadata.id] = JSON.parse(JSON.stringify(patch));
    },
    /** Get a patch from the song's library */
    getSongPatch(patchId: string): Patch | undefined {
      return this.songPatches[patchId];
    },
    /** Start editing a slot's patch */
    startEditingSlot(slotNumber: number) {
      this.editingSlot = slotNumber;
    },
    /** Stop editing and return to tracker */
    stopEditing() {
      this.editingSlot = null;
    },
    /** Update the patch for the currently editing slot */
    updateEditingPatch(patch: Patch) {
      if (this.editingSlot === null || !patch.metadata?.id) return;

      const slot = this.instrumentSlots.find(s => s.slot === this.editingSlot);
      if (!slot) return;

      // Update song patches
      this.songPatches[patch.metadata.id] = JSON.parse(JSON.stringify(patch));

      // Update slot metadata
      slot.patchId = patch.metadata.id;
      slot.patchName = patch.metadata.name ?? 'Untitled';
      slot.instrumentName = patch.metadata.name ?? 'Untitled';
      slot.source = 'song';
    },
    /** Assign a patch to a slot (copies it to song patches) */
    assignPatchToSlot(slotNumber: number, patch: Patch, bankName: string) {
      if (!patch.metadata?.id) return;

      // Deep copy the patch to song patches
      const patchCopy = JSON.parse(JSON.stringify(patch)) as Patch;
      this.songPatches[patchCopy.metadata.id] = patchCopy;

      // Update the slot
      const slot = this.instrumentSlots.find(s => s.slot === slotNumber);
      if (slot) {
        slot.patchId = patchCopy.metadata.id;
        slot.patchName = patchCopy.metadata.name ?? 'Untitled';
        slot.bankName = bankName;
        slot.instrumentName = patchCopy.metadata.name ?? 'Untitled';
        slot.source = 'song';
      }
    },
    serializeSong(): TrackerSongFile {
      const data: TrackerSongFile['data'] = {
        currentSong: { ...this.currentSong },
        patternRows: this.patternRows,
        stepSize: this.stepSize,
        patterns: JSON.parse(JSON.stringify(this.patterns)),
        sequence: [...this.sequence],
        currentPatternId: this.currentPatternId,
        instrumentSlots: JSON.parse(JSON.stringify(this.instrumentSlots)),
        activeInstrumentId: this.activeInstrumentId,
        currentInstrumentPage: this.currentInstrumentPage,
        songPatches: JSON.parse(JSON.stringify(this.songPatches))
      };
      return { version: 1, data };
    },
    loadSongFile(file: TrackerSongFile) {
      if (!file || file.version !== 1 || !file.data) return;
      const data = file.data;

      this.currentSong = {
        title: data.currentSong?.title ?? 'Untitled song',
        author: data.currentSong?.author ?? 'Unknown',
        bpm: data.currentSong?.bpm ?? 120
      };
      this.patternRows = Number.isFinite(data.patternRows) ? data.patternRows : 64;
      this.stepSize = Number.isFinite(data.stepSize) ? data.stepSize : 1;

      const patterns = Array.isArray(data.patterns) && data.patterns.length > 0
        ? data.patterns
        : [createDefaultPattern()];
      this.patterns = patterns;

      const patternIds = new Set(this.patterns.map((p) => p.id));
      const sequence = (data.sequence ?? []).filter((id) => patternIds.has(id));
      const firstPatternId = this.patterns[0]?.id;
      this.sequence = sequence.length > 0 ? sequence : firstPatternId ? [firstPatternId] : [];

      this.currentPatternId = patternIds.has(data.currentPatternId ?? '')
        ? data.currentPatternId
        : this.sequence[0] ?? this.patterns[0]?.id ?? null;

      const slots =
        Array.isArray(data.instrumentSlots) && data.instrumentSlots.length === TOTAL_SLOTS
          ? data.instrumentSlots
          : createDefaultInstrumentSlots();
      this.instrumentSlots = slots.map((slot, idx) => ({
        slot: slot?.slot ?? idx + 1,
        bankId: slot?.bankId,
        bankName: slot?.bankName ?? '',
        patchId: slot?.patchId,
        patchName: slot?.patchName ?? '',
        instrumentName: slot?.instrumentName ?? '',
        source: slot?.source
      }));

      this.activeInstrumentId = data.activeInstrumentId ?? null;
      this.currentInstrumentPage = data.currentInstrumentPage ?? 0;
      this.songPatches = data.songPatches ?? {};
      this.editingSlot = null;
    }
  }
});
