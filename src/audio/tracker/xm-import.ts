import { uid } from 'quasar';
import type {
  TrackerSongFile,
  TrackerPattern,
  InstrumentSlot,
} from 'src/stores/tracker-store';
import {
  TOTAL_SLOTS,
  CURRENT_SONG_FILE_VERSION,
  clampPatternRows,
} from 'src/stores/tracker-store';
import type {
  TrackerTrackData,
  TrackerEntryData,
} from 'src/components/tracker/tracker-types';
import type { Patch } from 'src/audio/types/preset-types';
import {
  SamplerLoopMode,
  type TrackerVolumeEnvelope,
} from 'src/audio/types/synth-layout';
import { createSamplerPatch } from 'src/audio/tracker/sampler-patch-builder';
import {
  looksLikeXm as looksLikeXmInternal,
  parseXm,
  XM_KEY_OFF,
  type XmSong,
  type XmInstrument,
  type XmPatternCell,
  type XmSample,
} from '../../../packages/tracker-playback/src/formats/xm';
import {
  createLinearPitchModel,
  createXmAmigaPitchModel,
  type PitchModel,
} from '../../../packages/tracker-playback/src/pitch-model';

export const looksLikeXm = looksLikeXmInternal;

const DEFAULT_STEP_SIZE = 1;
/**
 * The sample buffer is declared at this rate regardless of its true rate, and
 * the root note compensates. Matches what mod-import does.
 */
const ASSET_SAMPLE_RATE = 44100;

/**
 * MIDI note at which an XM sample with relativeNote 0 plays untransposed.
 *
 * The sampler computes playbackRate = scheduledFrequency / f(rootNote), and we
 * schedule frequencies in musical Hz (the XM rate divided by 32, see
 * pitch-model.ts). For the buffer -- declared at ASSET_SAMPLE_RATE -- to play
 * back at the XM rate, f(rootNote) must equal ASSET_SAMPLE_RATE / 32, so
 *
 *   rootNote = 69 + 12*log2(ASSET_SAMPLE_RATE / 32 / 440) = 88.77
 *
 * The same derivation with MOD's /128 scale gives 64.77, which is where
 * mod-import's empirically calibrated root note of 65 comes from -- a useful
 * check that this is the right relation rather than a fitted number.
 */
const XM_ROOT_NOTE =
  69 + 12 * Math.log2(ASSET_SAMPLE_RATE / 32 / 440);

/** XM note 1 is C-0, which is MIDI 12. */
const XM_NOTE_TO_MIDI_OFFSET = 11;

/** XM finetune spans -128..127 across one semitone. */
const FINETUNE_UNITS_PER_SEMITONE = 128;

export function importXmToTrackerSong(buffer: ArrayBuffer): TrackerSongFile {
  const bytes = new Uint8Array(buffer);
  const xm: XmSong = parseXm(bytes);

  // eslint-disable-next-line no-console
  console.log('[XM Import]', {
    title: xm.title,
    tracker: xm.trackerName,
    channels: xm.numChannels,
    patterns: xm.patterns.length,
    instruments: xm.instruments.length,
    linearFrequency: xm.linearFrequency,
  });

  const pitch: PitchModel = xm.linearFrequency
    ? createLinearPitchModel()
    : createXmAmigaPitchModel();

  const { slots, songPatches, slotForInstrument } =
    buildInstrumentSlotsAndPatches(xm);

  const patterns = buildTrackerPatterns(xm, pitch, slotForInstrument);

  const sequenceIds: string[] = [];
  const orderLength = Math.min(xm.songLength || xm.orders.length, xm.orders.length);
  for (let i = 0; i < orderLength; i++) {
    const pattern = patterns[xm.orders[i] ?? 0];
    if (pattern) sequenceIds.push(pattern.id);
  }

  return {
    version: CURRENT_SONG_FILE_VERSION,
    data: {
      currentSong: {
        title: xm.title || 'Imported XM',
        author: 'Unknown',
        bpm: xm.defaultBpm || 125,
      },
      moduleFormat: 'xm',
      // XM declares its own ticks-per-row; most modules use something other
      // than the tracker default of 6.
      initialSpeed: xm.defaultSpeed || 6,
      patternRows: clampPatternRows(patterns[0]?.rows),
      stepSize: DEFAULT_STEP_SIZE,
      patterns,
      sequence: sequenceIds,
      currentPatternId: sequenceIds[0] ?? patterns[0]?.id ?? null,
      instrumentSlots: slots,
      activeInstrumentId: (() => {
        const firstUsed = slots.find((s) => s.patchId);
        return firstUsed ? formatInstrumentId(firstUsed.slot) : null;
      })(),
      currentInstrumentPage: 0,
      songPatches,
    },
  };
}

