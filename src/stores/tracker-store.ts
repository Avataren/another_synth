import { defineStore } from 'pinia';
import { effectScope, toRaw, watch } from 'vue';
import { uid } from 'quasar';
import type { TrackerEntryData, TrackerTrackData } from 'src/components/tracker/tracker-types';
import type { Patch } from 'src/audio/types/preset-types';
import { clearLoadedSongHash } from 'src/composables/song-identity';
import {
  inferSlotTags,
  isAhxSlot,
  normalizeInstrumentType,
  type InstrumentFormat,
  type InstrumentType,
  type LegacyInstrumentType,
} from 'src/audio/tracker/instrument-types';
import {
  DEFAULT_MODULE_FORMAT,
  TOTAL_SLOTS,
  DEFAULT_SPEED,
  DEFAULT_PATTERN_ROWS,
  MIN_PATTERN_ROWS,
  MAX_PATTERN_ROWS,
  clampPatternRows,
  type ModuleFormat,
  type TrackerPattern,
  type OplInstrumentData,
  type AhxInstrument,
  ahxInstrumentProblem,
  normalizeAhxInstrumentForVersion,
  parseAhx,
  sanitizeAhxInstrument,
  serializeAhxInstrument,
} from '@another-synth/tracker-playback';
import {
  ahxSourceInfo,
  ahxSourceRecordOf,
  recordAhxInstrumentEdit,
  currentAhxSource,
  replaceCurrentAhxBytes,
  setCurrentAhxSource,
  type ReplaceAhxBytesOptions,
} from 'src/audio/tracker/ahx-source';
import {
  AHX_CHANNELS,
  ahxEditRefusal,
  ahxInstrumentBytes,
  allocTrack,
  assignTrack,
  buildAhxFile,
  buildAhxSlots,
  decodeAhxFile,
  docFromSong,
  encodeAhxFile,
  entriesToTrack,
  isBlankTrack,
  projectAhxPatterns,
  projectTracks,
  setTrack,
  tracksEqual,
  type AhxDoc,
  type AhxDocTrack,
  type AhxEditCheck,
  type AhxOpContext,
} from 'src/audio/tracker/ahx-doc';
import { clearAhxEditNotice, reportAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';

export type {
  ModuleFormat,
  TrackerPattern,
  OplInstrumentData,
};
export {
  TOTAL_SLOTS,
  DEFAULT_SPEED,
  DEFAULT_PATTERN_ROWS,
  MIN_PATTERN_ROWS,
  MAX_PATTERN_ROWS,
  clampPatternRows,
};

/**
 * How the instrument panel pages through the slots. Purely a UI concern --
 * the slot count itself is a property of the song model and now lives in
 * the library (see `TOTAL_SLOTS`), so the page count derives from it rather
 * than defining it.
 */
export const SLOTS_PER_PAGE = 5;
export const TOTAL_PAGES = Math.ceil(TOTAL_SLOTS / SLOTS_PER_PAGE); // 26 pages

/** What became of an AHX instrument edit (`updateAhxInstrument`). */
export type AhxEditOutcome = 'applied' | 'kept' | 'rejected';

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
  /**
   * Rendering path: synth = full WASM engine, sampler = lightweight Web Audio
   * sample playback, ahx = the AHX/HVL engine, opl = OPL FM (inactive: no
   * playback path yet). Playback keys on this. Absent on an empty slot.
   */
  instrumentType?: InstrumentType | undefined;
  /**
   * Data lineage: which format's data model the payload follows, and so which
   * editor opens it and which exporter can write it back. Never read on the
   * audio path. Absent on an empty slot.
   */
  instrumentFormat?: InstrumentFormat | undefined;
  /**
   * Raw OPL2/FM instrument data parsed from an S3M AdLib instrument header,
   * preserved for the future OPL playback task (Morten, 2026-09-03):
   * parse and keep, marked inactive -- the slot carries no patchId, so
   * nothing plays it. The future consumer is a DEDICATED WASM OPL core (a
   * small standalone OPL emulator with its own worklet/voice path, not the
   * main WASM synth), and these bytes are kept exactly as the file stores
   * them -- the natural patch format for that core. No mapping layer toward
   * the existing synth's FM primitives is designed here or wanted.
   */
  oplData?: OplInstrumentData;
  /**
   * The AHX instrument this slot lists, exactly as the parser decoded it
   * (envelope, filter/square/vibrato settings, the PList), kept for the AHX
   * instrument editor (Task 5) the way `oplData` is kept for OPL. The whole
   * parsed struct is held rather than a trimmed view: it is a few hundred
   * plain numbers per instrument, and the editor phases need every field.
   *
   * It is the song's instrument, not a copy of it: `updateAhxInstrument`
   * writes an edit here and, in the same call, replaces that instrument in the
   * song the worklets play (`ahx-source`'s recorded edits), so what this holds
   * is what plays. An editable AHX song saves it (`serializeSong` embeds the file
   * built from the slots, `data.ahxFile`, and the Jukebox's snapshot carries it);
   * a song with no doc cannot be saved as a `.cmod` (`handleSaveSongFile`
   * refuses), so an edit to one is a session's. A song file from anywhere can put
   * anything here, so `loadSongFile`
   * only keeps a value that `ahxInstrumentProblem` accepts (in the song's format).
   */
  ahxData?: AhxInstrument;
}

// `OplInstrumentData` is re-exported from the library; see the import above.

/**
 * A slot as it may sit in a saved song: pre-v4 files carry the legacy
 * `'mod'` type and no `instrumentFormat`. `loadSongFile` rewrites it.
 */
