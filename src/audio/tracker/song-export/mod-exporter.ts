import type { TrackerSongFile, InstrumentSlot } from 'src/stores/tracker-store';
import { DEFAULT_SPEED } from 'src/stores/tracker-store';
import { emptyModSample, modSampleOfSlot } from 'src/audio/tracker/mod-sample-codec';
import type { Patch } from 'src/audio/types/preset-types';
import {
  AMIGA_CLOCK,
  MOD_EXTENDED_PERIOD_TABLE,
  PAULA_TO_SYNTH_SCALE,
  PT_PERIOD_TABLE,
  modEntrySignature,
  parseTrackerNoteSymbol,
  parseTrackerVolume,
  writeMod,
  channelsForSignature,
  MAX_MOD_CHANNELS,
  type ModPatternCell,
  type ModSample,
  type ModSong,
  type TrackerEntryData,
  type TrackerPattern,
} from '@another-synth/tracker-playback';
import { SongExportError, type SongExportCheck, type SongExporter } from './types';

/**
 * The ProTracker `.mod` exporter.
 *
 * A song's rows and instruments are the flat tracker model; a .mod is a stricter
 * container (64-row patterns, 31 8-bit samples, one effect per cell, volume
 * only through Cxx). An imported module keeps its original cells and header
 * volumes (`modCell`, `modVolume`) and is written back as it was read; anything
 * edited or authored here is converted, and `notes` names what that dropped.
 */

const PATTERN_ROWS = 64;
const MAX_ORDERS = 128;
const DEFAULT_BPM = 125;

export interface ModExportPlan {
  mod: ModSong;
  /** What could not be written as it is in the song; empty when nothing was lost. */
  notes: string[];
}

function patchOf(song: TrackerSongFile, slot: InstrumentSlot | undefined): Patch | undefined {
  return slot?.patchId ? song.data.songPatches[slot.patchId] : undefined;
}

/** Amiga period for a tracker entry's note, or undefined when it has none. */
function periodFor(entry: TrackerEntryData, amigaLimits: boolean, notes: Set<string>): number | undefined {
  const parsed = parseTrackerNoteSymbol(entry.note);
  if (parsed.midi === undefined) return undefined;
  const midi = parsed.midi;
  // An imported period is exact (it may not be a table value); trust it while
  // it still names the note shown.
  if (entry.frequency !== undefined && entry.frequency > 0) {
    const shown = Math.round(69 + 12 * Math.log2(entry.frequency / 440));
    if (shown === midi) {
      const period = Math.round(AMIGA_CLOCK / (2 * entry.frequency * PAULA_TO_SYNTH_SCALE));
      if (period >= 1 && period <= 0xfff) return period;
    }
  }
  if (midi >= 24 && midi <= 59) return PT_PERIOD_TABLE[midi - 24];
  if (!amigaLimits && midi >= 0 && midi <= 83) return MOD_EXTENDED_PERIOD_TABLE[midi];
  notes.add('Notes outside ProTracker\'s C-1 to B-3 range were moved to the nearest note it has.');
  return PT_PERIOD_TABLE[Math.max(0, Math.min(35, midi - 24))];
}

/** The `[command, param]` an entry's effect column holds, if it is one a .mod has. */
function effectOf(entry: TrackerEntryData, notes: Set<string>): [number, number] | undefined {
  if (entry.effectCommand !== undefined && entry.effectParam !== undefined) {
    return [entry.effectCommand & 0x0f, entry.effectParam & 0xff];
  }
  const text = (entry.macro ?? '').trim().toUpperCase();
  if (!text) return undefined;
  if (/^[0-9A-F][0-9A-F]{2}$/.test(text)) {
    const command = Number.parseInt(text[0]!, 16);
    const param = Number.parseInt(text.slice(1), 16);
    if (command === 0 && param === 0) return undefined;
    return [command, param];
  }
  notes.add("Effects a .mod doesn't have (the letter commands and macros) were left out.");
  return undefined;
}

function cellFromEntry(
  entry: TrackerEntryData,
  slotVolumes: ReadonlyMap<number, number>,
  amigaLimits: boolean,
  notes: Set<string>,
): ModPatternCell {
  if (entry.modCell && entry.modSig === modEntrySignature(entry)) {
    const [period, sampleNumber, effectCmd, effectParam] = entry.modCell;
    return { period, sampleNumber, effectCmd, effectParam };
  }

  let period = 0;
  let effect = effectOf(entry, notes);
  if (entry.note === '###') {
    period = 0;
    if (!effect) effect = [0xe, 0xc0];
    else notes.add('A note-off next to another effect was left out.');
  } else {
    period = periodFor(entry, amigaLimits, notes) ?? 0;
  }

  let sampleNumber = 0;
  if (entry.instrument !== undefined) {
    const n = Number.parseInt(entry.instrument, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 31) sampleNumber = n;
    else if (Number.isFinite(n) && n > 31) notes.add('Instruments above 31 were left out; a .mod has 31.');
  }

  const velocity = parseTrackerVolume(entry.volume);
  if (velocity !== undefined) {
    const volume = Math.round((velocity / 255) * 64);
    const implied = sampleNumber > 0 ? (slotVolumes.get(sampleNumber) ?? 64) : undefined;
    if (volume !== implied) {
      if (!effect) effect = [0xc, volume];
      else if (effect[0] !== 0xc) notes.add('A volume next to another effect was left out; a .mod has one effect per note.');
    }
  }

  return { period, sampleNumber, effectCmd: effect?.[0] ?? 0, effectParam: effect?.[1] ?? 0 };
}

