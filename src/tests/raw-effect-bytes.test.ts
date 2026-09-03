/**
 * P1 -- raw effect bytes on TrackerEntryData (D94).
 *
 * Importers write format-native `(cmd, param)` bytes on each entry; the text
 * macro is derived from them and only displayed. The song builder decodes the
 * raw bytes through the module format's `FormatProfile` command tables.
 *
 * Proofs here:
 *  1. Importers populate the raw fields (XM and MOD).
 *  2. Scheduled-command identity: for every corpus module, the raw-byte path
 *     schedules byte-identical commands through PlaybackEngine.scheduleRow as
 *     the old text-macro path (a stripped copy of the same import falls back
 *     to `parseEffectCommand`).
 *  3. A hypothetical third format's command numbering maps via profile data
 *     only -- same decoder, no parser fork.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ref, computed } from 'vue';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import {
  parseEffectCommand,
  decodeRawEffect,
} from 'src/audio/tracker/note-utils';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import type { TrackerEntryData } from 'src/components/tracker/tracker-types';
import type { TrackerPattern } from 'src/stores/tracker-store';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import {
  useTrackerEditing,
  type TrackerEditingContext,
} from 'src/composables/useTrackerEditing';
import {
  PlaybackEngine,
} from '../../packages/tracker-playback/src/engine';
import {
  XM_PROFILE,
  PROTRACKER_PROFILE,
  type FormatProfile,
} from '../../packages/tracker-playback/src/format-profile';
import { buildXm, cell } from './helpers/xm-builder';

const DEMOS = path.resolve(__dirname, '../../public/demos');

/**
 * Read a module file as an exact ArrayBuffer.
 *
 * `readFileSync(...).buffer` can be a pooled 64 KB buffer whose file data
 * starts at a non-zero byteOffset -- handing that to a parser feeds it
 * whatever bytes precede the file. Slice to the real bytes.
 */
function readModule(dir: string, name: string): ArrayBuffer {
  const view = fs.readFileSync(path.join(DEMOS, dir, name));
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
}

// Only modules the importers accept; a few corpus files use flavours the
// importers do not support (outside this task's scope).
const XM_FILES = fs
  .readdirSync(path.join(DEMOS, 'ft2'))
  .filter((f) => f.toLowerCase().endsWith('.xm'))
  .filter((f) => {
    try {
      importXmToTrackerSong(readModule('ft2', f));
      return true;
    } catch {
      return false;
    }
  });
const MOD_FILES = fs
  .readdirSync(path.join(DEMOS, 'amiga'))
  .filter((f) => f.toLowerCase().endsWith('.mod'))
  .filter((f) => {
    try {
      importModToTrackerSong(readModule('amiga', f));
      return true;
    } catch {
      return false;
    }
  });

function builderContext(
  file: ReturnType<typeof importXmToTrackerSong> | ReturnType<typeof importModToTrackerSong>,
): TrackerSongBuilderContext {
  const patterns = file.data.patterns;
  return {
    currentSong: ref(file.data.currentSong),
    moduleFormat: ref(file.data.moduleFormat!),
    initialSpeed: ref(file.data.initialSpeed ?? 6),
    linearFrequency: ref(file.data.linearFrequency ?? true),
    patterns: ref(patterns),
    sequence: ref(file.data.sequence ?? patterns.map((p) => p.id)),
    currentPatternId: ref(patterns[0]!.id),
    currentPattern: ref(patterns[0]!),
    defaultPatternRows: ref(64),
    instrumentSlots: ref(file.data.instrumentSlots),
    songPatches: ref(file.data.songPatches ?? {}),
    songBank: {} as TrackerSongBuilderContext['songBank'],
    normalizeInstrumentId: (id) => (id ? id : undefined),
    formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
  };
}

/**
 * Every scheduled handler invocation as stable JSON strings, per pattern, so
 * the raw-byte path and the text path can be compared command for command.
 */