function buildTrackerPatterns(
  xm: XmSong,
  pitch: PitchModel,
  slotForInstrument: Map<number, number>,
): TrackerPattern[] {
  return xm.patterns.map((pattern, index) => {
    const tracks: TrackerTrackData[] = [];
    for (let ch = 0; ch < xm.numChannels; ch++) {
      tracks.push({
        id: `T${(ch + 1).toString().padStart(2, '0')}`,
        name: `Track ${ch + 1}`,
        entries: [],
        interpolations: [],
      });
    }

    for (let row = 0; row < pattern.rows.length; row++) {
      for (let ch = 0; ch < xm.numChannels; ch++) {
        const cell = pattern.rows[row]?.[ch];
        if (!cell) continue;
        const entry = xmCellToTrackerEntry(cell, row, xm, pitch, slotForInstrument);
        if (!entry) continue;
        tracks[ch]?.entries.push(entry);
      }
    }

    return {
      id: uid(),
      name: `Pattern ${index + 1}`,
      rows: clampPatternRows(pattern.numRows),
      tracks,
    };
  });
}

/**
 * The frequency a note should sound at, in the engine's musical-Hz domain.
 *
 * Only the written note is converted here. A sample's `relativeNote` is folded
 * into its patch root note instead, so it must not be applied twice.
 */
function frequencyForNote(note: number, pitch: PitchModel): number | undefined {
  if (note < 1 || note > 96) return undefined;
  const zeroBased = note - 1;
  const period =
    pitch.kind === 'linear'
      ? 7680 - zeroBased * 64
      : 1712 * Math.pow(2, (48 - zeroBased) / 12);
  return pitch.frequencyFromPeriod(period);
}

function xmCellToTrackerEntry(
  cell: XmPatternCell,
  row: number,
  xm: XmSong,
  pitch: PitchModel,
  slotForInstrument: Map<number, number>,
): TrackerEntryData | undefined {
  const hasNote = cell.note > 0 && cell.note <= 96;
  const isKeyOff = cell.note === XM_KEY_OFF;
  const hasInstrument = cell.instrument > 0;
  const hasEffect = cell.effectType !== 0 || cell.effectParam !== 0;
  const hasVolumeColumn = cell.volumeColumn > 0;

  if (!hasNote && !isKeyOff && !hasInstrument && !hasEffect && !hasVolumeColumn) {
    return undefined;
  }

  const entry: TrackerEntryData = { row };

  if (hasInstrument) {
    const slot = slotForInstrument.get(cell.instrument);
    if (slot !== undefined) entry.instrument = formatInstrumentId(slot);
  }

  if (isKeyOff) {
    // The tracker's note-off symbol; the engine releases the track's voice.
    entry.note = '###';
  } else if (hasNote) {
    entry.note = midiToTrackerNote(cell.note + XM_NOTE_TO_MIDI_OFFSET);
    const frequency = frequencyForNote(cell.note, pitch);
    if (frequency !== undefined) entry.frequency = frequency;
  }

  // Volume column: 0x10..0x50 is "set volume" 0..64, which is a velocity like
  // any other. From 0x60 up it holds commands -- volume and pan slides, fine
  // slides, panning, vibrato, tone portamento -- which are carried separately
  // (see TrackerEntryData.volumeCommand) because they have no velocity
  // meaning and run alongside the effect column rather than replacing it.
  if (cell.volumeColumn >= 0x60) {
    entry.volumeCommand = cell.volumeColumn
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
  }

  if (cell.volumeColumn >= 0x10 && cell.volumeColumn <= 0x50) {
    const volume = cell.volumeColumn - 0x10; // 0..64
    entry.volume = Math.round((volume / 64) * 255)
      .toString(16)
      .toUpperCase()
      .padStart(2, '0');
  } else if (hasNote && hasInstrument) {
    // A note with an instrument and no explicit volume plays at the sample's
    // default, as in ProTracker.
    const sample = firstSampleOf(xm.instruments[cell.instrument - 1]);
    if (sample) {
      entry.volume = Math.round((sample.volume / 64) * 255)
        .toString(16)
        .toUpperCase()
        .padStart(2, '0');
    }
  }

  const macro = xmEffectToMacro(cell.effectType, cell.effectParam);
  if (macro) entry.macro = macro;

  return entry;
}

