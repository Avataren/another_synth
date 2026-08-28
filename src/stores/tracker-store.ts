import { defineStore } from 'pinia';
import { uid } from 'quasar';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';
import type { Patch } from 'src/audio/types/preset-types';
import {
  DEFAULT_MODULE_FORMAT,
  type ModuleFormat,
} from '../../packages/tracker-playback/src/types';

export type { ModuleFormat };

export const SLOTS_PER_PAGE = 5;
export const TOTAL_PAGES = 7;
export const TOTAL_SLOTS = SLOTS_PER_PAGE * TOTAL_PAGES; // 35 slots

export interface InstrumentSlot {
  slot: number;
  bankId?: string | undefined;
  bankName: string;
  patchId?: string | undefined;
  patchName: string;
  instrumentName: string;
  source?: 'system' | 'user' | 'song' | undefined;
  /** Mixer volume for this instrument (0-2, default 1.0) */
  volume?: number;
  /** Type of instrument: synth uses full WASM engine, mod uses lightweight Web Audio playback */
  instrumentType?: 'synth' | 'mod' | undefined;
}

interface SongMeta {
  title: string;
  author: string;
  bpm: number;
}

export const DEFAULT_PATTERN_ROWS = 64;
export const MIN_PATTERN_ROWS = 1;
/** FastTracker 2's per-pattern maximum. */
export const MAX_PATTERN_ROWS = 256;

export function clampPatternRows(rows: number | undefined | null): number {
  if (!Number.isFinite(rows as number)) return DEFAULT_PATTERN_ROWS;
  return Math.max(MIN_PATTERN_ROWS, Math.min(MAX_PATTERN_ROWS, Math.round(rows as number)));
}

export interface TrackerPattern {
  id: string;
  name: string;
  /**
   * Row count for this pattern. XM (and IT) allow this to vary per pattern,
   * so it lives here rather than on the song. Songs saved before v3 have it
   * backfilled from the old song-level `patternRows` on load.
   */
  rows: number;
  tracks: TrackerTrackData[];
}

