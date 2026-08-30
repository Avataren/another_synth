import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ref } from 'vue';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import {
  useTrackerSongBuilder,
  type TrackerSongBuilderContext,
} from 'src/composables/useTrackerSongBuilder';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';

/**
 * The same invariant as tracker-channel-voice-addressing, driven from the real
 * corpus instead of a hand-built rig.
 *
 * The point of doing it twice is that the unit rig proves the bank *can* route
 * a mis-addressed command, while this proves real modules actually send them.
 * They do, in eight of the sixty-one demos: a per-voice command whose row carries
 * an instrument that is not what the channel is sounding. Each of the five
 * previous fixes (D29, D55, D65, D68, D77) closed one row shape on the import
 * side, and the corpus kept producing others, which is why the addressing
 * model itself had to change.
 */

const DEMOS = path.resolve(__dirname, '../../public/demos');

const createMockAudioSystem = () => {
  const gainNode = { gain: { value: 1 }, connect: vi.fn(), numberOfOutputs: 1 };
  return {
    audioContext: {
      sampleRate: 48000,
      currentTime: 0,
      state: 'running' as const,
      createGain: () => ({ ...gainNode }),
      destination: gainNode,
      onstatechange: null as unknown,
    },
    destinationNode: { connect: vi.fn(), numberOfOutputs: 1 },
  };
};

