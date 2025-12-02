import { uid } from 'quasar';
import type {
  TrackerSongFile,
  TrackerPattern,
  InstrumentSlot,
} from 'src/stores/tracker-store';
import type {
  TrackerTrackData,
  TrackerEntryData,
} from 'src/components/tracker/tracker-types';
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
  type LfoState,
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

function resolveSamplerGain(sample: ModSample): number {
  // ProTracker sample volumes are initial defaults that Cxx commands override.
  // Since the synth architecture multiplies samplerGain × voiceGain, and we
  // want Cxx commands to directly control volume without double-scaling, always
  // use unity gain at the sampler level. Sample default volumes are handled by
  // converting them to Cxx commands at import time.
  const raw = Number.isFinite(sample.volume) ? sample.volume : 64;
  const clamped = Math.max(0, Math.min(64, raw));
  return clamped / 64;
}

export const looksLikeMod = looksLikeModInternal;

export function importModToTrackerSong(buffer: ArrayBuffer): TrackerSongFile {
  const bytes = new Uint8Array(buffer);
  const mod: ModSong = parseMod(bytes);

  const patterns = buildTrackerPatterns(mod);
  // Build song sequence from the MOD order table so repeated
  // patterns (e.g. first pattern listed twice) are preserved.
  const sequenceIds: string[] = [];
  const orderLength = mod.songLength || mod.orders.length;
  for (let i = 0; i < orderLength; i++) {
    const patIndex = mod.orders[i] ?? 0;
    const pattern = patterns[patIndex];
    if (pattern) {
      sequenceIds.push(pattern.id);
    }
  }

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

    // Track the last volume set on each channel (ProTracker behavior: volume "sticks")
    const channelVolumes: (string | undefined)[] = new Array(trackCount).fill(undefined);

    for (let row = 0; row < PATTERN_ROWS; row++) {
      for (let ch = 0; ch < trackCount; ch++) {
        const cell: ModPatternCell | undefined =
          mod.patterns[p]?.rows[row]?.[ch];
        if (!cell) continue;

        const panNorm = resolveChannelPanNorm(ch, trackCount);
        const entry = modCellToTrackerEntry(cell, row, panNorm, mod, channelVolumes[ch]);
        if (!entry) continue;

        // Update the channel's current volume if this entry sets one
        if (entry.volume !== undefined) {
          channelVolumes[ch] = entry.volume;
        }

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

function resolveChannelPanNorm(channelIndex: number, trackCount: number): number {
  // Map MOD channels to stereo positions using fixed macro values:
  // Left  ~ M040 (64/255), center ~ M080 (128/255), right ~ M0BF (191/255).
  // These feed macro 0 (0..1) which the mixer interprets as 0 = left, 0.5 = center, 1 = right.
  const leftNorm = 0x40 / 0xff;   // ≈ 0.25
  const centerNorm = 0.5;         // 0x80 / 0xFF ≈ 0.5
  const rightNorm = 0xbf / 0xff;  // ≈ 0.75

  if (trackCount <= 1) {
    return centerNorm;
  }

  if (trackCount === 2) {
    // Two channels: left / right
    return channelIndex === 0 ? leftNorm : rightNorm;
  } else if (trackCount === 3) {
    // Three channels: left / center / right
    if (channelIndex === 0) return leftNorm;
    if (channelIndex === 1) return centerNorm;
    return rightNorm;
  } else {
    // Four channels (classic Amiga): 0 & 3 left, 1 & 2 right.
    const isLeft = channelIndex === 0 || channelIndex === 3;
    return isLeft ? leftNorm : rightNorm;
  }
}

function modCellToTrackerEntry(
  cell: ModPatternCell,
  row: number,
  panNorm: number,
  mod: ModSong,
  lastVolume?: string,
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
    // Store exact ProTracker frequency for accurate playback
    const freq = periodToFrequency(period);
    if (freq !== undefined) {
      entry.frequency = freq;
    }
  }

  let effectMacro: string | undefined;
  if (hasEffect) {
    const paramHex = effectParam.toString(16).toUpperCase().padStart(2, '0');
    let prefix: string | undefined;

    switch (effectCmd & 0x0f) {
      case 0x0:
        // 0xy: Arpeggio (xy != 00)
        if (effectParam !== 0) {
          prefix = '0';
        }
        break;
      case 0x1:
        // 1xx: Portamento up
        prefix = '1';
        break;
      case 0x2:
        // 2xx: Portamento down
        prefix = '2';
        break;
      case 0x3:
        // 3xx: Tone portamento
        prefix = '3';
        break;
      case 0x4:
        // 4xy: Vibrato
        prefix = '4';
        break;
      case 0x5:
        // 5xy: Tone portamento + volume slide
        prefix = '5';
        break;
      case 0x6:
        // 6xy: Vibrato + volume slide
        prefix = '6';
        break;
      case 0x7:
        // 7xy: Tremolo
        prefix = '7';
        break;
      case 0x8:
        // 8xx: Set panning
        prefix = '8';
        break;
      case 0x9:
        // 9xx: Sample offset
        prefix = '9';
        break;
      case 0xa:
        // Axy: Volume slide
        prefix = 'A';
        break;
      case 0xb:
        // Bxx: Position jump
        prefix = 'B';
        break;
      case 0xc:
        // Cxx: Set volume
        prefix = 'C';
        break;
      case 0xd:
        // Dxx: Pattern break
        prefix = 'D';
        break;
      case 0xe:
        // Exy: Extended effects
        prefix = 'E';
        break;
      case 0xf:
        // Fxx: Speed/tempo
        prefix = 'F';
        break;
      default:
        prefix = undefined;
        break;
    }

    if (prefix) {
      effectMacro = `${prefix}${paramHex}`;
    }
  }

  // Convert Cxx volume effects to the volume column (instead of macro column).
  // This ensures notes trigger with the correct velocity, avoiding the note-on
  // gain (velocity/127) conflicting with the Cxx effect gain.
  const hasVolumeEffectCmd = (effectCmd & 0x0f) === 0xc;
  if (hasVolumeEffectCmd && effectMacro) {
    // Extract the Cxx parameter (00-40 hex) and convert to volume column format (00-FF hex)
    // ProTracker: C00-C40 (0-64) → Volume column: 00-FF (0-255)
    const volumeParam = effectParam; // Already 0-64
    const volumeScaled = Math.round((volumeParam / 64) * 255);
    const volumeHex = volumeScaled.toString(16).toUpperCase().padStart(2, '0');
    entry.volume = volumeHex;
    // Clear the effect macro since we moved it to volume column
    effectMacro = undefined;
  }

  if (!entry.volume) {
    if (hasNote && !hasSample && lastVolume !== undefined) {
      // Note without instrument: inherit last volume (sticky)
      entry.volume = lastVolume;
    }
    // If no note at all, don't set volume (only Cxx without note sets sticky volume)
  }

  // Always add a macro command that drives macro 0 for stereo pan, using the
  // resolved channel pan. This lives in the second effect column so the first
  // column can carry the original MOD effect.
  let panMacro: string | undefined;
  if (hasNote) {
    const clamped = Math.max(0, Math.min(1, panNorm));
    const raw = Math.round(clamped * 255);
    const hex = raw.toString(16).toUpperCase().padStart(2, '0');
    // Use 3-char macro shorthand (Mxx) for macro 0 so it fits the tracker column.
    panMacro = `M${hex}`;
  }

  if (effectMacro) {
    entry.macro = effectMacro;
  }
  if (panMacro) {
    entry.macro2 = panMacro;
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
    // MOD sample volumes are handled via Cxx commands on notes, not sampler gain,
    // so slot volume remains at unity to avoid double-scaling.
    slot.volume = 1.0;

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
  const lfoNodeId = generateNodeId('lfo');
  const chorusNodeId = '10000';
  const delayNodeId = '10001';
  const reverbNodeId = '10002';
  const convolverNodeId = '10003';
  const limiterNodeId = '10004';
  const compressorNodeId = '10005';
  const saturationNodeId = '10006';
  const bitcrusherNodeId = '10007';
  const patchName =
    sample.name || `Instrument ${formatInstrumentId(sampleIndex)}`;
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
    // ProTracker sample volumes are applied via Cxx commands at note-on time,
    // not as sampler gain, to avoid volume multiplication with voice gain.
    gain: resolveSamplerGain(sample),
    detune_oct: 0,
    detune_semi: 0,
    detune_cents: 0,
    detune: 0,
    loopMode: loopEnabled ? SamplerLoopMode.Loop : SamplerLoopMode.Off,
    loopStart: loopEnabled ? loopStartFrames / sampleLengthFrames : 0,
    loopEnd: loopEnabled ? loopEndFrames / sampleLengthFrames : 1,
    sampleLength: sampleLengthFrames,
    // Empirically calibrated root note for MOD import.
    // Using a fixed root of 65 keeps most instruments (including AmegAs)
    // close to their original ProTracker pitch; per-sample finetune is
    // currently ignored here to avoid over-shifting bright drums.
    rootNote: 65,
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
      [VoiceNodeType.LFO]: [
        {
          id: lfoNodeId,
          type: VoiceNodeType.LFO,
          name: 'LFO',
        },
      ],
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
      [VoiceNodeType.Convolver]: [
        {
          id: convolverNodeId,
          type: VoiceNodeType.Convolver,
          name: 'Convolver',
        },
      ],
      [VoiceNodeType.Delay]: [
        {
          id: delayNodeId,
          type: VoiceNodeType.Delay,
          name: 'Delay',
        },
      ],
      [VoiceNodeType.GateMixer]: [
        {
          id: generateNodeId('gatemixer'),
          type: VoiceNodeType.GateMixer,
          name: 'Gate Mixer',
        },
      ],
      [VoiceNodeType.ArpeggiatorGenerator]: [],
      [VoiceNodeType.Chorus]: [
        {
          id: chorusNodeId,
          type: VoiceNodeType.Chorus,
          name: 'Chorus',
        },
      ],
      [VoiceNodeType.Limiter]: [
        {
          id: limiterNodeId,
          type: VoiceNodeType.Limiter,
          name: 'Limiter',
        },
      ],
      [VoiceNodeType.Reverb]: [
        {
          id: reverbNodeId,
          type: VoiceNodeType.Reverb,
          name: 'Reverb',
        },
      ],
      [VoiceNodeType.Compressor]: [
        {
          id: compressorNodeId,
          type: VoiceNodeType.Compressor,
          name: 'Compressor',
        },
      ],
      [VoiceNodeType.Saturation]: [
        {
          id: saturationNodeId,
          type: VoiceNodeType.Saturation,
          name: 'Saturation',
        },
      ],
      [VoiceNodeType.Bitcrusher]: [
        {
          id: bitcrusherNodeId,
          type: VoiceNodeType.Bitcrusher,
          name: 'Bitcrusher',
        },
      ],
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
    // Use 4 voices per imported MOD instrument so tracker playback
    // has enough polyphony for chords / overlaps while still feeling
    // “Amiga-like” rather than 8‑voice polysynth.
    voiceCount: 4,
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
      lfos: {
        [lfoNodeId]: {
          id: lfoNodeId,
          frequency: 1.0,
          phaseOffset: 0,
          waveform: 0,
          useAbsolute: false,
          useNormalized: false,
          triggerMode: 0,
          gain: 0,
          active: false,
          loopMode: 0,
          loopStart: 0,
          loopEnd: 1,
        } satisfies LfoState,
      },
      samplers: {
        [samplerNodeId]: samplerState,
      },
      glides: {},
      convolvers: {
        [convolverNodeId]: {
          id: convolverNodeId,
          wetMix: 0.0,
          active: false,
        },
      },
      delays: {
        [delayNodeId]: {
          id: delayNodeId,
          delayMs: 250,
          feedback: 0.5,
          wetMix: 0.0,
          active: false,
        },
      },
      choruses: {
        [chorusNodeId]: {
          id: chorusNodeId,
          active: false,
          baseDelayMs: 15.0,
          depthMs: 5.0,
          lfoRateHz: 0.5,
          feedback: 0.3,
          feedback_filter: 0.5,
          mix: 0.5,
          stereoPhaseOffsetDeg: 90.0,
        },
      },
      reverbs: {
        [reverbNodeId]: {
          id: reverbNodeId,
          active: false,
          room_size: 0.95,
          damp: 0.5,
          wet: 0.3,
          dry: 0.7,
          width: 1.0,
        },
      },
      compressors: {
        [compressorNodeId]: {
          id: compressorNodeId,
          active: false,
          thresholdDb: -12,
          ratio: 4,
          attackMs: 10,
          releaseMs: 80,
          makeupGainDb: 3,
          mix: 0.5,
        },
      },
      saturations: {
        [saturationNodeId]: {
          id: saturationNodeId,
          active: false,
          drive: 2.0,
          mix: 0.5,
        },
      },
      bitcrushers: {
        [bitcrusherNodeId]: {
          id: bitcrusherNodeId,
          active: false,
          bits: 12,
          downsampleFactor: 4,
          mix: 0.5,
        },
      },
      macros: {
        // Macro 0: per-instrument stereo pan for the sampler.
        // Value domain 0..1 (0 = left, 0.5 = center, 1 = right).
        values: [0.5],
        routes: [
          {
            macroIndex: 0,
            // For now we route pan macros to the Mixer StereoPan port
            // so imported MOD instruments get audible stereo separation.
            targetId: mixerNodeId,
            targetPort: PortId.StereoPan,
            amount: 1,
            modulationType: 2 as WasmModulationType,
            modulationTransformation: 0 as ModulationTransformation,
          },
        ],
      },
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

/**
 * Convert Amiga period to a synth frequency in Hz.
 *
 * ProTracker's Paula playback frequency is:
 *   f_paula = AMIGA_CLOCK / (2 * period)
 *
 * Those values are ~128× higher than the equal‑tempered note frequencies
 * our synth expects (e.g. period 856 → ~4181 Hz, but C-1 in our tuning is
 * ~32.7 Hz). To stay in the engine's \"musical Hz\" domain and avoid driving
 * the sampler at 128× speed, we scale the Paula frequency down by 2^7.
 */
function periodToFrequency(period: number): number | undefined {
  if (!period || !Number.isFinite(period)) return undefined;
  const AMIGA_CLOCK = 7159090.5;
  const PAULA_TO_SYNTH_SCALE = 128; // 2^7 – matches the -84 semitone offset used previously
  const freq = AMIGA_CLOCK / (2 * period * PAULA_TO_SYNTH_SCALE);
  if (!Number.isFinite(freq) || freq <= 0) return undefined;
  return freq;
}

/**
 * Convert Amiga period to MIDI note number (for note display only).
 * Uses the scaled synth frequency so C-1..B-3 land at the expected MIDI
 * positions (C-1 = 24, C-2 = 36, etc.).
 */
function periodToMidi(period: number): number | undefined {
  const freq = periodToFrequency(period);
  if (!freq) return undefined;

  const rawMidi = 69 + 12 * Math.log2(freq / 440);
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
