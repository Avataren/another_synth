import type { TrackerSongFile, InstrumentSlot } from 'src/stores/tracker-store';
import { DEFAULT_SPEED } from 'src/stores/tracker-store';
import { xmInstrumentOfSlot } from 'src/audio/tracker/xm-instrument-codec';
import type { Patch } from 'src/audio/types/preset-types';
import {
  FT2_TRACKER_NAME,
  XM_MAX_CHANNELS,
  XM_MAX_ENVELOPE_POINTS,
  XM_MAX_INSTRUMENTS,
  XM_MAX_PATTERNS,
  emptyXmEnvelope,
  parseTrackerNoteSymbol,
  parseTrackerVolume,
  writeXm,
  xmEntrySignature,
  xmSampleForNote,
  type TrackerEntryData,
  type TrackerPattern,
  type XmInstrument,
  type XmPatternCell,
  type XmSong,
} from '@another-synth/tracker-playback';
import { SongExportError, type SongExportCheck, type SongExporter } from './types';

/**
 * The FastTracker 2 `.xm` exporter.
 *
 * An imported module keeps its original cells (`xmCell`) and its instrument
 * headers (`slot.xmInstrument`) and is written back as it was read; rows
 * edited or authored here are converted, and `notes` names what that dropped.
 */

const DEFAULT_BPM = 125;
const MAX_ORDERS = 256;

export interface XmExportPlan {
  xm: XmSong;
  notes: string[];
}

function patchOf(song: TrackerSongFile, slot: InstrumentSlot | undefined): Patch | undefined {
  return slot?.patchId ? song.data.songPatches[slot.patchId] : undefined;
}

/** `G`..`Z` continue the hex digits: FT2's effect letters are numbered 0..0x23. */
function effectTypeOfLetter(ch: string): number | undefined {
  if (/[0-9]/.test(ch)) return Number.parseInt(ch, 10);
  const code = ch.charCodeAt(0);
  if (code >= 65 && code <= 90) return 10 + (code - 65);
  return undefined;
}

function effectOf(entry: TrackerEntryData, notes: Set<string>): [number, number] {
  if (entry.effectCommand !== undefined && entry.effectParam !== undefined) {
    return [entry.effectCommand & 0xff, entry.effectParam & 0xff];
  }
  const text = (entry.macro ?? '').trim().toUpperCase();
  if (!text) return [0, 0];
  if (/^[0-9A-Z][0-9A-F]{2}$/.test(text)) {
    const type = effectTypeOfLetter(text[0]!);
    if (type !== undefined && type <= 0x23) return [type, Number.parseInt(text.slice(1), 16)];
  }
  notes.add("Effects a .xm doesn't have (macros and unknown commands) were left out.");
  return [0, 0];
}

function cellFromEntry(
  entry: TrackerEntryData,
  instruments: ReadonlyMap<number, XmInstrument>,
  notes: Set<string>,
): XmPatternCell {
  if (entry.xmCell && entry.xmSig === xmEntrySignature(entry)) {
    const [note, instrument, volumeColumn, effectType, effectParam] = entry.xmCell;
    return { note, instrument, volumeColumn, effectType, effectParam };
  }

  let note = 0;
  const parsed = parseTrackerNoteSymbol(entry.note);
  if (entry.note === '###') {
    note = 97;
  } else if (parsed.midi !== undefined) {
    const xmNote = parsed.midi - 11;
    if (xmNote < 1 || xmNote > 96) notes.add('Notes outside C-0 to B-7 were moved to the nearest note a .xm has.');
    note = Math.max(1, Math.min(96, xmNote));
  }

  let instrument = 0;
  if (entry.instrument !== undefined) {
    const n = Number.parseInt(entry.instrument, 10);
    if (Number.isFinite(n) && n >= 1 && n <= XM_MAX_INSTRUMENTS) instrument = n;
    else if (Number.isFinite(n) && n > XM_MAX_INSTRUMENTS) notes.add(`Instruments above ${XM_MAX_INSTRUMENTS} were left out; a .xm has ${XM_MAX_INSTRUMENTS}.`);
  }

  let volumeColumn = 0;
  if (entry.volumeCommand && /^[0-9A-Fa-f]{2}$/.test(entry.volumeCommand)) {
    volumeColumn = Number.parseInt(entry.volumeCommand, 16);
  } else {
    const velocity = parseTrackerVolume(entry.volume);
    if (velocity !== undefined) {
      const volume = Math.round((velocity / 255) * 64);
      const sample =
        instrument > 0 && note >= 1 && note <= 96
          ? xmSampleForNote(instruments.get(instrument) ?? { keymap: [], samples: [] as XmInstrument['samples'] }, note)
          : undefined;
      const implied = sample ? sample.volume : undefined;
      if (entry.volumeColumnVolume || volume !== implied) volumeColumn = 0x10 + Math.max(0, Math.min(64, volume));
    }
  }

  const [effectType, effectParam] = effectOf(entry, notes);
  return { note, instrument, volumeColumn, effectType, effectParam };
}

