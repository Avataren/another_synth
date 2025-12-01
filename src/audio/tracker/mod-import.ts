import { uid } from 'quasar';
import type { TrackerSongFile, TrackerPattern, InstrumentSlot } from 'src/stores/tracker-store';
import type { TrackerTrackData, TrackerEntryData } from 'src/components/tracker/tracker-types';
import {
  type Patch,
  AudioAssetType,
  createDefaultPatchMetadata,
} from 'src/audio/types/preset-types';
import {
  SamplerLoopMode,
  SamplerTriggerMode,
  VoiceNodeType,
  type SamplerState,
  type VoiceLayout,
  type PatchLayout,
  type EnvelopeConfig,
} from 'src/audio/types/synth-layout';
import { PortId } from 'src/audio/types/generated/port-ids';
import type { ModulationTransformation, WasmModulationType } from 'app/public/wasm/audio_processor';
import { encodeFloat32ArrayToBase64 } from 'src/audio/serialization/audio-asset-encoder';
import {
  looksLikeMod as looksLikeModInternal,
  parseMod,
  type ModSong,
  type ModPatternCell,
  type ModSample,
} from '../../../packages/tracker-playback/src/mod-parser';

const MAX_TRACKS = 4; // 4-channel MODs only
const PATTERN_ROWS = 64;
const DEFAULT_BPM = 125;
const DEFAULT_STEP_SIZE = 1;
const MAX_SLOTS = 25;
const DEFAULT_SAMPLE_RATE = 44100;

export const looksLikeMod = looksLikeModInternal;

export function importModToTrackerSong(buffer: ArrayBuffer): TrackerSongFile {
  const bytes = new Uint8Array(buffer);
  const mod: ModSong = parseMod(bytes);

  const patterns = buildTrackerPatterns(mod);
  const sequenceIds = patterns.map((p) => p.id);

  const { slots, songPatches } = buildInstrumentSlotsAndPatches(mod);

  const songFile: TrackerSongFile = {
    version: 1,
    data: {
      currentSong: {
        title: mod.title || 'Imported MOD',
        author: 'Unknown',
        bpm: DEFAULT_BPM,
      },
      patternRows: PATTERN_ROWS,
      stepSize: DEFAULT_STEP_SIZE,
      patterns,
      sequence: sequenceIds.slice(0, mod.songLength || sequenceIds.length),
      currentPatternId: patterns[0]?.id ?? null,
      instrumentSlots: slots,
      activeInstrumentId: (() => {
        const firstUsed = slots.find((s) => s.patchId);
        return firstUsed ? formatInstrumentId(firstUsed.slot) : null;
      })(),
      currentInstrumentPage: 0,
      songPatches,
    },
  };

  return songFile;
}

function buildTrackerPatterns(mod: ModSong): TrackerPattern[] {
  const patternCount = mod.patterns.length;
  const trackCount = Math.min(mod.numChannels, MAX_TRACKS);

  const patterns: TrackerPattern[] = [];

  for (let p = 0; p < patternCount; p++) {
    const patternId = uid();

    const tracks: TrackerTrackData[] = [];
    for (let ch = 0; ch < trackCount; ch++) {
      tracks.push({
        id: `T${(ch + 1).toString().padStart(2, '0')}`,
        name: `Track ${ch + 1}`,
        entries: [],
        interpolations: [],
      });
    }

    for (let row = 0; row < PATTERN_ROWS; row++) {
      for (let ch = 0; ch < trackCount; ch++) {
        const cell: ModPatternCell | undefined =
          mod.patterns[p]?.rows[row]?.[ch];
        if (!cell) continue;

        const entry = modCellToTrackerEntry(cell, row);
        if (!entry) continue;

        const track = tracks[ch];
        if (!track) continue;
        track.entries.push(entry);
      }
    }

    patterns.push({
      id: patternId,
      name: `Pattern ${p + 1}`,
      tracks,
    });
  }

  return patterns;
}

function modCellToTrackerEntry(
  cell: ModPatternCell,
  row: number,
): TrackerEntryData | undefined {
  const { period, sampleNumber, effectCmd, effectParam } = cell;

  const hasNote = period > 0;
  const hasSample = sampleNumber > 0;
  const hasEffect = effectCmd !== 0 || effectParam !== 0;

  if (!hasNote && !hasSample && !hasEffect) {
    return undefined;
  }

  const entry: TrackerEntryData = { row };

  if (hasSample) {
    entry.instrument = formatInstrumentId(sampleNumber);
  }

  if (hasNote) {
    const midi = periodToMidi(period);
    if (midi !== undefined) {
      entry.note = midiToTrackerNote(midi);
    }
  }

  if (hasEffect) {
    const cmdHex = effectCmd.toString(16).toUpperCase();
    const paramHex = effectParam.toString(16).toUpperCase().padStart(2, '0');

    // 0xy is arpeggio; treat 000 as no-op.
    if (!(effectCmd === 0 && effectParam === 0)) {
      entry.macro = `${cmdHex}${paramHex}`;
    }
  }

  return entry;
}