export type SerializedInstrumentSlot = Omit<InstrumentSlot, 'instrumentType'> & {
  instrumentType?: LegacyInstrumentType | undefined;
};

interface SongMeta {
  title: string;
  author: string;
  bpm: number;
}

// Row-count limits and the default speed are re-exported from the library;
// see the import above.

// `TrackerPattern` is re-exported from the library; see the import above.

interface TrackerSnapshot {
  currentSong: SongMeta;
  moduleFormat: ModuleFormat;
  initialSpeed: number;
  linearFrequency: boolean;
  amigaLimits: boolean;
  fastVolumeSlides: boolean;
  initialGlobalVolume: number;
  vblankTiming: boolean;
  defaultPatternRows: number;
  stepSize: number;
  baseOctave: number;
  /** Empty for an editable AHX song: the grid is rebuilt from `ahxDoc` on apply. */
  patterns: TrackerPattern[];
  sequence: string[];
  currentPatternId: string | null;
  instrumentSlots: InstrumentSlot[];
  activeInstrumentId: string | null;
  currentInstrumentPage: number;
  songPatches: Record<string, Patch>;
  /** The AHX doc of an editable AHX song (a reference: docs are immutable). */
  ahxDoc?: AhxDoc | null;
}

interface TrackerStoreState {
  currentSong: SongMeta;
  /** Which tracker's playback semantics this song follows. */
  moduleFormat: ModuleFormat;
  /**
   * Ticks per row the song starts at (tracker "speed", the Fxx 01-1F
   * parameter). The tracker default is 6; XM songs commonly declare 3.
   */
  initialSpeed: number;
  /**
   * XM only: whether the module selected the linear frequency table.
   *
   * Carried per song rather than per format -- roughly half of real XM files
   * use the Amiga table instead (4 of the 9 in the local corpus). It selects
   * the pitch model every pitch *effect* is computed in, so losing it plays
   * portamento, vibrato and arpeggio in the wrong period space even though
   * the notes themselves are in tune, the note frequencies having been
   * resolved at import.
   */
  linearFrequency: boolean;
  /**
   * S3M only: the per-file amiga-limits header flag (flags & 0x10), which
   * selects S3M_AMIGA_PROFILE. Same per-file-flag shape as
   * `linearFrequency` and threaded through the same chain (D59); absent
   * means the default 64..32767 period range.
   */
  amigaLimits: boolean;
  /**
   * S3M only: whether the module's volume slides also step on tick 0 --
   * OpenMPT's `SONG_FASTVOLSLIDES` (cwtv 0x1300, or header flag 0x40).
   * Threaded through the same per-file chain as `amigaLimits` (D59).
   */
  fastVolumeSlides: boolean;
  /**
   * The song's initial global volume 0..1 (S3M's header globalVol / 64).
   * Absent/default means full volume.
   */
  initialGlobalVolume: number;
  /**
   * ProTracker only: whether every Fxx command sets the speed (ticks per row)
   * rather than the tempo.
   *
   * VBlank-timed modules have no tempo command -- the replayer runs off the
   * 50 Hz vertical blank -- so an `F20` in one means "48 ticks on this row",
   * not "32 BPM from here on". The file cannot say which it is, so it is
   * detected on import (`usesVBlankTiming`) and carried with the song.
   */
  vblankTiming: boolean;
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
  /**
   * The structure of an editable AHX song (see `ahx-doc`); `null` for every
   * other song, and for an AHX/HVL song that has no doc (it stays read-only).
   * Always a `markRaw` object, replaced (never mutated) by an edit.
   */
  ahxDoc: AhxDoc | null;
  /** Counts every change of `ahxDoc`, including the one that clears it. */
  ahxRevision: number;
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
 * (v1 predates the XM and S3M importers, so 'mod' can only mean MOD here.)
 */
function inferLegacyModuleFormat(
  slots: SerializedInstrumentSlot[] | undefined | null,
): ModuleFormat {
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
 * The `.cmod` format's version. Defined here, not in the library's
 * `song-constants.ts` (which still says 4): the song file is the app's format,
 * and v5 adds what only the app writes (`data.ahxFile`).
 *
 * v1..v4: see the library's `TrackerSongFileVersion`.
 * v5: an editable AHX song carries its file (`data.ahxFile`, base64). Nothing
 *     else changes shape, so every earlier version still loads.
 *
 * The reader accepts every version in `1..CURRENT_SONG_FILE_VERSION`; the
 * writer always emits `CURRENT_SONG_FILE_VERSION`.
 */
export type TrackerSongFileVersion = 1 | 2 | 3 | 4 | 5;
export const CURRENT_SONG_FILE_VERSION: TrackerSongFileVersion = 5;

export interface TrackerSongFile {
  version: TrackerSongFileVersion;
  data: {
    currentSong: SongMeta;
    /** Absent in v1 files; inferred on load. See `inferLegacyModuleFormat`. */
    moduleFormat?: ModuleFormat;
    /**
     * Ticks per row at the start of the song. Optional and additive: files
     * without it use the tracker default of 6, which is what every song saved
     * before this field existed assumed.
     */
    initialSpeed?: number;
    /** XM only; absent means XM's own default, linear. */
    linearFrequency?: boolean;
    /**
     * Whether the module's periods are confined to ProTracker's Amiga range.
     * S3M: absent means ST3's wide default. MOD: absent means ProTracker's
     * own three octaves, so an imported multi-octave module writes `false`
     * here explicitly. See `ProfileOptions.amigaLimits` in the library.
     */
    amigaLimits?: boolean;
    /**
     * S3M only: whether volume slides also step on tick 0. Absent means the
     * ordinary ST3 reading. See `ProfileOptions.fastVolumeSlides`.
     */
    fastVolumeSlides?: boolean;
    /**
     * The song's initial global volume 0..1 (S3M's header globalVol / 64).
     * Absent means full, what every other format declares.
     */
    initialGlobalVolume?: number;
    /** ProTracker only; absent means the usual CIA speed/tempo split. */
    vblankTiming?: boolean;
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
    /**
     * What the writer emits. A pre-v4 file's slots may still hold the legacy
     * `'mod'` type at runtime; the loader reads them through `inferSlotTags`.
     */
    instrumentSlots: InstrumentSlot[];
    activeInstrumentId: string | null;
    currentInstrumentPage: number;
    songPatches: Record<string, Patch>;
    /**
     * v5, editable AHX songs only: the song as an `.ahx` file (`buildAhxFile`,
     * base64). It is the authority on load: the doc, the grid and the
     * instrument slots are rebuilt from it, and the row model and slots written
     * beside it are ignored for such a song. Absent for every other song, and
     * for an AHX song with no editable doc (HVL, or bytes the parser rejects).
     */
    ahxFile?: string;
  };
}

/**
 * What the AHX write-back has reconciled: the raw `entries` array of every
 * (position, channel) cell as it last stood in step with the doc. A cell whose
 * array is another one has been edited (every edit site replaces the array, none
 * mutates it). Not reactive and not state: it is bookkeeping of the watcher,
 * kept per store.
 */
interface AhxSyncCache {
  cells: unknown[][];
  watching: boolean;
  /** What the engine's bytes were last built from (`ahxPublishKey`); `null` when unknown. */
  published: string | null;
}
const ahxSyncCaches = new WeakMap<object, AhxSyncCache>();

function ahxSyncCacheOf(store: { $state: object }): AhxSyncCache {
  const key = toRaw(store.$state);
  let cache = ahxSyncCaches.get(key);
  if (!cache) {
    cache = { cells: [], watching: false, published: null };
    ahxSyncCaches.set(key, cache);
  }
  return cache;
}

/** Which pattern id a saved id was at, as the stable id of that position. */
function stableIdOf(index: number): string {
  return `ahx-pos-${index}`;
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
      initialSpeed: DEFAULT_SPEED,
      linearFrequency: true,
      amigaLimits: false,
      fastVolumeSlides: false,
      initialGlobalVolume: 1.0,
      vblankTiming: false,
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
      redoStack: [],
      ahxDoc: null,
      ahxRevision: 0
    };
  },
  getters: {
    /** The song is an AHX song (editable or not): what the scope and waveform code means. */
    isAhxSong(): boolean {
      return this.moduleFormat === 'ahx';
    },
    /** The song is an AHX song with a doc: its grid is edited and written back to the doc. */
    isAhxEditable(): boolean {
      return this.moduleFormat === 'ahx' && this.ahxDoc !== null;
    },
    /**
     * The song's row model is display only. An HVL song, or an AHX song that
     * has no doc (a saved file without its bytes), is played from its file by
     * the worklet's own engine; the patterns here mirror it for the eye, so an
     * edit to them would never reach the audio. An AHX song with a doc is
     * editable: `isAhxSong` is the question "is it AHX", this is "may I write".
     */
    isReadOnly(): boolean {
      return this.moduleFormat === 'ahx' && this.ahxDoc === null;
    },
    /**
     * Why an AHX step cannot hold what an edit wants to write (`null` when it
     * can, and for every song that is not an editable AHX one). Asked at the
     * top of a handler that can refuse, before its undo snapshot and before
     * the cursor moves; the write-back's safety net asks the same rules.
     */
    ahxRefusal(): (check: AhxEditCheck) => string | null {
      return (check) => (this.ahxDoc === null ? null : ahxEditRefusal(check, this.ahxDoc.trackLength));
    },
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
      // Before anything is read: an edit the watcher has not flushed yet must
      // be in the doc this snapshot keeps, or an undo would lose it.
      this.syncAhxWriteBack();
      const ahxDoc = this.moduleFormat === 'ahx' ? this.ahxDoc : null;
      return {
        currentSong: { ...this.currentSong },
        moduleFormat: this.moduleFormat,
        initialSpeed: this.initialSpeed,
        linearFrequency: this.linearFrequency,
        amigaLimits: this.amigaLimits,
        fastVolumeSlides: this.fastVolumeSlides,
        initialGlobalVolume: this.initialGlobalVolume,
        vblankTiming: this.vblankTiming,
        defaultPatternRows: this.defaultPatternRows,
        stepSize: this.stepSize,
        baseOctave: this.baseOctave,
        // An editable AHX song keeps the doc (a reference: it is immutable) and
        // no grid: up to 129 patterns per keystroke are what the doc replaces,
        // and `applySnapshot` projects them again.
        patterns: ahxDoc ? [] : JSON.parse(JSON.stringify(this.patterns)),
        sequence: [...this.sequence],
        currentPatternId: this.currentPatternId,
        instrumentSlots: JSON.parse(JSON.stringify(this.instrumentSlots)),
        activeInstrumentId: this.activeInstrumentId,
        currentInstrumentPage: this.currentInstrumentPage,
        songPatches: JSON.parse(JSON.stringify(this.songPatches)),
        ahxDoc
      };
    },
    /** Apply a snapshot back into the store state. */
    applySnapshot(snapshot: TrackerSnapshot) {
      this.currentSong = { ...snapshot.currentSong };
      this.moduleFormat = snapshot.moduleFormat ?? DEFAULT_MODULE_FORMAT;
      this.initialSpeed = snapshot.initialSpeed ?? DEFAULT_SPEED;
      this.linearFrequency = snapshot.linearFrequency ?? true;
      this.amigaLimits = snapshot.amigaLimits ?? false;
      this.fastVolumeSlides = snapshot.fastVolumeSlides ?? false;
      this.initialGlobalVolume = snapshot.initialGlobalVolume ?? 1.0;
      this.vblankTiming = snapshot.vblankTiming ?? false;
      this.defaultPatternRows = clampPatternRows(snapshot.defaultPatternRows);
      this.stepSize = snapshot.stepSize;
      this.baseOctave = snapshot.baseOctave;

      // The snapshot's doc (`null` for any other song): the song being applied
      // decides, never the doc that happens to be in the store.
      const ahxDoc = snapshot.moduleFormat === 'ahx' ? snapshot.ahxDoc ?? null : null;
      const previousDoc = this.ahxDoc;
      this.ahxDoc = ahxDoc;
      this.ahxRevision += 1;
      clearAhxEditNotice();
      this.patterns = ahxDoc ? projectAhxPatterns(ahxDoc) : JSON.parse(JSON.stringify(snapshot.patterns));

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

      if (ahxDoc) {
        // The grid is the projection of the doc just set: nothing to write back.
        this.primeAhxWriteBack();
        // The slots have just gone back too, so the recorded instrument edits
        // are stale: start the song's bytes over (a full reload at the next Play).
        // A snapshot of another song than the one whose bytes are current (the
        // stacks are cleared by every load, so this is the belt) is installed as
        // a song change: its header info, notices and preview follow it.
        const sameSong = previousDoc !== null && previousDoc.base === ahxDoc.base && currentAhxSource() !== null;
        this.publishAhxBytes({ resetEdits: true, install: !sameSong });
      } else if (previousDoc !== null && currentAhxSource() !== null) {
        // An AHX song's bytes must not outlive the AHX song on screen.
        setCurrentAhxSource(null);
      }
    },
    /** Push the current state onto the undo stack and clear redo history. */
    pushHistory() {
      // Read-only: nothing can change, so there is nothing to undo to.
      if (this.isReadOnly) return;
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
      // A native song: no module bytes were loaded, so no file hash stands.
      clearLoadedSongHash();
      const defaultPattern = createDefaultPattern();
      this.currentSong = {
        title: 'Untitled song',
        author: 'Unknown',
        bpm: 120
      };
      this.moduleFormat = DEFAULT_MODULE_FORMAT;
      this.initialSpeed = DEFAULT_SPEED;
      this.linearFrequency = true;
      this.amigaLimits = false;
      this.fastVolumeSlides = false;
      this.initialGlobalVolume = 1.0;
      this.vblankTiming = false;
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
      this.ahxDoc = null;
      this.ahxRevision += 1;
      ahxSyncCacheOf(this).cells = [];
      ahxSyncCacheOf(this).published = null;
      clearAhxEditNotice();
    },
    undo() {
      if (this.isReadOnly) return;
      if (this.undoStack.length === 0) return;
      const snapshot = this.undoStack.pop() as TrackerSnapshot;
      const current = this.createSnapshot();
      this.redoStack.push(current);
      this.applySnapshot(snapshot);
    },
    redo() {
      if (this.isReadOnly) return;
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
      // AHX has exactly four channels, editable or not.
      if (this.isAhxSong) return false;
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
      if (this.isAhxSong) return false;
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
      // An AHX song's patterns are its positions: the position ops make them.
      if (this.isAhxSong) return '';
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
      if (this.isAhxSong) return;
      const targetId = patternId ?? this.currentPatternId;
      const pattern = this.patterns.find(p => p.id === targetId);
      if (!pattern) return;
      const clamped = clampPatternRows(rows);
      pattern.rows = clamped;
      this.defaultPatternRows = clamped;
    },
    deletePattern(patternId: string) {
      if (this.isAhxSong) return;
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
      if (this.isAhxSong) return;
      this.sequence.push(patternId);
    },
    removePatternFromSequence(index: number) {
      if (this.isAhxSong) return;
      if (index >= 0 && index < this.sequence.length) {
        this.sequence.splice(index, 1);
      }
    },
    setPatternName(patternId: string, name: string) {
      if (this.isAhxSong) return;
      const pattern = this.patterns.find(p => p.id === patternId);
      if (pattern) {
        pattern.name = name;
      }
    },
    moveSequenceItem(fromIndex: number, toIndex: number) {
      if (this.isAhxSong) return;
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
      const previous = slot.instrumentName;
      slot.instrumentName = name?.trim() ?? '';
      // An AHX slot's name is the instrument's own (the AHX exporter writes
      // `ahxData.name` into the file), so a rename has to reach it too. An
      // unchanged name is not a rename: import seeds `instrumentName` with
      // "Instrument NN" for an unnamed instrument, which the file never had.
      if (isAhxSlot(slot) && slot.ahxData && slot.instrumentName !== previous) {
        slot.ahxData.name = slot.instrumentName;
      }
    },
    clearSlot(slotNumber: number) {
      // An AHX song's instruments are numbered in order: none is cleared here.
      if (this.isAhxSong) return;
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
        slot.instrumentType = undefined;
        slot.instrumentFormat = undefined;
        delete slot.oplData;
        delete slot.ahxData;
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
      // The synth patch editor writes a patch into the slot it edits; an AHX
      // slot has none by design (its instrument is `ahxData`, edited by the AHX
      // editor), and an AHX song's slots are not the synth editor's to change.
      const slot = this.instrumentSlots.find(s => s.slot === slotNumber);
      if (slot && isAhxSlot(slot)) return;
      this.editingSlot = slotNumber;
    },
    /** Stop editing and return to tracker */
    stopEditing() {
      this.editingSlot = null;
    },
    /** Update the patch for the currently editing slot */
    updateEditingPatch(patch: Patch) {
      // Like `assignPatchToSlot`: an AHX song's slots are read-only to the
      // patch editor, and no patch is ever written into an AHX slot (it would
      // give the slot a `patchId` next to its `ahxData`).
      if (this.isAhxSong) return;
      if (this.editingSlot === null || !patch.metadata?.id) return;

      const slot = this.instrumentSlots.find(s => s.slot === this.editingSlot);
      if (!slot || isAhxSlot(slot)) return;

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
      if (this.isAhxSong) return;
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
        // A patch dropped into a slot is the user's own, whatever the slot
        // held before: lineage is native, the type follows the patch.
        slot.instrumentType = normalizeInstrumentType(patchCopy.metadata.instrumentType) ?? 'synth';
        slot.instrumentFormat = 'native';
        delete slot.oplData;
        delete slot.ahxData;
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
    /**
     * Commit an edit of the AHX instrument in `slotNumber`. `next` replaces the
     * slot's `ahxData` and, in the same call, replaces that instrument in the
     * song the worklets play: it is recorded in `ahx-source`, which hands it to
     * the song player and the keyboard preview that already hold the song and to
     * every worklet that loads it later. There is no preview-only copy: the song
     * plays the edited instrument from its next trigger of it (a voice already
     * holding it keeps what its trigger copied and takes PList and envelope
     * changes at once).
     *
     * What the slot holds is what the editor shows and, through `ahx-source`, what
     * plays. An editable AHX song saves it: `serializeSong` embeds the file built
     * from the slots (`data.ahxFile`). A song with no doc (HVL) cannot be saved as a
     * `.cmod` (`handleSaveSongFile` refuses), so an edit to one lasts for the session.
     *
     * The instrument is written in the song's own format (HVL's wider PList
     * entries and command set for an HVL song) and as its version's engine will
     * read it (`normalizeAhxInstrumentForVersion`), so the slot shows what plays.
     *
     * Returns what became of it:
     * - `'applied'`: kept in the slot and recorded, so it is heard;
     * - `'kept'`: kept in the slot only, because no AHX song's bytes are current
     *   (a song loaded from a saved file has none): it cannot be heard;
     * - `'rejected'`: changed nothing, for a slot that is not an AHX slot with an
     *   instrument, or a `next` that is not a valid instrument for the song's
     *   format (`ahxInstrumentProblem`). The name is kept: it lives in the
     *   song's string table, not in the instrument.
     */
    updateAhxInstrument(slotNumber: number, next: AhxInstrument): AhxEditOutcome {
      const slot = this.instrumentSlots.find(s => s.slot === slotNumber);
      if (!slot || !isAhxSlot(slot) || !slot.ahxData) return 'rejected';
      const info = ahxSourceInfo.value;
      const format = info?.format ?? 'ahx';
      const clean = sanitizeAhxInstrument({ ...next, name: slot.ahxData.name }, format);
      if (!clean) return 'rejected';
      const played = normalizeAhxInstrumentForVersion(clean, format, info?.version ?? 1);
      slot.ahxData = played;
      return recordAhxInstrumentEdit(slotNumber, serializeAhxInstrument(played, format)) ? 'applied' : 'kept';
    },
    serializeSong(): TrackerSongFile {
      // An edit the watcher has not flushed yet is part of the song.
      this.flushAhxBytes();
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
        initialSpeed: this.initialSpeed,
        linearFrequency: this.linearFrequency,
        ...(this.moduleFormat === 's3m' && this.amigaLimits
          ? { amigaLimits: true }
          : {}),
        // MOD's default is the opposite of S3M's, so it is the `false` that
        // has to survive a save/load round trip.
        ...(this.moduleFormat === 'protracker'
          ? { amigaLimits: this.amigaLimits }
          : {}),
        ...(this.moduleFormat === 's3m' && this.fastVolumeSlides
          ? { fastVolumeSlides: true }
          : {}),
        ...(this.moduleFormat === 's3m' && this.initialGlobalVolume !== 1.0
          ? { initialGlobalVolume: this.initialGlobalVolume }
          : {}),
        ...(this.vblankTiming ? { vblankTiming: true } : {}),
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
      // Both, as a belt against a stale doc: only an AHX song carries a file.
      if (this.moduleFormat === 'ahx' && this.ahxDoc !== null) {
        const bytes = this.currentAhxBytes();
        if (bytes !== null) data.ahxFile = encodeAhxFile(bytes);
      }
      return { version: CURRENT_SONG_FILE_VERSION, data };
    },
    loadSongFile(file: TrackerSongFile) {
      if (!file || !file.data) return;
      if (!Number.isInteger(file.version) || file.version < 1 || file.version > CURRENT_SONG_FILE_VERSION) {
        return;
      }
      const data = file.data;

      // History belongs to the song it was made on: an undo across a load would
      // put the old song's grid (and, for AHX, its doc) on top of the new
      // song's engine bytes. (The Jukebox puts the editor's stacks back by hand
      // after the load that restores its song.)
      this.undoStack = [];
      this.redoStack = [];

      // The doc belongs to the song that is being replaced: whichever song this
      // is, it starts without one (an editable AHX song sets its own below).
      this.ahxDoc = null;
      this.ahxRevision += 1;
      clearAhxEditNotice();

      this.currentSong = {
        title: data.currentSong?.title ?? 'Untitled song',
        author: data.currentSong?.author ?? 'Unknown',
        bpm: data.currentSong?.bpm ?? 120
      };
      // v1 files predate the tag, so fall back to inferring it from the slots.
      this.moduleFormat = data.moduleFormat ?? inferLegacyModuleFormat(data.instrumentSlots);
      this.initialSpeed = Number.isFinite(data.initialSpeed)
        ? Math.max(1, Math.min(31, data.initialSpeed as number))
        : DEFAULT_SPEED;
      // Absent means XM's own default. Songs saved before this field existed
      // were played with the linear model regardless, so nothing changes for
      // them.
      this.linearFrequency = data.linearFrequency ?? true;
      // Absent means each format's own default: ST3's wide range for S3M
      // (false), ProTracker's three octaves for MOD (true) -- which is what
      // every song saved before this field existed was played with. The
      // header global volume below defaults the same way.
      this.amigaLimits =
        data.amigaLimits ?? this.moduleFormat === 'protracker';
      this.fastVolumeSlides = data.fastVolumeSlides === true;
      this.initialGlobalVolume = Number.isFinite(data.initialGlobalVolume)
        ? Math.max(0, Math.min(1, data.initialGlobalVolume as number))
        : 1.0;
      this.vblankTiming = data.vblankTiming === true;
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
          source: slot?.source
        };
        // Pre-v4 slots carry no format and may hold the legacy 'mod' type;
        // v4 slots pass through unchanged. See `inferSlotTags`.
        const patchType = slot?.patchId
          ? data.songPatches?.[slot.patchId]?.metadata?.instrumentType
          : undefined;
        const tags = inferSlotTags(slot ?? {}, this.moduleFormat, patchType);
        if (tags.instrumentType) mapped.instrumentType = tags.instrumentType;
        if (tags.instrumentFormat) mapped.instrumentFormat = tags.instrumentFormat;
        if (slot?.oplData) {
          mapped.oplData = slot.oplData;
        }
        if (slot?.ahxData !== undefined) {
          // A song file can put anything here; the display, the editor and the
          // serializer all trust the shape, so only a valid instrument is kept.
          // A slot left without one has no editor to open (`canEditSlot`).
          const problem = ahxInstrumentProblem(slot.ahxData, ahxSourceRecordOf(file)?.format ?? 'ahx');
          if (problem === null) {
            mapped.ahxData = JSON.parse(JSON.stringify(slot.ahxData)) as AhxInstrument;
          } else {
            console.warn(`[TrackerStore] slot ${mapped.slot}: ignoring invalid AHX instrument data (${problem})`);
          }
        }
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
          const copy = JSON.parse(JSON.stringify(patch)) as Patch;
          // The patch's own type follows the same alias rule as the slot's.
          const patchType = normalizeInstrumentType(copy.metadata?.instrumentType);
          if (patchType === 'sampler' && copy.metadata.instrumentType !== 'sampler') {
            copy.metadata.instrumentType = 'sampler';
          }
          filteredSongPatches[patchId] = copy;
        }
      }
      this.songPatches = filteredSongPatches;
      this.editingSlot = null;

      if (this.moduleFormat === 'ahx') this.adoptAhxDoc(file, data);
    },

    // ------------------------------------------------------------------
    // Editable AHX songs: the doc and the write-back (see `ahx-doc`)
    // ------------------------------------------------------------------

    /**
     * Gives the AHX song just loaded its doc when its bytes are known: the grid
     * becomes the doc's projection (no latch, no clamp, stable ids), so what the
     * user edits is exactly what `entriesToTrack` reads back. A song with no
     * bytes, HVL, or bytes the parser rejects stays a read-only display.
     *
     * Where the bytes come from: a valid `data.ahxFile` wins over the source
     * record. The record can be older than the slots (an instrument-parameter
     * edit does not touch the doc, so `current` may still be the pre-edit bytes
     * while the edit lives in `slots[].ahxData`), and doc, slots and engine must
     * come from one file. The file is `buildAhxFile(doc, slots, title)`, so it
     * already holds every slot edit and name; the slots are rebuilt from it and
     * the row model and slots written beside it are ignored. The record is what a
     * fresh `.ahx` import (and an in-memory pre-v5 snapshot) has.
     */
    adoptAhxDoc(file: TrackerSongFile, data: TrackerSongFile['data']) {
      let bytes: Uint8Array | null = null;
      let fromFile = false;
      if (data.ahxFile !== undefined) {
        const decoded = decodeAhxFile(data.ahxFile);
        if (decoded.ok) {
          bytes = decoded.bytes;
          fromFile = true;
        } else {
          console.warn(`[TrackerStore] AHX song kept read-only: its embedded file is unusable (${decoded.reason})`);
        }
      }
      if (bytes === null) {
        const record = ahxSourceRecordOf(file);
        if (!record || record.format !== 'ahx') return;
        bytes = record.bytes;
      }
      let doc: AhxDoc;
      let slots: InstrumentSlot[] | null = null;
      try {
        const song = parseAhx(bytes);
        doc = docFromSong(song, bytes);
        if (fromFile) slots = buildAhxSlots(song);
      } catch (error) {
        console.warn('[TrackerStore] AHX song kept read-only: its bytes have no editable doc', error);
        return;
      }
      const oldIndex = (data.patterns ?? []).findIndex((pattern) => pattern.id === data.currentPatternId);
      this.ahxDoc = doc;
      if (slots !== null) this.instrumentSlots = slots;
      this.patterns = projectAhxPatterns(doc);
      this.sequence = this.patterns.map((pattern) => pattern.id);
      this.currentPatternId = stableIdOf(Math.max(0, Math.min(doc.positions.length - 1, oldIndex)));
      this.primeAhxWriteBack();
      // The bytes are what the engine holds for this song (`applySongFile` hands
      // them over): nothing is dirty until an edit (a flush of an unedited song
      // is a no-op).
      ahxSyncCacheOf(this).published = this.ahxPublishKey();
    },
    /**
     * The song as an `.ahx` file, from the doc, the slots and the title (the
     * grid written back first): what a save embeds, what an export writes and
     * what the engine plays, all through `buildAhxFile`. `null` for a song
     * without a doc. A pure build: it never swaps the engine's current bytes
     * (`setCurrentAhxSource` installs them when a song is applied, and it must
     * see them differ from the old song's).
     */
    currentAhxBytes(): Uint8Array | null {
      const doc = this.ahxDoc;
      if (doc === null || this.moduleFormat !== 'ahx') return null;
      this.syncAhxWriteBack();
      try {
        return buildAhxFile({ doc: this.ahxDoc ?? doc, slots: this.instrumentSlots, title: this.currentSong.title }).bytes;
      } catch (error) {
        console.error('[TrackerStore] the AHX song could not be written', error);
        return null;
      }
    },
    /** Marks the grid as reconciled with the doc (it was just built from it) and makes sure the watcher runs. */
    primeAhxWriteBack() {
      const cache = ahxSyncCacheOf(this);
      cache.cells = this.patterns.map((pattern) => pattern.tracks.map((track) => toRaw(track.entries)));
      if (cache.watching) return;
      cache.watching = true;
      // Detached: it lives as long as the store, not as long as whatever
      // component happened to load the song.
      effectScope(true).run(() => {
        watch(
          () => (this.ahxDoc === null ? null : this.patterns.map((pattern) => pattern.tracks.map((track) => track.entries))),
          () => {
            this.syncAhxWriteBack();
          }
        );
      });
    },
    /** What the size limit needs to know of the file besides the doc. */
    ahxOpContext(): AhxOpContext {
      const instruments = this.instrumentSlots.flatMap((slot) => (slot.ahxData ? [slot.ahxData] : []));
      return { instrumentBytes: ahxInstrumentBytes(instruments) };
    },
    /**
     * Writes every edited grid cell back into the doc. Idempotent, and safe to
     * call at any moment (the watcher calls it; so does every flush point, so
     * that nothing depends on when the watcher runs).
     *
     * A cell is edited when its `entries` array is another one than at the last
     * reconciliation. Its rows become a track (`entriesToTrack`); when that
     * equals the doc's track for the cell (compared as steps, in doc space) there
     * is nothing to write, which is also what makes a re-projected sibling, a
     * loaded song and an applied snapshot no-ops: no flag marks "I am writing".
     * Otherwise the track is written in place (a shared track changes for every
     * cell using it; the cells that show it are re-projected), except the blank
     * track 0, which is never written: the cell gets a track of its own first.
     * Whatever the format cannot hold (the pre-guards should have caught it) is
     * reverted from the doc, with a notice. Returns whether the doc changed.
     */
    syncAhxWriteBack(): boolean {
      const doc = this.ahxDoc;
      if (doc === null || this.moduleFormat !== 'ahx') return false;
      const cache = ahxSyncCacheOf(this);
      const patterns = this.patterns;
      const count = Math.min(patterns.length, doc.positions.length);

      interface Edited {
        p: number;
        c: number;
        entries: TrackerEntryData[];
        encoded?: AhxDocTrack;
        revert?: boolean;
      }
      const edited: Edited[] = [];
      for (let p = 0; p < count; p++) {
        const cells = patterns[p]?.tracks;
        if (!cells) continue;
        for (let c = 0; c < AHX_CHANNELS; c++) {
          const cell = cells[c];
          if (!cell) continue;
          const raw = toRaw(cell.entries);
          if (cache.cells[p]?.[c] !== raw) edited.push({ p, c, entries: raw });
        }
      }
      if (edited.length === 0) return false;

      const context = this.ahxOpContext();
      let next = doc;
      let problem: string | null = null;
      for (const cell of edited) {
        const encoded = entriesToTrack(cell.entries, doc.trackLength);
        if ('error' in encoded) {
          cell.revert = true;
          problem ??= encoded.error;
          continue;
        }
        cell.encoded = encoded;
        let track = next.positions[cell.p]?.track[cell.c] as number;
        if (tracksEqual(encoded, next.tracks[track] as AhxDocTrack)) continue;
        let working = next;
        if (track === 0 && isBlankTrack(working.tracks[0] as AhxDocTrack)) {
          // Track 0 is what every blank cell points at: never written, so a
          // blank cell that gets its first step gets a track of its own.
          const fresh = allocTrack(working, {}, context);
          if (!fresh.ok) {
            cell.revert = true;
            problem ??= fresh.reason;
            continue;
          }
          const assigned = assignTrack(fresh.doc, cell.p, cell.c, fresh.track);
          if (!assigned.ok) {
            cell.revert = true;
            problem ??= assigned.reason;
            continue;
          }
          working = assigned.doc;
          track = fresh.track;
        }
        const written = setTrack(working, track, encoded);
        if (!written.ok) {
          cell.revert = true;
          problem ??= written.reason;
          continue;
        }
        next = written.doc;
      }

      if (next !== doc || edited.some((cell) => cell.revert)) {
        // Every cell that shows a track that changed (or is now another track),
        // and every reverted cell, gets the doc's rows. A cell that was edited
        // and now agrees with the doc keeps the text the user typed.
        const own = new Map(edited.map((cell) => [cell.p * AHX_CHANNELS + cell.c, cell]));
        const targets: { p: number; c: number; track: number }[] = [];
        for (let p = 0; p < count; p++) {
          for (let c = 0; c < AHX_CHANNELS; c++) {
            const track = next.positions[p]?.track[c] as number;
            const before = doc.positions[p]?.track[c] as number;
            const mine = own.get(p * AHX_CHANNELS + c);
            if (mine?.encoded && tracksEqual(mine.encoded, next.tracks[track] as AhxDocTrack)) continue;
            const moved = track !== before || next.tracks[track] !== doc.tracks[before];
            if (mine?.revert || moved) targets.push({ p, c, track });
          }
        }
        const projected = projectTracks(next, targets.map((target) => target.track));
        for (const { p, c, track } of targets) {
          const cell = patterns[p]?.tracks[c];
          if (cell) cell.entries = (projected.get(track) ?? []).map((entry) => ({ ...entry }));
        }
      }
      cache.cells = patterns.map((pattern) => pattern.tracks.map((track) => toRaw(track.entries)));

      const changed = next !== doc;
      // Looked for before the commit: it compares the written steps with the old doc's.
      const warning = changed ? this.emptySlotWarning(doc, edited) : null;
      if (changed) this.commitAhxDoc(next);
      // A refusal outranks a warning (one notice at a time).
      if (problem !== null) reportAhxEditNotice(problem);
      else if (warning !== null) reportAhxEditNotice(warning);
      return changed;
    },
    /**
     * A warning, not a refusal (the file may legally address such a step, and
     * the user may be about to fill the slot): a step this pass wrote names an
     * instrument whose slot is empty. The engine only sets an instrument up
     * when its number is within the song's instrument count, so the step would
     * not start one. Steps that already named it (a file's own) do not warn.
     */
    emptySlotWarning(
      before: AhxDoc,
      written: readonly { p: number; c: number; encoded?: AhxDocTrack; revert?: boolean }[],
    ): string | null {
      for (const cell of written) {
        if (cell.revert || !cell.encoded) continue;
        const old = before.tracks[before.positions[cell.p]?.track[cell.c] as number] ?? [];
        for (let row = 0; row < cell.encoded.length; row++) {
          const step = cell.encoded[row] as AhxDocTrack[number];
          if (step.instrument === 0 || this.instrumentSlots[step.instrument - 1]?.ahxData !== undefined) continue;
          const was = old[row];
          if (was && was.instrument === step.instrument && was.note === step.note) continue;
          const count = this.instrumentSlots.filter((slot) => slot.ahxData !== undefined).length;
          const named = String(step.instrument).padStart(2, '0');
          return `Instrument ${named} is empty (this song has ${count}): a step naming it does not start an instrument.`;
        }
      }
      return null;
    },
    /**
     * Installs `next` as the song's doc and hands the engine's bytes the change:
     * from here on the next Play plays what the grid shows.
     */
    commitAhxDoc(next: AhxDoc, options: ReplaceAhxBytesOptions = {}) {
      this.ahxDoc = next;
      this.ahxRevision += 1;
      clearAhxEditNotice();
      this.publishAhxBytes(options);
    },
    /**
     * Serializes doc + slots + title and swaps them in as the song's current
     * bytes when they differ (not debounced: a debounce and a live reload come
     * with the engine path). Never throws: a doc the writer refuses (the ops
     * cannot make one) leaves the previous bytes and says so.
     */
    publishAhxBytes(options: ReplaceAhxBytesOptions & { install?: boolean } = {}) {
      const doc = this.ahxDoc;
      if (doc === null) return;
      const { install = false, ...replaceOptions } = options;
      try {
        const key = this.ahxPublishKey();
        const { bytes } = buildAhxFile({ doc, slots: this.instrumentSlots, title: this.currentSong.title });
        // `install`: a snapshot of another song than the current bytes' one.
        // No bytes at all is the same case (an editable song must never be
        // left without what Play loads), and it must not fail silently.
        if (install || currentAhxSource() === null) {
          setCurrentAhxSource(bytes, { format: 'ahx', version: doc.version, edits: [] });
        } else {
          replaceCurrentAhxBytes(bytes, replaceOptions);
        }
        ahxSyncCacheOf(this).published = key;
      } catch (error) {
        console.error('[TrackerStore] the AHX song could not be written; the engine keeps the previous version', error);
      }
    },
    /**
     * Brings the current bytes up to date with everything the editor holds:
     * the grid (written back first), the slots' instruments and the title.
     * Called before a Play, a save, an export and a snapshot; cheap when
     * nothing changed (the bytes are only swapped when they differ).
     */
    flushAhxBytes() {
      if (this.ahxDoc === null) return;
      this.syncAhxWriteBack();
      // Nothing changed since the bytes were last built (or loaded): leave them
      // alone. A song whose re-serialisation is not byte-identical would
      // otherwise be swapped for re-encoded bytes without an edit being made.
      if (ahxSyncCacheOf(this).published === this.ahxPublishKey() && currentAhxSource() !== null) return;
      this.publishAhxBytes();
    },
    /** Everything `buildAhxFile` reads besides the doc's tracks, as one comparable string: the revision counts the doc's changes. */
    ahxPublishKey(): string {
      return `${this.ahxRevision}\u0000${this.currentSong.title}\u0000${JSON.stringify(this.instrumentSlots)}`;
    }
  }
});
