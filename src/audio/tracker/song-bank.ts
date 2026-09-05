import type AudioSystem from 'src/audio/AudioSystem';
import {
  DEFAULT_MODULE_FORMAT,
  type ModuleFormat,
} from '@another-synth/tracker-playback';
import {
  profileForFormat,
  type FormatProfile,
} from '@another-synth/tracker-playback';
import type { PitchModel } from '@another-synth/tracker-playback';
import type { TrackerSink } from '@another-synth/tracker-playback';
import InstrumentV2 from 'src/audio/instrument-v2';
import ModInstrument from 'src/audio/mod-instrument';
import { WorkletPool } from 'src/audio/worklet-pool';
import { VOICES_PER_ENGINE } from '../worklet-config';
import { PooledInstrument } from 'src/audio/pooled-instrument-factory';
import type {
  AudioAsset,
  Patch,
  MacroRouteState,
} from 'src/audio/types/preset-types';
import {
  deserializePatch,
  type DeserializedPatch,
  parseAudioAssetId,
} from 'src/audio/serialization/patch-serializer';
import {
  WasmModulationType,
  ModulationTransformation,
  PortId,
} from 'app/public/wasm/audio_processor';
import {
  synthLayoutToPatchLayout,
  type SynthLayout,
  type FilterState,
  type EnvelopeConfig,
  type LfoState,
  type SamplerState,
  type GlideState,
  type ConvolverState,
  type DelayState,
  type ChorusState,
  type ReverbState,
  type CompressorState,
  type SaturationState,
  type BitcrusherState,
} from 'src/audio/types/synth-layout';
import type OscillatorState from 'src/audio/models/OscillatorState';
import {
  PRESET_SCHEMA_VERSION,
  type PatchMetadata,
  type SynthState,
} from 'src/audio/types/preset-types';
import {
  combineDetuneParts,
  frequencyFromDetune,
} from 'src/audio/utils/sampler-detune';
import { getSharedAudioSystem } from 'src/audio/shared-audio-system';
import { useUserSettingsStore } from 'src/stores/user-settings-store';
import {
  MIN_SCHEDULE_LEAD_SECONDS,
  ScheduledEventQueue,
  type PendingScheduledEvent,
} from './scheduled-events';
import { SongBankRecorder } from './recorder';
import { TrackVoiceRegistry } from './track-voice-registry';

export interface SongBankSlot {
  instrumentId: string;
  patch: Patch;
}

/**
 * Bounded best-effort resume wait for song-load paths: a fresh-tab deep link
 * has no user gesture, so the context stays suspended and resume()'s promise
 * may never settle. Song loading must never wait longer than this for audio;
 * instruments are built while suspended and rebuilt on first gesture.
 */
const SYNC_SLOTS_RESUME_WAIT_MS = 500;

export interface ActiveInstrument {
  instrument: InstrumentV2 | ModInstrument | PooledInstrument;
  patchId: string;
  patchReuseKey: string | null;
  hasPortamento: boolean;
}

/**
 * The app's sound source: implements the library's `TrackerSink`, and then a
 * great deal more that only the editor needs -- the mixer, live patch editing,
 * recording, visualisation.
 *
 * The `implements` is the point. Everything playback can reach is the 21
 * members of `TrackerSink`; the other public methods here are the editor's. A
 * standalone player implements the interface and none of the rest.
 */
export class TrackerSongBank implements TrackerSink {
  private generation = 0;
  private readonly audioSystem: AudioSystem;
  private readonly masterGain: GainNode;
  private readonly desired: Map<string, Patch> = new Map();
  private readonly instruments: Map<string, ActiveInstrument> = new Map();
  private readonly activeNotes: Map<string, Map<number, Set<number>>> =
    new Map();
  /** Per-track taps for the visualisers; see getTrackMonitor. */
  private readonly trackMonitors: Map<number, GainNode> = new Map();
  private monitorSink: GainNode | null = null;
  private readonly restoredAssets: Map<string, Set<string>> = new Map();
  private readonly pendingInstruments: Map<string, Promise<void>> = new Map();
  /**
   * Playback semantics of the loaded song.
   *
   * A MOD or XM channel is monophonic in the hardware sense: it has one voice,
   * and a new note takes it over, so nothing of the previous note can survive.
   * A song authored here has no such limit -- overlapping notes on one track
   * are a feature -- so there a new note releases the previous one and lets it
   * ring out.
   *
   * Defaults to native, matching DEFAULT_MODULE_FORMAT and the engine's own
   * default: a song with no format tag *is* a native song, and every real
   * module sets this from `loadSong` before a note is scheduled.
   */
  private moduleFormat: ModuleFormat = DEFAULT_MODULE_FORMAT;
  /** The loaded song's playback semantics; see `setModuleFormat` (P4). */
  private formatProfile: FormatProfile = profileForFormat(DEFAULT_MODULE_FORMAT);
  private wasSuspended = false;
  private needsAudioContextResume = false;
  private readonly eventQueue: ScheduledEventQueue;
  private readonly voices: TrackVoiceRegistry;
  private readonly recorder: SongBankRecorder;
  private workletPool: WorkletPool | null = null;
  // Feature flag: pooling is re-enabled after fixing instrument-scoped patch loading
  private useWorkletPooling = true;
  // The user's explicitly-chosen master volume (from the settings slider),
  // as distinct from the *current* masterGain.gain value, which a song's own
  // Gxx/Hxy (global volume/slide) effects can ramp away from this baseline
  // while playing. Kept separately so stopping/switching songs can restore
  // the real baseline instead of whatever a song's effects last left it at.
  private userMasterVolume = 1.0;
  /**
   * The song's own global volume (Gxx/Hxy), 0..1.
   *
   * Kept apart from the user's baseline because the two are independent: the
   * song says how loud this moment is relative to the rest of itself, and the
   * user says how loud the app is. What reaches masterGain is the product.
   */
  private songGlobalVolume = 1.0;

  constructor(audioSystem?: AudioSystem) {
    this.audioSystem = audioSystem ?? getSharedAudioSystem();
    this.masterGain = this.audioSystem.audioContext.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.audioSystem.destinationNode);

    // Initialize WorkletPool for shared worklet management
    if (this.useWorkletPooling) {
      this.workletPool = new WorkletPool(
        this.audioSystem.audioContext,
        this.masterGain,
      );
      console.log(
        '[SongBank] WorkletPool initialized for efficient resource usage',
      );
    }

    // If the AudioContext resumes after we deferred a sync, rebuild instruments
    // using the last requested slot state so playback doesn't stay silent.
    this.eventQueue = new ScheduledEventQueue({
      audioContext: this.audioSystem.audioContext,
      instruments: this.instruments,
      dispatchNoteOnAtTime: this.dispatchNoteOnAtTime.bind(this),
      dispatchNoteOffAtTime: this.dispatchNoteOffAtTime.bind(this),
    });
    this.voices = new TrackVoiceRegistry({
      instruments: this.instruments,
      activeNotes: this.activeNotes,
      audioContext: this.audioSystem.audioContext,
      isMonophonicChannel: () => this.channelsAreMonophonic,
      getGateLeadTime: (instrument) => this.getGateLeadTime(instrument),
    });
    this.recorder = new SongBankRecorder(
      this.audioSystem,
      // Tap the post-fx rack output, not the pre-rack master bus: recordings
      // and Export MP3 must capture what-you-hear (D117).
      this.audioSystem.postFxOutput,
    );