function buildInstrumentSlotsAndPatches(mod: ModSong): {
  slots: InstrumentSlot[];
  songPatches: Record<string, Patch>;
} {
  const usedSamples = new Set<number>();
  for (const pattern of mod.patterns) {
    for (const row of pattern.rows) {
      for (const cell of row) {
        if (cell.sampleNumber > 0) {
          usedSamples.add(cell.sampleNumber);
        }
      }
    }
  }

  const slots: InstrumentSlot[] = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    slots.push({
      slot: i + 1,
      bankName: '',
      patchName: '',
      instrumentName: '',
    });
  }

  const songPatches: Record<string, Patch> = {};

  const sortedSamples = Array.from(usedSamples).sort((a, b) => a - b);

  for (const sampleNumber of sortedSamples) {
    if (sampleNumber < 1 || sampleNumber > mod.samples.length) continue;
    if (sampleNumber > MAX_SLOTS) {
      // Extra samples beyond available slots are ignored for now.
      // They will show up with instrument IDs that have no patch.
      continue;
    }

    const sampleMeta = mod.samples[sampleNumber - 1];
    if (!sampleMeta) continue;
    const patch = createSamplerPatchForSample(sampleMeta, sampleNumber);
    const slotIndex = sampleNumber - 1;
    const slot = slots[slotIndex];
    if (!slot) continue;

    slot.bankName = 'MOD Import';
    slot.patchId = patch.metadata.id;
    slot.patchName = patch.metadata.name;
    slot.instrumentName = patch.metadata.name;
    slot.source = 'song';

    const normalizedVolume = Math.max(
      0,
      Math.min(2, sampleMeta.volume / 32),
    );
    slot.volume = normalizedVolume;

    songPatches[patch.metadata.id] = patch;
  }

  return { slots, songPatches };
}

