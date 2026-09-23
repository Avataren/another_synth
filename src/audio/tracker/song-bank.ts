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
import type { Patch } from 'src/audio/types/preset-types';
import { deserializePatch } from 'src/audio/serialization/patch-serializer';
import { getSharedAudioSystem } from 'src/audio/shared-audio-system';
import {
  MIN_SCHEDULE_LEAD_SECONDS,
  ScheduledEventQueue,
  type PendingScheduledEvent,
} from './scheduled-events';
import { SongBankRecorder } from './recorder';
import {
  InstrumentLifecycle,
  type ResumeFlags,
} from './instrument-lifecycle';
import { TrackVoiceRegistry } from './track-voice-registry';
import type { BankInstrument } from './bank-instrument';

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

/**
 * How many instruments syncSlots builds per slice before yielding.
 *
 * ensureInstrumentInternal's loadPatch() (ModInstrument) decodes and
 * conditions the sample and builds every anti-alias mip level synchronously
 * on the main thread (sampler-instrument.ts buildMipLevels). Awaiting a big
 * Promise.all batch of these back-to-back stacked their synchronous CPU
 * chunks into one uninterrupted run -- measured as 3 longtasks totalling
 * ~450 ms right at play start (microstutter investigation, play-start
 * burst). A small slice keeps each JS turn short; yielding between slices
 * (see idleYield below) gives the browser a real chance to paint in
 * between. Small enough to matter, not so small it loses the concurrency
 * benefit of genuinely async decode work overlapping across instruments.
 */
const INSTRUMENT_BUILD_SLICE_SIZE = 2;
/** Idle-yield timeout between instrument-build slices (see idleYield). */
const INSTRUMENT_BUILD_IDLE_TIMEOUT_MS = 50;

interface IdleWindow {
  requestIdleCallback?: (
    cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void,
    opts?: { timeout: number },
  ) => number;
}

/**
 * Yield to the browser: idle time when it goes idle, else a bounded timeout
 * so a continuously busy main thread cannot stall this indefinitely (same
 * contract as PatternCanvas's pre-render/bright-text-rebake idle requests).
 * Falls back to a macrotask (setTimeout) where requestIdleCallback does not
 * exist (Safari, and every test environment) -- still a real yield to the
 * event loop, just not one that waits for actual idle time.
 */