export function planModExport(song: TrackerSongFile): ModExportPlan | { error: string } {
  const data = song.data;
  if (data.moduleFormat !== 'protracker') {
    return { error: 'Only ProTracker songs can be saved as a .mod.' };
  }
  const notes = new Set<string>();

  // Patterns in the order they first play: that is the .mod's own numbering.
  const byId = new Map<string, TrackerPattern>(data.patterns.map((p) => [p.id, p]));
  const patternIds: string[] = [];
  const orders: number[] = [];
  for (const id of data.sequence) {
    if (!byId.has(id)) continue;
    let index = patternIds.indexOf(id);
    if (index < 0) {
      index = patternIds.length;
      patternIds.push(id);
    }
    orders.push(index);
  }
  if (orders.length === 0) {
    const first = data.patterns[0];
    if (!first) return { error: 'This song has no patterns.' };
    patternIds.push(first.id);
    orders.push(0);
  }
  if (orders.length > MAX_ORDERS) return { error: `A .mod holds ${MAX_ORDERS} order positions; this song has ${orders.length}.` };
  if (patternIds.length > MAX_ORDERS) return { error: `A .mod holds ${MAX_ORDERS} patterns; this song has ${patternIds.length}.` };

  const used = patternIds.map((id) => byId.get(id)!);
  const numChannels = Math.max(1, ...used.map((p) => p.tracks.length));
  if (numChannels > MAX_MOD_CHANNELS) return { error: `A .mod holds ${MAX_MOD_CHANNELS} channels; this song has ${numChannels}.` };

  const slotVolumes = new Map<number, number>();
  const samples: ModSample[] = [];
  for (let i = 1; i <= 31; i++) {
    const slot = data.instrumentSlots.find((s) => s.slot === i);
    slotVolumes.set(i, Math.max(0, Math.min(64, slot?.modVolume ?? 64)));
    samples.push(
      slot
        ? modSampleOfSlot(slot, patchOf(song, slot), notes)
        : emptyModSample(),
    );
  }
  if (data.instrumentSlots.some((s) => s.slot > 31 && (s.patchId || s.instrumentName))) {
    notes.add('Instruments above 31 were left out; a .mod has 31.');
  }

  const amigaLimits = data.amigaLimits ?? true;
  const patterns = used.map((pattern) => {
    const rows: ModPatternCell[][] = Array.from({ length: PATTERN_ROWS }, () =>
      Array.from({ length: numChannels }, () => ({ period: 0, sampleNumber: 0, effectCmd: 0, effectParam: 0 })),
    );
    if (pattern.rows > PATTERN_ROWS) notes.add(`Patterns longer than ${PATTERN_ROWS} rows were cut; a .mod pattern has ${PATTERN_ROWS}.`);
    pattern.tracks.forEach((track, channel) => {
      for (const entry of track.entries) {
        if (entry.row < 0 || entry.row >= PATTERN_ROWS) continue;
        const rowCells = rows[entry.row]!;
        rowCells[channel] = cellFromEntry(entry, slotVolumes, amigaLimits, notes);
      }
    });
    // A short pattern has to end itself; a .mod always plays 64 rows.
    if (pattern.rows < PATTERN_ROWS && pattern.rows > 0) {
      const last = rows[pattern.rows - 1]!;
      const hasBreak = last.some((c) => c.effectCmd === 0xd || c.effectCmd === 0xb);
      if (!hasBreak) {
        const free = last.find((c) => c.effectCmd === 0 && c.effectParam === 0);
        if (free) free.effectCmd = 0xd;
        else notes.add('A pattern shorter than 64 rows could not be ended early and plays on to row 64.');
      }
    }
    return { rows };
  });

  // The header has no speed or tempo; ProTracker starts at 6 and 125.
  const speed = data.initialSpeed ?? DEFAULT_SPEED;
  const bpm = Math.round(data.currentSong.bpm);
  const first = patterns[0]!.rows[0]!;
  const startEffects: Array<[number, number]> = [];
  if (speed !== 6 && speed >= 1 && speed <= 31) startEffects.push([0xf, speed]);
  if (bpm !== DEFAULT_BPM && bpm >= 32 && bpm <= 255) startEffects.push([0xf, bpm]);
  for (const [command, param] of startEffects) {
    const cell = first.find((c) => c.effectCmd === 0 && c.effectParam === 0);
    if (cell) {
      cell.effectCmd = command;
      cell.effectParam = param;
    } else {
      notes.add("The starting speed or tempo couldn't be written: the first row has no free effect.");
    }
  }

  const signature = data.modOrigin?.signature ?? '';
  const mod: ModSong = {
    title: data.currentSong.title,
    numChannels,
    songLength: orders.length,
    orders: Array.from({ length: 128 }, (_, i) => orders[i] ?? 0),
    patterns,
    samples,
    signature: channelsForSignature(signature) === numChannels ? signature : '',
    trackerFlavor: 'ProTracker',
    amigaLimits,
  };
  return { mod, notes: [...notes] };
}

function check(song: TrackerSongFile): SongExportCheck {
  const plan = planModExport(song);
  return 'error' in plan ? { ok: false, reason: plan.error } : { ok: true };
}

function warnings(song: TrackerSongFile): string[] {
  const plan = planModExport(song);
  return 'error' in plan ? [] : plan.notes;
}

function serialize(song: TrackerSongFile): Uint8Array {
  const plan = planModExport(song);
  if ('error' in plan) throw new SongExportError(plan.error);
  return writeMod(plan.mod);
}

export const modExporter: SongExporter = {
  id: 'mod',
  label: 'ProTracker module',
  extension: '.mod',
  mimeType: 'application/octet-stream',
  available: true,
  check,
  warnings,
  serialize,
};