interface TrackerSnapshot {
  currentSong: SongMeta;
  moduleFormat: ModuleFormat;
  defaultPatternRows: number;
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
  /** Which tracker's playback semantics this song follows. */
  moduleFormat: ModuleFormat;
  /**
   * Row count applied to newly created patterns. Existing patterns carry
   * their own `rows`; this is only a seed for new ones.
   */
  defaultPatternRows: number;
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
    entries: [],
    interpolations: []
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

function normalizeInstrumentSlots(slots: InstrumentSlot[] | undefined | null): InstrumentSlot[] {
  const normalized = createDefaultInstrumentSlots();
  if (!Array.isArray(slots) || slots.length === 0) {
    return normalized;
  }

  const limit = Math.min(slots.length, TOTAL_SLOTS);
  for (let i = 0; i < limit; i += 1) {
    const slot = slots[i];
    if (!slot) continue;
    normalized[i] = {
      ...normalized[i],
      ...slot,
      slot: slot.slot ?? i + 1
    };
  }

  return normalized;
}

/**
 * Guess the module format for a v1 song file, which predates the tag.
 *
 * Defaulting every legacy file to 'protracker' would be wrong: it would later
 * apply Amiga period clamping, LRRL panning and ProTracker effect quirks to
 * songs hand-authored in this tracker. A MOD import is identifiable, though --
 * it is the only thing that stamps `instrumentType: 'mod'` onto slots (see
 * mod-import.ts) -- so key off that and treat everything else as native.
 */
function inferLegacyModuleFormat(slots: InstrumentSlot[] | undefined | null): ModuleFormat {
  if (!Array.isArray(slots)) return DEFAULT_MODULE_FORMAT;
  const hasModInstrument = slots.some((slot) => slot?.instrumentType === 'mod');
  return hasModInstrument ? 'protracker' : DEFAULT_MODULE_FORMAT;
}

function createDefaultPattern(rows: number = DEFAULT_PATTERN_ROWS): TrackerPattern {
  return {
    id: uid(),
    name: 'Pattern 1',
    rows: clampPatternRows(rows),
    tracks: createDefaultTracks()
  };
}

/**
 * Backfill `rows` on patterns loaded from a pre-v3 song file, where the row
 * count lived on the song rather than the pattern.
 */
function normalizePatternRows(
  patterns: TrackerPattern[],
  legacySongRows: number
): TrackerPattern[] {
  return patterns.map((pattern) => ({
    ...pattern,
    rows: clampPatternRows(pattern.rows ?? legacySongRows)
  }));
}

/**
 * Song-file schema versions.
 *
 * v1: original format, no `moduleFormat` field.
 * v2: adds `data.moduleFormat`.
 * v3: row count moves onto each pattern (`patterns[].rows`); the song-level
 *     `patternRows` is retained only as the seed for newly created patterns.
 *
 * The reader accepts every version in this range; the writer always emits
 * `CURRENT_SONG_FILE_VERSION`.
 */
export type TrackerSongFileVersion = 1 | 2 | 3;
export const CURRENT_SONG_FILE_VERSION = 3;

export interface TrackerSongFile {
  version: TrackerSongFileVersion;
  data: {
    currentSong: SongMeta;
    /** Absent in v1 files; inferred on load. See `inferLegacyModuleFormat`. */
    moduleFormat?: ModuleFormat;
    /**
     * Pre-v3: the row count for every pattern in the song.
     * v3+: only the default applied to newly created patterns. Per-pattern
     * counts live on `patterns[].rows`.
     */
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
      moduleFormat: DEFAULT_MODULE_FORMAT,
      baseOctave: 4,
      defaultPatternRows: DEFAULT_PATTERN_ROWS,
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
    /**
     * Row count of the pattern currently being edited. This is what the grid,
     * navigation and selection should size themselves against -- not the
     * song-level default, which only seeds new patterns.
     */
    currentPatternRows(): number {
      const pattern = this.patterns.find(p => p.id === this.currentPatternId);
      return clampPatternRows(pattern?.rows ?? this.defaultPatternRows);
    },
    /** Row count for a specific pattern, falling back to the song default. */
    rowsForPattern(): (patternId: string | null | undefined) => number {
      return (patternId) => {
        const pattern = this.patterns.find(p => p.id === patternId);
        return clampPatternRows(pattern?.rows ?? this.defaultPatternRows);
      };
    },
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
        moduleFormat: this.moduleFormat,
        defaultPatternRows: this.defaultPatternRows,
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
      this.moduleFormat = snapshot.moduleFormat ?? DEFAULT_MODULE_FORMAT;
      this.defaultPatternRows = clampPatternRows(snapshot.defaultPatternRows);
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

      const slots = normalizeInstrumentSlots(snapshot.instrumentSlots);
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

    /** Reset to a new empty song */
    resetToNewSong() {
      const defaultPattern = createDefaultPattern();
      this.currentSong = {
        title: 'Untitled song',
        author: 'Unknown',
        bpm: 120
      };
      this.moduleFormat = DEFAULT_MODULE_FORMAT;
      this.baseOctave = 4;
      this.defaultPatternRows = DEFAULT_PATTERN_ROWS;
      this.stepSize = 1;
      this.patterns = [defaultPattern];
      this.sequence = [defaultPattern.id];
      this.currentPatternId = defaultPattern.id;
      this.instrumentSlots = createDefaultInstrumentSlots();
      this.activeInstrumentId = null;
      this.currentInstrumentPage = 0;
      this.songPatches = {};
      this.editingSlot = null;
      this.undoStack = [];
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
    removeTrack(_trackIndex: number): boolean {
      const minTracks = 1;
      if (!this.patterns.length) return false;
      const currentCount = this.patterns[0]?.tracks.length ?? 0;
      if (currentCount <= minTracks) return false;
      const idx = currentCount - 1; // always remove the rightmost track

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
        this.instrumentSlots = normalizeInstrumentSlots(this.instrumentSlots ?? []);
      }
    },
    createPattern() {
      const newPattern: TrackerPattern = {
        id: uid(),
        name: `Pattern ${this.patterns.length + 1}`,
        rows: clampPatternRows(this.defaultPatternRows),
        tracks: createDefaultTracks()
      };
      this.patterns.push(newPattern);
      return newPattern.id;
    },
    /**
     * Set the row count of one pattern (defaults to the current one).
     *
     * Also updates `defaultPatternRows` so subsequently created patterns
     * inherit the count the user just chose, which matches how the single
     * song-level control behaved before per-pattern lengths existed.
     */
    setPatternRows(rows: number, patternId?: string) {
      const targetId = patternId ?? this.currentPatternId;
      const pattern = this.patterns.find(p => p.id === targetId);
      if (!pattern) return;
      const clamped = clampPatternRows(rows);
      pattern.rows = clamped;
      this.defaultPatternRows = clamped;
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
    setInstrumentName(slotNumber: number, name: string) {
      const slot = this.instrumentSlots.find((s) => s.slot === slotNumber);
      if (!slot) return;
      slot.instrumentName = name?.trim() ?? '';
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

      // Only update slot metadata if values actually changed
      // This prevents triggering watchers unnecessarily
      const newPatchId = patch.metadata.id;
      const newPatchName = patch.metadata.name ?? 'Untitled';

      if (slot.patchId !== newPatchId) {
        slot.patchId = newPatchId;
      }
      if (slot.patchName !== newPatchName) {
        slot.patchName = newPatchName;
      }
      if (!slot.instrumentName) {
        slot.instrumentName = newPatchName;
      }
      if (slot.source !== 'song') {
        slot.source = 'song';
      }
    },
    /** Assign a patch to a slot (copies it to song patches) */
    assignPatchToSlot(slotNumber: number, patch: Patch, bankName: string) {
      if (!patch.metadata?.id) return;

      const slot = this.instrumentSlots.find(s => s.slot === slotNumber);
      const previousPatchId = slot?.patchId;

      // Deep copy the patch to song patches
      const patchCopy = JSON.parse(JSON.stringify(patch)) as Patch;
      this.songPatches[patchCopy.metadata.id] = patchCopy;

      // Update the slot
      if (slot) {
        const patchChanged = slot.patchId !== patchCopy.metadata.id;
        slot.patchId = patchCopy.metadata.id;
        slot.patchName = patchCopy.metadata.name ?? 'Untitled';
        slot.bankName = bankName;
        if (patchChanged || !slot.instrumentName) {
          slot.instrumentName = patchCopy.metadata.name ?? 'Untitled';
        }
        slot.source = 'song';
      }

      // If the slot previously pointed at a different patch that no other
      // slot uses anymore, remove that orphaned patch from songPatches so
      // the song file stays in-sync with the instrument list.
      if (previousPatchId && previousPatchId !== patchCopy.metadata.id) {
        const stillUsed = this.instrumentSlots.some(
          s => s.patchId === previousPatchId
        );
        if (!stillUsed) {
          delete this.songPatches[previousPatchId];
        }
      }
    },
    /** Set the mixer volume for an instrument slot */
    setSlotVolume(slotNumber: number, volume: number) {
      const slot = this.instrumentSlots.find(s => s.slot === slotNumber);
      if (slot) {
        slot.volume = Math.max(0, Math.min(2, volume));
      }
    },
    serializeSong(): TrackerSongFile {
      // Only persist patches that are actually referenced by at least one
      // instrument slot. This keeps the song file from accumulating old
      // swapped-out patches (and their audio assets) over time.
      const usedPatchIds = new Set(
        this.instrumentSlots
          .map((slot) => slot.patchId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      );
      const filteredSongPatches: Record<string, Patch> = {};
      for (const patchId of usedPatchIds) {
        const patch = this.songPatches[patchId];
        if (patch) {
          filteredSongPatches[patchId] = JSON.parse(JSON.stringify(patch));
        }
      }

      const data: TrackerSongFile['data'] = {
        currentSong: { ...this.currentSong },
        moduleFormat: this.moduleFormat,
        patternRows: this.defaultPatternRows,
        stepSize: this.stepSize,
        patterns: JSON.parse(JSON.stringify(this.patterns)),
        sequence: [...this.sequence],
        currentPatternId: this.currentPatternId,
        instrumentSlots: JSON.parse(JSON.stringify(this.instrumentSlots)),
        activeInstrumentId: this.activeInstrumentId,
        currentInstrumentPage: this.currentInstrumentPage,
        songPatches: filteredSongPatches
      };
      return { version: CURRENT_SONG_FILE_VERSION, data };
    },
    loadSongFile(file: TrackerSongFile) {
      if (!file || !file.data) return;
      if (file.version !== 1 && file.version !== 2 && file.version !== 3) return;
      const data = file.data;

      this.currentSong = {
        title: data.currentSong?.title ?? 'Untitled song',
        author: data.currentSong?.author ?? 'Unknown',
        bpm: data.currentSong?.bpm ?? 120
      };
      // v1 files predate the tag, so fall back to inferring it from the slots.
      this.moduleFormat = data.moduleFormat ?? inferLegacyModuleFormat(data.instrumentSlots);
      const legacySongRows = clampPatternRows(data.patternRows);
      this.defaultPatternRows = legacySongRows;
      this.stepSize = Number.isFinite(data.stepSize) ? data.stepSize : 1;

      // Pre-v3 files have no per-pattern `rows`; backfill from the song-level
      // value so an old song keeps exactly the shape it was saved with.
      const patterns = Array.isArray(data.patterns) && data.patterns.length > 0
        ? normalizePatternRows(data.patterns, legacySongRows)
        : [createDefaultPattern(legacySongRows)];
      this.patterns = patterns;

      const patternIds = new Set(this.patterns.map((p) => p.id));
      const sequence = (data.sequence ?? []).filter((id) => patternIds.has(id));
      const firstPatternId = this.patterns[0]?.id;
      this.sequence = sequence.length > 0 ? sequence : firstPatternId ? [firstPatternId] : [];

      this.currentPatternId = patternIds.has(data.currentPatternId ?? '')
        ? data.currentPatternId
        : this.sequence[0] ?? this.patterns[0]?.id ?? null;

      const slots = normalizeInstrumentSlots(data.instrumentSlots);
      this.instrumentSlots = slots.map((slot, idx) => {
        const mapped: InstrumentSlot = {
          slot: slot?.slot ?? idx + 1,
          bankId: slot?.bankId,
          bankName: slot?.bankName ?? '',
          patchId: slot?.patchId,
          patchName: slot?.patchName ?? '',
          instrumentName: slot?.instrumentName ?? '',
          source: slot?.source,
          instrumentType: slot?.instrumentType
        };
        if (slot?.volume !== undefined) {
          mapped.volume = slot.volume;
        }
        return mapped;
      });

      this.activeInstrumentId = data.activeInstrumentId ?? null;
      this.currentInstrumentPage = data.currentInstrumentPage ?? 0;

      // Only keep song patches that are actually referenced by at least one
      // instrument slot. Older song files may contain orphaned patches that
      // no longer correspond to any slot; skipping them keeps memory usage
      // and file size aligned with the visible instrument list.
      const incomingSongPatches = data.songPatches ?? {};
      const usedPatchIds = new Set(
        this.instrumentSlots
          .map((slot) => slot.patchId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      );
      const filteredSongPatches: Record<string, Patch> = {};
      for (const patchId of usedPatchIds) {
        const patch = incomingSongPatches[patchId];
        if (patch) {
          filteredSongPatches[patchId] = JSON.parse(JSON.stringify(patch));
        }
      }
      this.songPatches = filteredSongPatches;
      this.editingSlot = null;
    }
  }
});