function scheduleEverything(song: ReturnType<ReturnType<typeof useTrackerSongBuilder>['buildPlaybackSong']>): string[] {
  const log: string[] = [];
  const push = (prefix: string, event: unknown) => {
    log.push(`${prefix}:${JSON.stringify(event)}`);
  };
  const pushAll = (prefix: string, event: unknown) => {
    log.push(`${prefix}:${JSON.stringify(event)}`);
  };

  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: (e: unknown) => push('note', e),
    scheduledPitchHandler: (...args: unknown[]) => pushAll('pitch', args),
    scheduledVolumeHandler: (...args: unknown[]) => pushAll('volume', args),
    scheduledPanHandler: (...args: unknown[]) => pushAll('pan', args),
    scheduledSampleOffsetHandler: (...args: unknown[]) => pushAll('offset', args),
    scheduledEnvelopePositionHandler: (...args: unknown[]) => pushAll('envpos', args),
    scheduledAllNotesOffHandler: (...args: unknown[]) => pushAll('alloff', args),
    scheduledGlobalVolumeHandler: (...args: unknown[]) => pushAll('globalvol', args),
    scheduledRetriggerHandler: (...args: unknown[]) => pushAll('retrig', args),
    scheduledMacroHandler: (...args: unknown[]) => pushAll('macro', args),
    scheduledAutomationHandler: (e: unknown) => push('auto', e),
    positionCommandHandler: (e: unknown) => push('pos', e),
  } as unknown as ConstructorParameters<typeof PlaybackEngine>[0]);

  engine.loadSong(song);
  for (const pattern of song.patterns) {
    engine.loadPattern(pattern.id);
    for (let row = 0; row < pattern.length; row += 1) {
      (
        engine as unknown as { scheduleRow: (r: number, t: number) => void }
      ).scheduleRow(row, row);
    }
  }
  return log;
}

/**
 * The same imported song, with every raw byte field stripped so the builder
 * falls back to the pre-P1 text path (`parseEffectCommand` on the macros).
 */
function stripRawFields(
  file: ReturnType<typeof importXmToTrackerSong> | ReturnType<typeof importModToTrackerSong>,
) {
  for (const pattern of file.data.patterns) {
    for (const track of pattern.tracks) {
      for (const entry of track.entries) {
        delete (entry as Partial<TrackerEntryData>).effectCommand;
        delete (entry as Partial<TrackerEntryData>).effectParam;
      }
    }
  }
}

describe('importers carry raw format-native effect bytes', () => {
  it('XM import writes raw (cmd, param) alongside the derived macro', () => {
    const xm = buildXm({
      numChannels: 1,
      instruments: [{ samples: [{ frames: [0, 1, 0, -1] }] }],
      patterns: [
        {
          numRows: 2,
          cells: [
            [cell(49, { instrument: 1, effectType: 0x04, effectParam: 0x37 })],
            [cell(50, { instrument: 1, effectType: 0x19, effectParam: 0x40 })],
          ],
        },
      ],
    });
    const imp = importXmToTrackerSong(xm.buffer.slice(0) as ArrayBuffer);
    const entries = imp.data.patterns[0]!.tracks[0]!.entries;
    expect(entries[0]!.effectCommand).toBe(0x04);
    expect(entries[0]!.effectParam).toBe(0x37);
    expect(entries[0]!.macro).toBe('437');
    // 0x19 is FT2's pan slide; the raw byte -- not the colliding 'P' text --
    // carries the meaning.
    expect(entries[1]!.effectCommand).toBe(0x19);
    expect(entries[1]!.effectParam).toBe(0x40);
    expect(entries[1]!.macro).toBe('P40');
  });

  it('MOD import writes raw (cmd, param) alongside the derived macro', () => {
    const mod = importModToTrackerSong(
      readModule('amiga', 'nexus_seven.mod'),
    );
    let rawCount = 0;
    for (const pattern of mod.data.patterns) {
      for (const track of pattern.tracks) {
        for (const entry of track.entries) {
          if (entry.effectCommand === undefined) continue;
          expect(entry.macro).toBeDefined();
          expect(entry.effectCommand).toBeGreaterThanOrEqual(0);
          expect(entry.effectCommand).toBeLessThanOrEqual(0x0f);
          expect(entry.effectParam).toBeGreaterThanOrEqual(0);
          rawCount += 1;
        }
      }
    }
    expect(rawCount).toBeGreaterThan(100);
  });

  it('raw decoding matches the text path for every shared command byte', () => {
    // ProTracker numbers 0x01-0x0F and XM's extensions 0x10-0x21. For every
    // byte where the text dialect is unambiguous, raw decoding must give the
    // same result the text parse gives -- MOD/XM behaviour is untouched.
    for (let cmd = 0x01; cmd <= 0x0f; cmd += 1) {
      for (const param of [0x00, 0x01, 0x28, 0x47, 0xff]) {
        const raw = decodeRawEffect(cmd, param, PROTRACKER_PROFILE);
        const text = parseEffectCommand(
          `${cmd.toString(16).toUpperCase()}${param.toString(16).toUpperCase().padStart(2, '0')}`,
        );
        expect(raw).toEqual(text);
      }
    }
    for (const cmd of [0x10, 0x11, 0x14, 0x15, 0x1b, 0x1d, 0x1e, 0x21]) {
      const raw = decodeRawEffect(cmd, 0x23, XM_PROFILE);
      const text = parseEffectCommand(
        `${String.fromCharCode('G'.charCodeAt(0) + (cmd - 0x10))}23`,
      );
      expect(raw).toEqual(text);
    }
    // And where the text dialect *is* ambiguous -- FT2's Pxy pan slide, whose
    // derived text collides with the M/N/O/P macro shorthand (D52/D94) -- the
    // raw byte carries the real meaning instead of silently becoming a macro.
    const panSlide = decodeRawEffect(0x19, 0x40, XM_PROFILE);
    expect(panSlide).toEqual({
      type: 'effect',
      effect: { type: 'panSlide', paramX: 4, paramY: 0 },
    });
  });
});