function idleYield(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const w = window as unknown as IdleWindow;
    if (typeof w.requestIdleCallback === 'function') {
      w.requestIdleCallback(() => resolve(), { timeout: timeoutMs });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

export interface ActiveInstrument {
  instrument: BankInstrument;
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
  private readonly resumeFlags: ResumeFlags = {
    wasSuspended: false,
    needsAudioContextResume: false,
  };
  private readonly lifecycle: InstrumentLifecycle;
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

    this.lifecycle = new InstrumentLifecycle({
      audioSystem: this.audioSystem,
      masterGain: this.masterGain,
      audioContext: this.audioSystem.audioContext,
      formatProfile: () => this.formatProfile,
      useWorkletPooling: () => this.useWorkletPooling,
      workletPool: () => this.workletPool,
      instruments: this.instruments,
      activeNotes: this.activeNotes,
      eventQueue: this.eventQueue,
      voices: this.voices,
      generation: () => this.generation,
      flags: this.resumeFlags,
    });

    this.audioSystem.audioContext.onstatechange = () => {
      if (
        this.audioSystem.audioContext.state === 'running' &&
        this.resumeFlags.needsAudioContextResume
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

  /**
   * The very last node before the speakers: the post-fx rack output.
   *
   * `output` above is the *pre-rack* mix bus, so anything tapping it sees the
   * signal before the Amiga LPF and, more importantly, before the limiter.
   * Meters and analysers must show what-you-hear (the same reasoning that
   * puts the recorder tap here, D117), so they tap this instead.
   */
  get finalOutput(): AudioNode {
    return this.audioSystem.postFxOutput;
  }

  get needsResume(): boolean {
    return this.resumeFlags.needsAudioContextResume;
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
  /**
   * Get the instrument for a specific instrument id (for live editing).
   *
   * Editor-facing boundary: callers (IndexPage.vue) do concrete-class checks
   * (instanceof ModInstrument) we cannot retype, so this keeps returning the
   * concrete union exactly as before. The bank's INTERNAL handling is typed
   * through `BankInstrument` (ActiveInstrument.instrument); this single cast
   * is the boundary, not a capability probe.
   */
  getInstrument(
    instrumentId: string,
  ): InstrumentV2 | ModInstrument | PooledInstrument | null {
    const active = this.instruments.get(instrumentId);
    return (active?.instrument as InstrumentV2 | ModInstrument | PooledInstrument) ?? null;
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
        nextDesired.set(slot.instrumentId, this.lifecycle.normalizePatch(slot.patch));
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
          this.lifecycle.teardownInstrument(id);
        }
      }

      // Bounded, best-effort resume attempt. The sync itself must not depend
      // on a running context: fresh-tab deep links load songs while the
      // context is still suspended, so instruments are built either way. If
      // the context is still suspended afterwards, needsAudioContextResume
      // stays armed and the onstatechange handler rebuilds instruments via
      // syncSlots on the first user gesture.
      if (this.audioContext.state === 'suspended') {
        this.resumeFlags.wasSuspended = true;
      }
      const contextRunning = await this.ensureAudioContextRunning(
        SYNC_SLOTS_RESUME_WAIT_MS,
      );

      if (!contextRunning) {
        console.warn(
          `[SongBank] AudioContext still ${this.audioContext.state} after bounded resume attempt; building instruments while suspended (rebuild-on-resume is armed).`,
        );
      }

      if (this.resumeFlags.wasSuspended && this.audioContext.state === 'running') {
        // Recreate instruments after a resume to avoid stale worklet state
        console.log('[SongBank] Disposing all instruments after resume');
        this.disposeInstruments();
        this.resumeFlags.wasSuspended = false;
      }

      // Load instruments in small idle-scheduled slices: a big batch stacks
      // every instrument's synchronous decode/mip-build work into one
      // uninterrupted run (see INSTRUMENT_BUILD_SLICE_SIZE above). syncSlots
      // still only resolves once every instrument in nextDesired is truly
      // built -- this only paces *how* they get there, not whether the
      // caller's await sees them all ready. An instrument a note needs before
      // its slice comes up is still safe: noteOnAtTime/noteOffAtTime already
      // queue the event and ensureInstrumentIfDesired()-build it on demand,
      // replaying via flushPendingScheduledEvents once it's ready.
      const entries = Array.from(nextDesired.entries());
      console.log(
        `[SongBank] Loading ${entries.length} instruments in idle-scheduled slices of ${INSTRUMENT_BUILD_SLICE_SIZE}`,
      );

      for (let i = 0; i < entries.length; i += INSTRUMENT_BUILD_SLICE_SIZE) {
        const slice = entries.slice(i, i + INSTRUMENT_BUILD_SLICE_SIZE);
        console.log(
          `[SongBank] Loading slice ${Math.floor(i / INSTRUMENT_BUILD_SLICE_SIZE) + 1}/${Math.ceil(entries.length / INSTRUMENT_BUILD_SLICE_SIZE)}: instruments ${slice.map(([id]) => id).join(', ')}`,
        );

        const ensureTasks: Promise<void>[] = [];
        for (const [instrumentId, patch] of slice) {
          console.log(
            `[SongBank] Ensuring instrument: ${instrumentId}, patch: ${patch?.metadata?.id}`,
          );
          ensureTasks.push(this.lifecycle.ensureInstrument(instrumentId, patch));
        }

        await Promise.all(ensureTasks);

        // Yield between slices to let the browser breathe -- idle when the
        // main thread has room, bounded so a busy thread cannot stall
        // syncSlots indefinitely.
        if (i + INSTRUMENT_BUILD_SLICE_SIZE < entries.length) {
          await idleYield(INSTRUMENT_BUILD_IDLE_TIMEOUT_MS);
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
    await this.lifecycle.ensureInstrument(instrumentId, patch);
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
      this.lifecycle.teardownInstrument(id);
    }
    this.activeNotes.clear();
    this.voices.clearAll();
    this.lifecycle.clearRestoredAssets();
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
    instrument: BankInstrument,
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
      this.resumeFlags.wasSuspended = true;
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
      this.resumeFlags.wasSuspended = true;
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
        this.resumeFlags.wasSuspended = true;
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
        this.resumeFlags.wasSuspended = true;
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
      void this.lifecycle.ensureInstrument(instrumentId, patch);
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

    target.active.instrument.setEnvelopePositionAtTime?.(
      target.voiceIndex,
      tick,
      time,
    );
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
      this.resumeFlags.needsAudioContextResume = false;
      void this.eventQueue.flushPendingScheduledEvents();
      return true;
    }

    this.resumeFlags.needsAudioContextResume = true;
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
        this.resumeFlags.needsAudioContextResume = false;
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
    this.resumeFlags.needsAudioContextResume = true;
    return false;
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
    this.lifecycle.clearPendingInstruments();
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
      const normalizedPatch = this.lifecycle.normalizePatch(patch);

      // Load the patch into the instrument (this updates all synth parameters)
      await active.instrument.loadPatch(normalizedPatch);

      // Restore audio assets (samplers, convolvers) if any (only for InstrumentV2)
      if (active.instrument instanceof InstrumentV2) {
        const deserialized = deserializePatch(normalizedPatch);
        await this.lifecycle.restoreAudioAssets(
          instrumentId,
          active.instrument,
          normalizedPatch,
          deserialized,
        );
      }

      // Update the stored patch reference and signature
      this.desired.set(instrumentId, normalizedPatch);
      active.patchId = normalizedPatch.metadata.id;
      active.patchReuseKey = this.lifecycle.getPatchReuseKey(normalizedPatch);

      // Update portamento state based on new patch
      active.hasPortamento = this.lifecycle.hasActivePortamento(normalizedPatch);

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
    const normalizedPatch = this.lifecycle.normalizePatch(patch);
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
      active.patchReuseKey = this.lifecycle.getPatchReuseKey(normalizedPatch);
      active.hasPortamento = this.lifecycle.hasActivePortamento(normalizedPatch);

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