function buildSong(dir: string, name: string) {
  const buf = fs.readFileSync(path.join(DEMOS, dir, name));
  const bytes = buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
  const file = /\.xm$/i.test(name)
    ? importXmToTrackerSong(bytes)
    : importModToTrackerSong(bytes);
  const patterns = file.data.patterns;
  const ctx: TrackerSongBuilderContext = {
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
  return {
    song: useTrackerSongBuilder(ctx).buildPlaybackSong('song'),
    moduleFormat: file.data.moduleFormat!,
  };
}

interface Landing {
  instrumentId: string;
  voiceIndex: number;
}

/**
 * Play every pattern of a module through a real TrackerSongBank fitted with
 * stub instruments, and compare where each per-voice command was *addressed*
 * with where it actually *landed*.
 */
function play(dir: string, name: string) {
  const { song, moduleFormat } = buildSong(dir, name);
  const bank = new TrackerSongBank(
    createMockAudioSystem() as unknown as AudioSystem,
  );
  bank.setModuleFormat(moduleFormat);

  /** trackIndex -> the instrument and voice the channel's last note-on took. */
  const sounding = new Map<number, Landing>();
  // An append-only log rather than a single slot: TypeScript keeps a
  // narrowing across the `apply()` call that fills the slot in from a
  // callback, so a slot would read as `never` here.
  const landings: Landing[] = [];

  const makeInstrument = (instrumentId: string) => {
    let next = 0;
    return {
      getVoiceLimit: () => 8,
      getQuantumDurationSeconds: () => 128 / 48000,
      noteOnAtTime: (
        _midi: number,
        _velocity: number,
        _time: number,
        options?: { trackIndex?: number },
      ) => {
        const voiceIndex = next++ % 8;
        if (options?.trackIndex !== undefined) {
          sounding.set(options.trackIndex, { instrumentId, voiceIndex });
        }
        return voiceIndex;
      },
      gateOffVoiceAtTime: vi.fn(),
      cutVoiceAtTime: vi.fn(),
      cancelAndSilenceVoice: vi.fn(),
      cancelScheduledNotes: vi.fn(),
      noteOffAtTime: vi.fn(),
      setVoiceFrequencyAtTime: (voiceIndex: number) => {
        landings.push({ instrumentId, voiceIndex });
      },
      setVoiceGainAtTime: (voiceIndex: number) => {
        landings.push({ instrumentId, voiceIndex });
      },
      setVoiceMacroAtTime: (voiceIndex: number) => {
        landings.push({ instrumentId, voiceIndex });
      },
      get isReady() {
        return true;
      },
      workletNode: null,
    };
  };

  const instruments = Reflect.get(bank as object, 'instruments') as Map<
    string,
    unknown
  >;
  const ids = new Set<string>();
  for (const pattern of song.patterns) {
    for (const track of pattern.tracks) {
      for (const step of track?.steps ?? []) {
        if (step.instrumentId) ids.add(step.instrumentId);
      }
    }
  }
  for (const id of ids) {
    instruments.set(id, {
      instrument: makeInstrument(id),
      patchId: 'p',
      patchReuseKey: null,
      hasPortamento: false,
    });
  }

  const stats = { addressedElsewhere: 0, delivered: 0, misdelivered: 0 };
  /**
   * A command on a channel that is sounding must reach that channel's voice,
   * whatever instrument the row named.
   */
  const expectLands = (
    apply: () => void,
    rowInstrumentId: string,
    trackIndex: number,
  ) => {
    const owner = sounding.get(trackIndex);
    if (!owner) return; // nothing sounding: the command has nothing to apply to
    if (owner.instrumentId !== rowInstrumentId) stats.addressedElsewhere++;
    const before = landings.length;
    apply();
    const hit = landings[before];
    if (!hit) return;
    if (
      hit.instrumentId === owner.instrumentId &&
      hit.voiceIndex === owner.voiceIndex
    ) {
      stats.delivered++;
    } else {
      stats.misdelivered++;
    }
  };

  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: (e) => {
      if (e.type === 'noteOn') {
        bank.noteOnAtTime(
          e.instrumentId,
          e.midi ?? 60,
          e.velocity ?? 100,
          e.time,
          e.trackIndex,
        );
      } else {
        bank.noteOffAtTime(e.instrumentId, e.midi, e.time, e.trackIndex);
        sounding.delete(e.trackIndex);
      }
    },
    scheduledPitchHandler: (i, v, f, t, tr, ramp) =>
      expectLands(() => bank.setVoicePitchAtTime(i, v, f, t, tr, ramp), i, tr),
    scheduledVolumeHandler: (i, v, vol, t, tr, ramp) =>
      expectLands(
        () => bank.setVoiceVolumeAtTime(i, v, vol, t, tr, ramp),
        i,
        tr,
      ),
    scheduledPanHandler: (i, v, p, t, tr) =>
      expectLands(() => bank.setVoicePanAtTime(i, v, p, t, tr), i, tr),
  });
  engine.loadSong(song);
  const internals = engine as unknown as {
    scheduleRow: (row: number, time: number) => void;
  };
  for (const pattern of song.patterns) {
    engine.loadPattern(pattern.id);
    const rows = Math.max(1, pattern.length ?? 64);
    for (let row = 0; row < rows; row++) internals.scheduleRow(row, 0);
  }
  return stats;
}

describe.each([
  // A tone-portamento lead whose rows carry the next note's instrument -- the
  // D77 shape, still present after the import-side fix, on other channels.
  ['ft2', '4-mat_-_rose.xm'],
  // Channels 1 and 3 share sample 9, and rows latch a sample number without
  // starting a note -- the D29 shape.
  ['amiga', 'GSLINGER.MOD'],
  ['amiga', 'jogeir_liljedahl_-_addiction.mod'],
  ['ft2', 'an-path.xm'],
])('%s/%s', (dir, name) => {
  const stats = play(dir, name);

  it('sends per-voice commands to instruments with no voice on the channel', () => {
    // If this ever reaches zero the module changed, and the case below stops
    // testing anything -- the guard matters more than it looks.
    expect(stats.addressedElsewhere).toBeGreaterThan(0);
  });

  it('still delivers every one of them to the sounding voice', () => {
    expect(stats.misdelivered).toBe(0);
    expect(stats.delivered).toBeGreaterThanOrEqual(stats.addressedElsewhere);
  });
});