describe('scheduled-command identity: raw-byte path vs text path', () => {
  for (const name of XM_FILES) {
    it(`schedules identically for ${name}`, () => {
      const rawFile = importXmToTrackerSong(readModule('ft2', name));
      const rawLog = scheduleEverything(
        useTrackerSongBuilder(builderContext(rawFile)).buildPlaybackSong('song'),
      );

      const textFile = importXmToTrackerSong(readModule('ft2', name));
      stripRawFields(textFile);
      const textLog = scheduleEverything(
        useTrackerSongBuilder(builderContext(textFile)).buildPlaybackSong('song'),
      );
      expect(rawLog).toEqual(textLog);
    });
  }

  for (const name of MOD_FILES) {
    it(`schedules identically for ${name}`, () => {
      const rawFile = importModToTrackerSong(readModule('amiga', name));
      const rawLog = scheduleEverything(
        useTrackerSongBuilder(builderContext(rawFile)).buildPlaybackSong('song'),
      );

      const textFile = importModToTrackerSong(readModule('amiga', name));
      stripRawFields(textFile);
      const textLog = scheduleEverything(
        useTrackerSongBuilder(builderContext(textFile)).buildPlaybackSong('song'),
      );
      expect(rawLog).toEqual(textLog);
    });
  }
});