/**
 * Map an XM effect to the tracker's text macro form.
 *
 * XM numbers its effects 0..0x22: 0-0xF match the MOD/ProTracker letters this
 * tracker already understands, and 0x10+ are FT2's extras (Gxx global volume,
 * Kxx key off, Rxy retrigger and so on), which continue the alphabet.
 */
function xmEffectToMacro(effectType: number, effectParam: number): string | undefined {
  if (effectType === 0 && effectParam === 0) return undefined;

  const paramHex = effectParam.toString(16).toUpperCase().padStart(2, '0');

  // 0..0xF share ProTracker's numbering, so reuse the same characters.
  const prefixes = '0123456789ABCDEF';
  if (effectType < prefixes.length) {
    const prefix = prefixes[effectType]!;
    // 000 is a no-op rather than an arpeggio.
    if (effectType === 0 && effectParam === 0) return undefined;
    return `${prefix}${paramHex}`;
  }

  // 0x10 = G, 0x11 = H, ... continuing past F.
  const extended = String.fromCharCode('G'.charCodeAt(0) + (effectType - 0x10));
  return `${extended}${paramHex}`;
}

function firstSampleOf(instrument: XmInstrument | undefined): XmSample | undefined {
  if (!instrument) return undefined;
  return instrument.samples.find((s) => s.data.length > 0) ?? instrument.samples[0];
}

/**
 * How many distinct channels ever play each instrument.
 *
 * A tracker channel is monophonic and owns a voice of its own, so an
 * instrument needs one voice per channel that ever uses it -- not merely
 * enough for the peak overlap. Sizing by peak would leave a channel without a
 * voice of its own and put it back to stealing from another channel, which is
 * heard as notes going missing.
 *
 * Voices cost nothing until a note actually sounds on them: the instrument
 * only builds audio nodes at note-on.
 */
function measureChannelsPerInstrument(xm: XmSong): Map<number, Set<number>> {
  const channels = new Map<number, Set<number>>();

  for (const pattern of xm.patterns) {
    for (const row of pattern.rows) {
      row.forEach((cell, channel) => {
        if (cell.instrument > 0) {
          let set = channels.get(cell.instrument);
          if (!set) {
            set = new Set<number>();
            channels.set(cell.instrument, set);
          }
          set.add(channel);
        }
      });
    }
  }

  return channels;
}

function buildInstrumentSlotsAndPatches(xm: XmSong): {
  slots: InstrumentSlot[];
  songPatches: Record<string, Patch>;
  slotForInstrument: Map<number, number>;
} {
  // Only instruments actually referenced by pattern data need a slot. XM files
  // routinely declare far more than they use -- jt_letgo.xm declares 128 and
  // uses 8 -- so allocating for every declared instrument would exhaust the
  // slots on songs that comfortably fit.
  const referenced = new Set<number>();
  for (const pattern of xm.patterns) {
    for (const row of pattern.rows) {
      for (const cell of row) {
        if (cell.instrument > 0) referenced.add(cell.instrument);
      }
    }
  }

  const slots: InstrumentSlot[] = Array.from({ length: TOTAL_SLOTS }, (_, i) => ({
    slot: i + 1,
    bankName: '',
    patchName: '',
    instrumentName: '',
  }));

  const songPatches: Record<string, Patch> = {};
  const slotForInstrument = new Map<number, number>();
  const channelsPerInstrument = measureChannelsPerInstrument(xm);

  let nextSlot = 1;
  for (const instrumentNumber of [...referenced].sort((a, b) => a - b)) {
    const instrument = xm.instruments[instrumentNumber - 1];
    const sample = firstSampleOf(instrument);
    if (!instrument || !sample || sample.data.length === 0) continue;
    if (nextSlot > TOTAL_SLOTS) {
      // eslint-disable-next-line no-console
      console.warn(
        `[XM Import] Out of instrument slots; dropping instrument ${instrumentNumber}`,
      );
      break;
    }

    const patch = createSamplerPatchForXmSample(
      instrument,
      sample,
      instrumentNumber,
      channelsPerInstrument.get(instrumentNumber)?.size ?? 1,
    );
    const slot = slots[nextSlot - 1];
    if (!slot) break;

    slot.bankName = 'XM Import';
    slot.patchId = patch.metadata.id;
    slot.patchName = patch.metadata.name;
    slot.instrumentName = patch.metadata.name;
    slot.source = 'song';
    slot.instrumentType = 'mod';
    slot.volume = 1.0;

    songPatches[patch.metadata.id] = patch;
    slotForInstrument.set(instrumentNumber, nextSlot);
    nextSlot++;
  }

  return { slots, songPatches, slotForInstrument };
}

