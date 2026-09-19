/**
 * View model for the read-only AHX instrument display.
 *
 * Pure functions over the parsed `AhxInstrument`: nothing here plays or
 * changes anything. The meanings follow the vendored reference replayer
 * (`hvl_replay.c`: `hvl_plist_command_parse` and the ADSR block of
 * `hvl_process_frame`), so what the page prints is what the engine does.
 */
import type {
  AhxEnvelope,
  AhxInstrument,
  AhxPListEntry,
} from '@another-synth/tracker-playback';

// ---------------------------------------------------------------------------
// Waveforms
// ---------------------------------------------------------------------------

export type AhxWaveformKind = 'triangle' | 'sawtooth' | 'square' | 'noise';

const WAVEFORM_KINDS: readonly AhxWaveformKind[] = [
  'triangle',
  'sawtooth',
  'square',
  'noise',
];

/**
 * A PList entry's waveform field: 0 leaves the voice's waveform alone,
 * 1..=4 selects triangle / sawtooth / square / noise. Anything above that has
 * no table in the replayer; it is reported as unknown rather than guessed.
 */
export function ahxWaveformKind(field: number): AhxWaveformKind | 'keep' | 'unknown' {
  if (field === 0) return 'keep';
  return WAVEFORM_KINDS[field - 1] ?? 'unknown';
}

export function ahxWaveformLabel(field: number): string {
  const kind = ahxWaveformKind(field);
  if (kind === 'keep') return '—';
  if (kind === 'unknown') return `?${field}`;
  return kind[0]!.toUpperCase() + kind.slice(1);
}

/** Cycle length in samples of the instrument's waveforms: 4 << waveLength (4..=128). */
export function ahxWaveCycleLength(waveLength: number): number {
  return 4 << Math.max(0, Math.min(5, waveLength));
}

export interface AhxWaveformUse {
  kind: AhxWaveformKind | 'unknown';
  /** The raw field value: 1..=4 for a known waveform. */
  field: number;
  /** How many PList entries select it. */
  count: number;
  /** The PList row that selects it first. */
  firstRow: number;
}

/**
 * The waveforms an instrument's PList selects, in order of first use. This is
 * the instrument's waveform list: an AHX instrument has no waveform of its own
 * apart from what its PList picks (the first non-zero entry sets the timbre a
 * note starts with).
 */
export function ahxWaveformList(instrument: AhxInstrument): AhxWaveformUse[] {
  const uses = new Map<number, AhxWaveformUse>();
  instrument.plist.entries.forEach((entry, row) => {
    if (entry.waveform === 0) return;
    const kind = ahxWaveformKind(entry.waveform);
    const existing = uses.get(entry.waveform);
    if (existing) {
      existing.count++;
      return;
    }
    uses.set(entry.waveform, {
      kind: kind === 'keep' ? 'unknown' : kind,
      field: entry.waveform,
      count: 1,
      firstRow: row,
    });
  });
  return [...uses.values()];
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export const AHX_MAX_VOLUME = 64;

export interface AhxEnvelopePoint {
  /** Frames since the note started (one frame = one replay tick). */
  frame: number;
  /** 0..=64. */
  volume: number;
}

/**
 * The volume envelope taken at face value, as a polyline: silence, attack to
 * `aVolume`, decay to `dVolume`, hold for the sustain frames, release to
 * `rVolume`. This is the *ideal* envelope the four (frames, volume) pairs
 * describe, and it is where the editor's nodes sit. It is NOT what the engine
 * plays when a stage has 0 frames: the replayer skips such a stage rather than
 * jumping to its volume (see `simulateAhxEnvelope` in `ahx-envelope-sim.ts`,
 * which draws the engine's curve).
 */
export function ahxEnvelopePoints(envelope: AhxEnvelope): AhxEnvelopePoint[] {
  const points: AhxEnvelopePoint[] = [{ frame: 0, volume: 0 }];
  let frame = 0;
  const stage = (frames: number, volume: number): void => {
    frame += frames;
    points.push({ frame, volume });
  };
  stage(envelope.aFrames, envelope.aVolume);
  stage(envelope.dFrames, envelope.dVolume);
  stage(envelope.sFrames, envelope.dVolume);
  stage(envelope.rFrames, envelope.rVolume);
  return points;
}

// ---------------------------------------------------------------------------
// PList
// ---------------------------------------------------------------------------

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** PList / track note number (1 = C-1 .. 60 = B-5) as tracker text; 0 is empty. */
export function ahxNoteName(note: number): string {
  if (note <= 0) return '---';
  const index = note - 1;
  const name = NOTE_NAMES[index % 12]!;
  return `${name.length === 1 ? `${name}-` : name}${Math.floor(index / 12) + 1}`;
}

const PLIST_FX_NAMES: Readonly<Record<number, string>> = {
  0: 'Filter position',
  1: 'Slide up',
  2: 'Slide down',
  3: 'Square position',
  4: 'Square/filter modulation',
  5: 'Jump to row',
  7: 'Ring modulate (triangle)',
  8: 'Ring modulate (sawtooth)',
  9: 'Pan',
  12: 'Volume',
  15: 'Speed',
};

/** One PList command as text: '' for the empty slot (command 0, param 0). */
export function ahxPListFxText(fx: number, param: number): string {
  if (fx === 0 && param === 0) return '';
  const hex = (n: number, w: number): string => n.toString(16).toUpperCase().padStart(w, '0');
  return `${hex(fx, 1)}${hex(param, 2)}`;
}

/** The command's name, or '' for the empty slot / an unassigned command. */
export function ahxPListFxName(fx: number, param: number): string {
  if (fx === 0 && param === 0) return '';
  return PLIST_FX_NAMES[fx] ?? '';
}

export interface AhxPListRow {
  index: number;
  note: string;
  fixed: boolean;
  waveform: string;
  fx: Array<{ text: string; name: string }>;
}

export function ahxPListRows(entries: readonly AhxPListEntry[]): AhxPListRow[] {
  return entries.map((entry, index) => ({
    index,
    note: ahxNoteName(entry.note),
    fixed: entry.fixed,
    waveform: ahxWaveformLabel(entry.waveform),
    fx: [0, 1].map((i) => ({
      text: ahxPListFxText(entry.fx[i] ?? 0, entry.fxParam[i] ?? 0),
      name: ahxPListFxName(entry.fx[i] ?? 0, entry.fxParam[i] ?? 0),
    })),
  }));
}