export function planXmExport(song: TrackerSongFile): XmExportPlan | { error: string } {
  const data = song.data;
  if (data.moduleFormat !== 'xm') {
    return { error: 'Only FastTracker 2 songs can be saved as a .xm.' };
  }
  const notes = new Set<string>();

  // Patterns in the order they first play: that is the .xm's own numbering.
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
  if (orders.length > MAX_ORDERS) return { error: `A .xm holds ${MAX_ORDERS} order positions; this song has ${orders.length}.` };
  if (patternIds.length > XM_MAX_PATTERNS) return { error: `A .xm holds ${XM_MAX_PATTERNS} patterns; this song has ${patternIds.length}.` };

  const used = patternIds.map((id) => byId.get(id)!);
  const numChannels = Math.max(1, ...used.map((p) => p.tracks.length));
  if (numChannels > XM_MAX_CHANNELS) return { error: `A .xm holds ${XM_MAX_CHANNELS} channels; this song has ${numChannels}.` };

  // Instrument n is slot n.
  const instruments: XmInstrument[] = [];
  const byNumber = new Map<number, XmInstrument>();
  let count = 0;
  for (const slot of data.instrumentSlots) {
    if (slot.slot > XM_MAX_INSTRUMENTS) {
      if (slot.patchId || slot.instrumentName) notes.add(`Instruments above ${XM_MAX_INSTRUMENTS} were left out; a .xm has ${XM_MAX_INSTRUMENTS}.`);
      continue;
    }
    const instrument = xmInstrumentOfSlot(slot, patchOf(song, slot));
    if (!instrument) {
      if (slot.patchId || slot.oplData || slot.ahxData) notes.add(`Instrument ${slot.slot} is not a sample and is written empty.`);
      continue;
    }
    if (instrument.volumeEnvelope.points.length > XM_MAX_ENVELOPE_POINTS || instrument.panningEnvelope.points.length > XM_MAX_ENVELOPE_POINTS) {
      notes.add(`Instrument ${slot.slot} has more than ${XM_MAX_ENVELOPE_POINTS} envelope points; the rest were cut.`);
    }
    if (instrument.samples.length > 16) notes.add(`Instrument ${slot.slot} has more than 16 samples; the rest were left out.`);
    if (instrument.samples.length === 0 && data.xmOrigin?.shortEmptyHeaders?.includes(slot.slot)) {
      instrument.emptyHeaderSize = 29;
    }
    byNumber.set(slot.slot, instrument);
    count = Math.max(count, slot.slot);
  }
  for (let i = 1; i <= Math.max(1, count); i++) {
    instruments.push(
      byNumber.get(i) ?? {
        ...(data.xmOrigin?.shortEmptyHeaders?.includes(i) ? { emptyHeaderSize: 29 } : {}),
        name: '',
        keymap: new Array(96).fill(0),
        samples: [],
        volumeEnvelope: emptyXmEnvelope(),
        panningEnvelope: emptyXmEnvelope(),
        volumeFadeout: 0,
        vibratoType: 0,
        vibratoSweep: 0,
        vibratoDepth: 0,
        vibratoRate: 0,
      },
    );
  }

  const patterns = used.map((pattern) => {
    const numRows = Math.max(1, Math.min(256, pattern.rows));
    const rows: XmPatternCell[][] = Array.from({ length: numRows }, () =>
      Array.from({ length: numChannels }, () => ({ note: 0, instrument: 0, volumeColumn: 0, effectType: 0, effectParam: 0 })),
    );
    pattern.tracks.forEach((track, channel) => {
      for (const entry of track.entries) {
        if (entry.row < 0 || entry.row >= numRows) continue;
        rows[entry.row]![channel] = cellFromEntry(entry, byNumber, notes);
      }
    });
    return { rows, numRows };
  });

  const xm: XmSong = {
    title: data.currentSong.title,
    trackerName: data.xmOrigin?.trackerName ?? FT2_TRACKER_NAME,
    version: 0x0104,
    numChannels,
    songLength: orders.length,
    restartPosition: Math.min(data.xmOrigin?.restartPosition ?? 0, Math.max(0, orders.length - 1)),
    orders: Array.from({ length: 256 }, (_, i) => orders[i] ?? 0),
    patterns,
    instruments,
    linearFrequency: data.linearFrequency ?? true,
    defaultSpeed: data.initialSpeed ?? DEFAULT_SPEED,
    defaultBpm: Math.max(32, Math.min(255, Math.round(data.currentSong.bpm || DEFAULT_BPM))),
  };
  return { xm, notes: [...notes] };
}

function check(song: TrackerSongFile): SongExportCheck {
  const plan = planXmExport(song);
  return 'error' in plan ? { ok: false, reason: plan.error } : { ok: true };
}

function warnings(song: TrackerSongFile): string[] {
  const plan = planXmExport(song);
  return 'error' in plan ? [] : plan.notes;
}

function serialize(song: TrackerSongFile): Uint8Array {
  const plan = planXmExport(song);
  if ('error' in plan) throw new SongExportError(plan.error);
  return writeXm(plan.xm);
}

export const xmExporter: SongExporter = {
  id: 'xm',
  label: 'FastTracker 2 module',
  extension: '.xm',
  mimeType: 'application/octet-stream',
  available: true,
  check,
  warnings,
  serialize,
};