    this.audioSystem.audioContext.onstatechange = () => {
      if (
        this.audioSystem.audioContext.state === 'running' &&
        this.needsAudioContextResume
      ) {
        const pendingSlots: SongBankSlot[] = Array.from(
          this.desired.entries(),
        ).map(([instrumentId, patch]) => ({ instrumentId, patch }));
        if (pendingSlots.length > 0) {
          void this.syncSlots(pendingSlots);
        }
      }
    };
  }

  get output(): AudioNode {
    return this.masterGain;
  }

  get needsResume(): boolean {
    return this.needsAudioContextResume;
  }

  get audioContext(): AudioContext {
    return this.audioSystem.audioContext;
  }

  /** Get the output node for a specific instrument (for visualization) */
  getInstrumentOutput(instrumentId: string): AudioNode | null {
    const active = this.instruments.get(instrumentId);
    return active?.instrument.outputNode ?? null;
  }

  /**
   * A tap carrying only the voices of one tracker channel.
   *
   * The per-track visualisers used to read `getInstrumentOutput`, which is the
   * wrong node by a wide margin: one sample is one instrument here, and an
   * instrument is shared by every channel that plays it. Two channels on the
   * same sample therefore drew the *same* waveform -- their sum -- and a
   * channel's display jumped to a completely different mix the moment it
   * changed instrument.
   *
   * Voices connect here in addition to their instrument's output, so the tap
   * carries that channel and nothing else.
   */
  getTrackMonitor(trackIndex: number): GainNode {
    let monitor = this.trackMonitors.get(trackIndex);
    if (!monitor) {
      monitor = this.audioContext.createGain();
      monitor.gain.value = 1;
      monitor.connect(this.getMonitorSink());
      this.trackMonitors.set(trackIndex, monitor);
    }
    return monitor;
  }

  /**
   * Whether per-track taps are built at all.
   *
   * The phone layout shows no per-track waveforms and no spectrum analyser,
   * and the taps exist only to feed them: one GainNode per channel, a second
   * connection from every voice, and a live branch of the graph kept awake
   * by a silent sink -- for 32 channels, on the hardware least able to
   * afford it. Off, `getTrackMonitor` builds nothing and voices connect to
   * their instrument alone.
   */
  private trackMonitoringEnabled = true;

  setTrackMonitoringEnabled(enabled: boolean): void {
    if (this.trackMonitoringEnabled === enabled) return;
    this.trackMonitoringEnabled = enabled;
    if (enabled) return;
    // Voices already sounding keep their connection until they end; what is
    // dropped here is the taps themselves, so nothing new connects and the
    // sink has nothing left to keep awake.
    for (const monitor of this.trackMonitors.values()) {
      try {
        monitor.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.trackMonitors.clear();
    if (this.monitorSink) {
      try {
        this.monitorSink.disconnect();
      } catch {
        // Already disconnected.
      }
      this.monitorSink = null;
    }
  }

  /** The tap for a track, or null when per-track monitoring is off. */
  private maybeTrackMonitor(trackIndex: number): GainNode | null {
    if (!this.trackMonitoringEnabled) return null;
    return this.getTrackMonitor(trackIndex);
  }

  /**
   * Silent terminus for the monitor taps.
   *
   * A branch that ends in nothing is not guaranteed to be processed, so the
   * taps are given a path to the destination at zero gain. It contributes
   * nothing audible and exists only to keep them alive.
   */
  private getMonitorSink(): GainNode {
    if (!this.monitorSink) {
      this.monitorSink = this.audioContext.createGain();
      this.monitorSink.gain.value = 0;
      this.monitorSink.connect(this.audioContext.destination);
    }
    return this.monitorSink;
  }

  /**
   * The node a track's visualiser should analyse.
   *
   * Per-track monitoring needs each voice to connect somewhere of its own,
   * which only `ModInstrument` does. Everything else keeps the old
   * instrument-output behaviour rather than showing a flat line.
   */
  getTrackVisualizationNode(
    trackIndex: number,
    instrumentId: string | undefined,
  ): AudioNode | null {
    // Nothing to visualise with, and asking would build the tap this mode
    // exists to avoid.
    if (!this.trackMonitoringEnabled) return null;
    const active = instrumentId ? this.instruments.get(instrumentId) : undefined;
    if (active?.instrument instanceof ModInstrument) {
      return this.getTrackMonitor(trackIndex);
    }
    return instrumentId ? this.getInstrumentOutput(instrumentId) : null;
  }

  /** Get the InstrumentV2 instance for a specific instrument (for live editing) */
  getInstrument(
    instrumentId: string,
  ): InstrumentV2 | ModInstrument | PooledInstrument | null {
    const active = this.instruments.get(instrumentId);
    return active?.instrument ?? null;
  }

  /** Get WorkletPool statistics (for debugging and monitoring) */
  getWorkletPoolStats() {
    if (!this.workletPool) {
      return null;
    }
    return this.workletPool.getStats();
  }

  /** Aggregate CPU usage across all active instruments/worklets (for tracker UI). */
  async getCpuUsage(): Promise<{
    total: number;
    worklets: Array<{
      workletIndex: number;
      total: number;
      perEngine: Array<{
        id: string;
        cpu: number;
        instrumentId?: string;
        voices?: number;
      }>;
      perInstrument: Record<string, number>;
    }>;
    standalone: Array<{ instrumentId: string; cpu: number }>;
  }> {
    let total = 0;
    const worklets: Array<{
      workletIndex: number;
      total: number;
      perEngine: Array<{
        id: string;
        cpu: number;
        instrumentId?: string;
        voices?: number;
      }>;
      perInstrument: Record<string, number>;
    }> = [];
    const standalone: Array<{ instrumentId: string; cpu: number }> = [];

    if (this.workletPool) {
      const poolUsage = await this.workletPool.getCpuUsage();
      total += poolUsage.total;
      worklets.push(...poolUsage.worklets);
    }

    for (const [instrumentId, active] of this.instruments.entries()) {
      const instrument = active.instrument;
      if (instrument instanceof PooledInstrument) {
        // Counted via pooled worklet aggregation above.
        continue;
      }

      if (instrument instanceof InstrumentV2) {
        const cpu = await this.queryWorkletCpu(instrument.workletNode);
        if (cpu !== null) {
          total += cpu;
          standalone.push({ instrumentId, cpu });
        }
      }
    }

    return { total, worklets, standalone };
  }

  /**
   * Set the song's global volume (Gxx/Hxy), 0.0 to 1.0, scaling the user's
   * chosen master level rather than replacing it.
   *
   * Writing the song's value straight onto masterGain would make every module
   * that touches global volume override the user's setting -- and, worse, make
   * one that never touches it override the setting anyway the moment anything
   * pushed a default. A song looping back to the start restores global volume
   * to full, so with a 24-channel module and the master at 50%, the wrap
   * doubled the level and clipped hard (sweetdre.xm).
   *
   * When time is provided, schedules the change at the given AudioContext time.
   */
  setMasterVolume(volume: number, time?: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.songGlobalVolume = clamped;
    const when = time ?? this.audioSystem.audioContext.currentTime;
    this.masterGain.gain.setValueAtTime(this.userMasterVolume * clamped, when);
  }

  /**
   * Set the master volume from an explicit user action (e.g. the settings
   * slider), and remember it as the baseline to restore to whenever
   * playback stops or a new song is loaded. Unlike setMasterVolume(), this
   * also cancels any pending scheduled ramp (from a song's own Gxx/Hxy
   * global-volume effects) so the user's choice always wins immediately.
   */
  setUserMasterVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    this.userMasterVolume = clamped;
    const now = this.audioSystem.audioContext.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(clamped * this.songGlobalVolume, now);
  }

  /**
   * Restore master gain to the user's chosen baseline and drop any
   * still-pending scheduled ramp left over from the previous song.
   *
   * Tracker look-ahead scheduling schedules effect automation (including
   * Gxx/Hxy global-volume changes) up to several seconds ahead of real
   * playback time. If playback is stopped -- e.g. to load a different song
   * -- while one of those events is still in the future, it stays queued on
   * masterGain.gain and fires later regardless of what's now loaded,
   * silently (or partially) muting the *new* song. Without this, "load a
   * song, let it play through a global-volume fade, then load another
   * song" intermittently produces no sound, depending on exactly where
   * playback was stopped relative to any pending fade.
   */
  private resetMasterVolumeToBaseline(): void {
    const now = this.audioSystem.audioContext.currentTime;
    this.songGlobalVolume = 1.0;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(this.userMasterVolume, now);
  }

  /** Get the current master volume */
  getMasterVolume(): number {
    return this.masterGain.gain.value;
  }

  private syncInProgress = false;

  async syncSlots(slots: SongBankSlot[]): Promise<void> {
    console.log(`[SongBank] syncSlots called with ${slots.length} slots`);
    console.log(
      `[SongBank] Current instruments before sync: [${Array.from(this.instruments.keys()).join(', ')}]`,
    );
    console.log(`[SongBank] AudioContext state: ${this.audioContext.state}`);
    console.log(
      `[SongBank] MasterGain connected: ${this.masterGain.numberOfOutputs > 0}, gain value: ${this.masterGain.gain.value}`,
    );
    // Verify destinationNode connection
    console.log(
      `[SongBank] AudioSystem destinationNode outputs: ${this.audioSystem.destinationNode.numberOfOutputs}`,
    );

    // Prevent concurrent syncs - wait for previous sync to complete
    if (this.syncInProgress) {
      console.log('[SongBank] Sync already in progress, waiting...');
      // Wait for the current sync to finish (poll every 50ms)
      while (this.syncInProgress) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      console.log('[SongBank] Previous sync completed, proceeding');
    }

    this.syncInProgress = true;
    try {
      // Build desired patch map up front so it is available even if the context
      // cannot be resumed yet. This allows prepareInstrument() during playback
      // to find the correct patch once the AudioContext is running again.
      const nextDesired = new Map<string, Patch>();
      for (const slot of slots) {
        if (!slot.instrumentId) continue;
        nextDesired.set(slot.instrumentId, this.normalizePatch(slot.patch));
      }

      // Update desired patches immediately so playback can prepare instruments
      // later even if we have to bail out before connecting to the AudioContext.
      this.desired.clear();
      for (const [id, patch] of nextDesired.entries()) {
        this.desired.set(id, patch);
      }

      // Tear down instruments no longer referenced in the slots before we try
      // to resume audio. This keeps the active set aligned with desired state
      // even if we have to defer instrument creation until after a resume.
      const wantedIds = new Set(nextDesired.keys());
      for (const [id] of this.instruments.entries()) {
        if (!wantedIds.has(id)) {
          console.log(`[SongBank] Tearing down unwanted instrument: ${id}`);
          this.teardownInstrument(id);
        }
      }

      // Bounded, best-effort resume attempt. The sync itself must not depend
      // on a running context: fresh-tab deep links load songs while the
      // context is still suspended, so instruments are built either way. If
      // the context is still suspended afterwards, needsAudioContextResume
      // stays armed and the onstatechange handler rebuilds instruments via
      // syncSlots on the first user gesture.
      if (this.audioContext.state === 'suspended') {
        this.wasSuspended = true;
      }
      const contextRunning = await this.ensureAudioContextRunning(
        SYNC_SLOTS_RESUME_WAIT_MS,
      );

      if (!contextRunning) {
        console.warn(
          `[SongBank] AudioContext still ${this.audioContext.state} after bounded resume attempt; building instruments while suspended (rebuild-on-resume is armed).`,
        );
      }

      if (this.wasSuspended && this.audioContext.state === 'running') {
        // Recreate instruments after a resume to avoid stale worklet state
        console.log('[SongBank] Disposing all instruments after resume');
        this.disposeInstruments();
        this.wasSuspended = false;
      }

      // Load instruments in batches to avoid overwhelming the browser
      // with too many concurrent AudioWorklet/WASM initializations
      const BATCH_SIZE = 8; // Load 8 instruments at a time
      const entries = Array.from(nextDesired.entries());
      console.log(
        `[SongBank] Loading ${entries.length} instruments in batches of ${BATCH_SIZE}`,
      );

      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        console.log(
          `[SongBank] Loading batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(entries.length / BATCH_SIZE)}: instruments ${batch.map(([id]) => id).join(', ')}`,
        );

        const ensureTasks: Promise<void>[] = [];
        for (const [instrumentId, patch] of batch) {
          console.log(
            `[SongBank] Ensuring instrument: ${instrumentId}, patch: ${patch?.metadata?.id}`,
          );
          ensureTasks.push(this.ensureInstrument(instrumentId, patch));
        }

        await Promise.all(ensureTasks);

        // Small delay between batches to let the browser breathe
        if (i + BATCH_SIZE < entries.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      const loadedCount = this.instruments.size;
      const expectedCount = nextDesired.size;
      console.log(
        `[SongBank] syncSlots complete: ${loadedCount}/${expectedCount} instruments loaded`,
      );
      console.log(
        `[SongBank] Active instruments: ${Array.from(this.instruments.keys()).join(', ')}`,
      );

      // Verify all instruments are properly connected
      let disconnectedCount = 0;
      for (const [id, active] of this.instruments.entries()) {
        const hasOutput = active.instrument.outputNode.numberOfOutputs > 0;
        if (!hasOutput) {
          console.error(
            `[SongBank] ⚠️ Instrument ${id} is NOT connected to output!`,
          );
          disconnectedCount++;
        }
      }

      if (disconnectedCount > 0) {
        console.error(
          `[SongBank] ❌ ${disconnectedCount} instruments failed to connect!`,
        );
      } else if (loadedCount === expectedCount && loadedCount > 0) {
        console.log(
          `[SongBank] ✅ All ${loadedCount} instruments loaded and connected`,
        );
      } else if (loadedCount < expectedCount) {
        console.warn(
          `[SongBank] ⚠️ Only ${loadedCount}/${expectedCount} instruments loaded`,
        );
      }

      // Verify master gain is still connected to destination
      const masterConnected = this.masterGain.numberOfOutputs > 0;
      if (!masterConnected) {
        console.error(
          '[SongBank] ❌ CRITICAL: Master gain disconnected from output! Reconnecting...',
        );
        this.masterGain.connect(this.audioSystem.destinationNode);
      } else {
        console.log('[SongBank] ✅ Master gain connected to destination');
      }

      // Try to flush any scheduled events that were queued while suspended/loading
      await this.eventQueue.flushPendingScheduledEvents();
    } finally {
      this.syncInProgress = false;
    }
  }

  async prepareInstrument(instrumentId?: string): Promise<void> {
    if (!instrumentId) return;
    const patch = this.desired.get(instrumentId);
    if (!patch) return;
    await this.ensureInstrument(instrumentId, patch);
  }

  dispose() {
    this.disposeInstruments();
    this.masterGain.disconnect();
    this.recorder.dispose();

    // Dispose worklet pool and clean up all shared worklets
    if (this.workletPool) {
      this.workletPool.dispose();
      this.workletPool = null;
      console.log('[SongBank] WorkletPool disposed');
    }
  }

  private disposeInstruments() {
    for (const id of Array.from(this.instruments.keys())) {
      this.teardownInstrument(id);
    }
    this.activeNotes.clear();
    this.voices.clearAll();
    this.restoredAssets.clear();
  }

  allNotesOff() {
    for (const [instrumentId, active] of this.instruments.entries()) {
      const byTrack = this.activeNotes.get(instrumentId);
      if (byTrack) {
        for (const notes of byTrack.values()) {
          for (const note of notes) {
            active.instrument.noteOff(note);
          }
          notes.clear();
        }
        byTrack.clear();
      }
      // Also send a gate-low in case the set was empty but a gate is stuck
      active.instrument.allNotesOff();
    }
    this.voices.clearAll();
  }

  /**
   * Stop all notes playing on a specific track across all instruments.
   * Cancels all scheduled events and silences voices immediately.
   * Used when muting a track during playback.
   */
  notesOffForTrack(trackIndex: number) {
    for (const [instrumentId, active] of this.instruments.entries()) {
      const voiceIndex = this.voices.peekLastVoiceForTrack(
        instrumentId,
        trackIndex,
      );
      if (voiceIndex !== undefined) {
        active.instrument.cancelAndSilenceVoice(voiceIndex);
        this.voices.clearLastVoiceForTrack(instrumentId, trackIndex);
      }

      // Clear the note tracking for this track
      const byTrack = this.activeNotes.get(instrumentId);
      const notes = byTrack?.get(trackIndex);
      notes?.clear();

      // Clear the last voice tracking for this track
      this.voices.clearLastVoiceForTrack(instrumentId, trackIndex);
    }
  }

  /**
   * Tell the bank which playback semantics the loaded song follows.
   *
   * The channel-replacement policy depends on the format (see
   * `moduleFormat`), and the pitch model the format's instruments use for
   * autovibrato depth comes from the format's profile (P4). `linearFrequency`
   * selects XM's Amiga table; absent means XM's own default, linear.
   */
  setModuleFormat(
    format: ModuleFormat | undefined,
    linearFrequency?: boolean,
    amigaLimits?: boolean,
  ) {
    this.moduleFormat = format ?? DEFAULT_MODULE_FORMAT;
    this.formatProfile = profileForFormat(this.moduleFormat, {
      ...(linearFrequency !== undefined ? { linearFrequency } : {}),
      ...(amigaLimits !== undefined ? { amigaLimits } : {}),
    });
    // Instruments already built keep whatever model they were constructed
    // with, and on the real load path they are all built before this is
    // called: `useTrackerFileIO.applySongFile` runs
    // `syncSongBankFromSlots()` -- which creates every ModInstrument -- and
    // only then `initializePlayback()`, whose `playbackStore.loadSong` gets
    // here. So without this every song's instruments held the *default*
    // profile's ProTracker model, and XM autovibrato (the only thing that
    // reads the model here) came out roughly 16x too deep. See
    // ModInstrument.setPitchModel.
    for (const active of this.instruments.values()) {
      const instrument = active.instrument as {
        setPitchModel?: (model: PitchModel) => void;
      };
      instrument.setPitchModel?.(this.formatProfile.pitch);
    }
  }

  /**
   * Whether a track is a hardware-style monophonic channel, where a new note
   * leaves nothing of the previous one.
   */
  private get channelsAreMonophonic(): boolean {
    return this.moduleFormat !== 'native';
  }

  /**
   * Test-visibility seam (D95): the registry owns the voice maps now, but the
   * existing tests seed `lastTrackVoice` and call `setLastVoiceForTrack` via
   * reflection. Keep those hooks working unchanged.
   */
  private get lastTrackVoice(): Map<string, Map<number, number>> {
    return this.voices.lastVoiceByTrack;
  }

  private setLastVoiceForTrack(
    instrumentId: string,
    trackIndex: number | undefined,
    voiceIndex: number,
  ) {
    this.voices.setLastVoiceForTrack(instrumentId, trackIndex, voiceIndex);
  }

  /**
   * Silence every voice on every instrument at a given time.
   *
   * Used when the song loops back to the start: a loop is a restart, and a
   * restart begins from silence. Scheduled rather than immediate because the
   * engine decides this while scheduling ahead, so "now" is still part of the
   * previous pass.
   *
   * Voice indices are swept rather than tracked: a voice the maps have lost
   * sight of is exactly the kind this needs to catch.
   */
  cutAllVoicesAtTime(time: number) {
    const at = Math.max(time, this.audioContext.currentTime);
    for (const active of this.instruments.values()) {
      const limit = active.instrument.getVoiceLimit();
      for (let voiceIndex = 0; voiceIndex < limit; voiceIndex++) {
        this.voices.endVoiceForReplacement(active.instrument, voiceIndex, at);
      }
    }
    this.activeNotes.clear();
    this.voices.clearAll();
  }

  /** Remember a voice that a key-off left sounding out its release. */
  private gateOffPreviousTrackVoice(
    instrumentId: string,
    trackIndex: number | undefined,
    time: number,
  ) {
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    if (active.hasPortamento && active.instrument.getVoiceLimit() <= 1) return;
    const instrument = active.instrument;
    const previousVoice = this.voices.peekLastVoiceForTrack(instrumentId, trackIndex);
    if (previousVoice !== undefined) {
      const gateLead = this.getGateLeadTime(instrument);
      const now = this.audioContext.currentTime;

      // Aim gate low one lead before the note; if we're late, still get under the note edge.
      const idealGateTime = time - gateLead;
      let gateTime = idealGateTime;

      // Don't schedule in the past; if we're already too close, bias slightly before the note.
      if (gateTime < now) {
        gateTime = now + 0.001;
      }
      if (gateTime >= time) {
        gateTime = Math.max(now, time - 0.0005);
      }

      // Warning: If gate-off can't happen before the new note due to late scheduling
      if (gateTime > time - gateLead * 0.5) {
        console.warn(
          `[SongBank] Gate-off timing compromised for track ${trackIndex ?? -1}: ` +
            `gate=${gateTime.toFixed(3)}s, note=${time.toFixed(3)}s, ` +
            `lead=${(time - gateTime).toFixed(3)}s (wanted ${gateLead.toFixed(3)}s)`,
        );
        if (gateTime >= time) {
          instrument.cancelAndSilenceVoice(previousVoice);
          return;
        }
      }

      this.voices.endVoiceForReplacement(instrument, previousVoice, gateTime);
      return;
    }

    // No previous voice tracked for this track: nothing to gate off.
  }

  /**
   * Gate off any voices currently playing on this track for other instruments.
   *
   * Classic tracker channels are effectively monophonic: starting a note on a
   * track should stop whatever was previously playing there, regardless of
   * which instrument it came from. This helper scans the per-instrument
   * track voice mapping and gates off the voice on the given track for any
   * instrument except the one currently being triggered.
   */
  private gateOffOtherInstrumentsForTrack(
    excludingInstrumentId: string,
    trackIndex: number | undefined,
    time: number,
  ) {
    if (!Number.isFinite(trackIndex as number)) return;
    const now = this.audioContext.currentTime;

    for (const [instrumentId, active] of this.instruments.entries()) {
      if (instrumentId === excludingInstrumentId) continue;
      const voiceIndex = this.voices.peekLastVoiceForTrack(instrumentId, trackIndex);
      if (voiceIndex === undefined) continue;

      const instrument = active.instrument;
      const gateLead = this.getGateLeadTime(instrument);
      let gateTime = time - gateLead;

      if (gateTime < now) {
        gateTime = now + 0.001;
      }
      if (gateTime >= time) {
        gateTime = Math.max(now, time - 0.0005);
      }

      if (gateTime > time - gateLead * 0.5) {
        console.warn(
          `[SongBank] Cross-instrument gate-off compromised for track ${trackIndex}: ` +
            `gate=${gateTime.toFixed(3)}s, note=${time.toFixed(3)}s, ` +
            `lead=${(time - gateTime).toFixed(3)}s (wanted ${gateLead.toFixed(3)}s)`,
        );
        if (gateTime >= time) {
          instrument.cancelAndSilenceVoice(voiceIndex);
          continue;
        }
      }

      this.voices.endVoiceForReplacement(instrument, voiceIndex, gateTime);

      // Note: We don't clear lastTrackVoice here because the voice tracking
      // will be updated by setLastVoiceForTrack when the new note is allocated.
      // Clearing it here would create a gap where the voice isn't tracked.
    }
  }

  /**
   * For mono instruments, gate off voices on other tracks before triggering a new note.
   */
  private gateOffOtherTracksForInstrument(
    instrumentId: string,
    trackIndex: number | undefined,
    time: number,
  ) {
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    if (active.instrument.getVoiceLimit() > 1) return; // only needed for mono patches

    const trackKey = Number.isFinite(trackIndex) ? (trackIndex as number) : -1;
    const byTrack = this.voices.lastVoiceMapFor(instrumentId);
    if (!byTrack) return;
    const now = this.audioContext.currentTime;
    const gateLead = this.getGateLeadTime(active.instrument);

    for (const [key, voiceIndex] of Array.from(byTrack.entries())) {
      if (key === trackKey || key === -1 || voiceIndex === undefined) continue;

      let gateTime = time - gateLead;
      if (gateTime < now) {
        gateTime = now + 0.001;
      }
      if (gateTime >= time) {
        gateTime = Math.max(now, time - 0.0005);
      }

      if (gateTime > time - gateLead * 0.5 && gateTime >= time) {
        active.instrument.cancelAndSilenceVoice(voiceIndex);
      } else {
        // A mono patch stealing its own voice across tracks is a replacement.
        this.voices.endVoiceForReplacement(active.instrument, voiceIndex, gateTime);
      }

      // Note: We don't clear lastTrackVoice here because the tracking
      // will be updated by setLastVoiceForTrack when the new note is allocated.
    }
  }

  /** Return a small lead time (seconds) to drop the gate before retriggering. */
  private getGateLeadTime(
    instrument: InstrumentV2 | ModInstrument | PooledInstrument,
  ): number {
    // Ensure at least one quantum of gate-low so the automation frame sees the edge.
    // Fallback to ~5ms if we don't know the block size.
    const quantum = instrument.getQuantumDurationSeconds();
    return Math.max(quantum, 0.005);
  }

  /** Start capturing stereo audio from the master bus */
  async startRecording(): Promise<void> {
    await this.recorder.startRecording();
  }

  /** Stop capture and return interleaved Float32 data */
  async stopRecording(): Promise<{
    interleaved: Float32Array;
    sampleRate: number;
  }> {
    return this.recorder.stopRecording();
  }

  noteOn(
    instrumentId: string | undefined,
    midi: number,
    velocity = 100,
    trackIndex?: number,
  ) {
    if (this.audioContext.state === 'suspended') {
      this.wasSuspended = true;
    }
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    const now = this.audioContext.currentTime;
    // Ensure per-track mono behaviour across instruments on this track
    this.voices.cutReleasingVoicesForTrack(trackIndex, now);
    this.gateOffOtherInstrumentsForTrack(instrumentId, trackIndex, now);
    this.gateOffPreviousTrackVoice(instrumentId, trackIndex, now);
    const voiceIndex = active.instrument.noteOnAtTime(midi, velocity, now, {
      allowDuplicate: true,
    });

    this.voices.getTrackNotes(instrumentId, trackIndex).add(midi);
    if (voiceIndex !== undefined) {
      this.voices.setLastVoiceForTrack(instrumentId, trackIndex, voiceIndex);
    }
  }

  /**
   * Realtime preview note-on (no per-track voice gating/stealing).
   * Used by the tracker keyboard preview so chords behave like the patch editor.
   */
  previewNoteOn(
    instrumentId: string | undefined,
    midi: number,
    velocity = 100,
  ) {
    console.log(
      `[SongBank] previewNoteOn: inst=${instrumentId}, midi=${midi}, vel=${velocity}`,
    );
    if (this.audioContext.state === 'suspended') {
      this.wasSuspended = true;
    }
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) {
      console.warn(
        `[SongBank] previewNoteOn: instrument ${instrumentId} not found!`,
      );
      return;
    }
    const clampedMidi = Math.max(0, Math.min(127, Math.round(midi)));
    active.instrument.noteOn(clampedMidi, velocity);
  }

  /**
   * Realtime preview note-off companion to previewNoteOn.
   */
  previewNoteOff(instrumentId: string | undefined, midi: number) {
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    const clampedMidi = Math.max(0, Math.min(127, Math.round(midi)));
    active.instrument.noteOff(clampedMidi);
  }

  noteOff(
    instrumentId: string | undefined,
    midi?: number,
    trackIndex?: number,
  ) {
    if (instrumentId === undefined) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;

    const notes = this.voices.getTrackNotes(instrumentId, trackIndex);
    const voiceIndex = this.voices.peekLastVoiceForTrack(instrumentId, trackIndex);
    const when = this.audioContext.currentTime;

    if (midi === undefined) {
      if (voiceIndex !== undefined) {
        active.instrument.gateOffVoiceAtTime(voiceIndex, when);
      } else if (notes.size > 0) {
        for (const note of notes) {
          active.instrument.noteOff(note);
        }
      } else {
        active.instrument.allNotesOff();
      }
      notes.clear();
      return;
    }

    if (voiceIndex !== undefined) {
      active.instrument.noteOff(midi, voiceIndex);
    } else if (notes.has(midi)) {
      active.instrument.noteOff(midi);
    } else {
      active.instrument.noteOff(midi);
    }
    notes.delete(midi);
  }

  /**
   * Schedule a note on at a specific audio context time.
   */
  noteOnAtTime(
    instrumentId: string | undefined,
    midi: number,
    velocity: number,
    time: number,
    trackIndex?: number,
    frequency?: number,
    pan?: number,
    /**
     * Start offset into the sample in *frames* (ProTracker 9xx: param * 256).
     * Applied at voice start -- it cannot be set afterwards on a Web Audio
     * buffer source, so it has to arrive with the note rather than as
     * automation.
     */
    sampleOffsetFrames?: number,
    /** Tick duration in seconds, for tick-timed instrument envelopes. */
    tickSeconds?: number,
  ) {
    if (instrumentId === undefined) {
      console.warn('[SongBank] noteOnAtTime: instrumentId is undefined');
      return;
    }

    const scheduledTime = Math.max(time, this.audioContext.currentTime);
    const contextRunning = this.audioContext.state === 'running';
    const active = this.instruments.get(instrumentId);
    const instrumentReady = active?.instrument.isReady;

    if (!contextRunning || !active || !instrumentReady) {
      if (!contextRunning) {
        this.wasSuspended = true;
        console.warn(
          '[SongBank] noteOnAtTime: AudioContext is suspended, queuing event.',
        );
      }
      const queued: PendingScheduledEvent = {
        kind: 'noteOn',
        instrumentId,
        midi,
        velocity,
        time: scheduledTime,
        enqueuedAt: this.eventQueue.getEnqueueTimestamp(),
      };
      if (trackIndex !== undefined) queued.trackIndex = trackIndex;
      if (frequency !== undefined) queued.frequency = frequency;
      if (pan !== undefined) queued.pan = pan;
      if (sampleOffsetFrames !== undefined) queued.sampleOffsetFrames = sampleOffsetFrames;
      if (tickSeconds !== undefined) queued.tickSeconds = tickSeconds;
      this.eventQueue.enqueue(queued);
      this.ensureInstrumentIfDesired(instrumentId);
      return;
    }

    this.dispatchNoteOnAtTime(
      instrumentId,
      midi,
      velocity,
      scheduledTime,
      trackIndex,
      frequency,
      pan,
      sampleOffsetFrames,
      tickSeconds,
    );
  }

  /**
   * Schedule a note off at a specific audio context time.
   */
  noteOffAtTime(
    instrumentId: string | undefined,
    midi: number | undefined,
    time: number,
    trackIndex?: number,
  ) {
    if (instrumentId === undefined) return;

    const scheduledTime = Math.max(time, this.audioContext.currentTime);
    const contextRunning = this.audioContext.state === 'running';
    const active = this.instruments.get(instrumentId);
    const instrumentReady = active?.instrument.isReady;

    if (!contextRunning || !active || !instrumentReady) {
      if (!contextRunning) {
        this.wasSuspended = true;
        console.warn(
          '[SongBank] noteOffAtTime: AudioContext is suspended, queuing event.',
        );
      }
      const queued: PendingScheduledEvent = {
        kind: 'noteOff',
        instrumentId,
        time: scheduledTime,
        enqueuedAt: this.eventQueue.getEnqueueTimestamp(),
      };
      if (midi !== undefined) queued.midi = midi;
      if (trackIndex !== undefined) queued.trackIndex = trackIndex;
      this.eventQueue.enqueue(queued);
      this.ensureInstrumentIfDesired(instrumentId);
      return;
    }

    this.dispatchNoteOffAtTime(instrumentId, midi, scheduledTime, trackIndex);
  }

  /**
   * Cancel all scheduled notes and stop all sound immediately.
   */
  cancelAllScheduled() {
    for (const active of this.instruments.values()) {
      active.instrument.cancelScheduledNotes();
    }
    this.activeNotes.clear();
    this.voices.clearAll();
    this.resetMasterVolumeToBaseline();
  }

  /**
   * Reset all instruments to a clean state for playback.
   * Ensures all voice gains are at 1, gates are at 0, and connections are intact.
   */
  resetForPlayback() {
    console.log('[SongBank] resetForPlayback: resetting all instruments');
    for (const [id, active] of this.instruments.entries()) {
      // Reset all voice gains to 1
      active.instrument.setGainForAllVoices(1);

      // Verify output connection, reconnect if needed
      if (active.instrument.outputNode.numberOfOutputs === 0) {
        console.warn(
          `[SongBank] resetForPlayback: instrument ${id} disconnected, reconnecting`,
        );
        active.instrument.outputNode.connect(this.masterGain);
      }

      // Log state for debugging
      const outputGain = (active.instrument.outputNode as GainNode).gain.value;
      console.log(
        `[SongBank] resetForPlayback: ${id} outputGain=${outputGain}, connected=${active.instrument.outputNode.numberOfOutputs > 0}`,
      );
    }
  }

  setInstrumentGain(
    instrumentId: string | undefined,
    gain: number,
    time?: number,
  ) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    active.instrument.setGainForAllVoices(gain, time);
  }

  /**
   * Set the output volume for a specific instrument (mixer volume).
   * This sets the gain on the instrument's output node, separate from per-voice gain.
   */
  setInstrumentOutputGain(instrumentId: string | undefined, gain: number) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    active.instrument.setOutputGain(gain);
  }

  /**
   * Get the current output gain for a specific instrument.
   */
  getInstrumentOutputGain(instrumentId: string | undefined): number {
    if (!instrumentId) return 1.0;
    const active = this.instruments.get(instrumentId);
    if (!active) return 1.0;
    return active.instrument.getOutputGain();
  }

  setInstrumentMacro(
    instrumentId: string | undefined,
    macroIndex: number,
    value: number,
    time?: number,
    ramp?: {
      targetValue: number;
      targetTime: number;
      interpolation?: 'linear' | 'exponential';
    },
  ) {
    if (!instrumentId) return;
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    active.instrument.setMacro(
      macroIndex,
      value,
      time,
      ramp?.targetValue,
      ramp?.targetTime,
      ramp?.interpolation,
    );
  }

  private ensureInstrumentIfDesired(instrumentId: string) {
    const patch = this.desired.get(instrumentId);
    if (patch) {
      void this.ensureInstrument(instrumentId, patch);
    }
  }

  private dispatchNoteOnAtTime(
    instrumentId: string,
    midi: number,
    velocity: number,
    time: number,
    trackIndex?: number,
    frequency?: number,
    pan?: number,
    sampleOffsetFrames?: number,
    tickSeconds?: number,
  ) {
    const active = this.instruments.get(instrumentId);
    if (!active) return;
    const now = this.audioContext.currentTime;
    //const timeOffset = time - now;
    // if (timeOffset < 2) {
    //   console.log(
    //     `[SongBank] noteOnAtTime: inst=${instrumentId}, midi=${midi}, time=${time.toFixed(3)}, now=${now.toFixed(3)}, offset=${timeOffset.toFixed(3)}s`,
    //   );
    // }

    // Only warn about missing worklet for InstrumentV2 (ModInstruments don't use worklets)
    const worklet = active.instrument.workletNode;
    if (!worklet && active.instrument instanceof InstrumentV2) {
      console.warn(
        `[SongBank] noteOnAtTime: InstrumentV2 ${instrumentId} has NO workletNode!`,
      );
    }

    // Avoid pushing the note later than requested; only clamp if we're already in the past.
    const scheduledTime = time < now ? now + MIN_SCHEDULE_LEAD_SECONDS : time;
    // First, clear any lingering voice currently tracked on this track (any instrument).
    if (Number.isFinite(trackIndex as number)) {
      const existing = this.voices.ownerOf(trackIndex as number);
      if (existing) {
        const owner = this.instruments.get(existing.instrumentId);
        if (owner) {
          const gateLead = this.getGateLeadTime(owner.instrument);
          let gateTime = scheduledTime - gateLead;
          if (gateTime < now) gateTime = now + 0.001;
          if (gateTime >= scheduledTime)
            gateTime = Math.max(now, scheduledTime - 0.0005);
          // The channel is switching instrument, so nothing on the old
          // instrument will ever come back to stop this voice.
          this.voices.endVoiceForReplacement(
            owner.instrument,
            existing.voiceIndex,
            gateTime,
          );
        }
        this.voices.deleteOwner(trackIndex as number);
      }
    }
    // Anything left ringing on this track by an earlier key-off has to go too.
    // It is not the track's current voice, so neither of the paths above sees
    // it, and on a module channel it must not survive the new note.
    this.voices.cutReleasingVoicesForTrack(trackIndex, scheduledTime);
    // Also gate off the previous voice for this instrument/track if known.
    this.gateOffPreviousTrackVoice(instrumentId, trackIndex, scheduledTime);
    const monitorNode = Number.isFinite(trackIndex as number)
      ? this.maybeTrackMonitor(trackIndex as number)
      : null;
    const voiceIndex = active.instrument.noteOnAtTime(
      midi,
      velocity,
      scheduledTime,
      {
        allowDuplicate: true,
        ...(frequency !== undefined ? { frequency } : {}),
        ...(pan !== undefined ? { pan } : {}),
        ...(sampleOffsetFrames !== undefined ? { sampleOffsetFrames } : {}),
        ...(tickSeconds !== undefined ? { tickSeconds } : {}),
        // The channel owns a voice, so notes never cut another channel's.
        ...(trackIndex !== undefined ? { trackIndex } : {}),
        // Per-track visualiser tap; carries this channel alone. Absent when
        // per-track monitoring is off (the phone layout).
        ...(monitorNode ? { monitorNode } : {}),
      },
    );

    // Verify parameter presence for debugging
    if (voiceIndex !== undefined && worklet) {
      const instrumentWithParamName = active.instrument as unknown as {
        getParamName?: (paramType: string, voiceIndex: number) => string;
      };
      const getParamName = instrumentWithParamName?.getParamName;
      const gateName =
        typeof getParamName === 'function'
          ? getParamName.call(active.instrument, 'gate', voiceIndex)
          : `gate_${voiceIndex}`;
      const freqName =
        typeof getParamName === 'function'
          ? getParamName.call(active.instrument, 'frequency', voiceIndex)
          : `frequency_${voiceIndex}`;
      const gateParam = worklet.parameters.get(gateName);
      const freqParam = worklet.parameters.get(freqName);
      if (!gateParam || !freqParam) {
        console.warn(
          `[SongBank] noteOnAtTime: instrument ${instrumentId} voice ${voiceIndex} missing params! gate=${!!gateParam} (${gateName}), freq=${!!freqParam} (${freqName})`,
        );
      }
    }

    this.voices.getTrackNotes(instrumentId, trackIndex).add(midi);
    if (voiceIndex !== undefined) {
      this.voices.setLastVoiceForTrack(instrumentId, trackIndex, voiceIndex);
      if (Number.isFinite(trackIndex as number)) {
        this.voices.setOwner(trackIndex as number, {
          instrumentId,
          voiceIndex,
        });
      }
    } else {
      console.warn(
        '[SongBank] noteOnAtTime: voice allocation failed for instrument',
        instrumentId,
        'track',
        trackIndex,
        'midi',
        midi,
      );
    }
  }

  private dispatchNoteOffAtTime(
    requestedInstrumentId: string,
    midi: number | undefined,
    time: number,
    trackIndex?: number,
  ) {
    // A key-off releases the *channel*, not the instrument named on the row.
    //
    // XM rows routinely carry an instrument number alongside `===` -- in FT2
    // that selects the sample for the channel's *next* note, and has nothing
    // to do with what is being released. xyce-dans_la_rue.xm pattern 22 row 12
    // is `=== 11` on a channel that has been holding a note from an earlier
    // pattern on a different instrument: routing the release to instrument 11,
    // which has nothing sounding there, left the held note playing.
    //
    // `trackVoiceOwner` knows which instrument actually owns the channel's
    // voice, so ask it first and fall back to the row's own instrument.
    const owner = Number.isFinite(trackIndex as number)
      ? this.voices.ownerOf(trackIndex as number)
      : undefined;
    const instrumentId = owner?.instrumentId ?? requestedInstrumentId;

    const active = this.instruments.get(instrumentId);
    if (!active) return;
    const notes = this.voices.getTrackNotes(instrumentId, trackIndex);
    // When the owner answered, take its voice as well as its instrument. The
    // two maps can disagree, and the owner is the one that knows what the
    // channel is actually sounding.
    const voiceIndex =
      owner?.voiceIndex ?? this.voices.peekLastVoiceForTrack(instrumentId, trackIndex);

    const scheduledTime = Math.max(time, this.audioContext.currentTime);

    if (midi === undefined) {
      if (voiceIndex !== undefined) {
        active.instrument.gateOffVoiceAtTime(voiceIndex, scheduledTime);
        // It is no longer the track's *current* voice, but it is still making
        // sound, and on a module channel the next note has to kill it.
        this.voices.rememberReleasingVoice(instrumentId, trackIndex, voiceIndex);
        // Remove voice from track tracking
        this.voices.clearLastVoiceForTrack(instrumentId, trackIndex);
        if (Number.isFinite(trackIndex as number)) {
          this.voices.deleteOwner(trackIndex as number);
        }
      } else if (notes && notes.size > 0) {
        for (const note of notes) {
          active.instrument.noteOffAtTime(note, scheduledTime, trackIndex);
        }
      } else {
        active.instrument.cancelScheduledNotes();
      }
      notes.clear();
      // Clear all voice tracking for this track
      this.voices.clearLastVoiceForTrack(instrumentId, trackIndex);
      if (Number.isFinite(trackIndex as number)) {
        this.voices.deleteOwner(trackIndex as number);
      }
      return;
    }

    if (voiceIndex !== undefined) {
      // The voice is already known, so release it directly. This used to call
      // noteOffAtTime(midi, time, voiceIndex), passing a *voice* index into a
      // parameter that means the *track* index -- harmless only because the
      // callee ignored it.
      active.instrument.gateOffVoiceAtTime(voiceIndex, scheduledTime);
      this.voices.rememberReleasingVoice(instrumentId, trackIndex, voiceIndex);
      // Remove voice from track tracking
      this.voices.clearLastVoiceForTrack(instrumentId, trackIndex);
      if (Number.isFinite(trackIndex as number)) {
        this.voices.deleteOwner(trackIndex as number);
      }
    } else {
      active.instrument.noteOffAtTime(midi, scheduledTime, trackIndex);
    }
    notes.delete(midi);
  }

  /**
   * Set the pitch (frequency) for a specific voice at a specific time.
   * Used for portamento, vibrato, arpeggio effects.
   */
  setVoicePitchAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    frequency: number,
    time: number,
    trackIndex: number,
    rampMode?: 'linear' | 'exponential',
  ) {
    if (!instrumentId) return;
    const target = this.voices.resolveCommandVoice(
      instrumentId,
      voiceIndex,
      trackIndex,
    );
    if (!target) return;
    target.active.instrument.setVoiceFrequencyAtTime(
      target.voiceIndex,
      frequency,
      time,
      rampMode,
    );
  }

  /**
   * Set the volume for a specific voice at a specific time.
   * Used for tremolo, volume slide effects.
   */
  setVoiceVolumeAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    volume: number,
    time: number,
    trackIndex: number,
    rampMode?: 'linear' | 'exponential' | 'step',
  ) {
    if (!instrumentId) return;
    // No fallback to voice 0 when nothing resolves.
    //
    // Instruments are per-sample, so two tracks playing the same sample share
    // one instrument and its voice pool. Defaulting to voice 0 when *this*
    // track has no voice yet therefore aims the command at whichever track
    // happens to own voice 0, silently rewriting another channel's gain.
    // GSLINGER.MOD pattern 2 is the case that exposed it: channels 1 and 3
    // both play sample 9, and channel 3's row-0 "C00" (volume zero, no note)
    // landed on channel 1's just-started lead and killed it.
    //
    // A volume command on a track with nothing sounding has nothing to apply
    // to. ProTracker keeps it as the channel's volume and uses it for that
    // channel's next note, which is exactly what the importer's sticky volume
    // column already reproduces -- so dropping it here is correct, not merely
    // safe. A row that starts a note records its voice before this runs
    // (dispatchCommands precedes the velocity block in the engine), so
    // genuine note+volume rows still resolve.
    const target = this.voices.resolveCommandVoice(
      instrumentId,
      voiceIndex,
      trackIndex,
    );
    if (!target) return;
    // Default to a linear ramp for smoother gain changes to avoid audible
    // snaps. Instantaneous commands (Cxx, ECx, fine slides, a note's own
    // starting level) ask for 'step' explicitly, because a ramp there runs
    // from the previous automation event and turns an instant change into a
    // glide across the whole preceding row.
    const mode = rampMode ?? 'linear';
    target.active.instrument.setVoiceGainAtTime(
      target.voiceIndex,
      volume,
      time,
      mode,
    );
  }

  /**
   * Set the stereo pan (0-1, 0 = hard left) for a specific voice at a
   * specific time. Used for 8xx / E8x / Pxy, which pan a note that is already
   * sounding, unlike the per-note pan carried on a note-on.
   *
   * Pan rides on macro 0 for MOD-imported patches (see mod-import.ts), which
   * every instrument implementation routes to its pan control.
   */
  setVoicePanAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    pan: number,
    time: number,
    trackIndex: number,
  ) {
    if (!instrumentId) return;
    // No voice-0 fallback: tracks sharing a sample share this instrument's
    // voice pool, so that would pan another channel's note. See D13 in
    // PLAN-module-format-support.md.
    const target = this.voices.resolveCommandVoice(
      instrumentId,
      voiceIndex,
      trackIndex,
    );
    if (!target) return;
    // Macro index 0 is pan in MOD-imported sampler patches.
    target.active.instrument.setVoiceMacroAtTime(
      target.voiceIndex,
      0,
      Math.max(0, Math.min(1, pan)),
      time,
    );
  }

  /**
   * Move a voice's envelopes to a tick position (Lxx).
   *
   * Resolves the track's voice the same way the volume and pan commands do,
   * and drops the command when the track has nothing sounding -- there is no
   * envelope to reposition, and aiming at voice 0 would hit whichever track
   * happens to own it (D13).
   */
  setVoiceEnvelopePositionAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    tick: number,
    time: number,
    trackIndex: number,
  ) {
    if (!instrumentId) return;
    const target = this.voices.resolveCommandVoice(
      instrumentId,
      voiceIndex,
      trackIndex,
    );
    if (!target) return;

    const envelopes = target.active.instrument as {
      setEnvelopePositionAtTime?: (v: number, t: number, when: number) => void;
    };
    envelopes.setEnvelopePositionAtTime?.(target.voiceIndex, tick, time);
  }

  /**
   * Set the sample offset (normalized 0-1) for a specific voice at a specific
   * time, via a dedicated macro route.
   *
   * Nothing in tracker playback drives this any more: 9xx is applied when the
   * voice starts (it cannot be applied later on a Web Audio buffer source), so
   * it rides on the noteOn as `sampleOffsetFrames`, and a 9xx row that carries
   * no note is silent in ProTracker. Kept for direct/manual macro use.
   */
  setVoiceSampleOffsetAtTime(
    instrumentId: string | undefined,
    voiceIndex: number,
    offset: number,
    time: number,
    trackIndex: number,
  ) {
    if (!instrumentId) return;
    // Same cross-track hazard as setVoiceVolumeAtTime: two tracks sharing a
    // sample share this instrument's voices, so voice 0 may belong to a
    // different channel. A 9xx with no sounding voice on this track has
    // nothing to offset.
    const target = this.voices.resolveCommandVoice(
      instrumentId,
      voiceIndex,
      trackIndex,
    );
    if (!target) return;
    // Macro index 1 is reserved for sample offset in MOD-imported sampler patches.
    target.active.instrument.setVoiceMacroAtTime(
      target.voiceIndex,
      1,
      offset,
      time,
    );
  }

  /**
   * Retrigger a note at a specific time (for E9x, Rxy effects).
   */
  retriggerNoteAtTime(
    instrumentId: string | undefined,
    midi: number,
    velocity: number,
    time: number,
    trackIndex?: number,
    frequency?: number,
  ) {
    if (!instrumentId) return;

    // A retrigger restarts *what the channel is sounding*, so it addresses the
    // channel's voice, not the instrument written on the row -- the same rule
    // every other per-voice command follows (see resolveCommandVoice). On a
    // module channel a row can name an instrument for the next note while the
    // retrigger applies to the one already playing; resolving instrument-first
    // there restarts the wrong sample, or nothing at all.
    const owner = this.voices.resolveCommandVoice(instrumentId, -1, trackIndex);
    const targetInstrumentId = owner?.instrumentId ?? instrumentId;
    const active = this.instruments.get(targetInstrumentId);
    if (!active) return;

    // A retrigger is a note-on on the same channel -- E9x and Rxy restart the
    // sample from the beginning -- so it has to take the channel over exactly
    // as a new note does, cutting whatever was sounding there.
    //
    // This used to call `noteOnAtTime` directly with `allowDuplicate` and no
    // track index, which skipped every one of those steps: with no track the
    // instrument allocates from its round-robin pool rather than the channel's
    // own voice, so each repeat stacked another voice and none of them was
    // ever cut. `E91` at speed 6 is five repeats in a single row.
    // peacedroid.mod patterns 16 and 17 end their track-1 phrase on
    // `E93 E92 E91`, which is where it was heard.
    this.dispatchNoteOnAtTime(
      targetInstrumentId,
      midi,
      velocity,
      Math.max(time, this.audioContext.currentTime),
      trackIndex,
      frequency,
    );
  }

  /**
   * Ensure the audio context is running (resume if suspended).
   * Returns true if the context is running after this call (whether it was already running or successfully resumed).
   *
   * IMPORTANT: This will wait and poll for the context to become running,
   * which might require user interaction on the page.
   *
   * Every await on `resume()` is bounded: without a user gesture the browser
   * can leave the promise pending indefinitely (fresh-tab deep links), and an
   * unbounded await here would stall song loading, not just playback. Pass
   * `maxWaitMs` to shorten the wait on load paths; playback keeps the 10s
   * default.
   */
  async ensureAudioContextRunning(maxWaitMs = 10000): Promise<boolean> {
    const ctx = this.audioContext;
    if (ctx.state === 'running') {
      this.needsAudioContextResume = false;
      void this.eventQueue.flushPendingScheduledEvents();
      return true;
    }

    this.needsAudioContextResume = true;
    console.warn(
      `[SongBank] AudioContext state=${ctx.state}; attempting to resume.`,
    );

    // resume() itself may never settle (no user gesture yet), so race it
    // against a timeout instead of awaiting it directly.
    const resumeBounded = (ms: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        void ctx.resume().then(
          () => {
            clearTimeout(timer);
            resolve(ctx.state === 'running');
          },
          () => {
            clearTimeout(timer);
            resolve(false);
          },
        );
      });

    const deadline = Date.now() + maxWaitMs;
    const pollMs = 100;

    while (true) {
      const currentState: string = ctx.state;
      if (currentState === 'running') {
        this.needsAudioContextResume = false;
        void this.eventQueue.flushPendingScheduledEvents();
        return true;
      }
      if (Date.now() >= deadline) break;

      const resumed = await resumeBounded(
        Math.min(300, deadline - Date.now()),
      );
      if (!resumed) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }

    // Timed out
    console.error(
      '[TrackerSongBank] Timeout waiting for audio context to resume. Please interact with the page (click anywhere).',
    );
    console.warn(
      `[SongBank] AudioContext resume timed out; final state=${ctx.state}`,
    );
    this.needsAudioContextResume = true;
    return false;
  }

  private async ensureInstrument(
    instrumentId: string,
    patch: Patch,
  ): Promise<void> {
    const generation = this.generation;
    // Check if this instrument is already being initialized
    const pending = this.pendingInstruments.get(instrumentId);
    if (pending) {
      await pending;
      return;
    }

    // Start initialization and track the promise
    const initPromise = this.ensureInstrumentInternal(
      instrumentId,
      patch,
      generation,
    );
    this.pendingInstruments.set(instrumentId, initPromise);

    try {
      await initPromise;
    } finally {
      // Clean up the pending promise when done
      this.pendingInstruments.delete(instrumentId);
    }
  }

  private async ensureInstrumentInternal(
    instrumentId: string,
    patch: Patch,
    generation: number,
  ): Promise<void> {
    // A created-but-suspended context is enough for instrument/worklet
    // construction (fresh-tab deep links); only playback needs 'running'.
    // Only a closed context genuinely blocks construction. If still
    // suspended, needsAudioContextResume is armed (set by the bounded resume
    // attempt in syncSlots or here) and the onstatechange handler rebuilds
    // instruments built this way when the context becomes running.
    const contextState = this.audioContext.state;
    if (contextState === 'closed') {
      console.warn(
        `[SongBank] Skipping ensureInstrument for ${instrumentId} because AudioContext is closed. needsResume=${this.needsAudioContextResume}`,
      );

      return;
    }
    if (contextState !== 'running') {
      this.wasSuspended = true;
      this.needsAudioContextResume = true;
      console.warn(
        `[SongBank] Building instrument ${instrumentId} while AudioContext is ${contextState}; it will be rebuilt when the context resumes.`,
      );
    }
    const normalizedPatch = this.normalizePatch(patch);
    const deserialized = deserializePatch(normalizedPatch);
    const patchId = normalizedPatch?.metadata?.id;
    if (!patchId) return;
    const patchReuseKey = this.getPatchReuseKey(normalizedPatch);
    const hasPortamento = this.hasActivePortamento(normalizedPatch);

    const existing = this.instruments.get(instrumentId);
    const canReuse =
      existing &&
      existing.patchId === patchId &&
      patchReuseKey !== null &&
      existing.patchReuseKey === patchReuseKey;

    if (canReuse) {
      // console.log(
      //   `[SongBank] Reusing existing instrument: ${instrumentId} (skipping state reapplication to preserve live audio)`,
      // );
      existing.hasPortamento = hasPortamento;
      this.normalizeVoiceGain(existing.instrument);
      // Skip restoreAudioAssets, applyNodeStates, and applyMacros when reusing
      // These would reset effect buffers (delays, reverbs) and interrupt live playback
      // The instrument already has the correct patch loaded from previous sync
      // Verify connection is still intact, reconnect if needed
      if (existing.instrument.outputNode.numberOfOutputs === 0) {
        console.warn(
          `[SongBank] Instrument ${instrumentId} was disconnected, reconnecting...`,
        );
        existing.instrument.outputNode.connect(this.masterGain);
      }
      await this.eventQueue.flushPendingScheduledEvents(instrumentId);
      return;
    }

    if (existing) {
      console.log(
        `[SongBank] Tearing down existing instrument (different patch): ${instrumentId}`,
      );
      this.teardownInstrument(instrumentId);
    }

    console.log(`[SongBank] Creating new instrument: ${instrumentId}`);

    // Check if this is a MOD instrument and user has simplified MOD instruments enabled
    const userSettings = useUserSettingsStore();
    const isModInstrument = normalizedPatch.metadata.instrumentType === 'mod';
    // ModInstrument's per-voice pitch automation (e.g. 3xx tone portamento)
    // is scheduled directly on the native AudioParam (see
    // ModInstrument.setVoiceFrequencyAtTime), and MOD import/playback is
    // tuned against this path, so it defaults to ON (see SETTINGS_VERSION v1
    // in user-settings-store.ts). Users can still opt back into routing MOD
    // instruments through the full WASM synth.
    //
    // NOTE: this is app-global today. Per PLAN-module-format-support.md (D4),
    // engine choice should move into the per-song FormatProfile; ModInstrument
    // does implement XM's tracker volume/pan envelopes, auto-vibrato and
    // per-channel voice ownership, so this is an architecture cleanup rather
    // than a functional gap.
    const useSimplified = userSettings.settings.useSimplifiedModInstruments;

    // DETAILED DEBUGGING
    console.log('[SongBank] === INSTRUMENT CREATION DEBUG ===');
    console.log(`[SongBank]   instrumentId: ${instrumentId}`);
    console.log(
      `[SongBank]   instrumentType: ${normalizedPatch.metadata.instrumentType}`,
    );
    console.log(`[SongBank]   isModInstrument: ${isModInstrument}`);
    console.log(`[SongBank]   useSimplified: ${useSimplified}`);
    console.log(`[SongBank]   useWorkletPooling: ${this.useWorkletPooling}`);
    console.log(
      `[SongBank]   workletPool exists: ${this.workletPool !== null}`,
    );
    console.log(
      `[SongBank]   Decision: ${
        isModInstrument && useSimplified
          ? 'ModInstrument'
          : this.useWorkletPooling && isModInstrument && this.workletPool
            ? 'PooledInstrument'
            : 'InstrumentV2 (LEGACY - CREATES OWN WORKLET!)'
      }`,
    );

    let instrument: InstrumentV2 | ModInstrument | PooledInstrument;

    if (isModInstrument && useSimplified) {
      // Option 1: Use ModInstrument (native Web Audio API, no worklet)
      console.log(`[SongBank] Creating ModInstrument for ${instrumentId}`);
      instrument = new ModInstrument(
        this.masterGain,
        this.audioSystem.audioContext,
        { pitchModel: this.formatProfile.pitch },
      );

      await instrument.loadPatch(normalizedPatch);
      console.log(
        `[SongBank] ModInstrument ${instrumentId} loaded, isReady=${instrument.isReady}`,
      );
    } else if (this.useWorkletPooling && this.workletPool) {
      // Option 2: Use PooledInstrument (shared worklet, efficient for tracker playback)
      console.log(
        `[SongBank] Creating PooledInstrument for ${instrumentId} via WorkletPool`,
      );

      // Use the patch's requested voice count (clamped to per-engine limit)
      const requestedVoices = Math.max(
        1,
        Math.min(
          VOICES_PER_ENGINE,
          normalizedPatch?.synthState?.layout?.voiceCount ??
            normalizedPatch?.synthState?.layout?.voices?.length ??
            VOICES_PER_ENGINE,
        ),
      );

      const allocation = await this.workletPool.allocateVoices(
        instrumentId,
        requestedVoices,
      );

      console.log(
        `[SongBank] Allocated voices ${allocation.startVoice}-${allocation.endVoice - 1} on worklet ${allocation.workletIndex} for ${instrumentId}`,
      );

      // Create pooled instrument with the allocation
      instrument = new PooledInstrument(
        this.masterGain,
        this.audioSystem.audioContext,
        instrumentId,
        allocation,
      );

      await instrument.loadPatch(normalizedPatch);
      console.log(
        `[SongBank] PooledInstrument ${instrumentId} loaded, isReady=${instrument.isReady}`,
      );

      // Log pool statistics
      const stats = this.workletPool.getStats();
      console.log(
        `[SongBank] Pool stats: ${stats.workletCount} worklets, ${stats.allocatedVoices}/${stats.totalVoices} voices allocated`,
      );

      await this.restoreAudioAssets(
        instrumentId,
        instrument,
        normalizedPatch,
        deserialized,
      );

      // Normalize sampler loop points/detune for pooled instruments (patch stores normalized values)
      this.applySamplerStates(instrument, deserialized.samplers);

      // Apply macro values/routes so pooled instruments match the patch (e.g., vibrato depth).
      this.applyMacrosFromPatch(instrument, normalizedPatch);
    } else {
      // Option 3: Use InstrumentV2 (own worklet, for patch editor or non-MOD instruments)
      console.log(`[SongBank] Creating InstrumentV2 for ${instrumentId}`);
      const memory = new WebAssembly.Memory({
        initial: 256,
        maximum: 1024,
        shared: true,
      });
      instrument = new InstrumentV2(
        this.masterGain,
        this.audioSystem.audioContext,
        memory,
      );

      const ready = await this.waitForInstrumentReady(instrument);
      if (!ready) {
        console.warn('[TrackerSongBank] Instrument initialization timeout');
        instrument.outputNode.disconnect();
        return;
      }
      console.log(
        `[SongBank] Instrument ${instrumentId} worklet ready, loading patch...`,
      );

      await instrument.loadPatch(normalizedPatch);
      console.log(
        `[SongBank] Instrument ${instrumentId} patch loaded, isReady=${instrument.isReady}`,
      );
      // Give WASM time to finish building all voice node structures before updating states
      // Reduced from 100ms to 20ms - loadPatch already waits for synthLayout response,
      // this additional delay just ensures voice structures are built. Conservative reduction
      // maintains stability while reducing stutter on laptops
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Apply assets and node state in parallel to avoid serial stalls (only for InstrumentV2)
      await Promise.all([
        this.restoreAudioAssets(
          instrumentId,
          instrument,
          normalizedPatch,
          deserialized,
        ),
        this.applyNodeStates(instrument, deserialized),
      ]);

      this.applyMacrosFromPatch(instrument, normalizedPatch);
    }

    this.normalizeVoiceGain(instrument);
    if (generation !== this.generation) {
      console.warn(
        `[SongBank] Discarding instrument ${instrumentId} from previous generation`,
      );
      instrument.dispose();
      return;
    }
    this.instruments.set(instrumentId, {
      instrument,
      patchId,
      patchReuseKey,
      hasPortamento,
    });
    await this.eventQueue.flushPendingScheduledEvents(instrumentId);
  }

  private normalizeVoiceGain(
    instrument: InstrumentV2 | ModInstrument | PooledInstrument,
  ) {
    // Ensure voice gains aren't left at a previous automation value (e.g. 0)
    instrument.setGainForAllVoices(1);
  }

  private async restoreAudioAssets(
    instrumentId: string,
    instrument: InstrumentV2 | PooledInstrument,
    patch: Patch,
    deserialized: DeserializedPatch,
  ): Promise<void> {
    const assets = patch.audioAssets;
    if (!assets || Object.keys(assets).length === 0) {
      return;
    }

    // Track imported assets per instrument to avoid re-importing (expensive for wavetables).
    let seen = this.restoredAssets.get(instrumentId);
    if (!seen) {
      seen = new Set<string>();
      this.restoredAssets.set(instrumentId, seen);
    }

    const assetEntries = Object.entries(assets) as [string, AudioAsset][];
    for (const [assetId, asset] of assetEntries) {
      try {
        if (seen.has(assetId)) continue;
        const parsed = parseAudioAssetId(assetId);
        if (!parsed) continue;
        const { nodeType, nodeId } = parsed;

        const binaryData = atob(asset.base64Data);
        const bytes = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i);
        }

        if (nodeType === 'sample') {
          const wavInfo = this.parseWavInfo(bytes);
          if (wavInfo) {
            const samplerState = deserialized.samplers.get(nodeId);
            if (samplerState) {
              deserialized.samplers.set(nodeId, {
                ...samplerState,
                sampleLength: wavInfo.frames,
                sampleRate: wavInfo.sampleRate,
                channels: wavInfo.channels,
              });
            }
          }
          await instrument.importSampleData(nodeId, bytes);
        } else if (nodeType === 'impulse_response') {
          await instrument.importImpulseWaveformData(nodeId, bytes);
        } else if (nodeType === 'wavetable') {
          await instrument.importWavetableData(nodeId, bytes);
        }
        seen.add(assetId);
      } catch (error) {
        console.error(
          `[TrackerSongBank] Failed to restore audio asset ${assetId}:`,
          error,
        );
      }
    }
  }

  private applyMacrosFromPatch(
    instrument: InstrumentV2 | PooledInstrument,
    patch: Patch,
  ) {
    const macros = patch?.synthState?.macros;
    if (!macros) return;

    if (Array.isArray(macros.values)) {
      macros.values.forEach((value, index) => {
        if (Number.isFinite(value)) {
          instrument.setMacro(index, Number(value));
        }
      });
    }

    if (Array.isArray(macros.routes)) {
      (macros.routes as MacroRouteState[]).forEach((route) => {
        if (!route || route.targetId === undefined) return;

        const macroIndex = Number(route.macroIndex);
        if (!Number.isFinite(macroIndex) || macroIndex < 0) return;

        const targetPort = Number(route.targetPort ?? PortId.AudioInput0);
        const amount = Number(route.amount ?? 0);
        const modulationType =
          (route.modulationType as WasmModulationType | undefined) ??
          WasmModulationType.Additive;
        const modulationTransformation =
          (route.modulationTransformation as
            | ModulationTransformation
            | undefined) ?? ModulationTransformation.None;

        instrument.connectMacroRoute({
          macroIndex,
          targetId: route.targetId,
          targetPort: targetPort as PortId,
          amount,
          modulationType,
          modulationTransformation,
        });
      });
    }
  }

  private async waitForInstrumentReady(
    instrument: InstrumentV2,
    timeoutMs = 8000,
    pollMs = 50,
  ): Promise<boolean> {
    const start = Date.now();
    while (!instrument.isReady) {
      if (Date.now() - start > timeoutMs) {
        console.warn(
          '[TrackerSongBank] Timed out waiting for instrument readiness',
        );
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return true;
  }

  private hasActivePortamento(patch: Patch): boolean {
    const glides = patch?.synthState?.glides;
    if (!glides) return false;
    return Object.values(glides).some((glide) => {
      if (!glide) return false;
      const time = Number(glide.time ?? 0);
      const active = !!glide.active;
      return active && time > 0;
    });
  }

  /**
   * Normalize a patch so tracker playback uses the same upgraded shapes
   * as the patch editor (fills missing fields, canonical voice, etc.).
   */
  private normalizePatch(patch: Patch): Patch {
    try {
      const deserialized = deserializePatch(patch);
      const metadata = this.normalizePatchMetadata(patch.metadata);
      const synthState: SynthState = {
        layout: this.normalizePatchLayout(deserialized.layout),
        oscillators: this.mapToRecord(deserialized.oscillators),
        wavetableOscillators: this.mapToRecord(
          deserialized.wavetableOscillators,
        ),
        filters: this.mapToRecord(deserialized.filters),
        envelopes: this.mapToRecord(deserialized.envelopes),
        lfos: this.mapToRecord(deserialized.lfos),
        samplers: this.mapToRecord(deserialized.samplers),
        glides: this.mapToRecord(deserialized.glides),
        convolvers: this.mapToRecord(deserialized.convolvers),
        delays: this.mapToRecord(deserialized.delays),
        choruses: this.mapToRecord(deserialized.choruses),
        reverbs: this.mapToRecord(deserialized.reverbs),
        compressors: this.mapToRecord(deserialized.compressors),
        saturations: this.mapToRecord(deserialized.saturations),
        bitcrushers: this.mapToRecord(deserialized.bitcrushers),
      };

      if (deserialized.noise !== undefined) {
        synthState.noise = deserialized.noise;
      }
      if (deserialized.velocity !== undefined) {
        synthState.velocity = deserialized.velocity;
      }
      if (deserialized.macros) {
        synthState.macros = {
          values: deserialized.macros.values ?? [],
          routes: deserialized.macros.routes ?? [],
        };
      }

      return {
        metadata,
        synthState,
        audioAssets: this.mapToRecord(deserialized.audioAssets),
      };
    } catch (error) {
      console.warn(
        '[TrackerSongBank] Failed to normalize patch; using raw patch',
        error,
      );
      return patch;
    }
  }

  private normalizePatchLayout(layout: SynthLayout): SynthState['layout'] {
    return synthLayoutToPatchLayout(layout);
  }

  private normalizePatchMetadata(metadata: PatchMetadata): PatchMetadata {
    const safeTags = Array.isArray(metadata?.tags)
      ? [...metadata.tags]
      : undefined;
    const created = metadata?.created ?? metadata?.modified ?? 0;
    const modified = metadata?.modified ?? metadata?.created ?? created;
    return {
      id: metadata?.id ?? `song-patch-${created || Date.now()}`,
      name: metadata?.name ?? 'Untitled',
      created,
      modified,
      version: metadata?.version ?? PRESET_SCHEMA_VERSION,
      ...(typeof metadata?.category === 'string'
        ? { category: metadata.category }
        : {}),
      ...(typeof metadata?.author === 'string'
        ? { author: metadata.author }
        : {}),
      ...(safeTags ? { tags: safeTags } : {}),
      ...(typeof metadata?.description === 'string'
        ? { description: metadata.description }
        : {}),
      ...(metadata?.instrumentType
        ? { instrumentType: metadata.instrumentType }
        : {}),
    };
  }

  private mapToRecord<T>(map: Map<string, T>): Record<string, T> {
    const record: Record<string, T> = {};
    map.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }

  private async applyNodeStates(
    instrument: InstrumentV2,
    deserialized: DeserializedPatch,
  ): Promise<void> {
    deserialized.oscillators.forEach(
      (state: OscillatorState, nodeId: string) => {
        instrument.updateOscillatorState(nodeId, { ...state, id: nodeId });
      },
    );

    deserialized.wavetableOscillators.forEach(
      (state: OscillatorState, nodeId: string) => {
        instrument.updateWavetableOscillatorState(nodeId, {
          ...state,
          id: nodeId,
        });
      },
    );

    const envelopePromises: Promise<void>[] = [];
    deserialized.envelopes.forEach((state: EnvelopeConfig, nodeId: string) => {
      envelopePromises.push(
        instrument.updateEnvelopeState(nodeId, {
          ...state,
          id: nodeId,
        }),
      );
    });

    deserialized.lfos.forEach((state: LfoState, nodeId: string) => {
      instrument.updateLfoState(nodeId, {
        id: nodeId,
        frequency: state.frequency,
        phaseOffset: state.phaseOffset ?? 0,
        waveform: state.waveform,
        useAbsolute: state.useAbsolute,
        useNormalized: state.useNormalized,
        triggerMode: state.triggerMode,
        gain: state.gain,
        active: state.active,
        loopMode: state.loopMode,
        loopStart: state.loopStart,
        loopEnd: state.loopEnd,
      });
    });

    deserialized.filters.forEach((state: FilterState, nodeId: string) => {
      instrument.updateFilterState(nodeId, { ...state, id: nodeId });
    });

    deserialized.glides.forEach((state: GlideState, nodeId: string) => {
      instrument.updateGlideState(nodeId, { ...state, id: nodeId });
    });

    deserialized.convolvers.forEach((state: ConvolverState, nodeId: string) => {
      instrument.updateConvolverState(nodeId, { ...state, id: nodeId });
    });

    deserialized.delays.forEach((state: DelayState, nodeId: string) => {
      instrument.updateDelayState(nodeId, { ...state, id: nodeId });
    });

    deserialized.choruses.forEach((state: ChorusState, nodeId: string) => {
      instrument.updateChorusState(nodeId, { ...state, id: nodeId });
    });

    deserialized.reverbs.forEach((state: ReverbState, nodeId: string) => {
      instrument.updateReverbState(nodeId, { ...state, id: nodeId });
    });

    deserialized.compressors.forEach(
      (state: CompressorState, nodeId: string) => {
        instrument.updateCompressorState(nodeId, { ...state, id: nodeId });
      },
    );

    deserialized.saturations.forEach(
      (state: SaturationState, nodeId: string) => {
        instrument.updateSaturationState(nodeId, { ...state, id: nodeId });
      },
    );

    deserialized.bitcrushers.forEach(
      (state: BitcrusherState, nodeId: string) => {
        instrument.updateBitcrusherState(nodeId, { ...state, id: nodeId });
      },
    );

    this.applySamplerStates(instrument, deserialized.samplers);

    await Promise.all(envelopePromises);
  }

  private clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }

  private buildSamplerUpdatePayload(state: SamplerState) {
    const sampleLength = Math.max(
      1,
      state.sampleLength || state.sampleRate || 1,
    );
    const loopStartNorm = this.clamp01(state.loopStart ?? 0);
    const requestedEnd = this.clamp01(state.loopEnd ?? 1);
    const minDelta = 1 / sampleLength;
    const loopEndNorm =
      requestedEnd <= loopStartNorm + minDelta
        ? Math.min(1, loopStartNorm + minDelta)
        : requestedEnd;
    const detuneCents = Number.isFinite(state.detune)
      ? (state.detune as number)
      : combineDetuneParts(
          state.detune_oct ?? 0,
          state.detune_semi ?? 0,
          state.detune_cents ?? 0,
        );
    const tuningFrequency = frequencyFromDetune(detuneCents);

    return {
      frequency: tuningFrequency,
      // Avoid silent samplers when gain is 0 (common for MOD imports that rely on Axx/Cxx to fade in)
      gain: state.gain === 0 ? 1 : state.gain,
      loopMode: state.loopMode,
      loopStart: loopStartNorm * sampleLength,
      loopEnd: loopEndNorm * sampleLength,
      rootNote: state.rootNote,
      triggerMode: state.triggerMode,
      active: state.active,
    };
  }

  private applySamplerStates(
    instrument: InstrumentV2 | PooledInstrument,
    samplers: Map<string, SamplerState>,
  ) {
    samplers.forEach((state: SamplerState, nodeId: string) => {
      instrument.updateSamplerState(
        nodeId,
        this.buildSamplerUpdatePayload(state),
      );
    });
  }

  /**
   * Minimal WAV header parser to extract sample rate, channels, and frame count.
   */
  private parseWavInfo(
    bytes: Uint8Array,
  ): { sampleRate: number; channels: number; frames: number } | null {
    const getString = (offset: number, length: number) =>
      String.fromCharCode(...bytes.slice(offset, offset + length));
    const getUint32LE = (offset: number) =>
      ((bytes[offset] ?? 0) |
        ((bytes[offset + 1] ?? 0) << 8) |
        ((bytes[offset + 2] ?? 0) << 16) |
        ((bytes[offset + 3] ?? 0) << 24)) >>>
      0;
    const getUint16LE = (offset: number) =>
      ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;

    if (bytes.length < 44) return null;
    if (getString(0, 4) !== 'RIFF' || getString(8, 4) !== 'WAVE') return null;

    let offset = 12;
    let fmtSampleRate = 0;
    let fmtChannels = 0;
    let bitsPerSample = 16;
    let dataSize = 0;

    while (offset + 8 <= bytes.length) {
      const chunkId = getString(offset, 4);
      const chunkSize = getUint32LE(offset + 4);
      const next = offset + 8 + chunkSize;
      if (chunkId === 'fmt ') {
        fmtChannels = getUint16LE(offset + 10);
        fmtSampleRate = getUint32LE(offset + 12);
        bitsPerSample = getUint16LE(offset + 22);
      } else if (chunkId === 'data') {
        dataSize = chunkSize;
      }
      offset = next;
    }

    if (!fmtSampleRate || !fmtChannels || !dataSize) return null;
    const bytesPerSample = (bitsPerSample / 8) * fmtChannels;
    if (!bytesPerSample) return null;
    const frames = Math.floor(dataSize / bytesPerSample);
    return {
      sampleRate: fmtSampleRate,
      channels: fmtChannels,
      frames,
    };
  }

  /**
   * Key used to decide whether a slot's currently-live instrument can be
   * reused as-is (same key) or must be torn down and rebuilt (different
   * key). Deliberately just `id:revision`, not a hash of the patch's
   * content: `metadata.revision` is only ever incremented by patchStore
   * when a real, detected edit is saved (see patchStore.isDirty /
   * IndexPage.vue saveSongPatch) -- unlike `metadata.modified`, which used
   * to be bumped on every save regardless of whether anything actually
   * changed, forcing a rebuild (and losing live envelope/oscillator/LFO
   * phase) on every no-op editor visit. Comparing the explicit revision is
   * both cheaper and more honest about what it's actually testing than
   * hashing a multi-KB JSON blob of synthState + audioAssets on every sync.
   */
  private getPatchReuseKey(patch: Patch): string | null {
    const id = patch?.metadata?.id;
    if (!id) return null;
    return `${id}:${patch?.metadata?.revision ?? 0}`;
  }

  private teardownInstrument(instrumentId: string) {
    const active = this.instruments.get(instrumentId);
    if (!active) return;

    const isPooled = active.instrument instanceof PooledInstrument;
    const isModInstrument = active.instrument instanceof ModInstrument;
    const instrumentType = isPooled
      ? 'PooledInstrument'
      : isModInstrument
        ? 'ModInstrument'
        : 'InstrumentV2';
    console.log(
      `[SongBank] Tearing down instrument ${instrumentId}, type: ${instrumentType}`,
    );

    try {
      active.instrument.dispose();
    } catch (error) {
      console.warn('[TrackerSongBank] Failed to dispose instrument', error);
    }

    // Deallocate from pool if this is a pooled instrument
    if (isPooled && this.workletPool) {
      this.workletPool.deallocateVoices(instrumentId);
      console.log(`[SongBank] Deallocated ${instrumentId} from WorkletPool`);
    }

    this.instruments.delete(instrumentId);
    this.activeNotes.delete(instrumentId);
    this.voices.removeInstrument(instrumentId);
    this.restoredAssets.delete(instrumentId);
  }

  /**
   * Hard reset all tracker instruments. Use when loading a new song to drop
   * every existing AudioWorklet before instantiating the next set.
   */
  resetForNewSong(): void {
    console.log(
      '[SongBank] Resetting for new song (disposing all instruments)',
    );
    this.generation += 1;
    this.pendingInstruments.clear();
    this.disposeInstruments();
    this.desired.clear();
    this.resetMasterVolumeToBaseline();

    // Reset pool allocations but keep worklets alive for reuse
    if (this.workletPool) {
      this.workletPool.resetAllocations();
      console.log(
        '[SongBank] WorkletPool allocations reset (worklets kept alive for reuse)',
      );
    }
  }

  /**
   * Update a running instrument's patch in real-time without stopping playback.
   * This is used for live editing while a song is playing.
   *
   * @param instrumentId - The instrument ID (e.g., "01", "02")
   * @param patch - The updated patch to apply
   * @returns true if the patch was applied, false if the instrument wasn't found
   */
  async updatePatchLive(instrumentId: string, patch: Patch): Promise<boolean> {
    const active = this.instruments.get(instrumentId);
    if (!active) {
      console.warn(
        '[TrackerSongBank] Cannot update patch live: instrument not found',
        instrumentId,
      );
      return false;
    }

    try {
      // Normalize and apply the patch to the active instrument
      const normalizedPatch = this.normalizePatch(patch);

      // Load the patch into the instrument (this updates all synth parameters)
      await active.instrument.loadPatch(normalizedPatch);

      // Restore audio assets (samplers, convolvers) if any (only for InstrumentV2)
      if (active.instrument instanceof InstrumentV2) {
        const deserialized = deserializePatch(normalizedPatch);
        await this.restoreAudioAssets(
          instrumentId,
          active.instrument,
          normalizedPatch,
          deserialized,
        );
      }

      // Update the stored patch reference and signature
      this.desired.set(instrumentId, normalizedPatch);
      active.patchId = normalizedPatch.metadata.id;
      active.patchReuseKey = this.getPatchReuseKey(normalizedPatch);

      // Update portamento state based on new patch
      active.hasPortamento = this.hasActivePortamento(normalizedPatch);

      return true;
    } catch (error) {
      console.error('[TrackerSongBank] Failed to update patch live:', error);
      return false;
    }
  }

  /**
   * Check if an instrument is currently active (has been synced and created)
   */
  hasActiveInstrument(instrumentId: string): boolean {
    return this.instruments.has(instrumentId);
  }

  /**
   * Update the stored patch data for an instrument after live editing.
   * This updates the "desired" patch and the instrument's stored signature
   * WITHOUT reloading the instrument (since it already has the live changes).
   *
   * Call this when saving live edits to ensure the song bank's stored data
   * matches the actual instrument state.
   *
   * @param instrumentId - The instrument ID (e.g., "01", "02")
   * @param patch - The serialized patch with the current state
   */
  updateStoredPatch(instrumentId: string, patch: Patch): void {
    const normalizedPatch = this.normalizePatch(patch);
    const patchId = normalizedPatch?.metadata?.id;
    if (!patchId) return;

    // Update the desired patch
    this.desired.set(instrumentId, normalizedPatch);

    // Update the active instrument's stored signature so it matches
    const active = this.instruments.get(instrumentId);
    if (active) {
      const requestedVoices = Math.max(
        1,
        Math.min(
          VOICES_PER_ENGINE,
          normalizedPatch?.synthState?.layout?.voiceCount ??
            normalizedPatch?.synthState?.layout?.voices?.length ??
            VOICES_PER_ENGINE,
        ),
      );
      if (
        this.useWorkletPooling &&
        active.instrument instanceof PooledInstrument &&
        active.instrument.num_voices !== requestedVoices
      ) {
        console.warn(
          `[SongBank] Ignoring live patch for ${instrumentId}: voice count ${requestedVoices} does not match allocated ${active.instrument.num_voices}. Re-sync slots to rebuild the instrument.`,
        );
        return;
      }
      active.patchId = patchId;
      active.patchReuseKey = this.getPatchReuseKey(normalizedPatch);
      active.hasPortamento = this.hasActivePortamento(normalizedPatch);

      // Also push the updated patch into the live instrument so tracker playback
      // uses the same edits heard in the instrument editor (handles multi-engine worklet).
      if (
        'loadPatch' in active.instrument &&
        typeof active.instrument.loadPatch === 'function'
      ) {
        void active.instrument
          .loadPatch(normalizedPatch)
          .catch((err: unknown) => {
            console.warn(
              '[SongBank] Failed to apply updated patch to active instrument',
              instrumentId,
              err,
            );
          });
      }
    }
  }

  /** Query CPU usage from a single worklet-backed instrument. */
  private queryWorkletCpu(
    workletNode: AudioWorkletNode | null,
  ): Promise<number | null> {
    if (!workletNode) return Promise.resolve(null);

    return new Promise((resolve) => {
      const messageId = `cpu-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const { port } = workletNode;

      const timeout = window.setTimeout(() => {
        port.removeEventListener('message', handleMessage as EventListener);
        resolve(null);
      }, 100);

      const handleMessage = (event: MessageEvent) => {
        const data = event.data as {
          type?: string;
          cpu?: number;
          total?: number;
          messageId?: string;
        };

        if (data?.type !== 'cpuUsage') return;
        if (data.messageId && data.messageId !== messageId) return;

        port.removeEventListener('message', handleMessage as EventListener);
        window.clearTimeout(timeout);

        const value = Number.isFinite(data.total)
          ? Number(data.total)
          : Number(data.cpu ?? 0);
        resolve(Number.isFinite(value) ? value : 0);
      };

      port.addEventListener('message', handleMessage as EventListener);
      port.postMessage({ type: 'cpuUsage', messageId });
    });
  }
}