function createSamplerPatchForSample(
  sample: ModSample,
  sampleIndex: number,
): Patch {
  const samplerNodeId = generateNodeId('sampler');
  const mixerNodeId = generateNodeId('mixer');
  const envelopeNodeId = generateNodeId('envelope');
  const patchName = sample.name || `Instrument ${formatInstrumentId(sampleIndex)}`;
  const metadata = createDefaultPatchMetadata(patchName, 'Imported/MOD');

  const floatData = convertSampleToFloat32(sample);

  const audioAsset = encodeFloat32ArrayToBase64(
    floatData,
    DEFAULT_SAMPLE_RATE,
    1,
    AudioAssetType.Sample,
    samplerNodeId,
    sample.name || undefined,
    60,
  );

  const sampleLengthFrames = Math.max(1, sample.length);
  const loopEnabled = sample.loopLength > 2;
  const loopStartFrames = Math.min(sample.loopStart, sampleLengthFrames - 1);
  const loopEndFrames = Math.min(
    loopStartFrames + sample.loopLength,
    sampleLengthFrames,
  );

  const samplerState: SamplerState = {
    id: samplerNodeId,
    frequency: 440,
    gain: Math.max(0, Math.min(2, sample.volume / 64)),
    detune_oct: 0,
    detune_semi: 0,
    detune_cents: 0,
    detune: 0,
    loopMode: loopEnabled ? SamplerLoopMode.Loop : SamplerLoopMode.Off,
    loopStart: loopEnabled ? loopStartFrames / sampleLengthFrames : 0,
    loopEnd: loopEnabled ? loopEndFrames / sampleLengthFrames : 1,
    sampleLength: sampleLengthFrames,
    rootNote: 60,
    triggerMode: SamplerTriggerMode.Gate,
    active: true,
    sampleRate: DEFAULT_SAMPLE_RATE,
    channels: 1,
  };
  if (sample.name) {
    samplerState.fileName = sample.name;
  }

  const canonicalVoice: VoiceLayout = {
    id: 0,
    nodes: {
      [VoiceNodeType.Oscillator]: [],
      [VoiceNodeType.WavetableOscillator]: [],
      [VoiceNodeType.Filter]: [],
      [VoiceNodeType.Envelope]: [
        {
          id: envelopeNodeId,
          type: VoiceNodeType.Envelope,
          name: 'Amp Envelope',
        },
      ],
      [VoiceNodeType.LFO]: [],
      [VoiceNodeType.Mixer]: [
        {
          id: mixerNodeId,
          type: VoiceNodeType.Mixer,
          name: 'Mixer',
        },
      ],
      [VoiceNodeType.Noise]: [],
      [VoiceNodeType.Sampler]: [
        {
          id: samplerNodeId,
          type: VoiceNodeType.Sampler,
          name: sample.name || `Sampler ${sampleIndex}`,
        },
      ],
      [VoiceNodeType.Glide]: [],
      [VoiceNodeType.GlobalFrequency]: [
        {
          id: generateNodeId('global_frequency'),
          type: VoiceNodeType.GlobalFrequency,
          name: 'Global Frequency',
        },
      ],
      [VoiceNodeType.GlobalVelocity]: [
        {
          id: generateNodeId('global_velocity'),
          type: VoiceNodeType.GlobalVelocity,
          name: 'Global Velocity',
        },
      ],
      [VoiceNodeType.Convolver]: [],
      [VoiceNodeType.Delay]: [],
      [VoiceNodeType.GateMixer]: [
        {
          id: generateNodeId('gatemixer'),
          type: VoiceNodeType.GateMixer,
          name: 'Gate Mixer',
        },
      ],
      [VoiceNodeType.ArpeggiatorGenerator]: [],
      [VoiceNodeType.Chorus]: [],
      [VoiceNodeType.Limiter]: [],
      [VoiceNodeType.Reverb]: [],
      [VoiceNodeType.Compressor]: [],
      [VoiceNodeType.Saturation]: [],
      [VoiceNodeType.Bitcrusher]: [],
    },
    connections: [
      {
        fromId: samplerNodeId,
        toId: mixerNodeId,
        target: PortId.AudioInput0,
        amount: 1,
        modulationType: 2 as WasmModulationType,
        modulationTransformation: 0 as ModulationTransformation,
      },
      {
        fromId: envelopeNodeId,
        toId: mixerNodeId,
        target: PortId.GainMod,
        amount: 1,
        modulationType: 0 as WasmModulationType,
        modulationTransformation: 0 as ModulationTransformation,
      },
    ],
  };

  const layout: PatchLayout = {
    voiceCount: 1,
    canonicalVoice,
    globalNodes: {},
  };

  const patch: Patch = {
    metadata,
    synthState: {
      layout,
      oscillators: {},
      wavetableOscillators: {},
      filters: {},
      envelopes: {
        [envelopeNodeId]: {
          id: envelopeNodeId,
          active: true,
          attack: 0,
          decay: 0,
          sustain: 1,
          release: 0,
          attackCurve: 0,
          decayCurve: 0,
          releaseCurve: 0,
        } satisfies EnvelopeConfig,
      },
      lfos: {},
      samplers: {
        [samplerNodeId]: samplerState,
      },
      glides: {},
      convolvers: {},
      delays: {},
      choruses: {},
      reverbs: {},
      compressors: {},
      saturations: {},
      bitcrushers: {},
      instrumentGain: 1.0,
    },
    audioAssets: {
      [audioAsset.id]: audioAsset,
    },
  };

  return patch;
}

export function convertSampleToFloat32(sample: ModSample): Float32Array {
  const data = sample.data;
  const floats = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    // 8-bit signed -> -1..1
    floats[i] = (data[i] ?? 0) / 128;
  }
  return floats;
}

function formatInstrumentId(slotNumber: number): string {
  return slotNumber.toString().padStart(2, '0');
}

function generateNodeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as unknown as { randomUUID: () => string }).randomUUID();
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function periodToMidi(period: number): number | undefined {
  if (!period || !Number.isFinite(period)) return undefined;
  // Approximate Amiga PAL clock formula:
  // Paula frequency = 7093789.2 Hz (PAL), output frequency = clock / (2 * period).
  const AMIGA_CLOCK = 7093789.2;
  const freq = AMIGA_CLOCK / (2 * period);
  if (!Number.isFinite(freq) || freq <= 0) return undefined;

  // Map to MIDI space but with a fixed octave offset so typical MOD ranges
  // land around C-1..C-5 instead of up around F-9.
  //
  // Using A4 = 440 Hz as the reference and subtracting 84 semitones (7 octaves)
  // puts period 1712 (~C-1 in ProTracker tables) near MIDI 24 (C-1),
  // and period 428 (~C-3) near MIDI 48 (C-3).
  const rawMidi = 69 + 12 * Math.log2(freq / 440) - 84;
  const rounded = Math.round(rawMidi);
  if (rounded < 0 || rounded > 127) return undefined;
  return rounded;
}

function midiToTrackerNote(midi: number): string {
  const names = [
    'C-',
    'C#',
    'D-',
    'D#',
    'E-',
    'F-',
    'F#',
    'G-',
    'G#',
    'A-',
    'A#',
    'B-',
  ];
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const name = names[clamped % 12] ?? 'C-';
  const octave = Math.floor(clamped / 12) - 1;
  return `${name}${octave}`;
}