/**
 * Convert an XM instrument's volume envelope into the engine's form.
 *
 * Returns undefined when the instrument has neither an enabled envelope nor a
 * fadeout, so instruments that do not need one carry no extra state.
 */
function toTrackerEnvelope(
  instrument: XmInstrument,
): TrackerVolumeEnvelope | undefined {
  const env = instrument.volumeEnvelope;
  const hasEnvelope = env.enabled && env.points.length > 0;
  if (!hasEnvelope && instrument.volumeFadeout <= 0) return undefined;

  return {
    points: hasEnvelope
      ? env.points.map((p) => ({ tick: p.frame, value: p.value }))
      : [],
    // A sustain point only applies when the instrument enables sustain;
    // otherwise the envelope runs straight through.
    sustainPoint: hasEnvelope && env.sustainEnabled ? env.sustainPoint : -1,
    loopStart: env.loopStart,
    loopEnd: env.loopEnd,
    loopEnabled: hasEnvelope && env.loopEnabled,
    fadeout: instrument.volumeFadeout,
  };
}

function createSamplerPatchForXmSample(
  instrument: XmInstrument,
  sample: XmSample,
  instrumentNumber: number,
  channelCount: number,
): Patch {
  const sampleLengthFrames = Math.max(1, sample.data.length);
  const loopEnabled = sample.loopType !== 'none' && sample.loopLength > 0;
  const envelope = toTrackerEnvelope(instrument);

  return createSamplerPatch({
    name: instrument.name || sample.name,
    fallbackName: `Instrument ${formatInstrumentId(instrumentNumber)}`,
    category: 'Imported/XM',
    data: sample.data,
    sampleRate: ASSET_SAMPLE_RATE,
    // relativeNote transposes the sample, which is equivalent to moving the
    // root note the other way. Folding it in here keeps note scheduling free
    // of per-sample tuning.
    rootNote: XM_ROOT_NOTE - sample.relativeNote,
    detuneCents: (sample.finetune / FINETUNE_UNITS_PER_SEMITONE) * 100,
    gain: sample.volume === 0 ? 1 : sample.volume / 64,
    loopMode: loopEnabled
      ? sample.loopType === 'pingpong'
        ? SamplerLoopMode.PingPong
        : SamplerLoopMode.Loop
      : SamplerLoopMode.Off,
    loopStartFrames: loopEnabled ? sample.loopStart : 0,
    loopLengthFrames: loopEnabled ? sample.loopLength : sampleLengthFrames,
    // One voice per channel that ever plays this instrument, so every channel
    // owns one and none has to steal.
    voiceCount: Math.max(1, Math.min(32, channelCount)),
    ...(envelope ? { trackerEnvelope: envelope } : {}),
  });
}

function formatInstrumentId(slotNumber: number): string {
  return slotNumber.toString().padStart(2, '0');
}

function midiToTrackerNote(midi: number): string {
  const names = [
    'C-', 'C#', 'D-', 'D#', 'E-', 'F-',
    'F#', 'G-', 'G#', 'A-', 'A#', 'B-',
  ];
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const name = names[clamped % 12] ?? 'C-';
  const octave = Math.floor(clamped / 12) - 1;
  return `${name}${octave}`;
}