describe('a hand edit of the macro column drops the raw bytes', () => {
  /**
   * Pins the text-authority path (D94): editing the primary macro column of
   * an imported row must delete effectCommand/effectParam, so the row plays
   * from the text the user typed, not from the command the module shipped.
   */
  function editingContext(entries: TrackerEntryData[]) {
    const pattern: TrackerPattern = {
      id: 'p1',
      rows: 4,
      tracks: [{ id: 't1', entries }],
    };
    const currentPattern = computed(() => pattern);
    const context: TrackerEditingContext = {
      activeRow: ref(0),
      activeTrack: ref(0),
      activeColumn: ref(4),
      activeMacroNibble: ref(0),
      isEditMode: ref(true),
      stepSize: ref(1),
      baseOctave: ref(4),
      defaultBaseOctave: 4,
      activeInstrumentId: ref(null),
      rowsCount: ref(pattern.rows),
      currentPattern,
      instrumentSlots: ref([]),
      songBank: {} as TrackerSongBank,
      toggleInterpolationRange: () => {},
      clearInterpolationRangeAt: () => {},
      pushHistory: () => {},
      moveRow: () => {},
      formatInstrumentId: (slot) => String(slot).padStart(2, '0'),
      normalizeInstrumentId: (id) => (id ? id : undefined),
      normalizeVolumeChars: (vol) => {
        const chars: [string, string] = ['.', '.'];
        const clean = (vol ?? '').toUpperCase();
        if (/^[0-9A-F]$/.test(clean[0] ?? '')) chars[0] = clean[0];
        if (/^[0-9A-F]$/.test(clean[1] ?? '')) chars[1] = clean[1];
        return chars;
      },
      normalizeMacroChars: (macro) => {
        const chars: [string, string, string] = ['.', '.', '.'];
        const clean = (macro ?? '').toUpperCase();
        if (/^[0-9A-Z]$/.test(clean[0] ?? '')) chars[0] = clean[0];
        if (/^[0-9A-F]$/.test(clean[1] ?? '')) chars[1] = clean[1];
        if (/^[0-9A-F]$/.test(clean[2] ?? '')) chars[2] = clean[2];
        return chars;
      },
      midiToTrackerNote: (midi) => `C-${Math.floor(midi / 12) - 1}`,
    };
    return { editing: useTrackerEditing(context), pattern };
  }

  it('handleMacroInput clears effectCommand/effectParam', () => {
    const entry: TrackerEntryData = {
      row: 0,
      macro: 'P40',
      effectCommand: 0x19,
      effectParam: 0x40,
    };
    const { editing, pattern } = editingContext([entry]);

    editing.handleMacroInput('4');
    editing.handleMacroInput('3');
    editing.handleMacroInput('7');

    const edited = pattern.tracks[0]!.entries[0]!;
    expect(edited.macro).toBe('437');
    expect(edited.effectCommand).toBeUndefined();
    expect(edited.effectParam).toBeUndefined();
  });

  it('clearMacroField clears them too', () => {
    const entry: TrackerEntryData = {
      row: 0,
      macro: '437',
      effectCommand: 0x04,
      effectParam: 0x37,
    };
    const { editing, pattern } = editingContext([entry]);

    editing.clearMacroField();

    const edited = pattern.tracks[0]!.entries[0]!;
    expect(edited.macro).toBeUndefined();
    expect(edited.effectCommand).toBeUndefined();
    expect(edited.effectParam).toBeUndefined();
  });
});

describe('a third format maps its command bytes via profile data only', () => {
  /**
   * A hypothetical future format. Its command numbering is deliberately NOT
   * MOD/XM's: byte 0x01 is tone portamento (where ProTracker slides up),
   * 0x0A is vibrato (where MOD/XM volume-slides). Nothing here touches the
   * parsers, the engine or the effect processor -- the profile's tables are
   * the whole difference (D94).
   */
  const THIRD_FORMAT_PROFILE: FormatProfile = {
    ...XM_PROFILE,
    effectCommands: {
      0x01: 'tonePorta',
      0x02: 'volSlide',
      0x0a: 'vibrato',
    },
    // This format has no speed/tempo command and no extended subcommands.
    speedTempoCommandByte: undefined,
    extendedCommandByte: undefined,
  };

  it('decodes the same byte differently through the profile', () => {
    expect(decodeRawEffect(0x01, 0x20, XM_PROFILE)).toEqual({
      type: 'effect',
      effect: { type: 'portaUp', paramX: 2, paramY: 0 },
    });
    expect(decodeRawEffect(0x01, 0x20, THIRD_FORMAT_PROFILE)).toEqual({
      type: 'effect',
      effect: { type: 'tonePorta', paramX: 2, paramY: 0 },
    });

    expect(decodeRawEffect(0x0a, 0x34, XM_PROFILE)).toEqual({
      type: 'effect',
      effect: { type: 'volSlide', paramX: 3, paramY: 4 },
    });
    expect(decodeRawEffect(0x0a, 0x34, THIRD_FORMAT_PROFILE)).toEqual({
      type: 'effect',
      effect: { type: 'vibrato', paramX: 3, paramY: 4 },
    });
  });

  it('leaves unmapped bytes undefined instead of guessing', () => {
    expect(decodeRawEffect(0x07, 0x11, THIRD_FORMAT_PROFILE)).toBeUndefined();
  });

  it('returns undefined for command bytes the third-format profile does not map', () => {
    // XM's 0x0F is speed/tempo; the third format has no such command byte
    // and no table entry for it, so the byte decodes to nothing rather than
    // being guessed into a MOD/XM reading.
    expect(decodeRawEffect(0x0f, 0x06, THIRD_FORMAT_PROFILE)).toBeUndefined();
    expect(decodeRawEffect(0x0f, 0x06, XM_PROFILE)).toEqual({
      type: 'speed',
      speed: 6,
    });
  });
});