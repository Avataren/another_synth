import {
  type InstrumentResolver,
  type Pattern,
  type PlaybackEvent,
  type PlaybackEventMap,
  type PlaybackListener,
  type PlaybackNoteEvent,
  type PlaybackOptions,
  type PlaybackPosition,
  type PlaybackScheduler,
  type PlaybackNoteHandler,
  type ScheduledNoteHandler,
  type ScheduledNoteEvent,
  type Song,
  type TransportState,
  type ScheduledAutomationHandler,
  type AutomationHandler,
  type ScheduledMacroHandler,
  type MacroHandler,
  type ScheduledPitchHandler,
  type ScheduledVolumeHandler,
  type ScheduledRetriggerHandler,
  type PositionCommandHandler
} from './types';
import { createAudioContextScheduler, IntervalScheduler } from './scheduler';
import {
  type TrackEffectState,
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN,
  resetEffectStateForNote
} from './effect-processor';

type ListenerMap = {
  [K in PlaybackEvent]: Set<PlaybackListener<K>>;
};

/** How far ahead to schedule notes (in seconds) */
const SCHEDULE_AHEAD_TIME = 0.5;

export class PlaybackEngine {
  private song: Song | null = null;
  private state: TransportState = 'stopped';
  private position: PlaybackPosition = { row: 0 };
  private bpm = 120;
  private speed = 6; // FastTracker 2 style speed, where 6 is normal
  private ticksPerRow = 6; // FT2 default ticks per row
  private length = 64;
  private currentSequenceIndex = 0;
  private readonly listeners: ListenerMap = {
    position: new Set(),
    state: new Set(),
    error: new Set()
  };
  private readonly resolver: InstrumentResolver | undefined;
  private readonly scheduler: PlaybackScheduler;
  private readonly noteHandler: PlaybackNoteHandler | undefined;
  private readonly scheduledNoteHandler: ScheduledNoteHandler | undefined;
  private readonly scheduledAutomationHandler: ScheduledAutomationHandler | undefined;
  private readonly automationHandler: AutomationHandler | undefined;
  private readonly scheduledMacroHandler: ScheduledMacroHandler | undefined;
  private readonly macroHandler: MacroHandler | undefined;
  private readonly scheduledPitchHandler: ScheduledPitchHandler | undefined;
  private readonly scheduledVolumeHandler: ScheduledVolumeHandler | undefined;
  private readonly scheduledRetriggerHandler: ScheduledRetriggerHandler | undefined;
  private readonly positionCommandHandler: PositionCommandHandler | undefined;
  private readonly audioContext: AudioContext | undefined;
  private stepIndex: Map<number, PlaybackPatternStep[]> = new Map();
  private loopCurrentPattern = false;
  private loopSong = true;

  /** Audio context time when playback started */
  private playStartTime = 0;
  /** Row offset when playback started (for seeking) */
  private startRow = 0;
  /** Last scheduled row (for lookahead scheduling) */
  private lastScheduledRow = -1;
  /** Exact audio time for the next row to be scheduled */
  private nextRowTime = 0;
  /** Pattern loop count for scheduling */
  private scheduledLoops = 0;
  /** RAF handle for playback loop */
  private rafHandle: number | null = null;
  /** Interval handle for background playback when tab is hidden */
  private intervalHandle: number | null = null;
  /** Track if tab is currently visible */
  private isTabVisible = true;

  /** Per-track effect state for FT2-style effects */
  private trackEffectStates: Map<number, TrackEffectState> = new Map();

  /** Position/pattern commands to process (Bxx, Dxx) */
  private pendingPosCommand: { type: 'posJump' | 'patBreak'; value: number } | null = null;

  constructor(options: PlaybackOptions = {}) {
    this.resolver = options.instrumentResolver;
    this.scheduler =
      options.scheduler ||
      createAudioContextScheduler() ||
      new IntervalScheduler();
    this.noteHandler = options.noteHandler;
    this.scheduledNoteHandler = options.scheduledNoteHandler;
    this.scheduledAutomationHandler = options.scheduledAutomationHandler;
    this.automationHandler = options.automationHandler;
    this.scheduledMacroHandler = options.scheduledMacroHandler;
    this.macroHandler = options.macroHandler;
    this.scheduledPitchHandler = options.scheduledPitchHandler;
    this.scheduledVolumeHandler = options.scheduledVolumeHandler;
    this.scheduledRetriggerHandler = options.scheduledRetriggerHandler;
    this.positionCommandHandler = options.positionCommandHandler;
    this.audioContext = options.audioContext;
    this.ticksPerRow = options.ticksPerRow ?? 6;
    this.setupVisibilityHandling();
  }

  private setupVisibilityHandling() {
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      this.isTabVisible = !document.hidden;
      if (this.state === 'playing') {
        // Switch between RAF and interval based on visibility
        if (this.isTabVisible) {
          this.switchToRAF();
        } else {
          this.switchToInterval();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  private switchToRAF() {
    // Clear interval if it's running
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    // Start RAF loop if not already running
    if (this.rafHandle === null && this.state === 'playing') {
      const loop = () => {
        if (this.state !== 'playing' || !this.isTabVisible) return;
        this.updatePosition();
        this.scheduleAhead();
        this.rafHandle = requestAnimationFrame(loop);
      };
      this.rafHandle = requestAnimationFrame(loop);
    }
  }

  private switchToInterval() {
    // Clear RAF if it's running
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }

    // Start interval loop if not already running
    if (this.intervalHandle === null && this.state === 'playing') {
      // Use 60fps equivalent (16.67ms) for smooth scheduling even when hidden
      this.intervalHandle = setInterval(() => {
        if (this.state !== 'playing' || this.isTabVisible) return;
        this.updatePosition();
        this.scheduleAhead();
      }, 16) as unknown as number;
    }
  }

  setLoopCurrentPattern(loop: boolean) {
    this.loopCurrentPattern = loop;
  }

  setLoopSong(loop: boolean) {
    this.loopSong = loop;
  }

  loadSong(song: Song) {
    this.song = song;
    this.bpm = song.bpm;
    this.currentSequenceIndex = 0;
    if (this.song.sequence.length > 0) {
      this.loadPattern(this.song.sequence[0] as string);
    }
    this.emit('state', this.state);
  }

  loadPattern(patternId: string, options?: { emitPosition?: boolean; updatePosition?: boolean }) {
    const pattern = this.song?.patterns.find(p => p.id === patternId);
    if (!pattern) {
      this.emit('error', new Error(`Pattern with id ${patternId} not found.`));
      return;
    }
    this.length = Math.max(1, pattern.length);
    this.indexPattern(pattern);
    const shouldUpdatePosition = options?.updatePosition !== false;
    if (shouldUpdatePosition) {
      this.position = { row: 0, patternId: pattern.id };
      if (options?.emitPosition !== false) {
        this.emit('position', this.position);
      }
    }
  }

  setBpm(bpm: number) {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    this.bpm = bpm;
  }

  setLength(rows: number) {
    const clamped = Math.max(1, Math.round(rows));
    this.length = clamped;

    // For tracker usage today, pattern length is effectively
    // a song-level setting. Keep the Song's pattern lengths in
    // sync so position tracking and scheduling both see the
    // updated row count. If per-pattern lengths are introduced
    // later, prefer updating `song.patterns` directly instead
    // of calling `setLength` for all patterns.
    if (this.song) {
      this.song = {
        ...this.song,
        patterns: this.song.patterns.map((pattern) => ({
          ...pattern,
          length: clamped
        }))
      };
    }
  }

  async play() {
    if (this.state === 'playing') return;
    this.state = 'playing';
    this.emit('state', this.state);
    await this.prepareInstruments();

    if (this.scheduledNoteHandler && this.audioContext) {
      // Use scheduled playback
      this.startScheduledPlayback();
    } else if (this.noteHandler) {
      // Fall back to tick-based playback
      this.dispatchStepsForRow(this.position.row);
      this.scheduler.start((deltaMs) => this.step(deltaMs));
    }
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.stopScheduledPlayback();
    this.scheduler.stop();
    this.emit('state', this.state);
  }

  stop() {
    this.state = 'stopped';
    this.stopScheduledPlayback();
    this.scheduler.stop();
    // Reset to row 0 but stay on the current pattern
    this.position = { ...this.position, row: 0 };
    this.resetEffectStates();
    this.emit('state', this.state);
    // Emit position without changing the pattern
    this.emit('position', this.position);
  }

  seek(row: number) {
    const clamped = ((Math.round(row) % this.length) + this.length) % this.length;
    this.position = { ...this.position, row: clamped };
    this.startRow = clamped;
    this.emit('position', this.position);
  }

  on<K extends PlaybackEvent>(event: K, listener: PlaybackListener<K>): () => void {
    const set = this.listeners[event];
    set.add(listener as PlaybackListener<K>);
    return () => set.delete(listener as PlaybackListener<K>);
  }

  private startScheduledPlayback() {
    if (!this.audioContext || !this.scheduledNoteHandler) return;

    this.playStartTime = this.audioContext.currentTime;
    this.startRow = this.position.row;
    this.lastScheduledRow = this.startRow - 1;
    this.scheduledLoops = 0;
    // Initialize timing for cumulative tempo changes
    this.nextRowTime = this.playStartTime;
    this.speed = 6; // Reset to normal speed
    // Reset effect states for clean playback start
    this.resetEffectStates();

    // Schedule initial batch of notes
    this.scheduleAhead();

    // Use RAF when tab is visible, setInterval when hidden
    if (this.isTabVisible) {
      this.switchToRAF();
    } else {
      this.switchToInterval();
    }
  }

  private stopScheduledPlayback() {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.lastScheduledRow = -1;
    this.scheduledLoops = 0;
  }

  private scheduleAhead() {
    if (!this.audioContext || !this.scheduledNoteHandler) return;
    if (this.state !== 'playing') return;

    const now = this.audioContext.currentTime;
    const scheduleUntil = now + SCHEDULE_AHEAD_TIME;

    // Schedule rows using cumulative timing to support dynamic tempo changes
    while (this.nextRowTime < scheduleUntil) {
      const currentRow = this.lastScheduledRow + 1;
      const actualRow = currentRow % this.length;

      if (actualRow === 0 && currentRow > 0 && !this.loopCurrentPattern) { // Pattern finished
        const sequence = this.song?.sequence ?? [];
        if (sequence.length === 0) {
          this.stop();
          return;
        }

        this.currentSequenceIndex += 1;
        if (this.currentSequenceIndex >= sequence.length) {
          if (this.loopSong) {
            this.currentSequenceIndex = 0;
          } else {
            this.stop();
            return;
          }
        }

        const nextPatternId = sequence[this.currentSequenceIndex];
        if (nextPatternId) {
          // Preload next pattern for scheduling without flipping the visible position yet
          this.loadPattern(nextPatternId, { emitPosition: false, updatePosition: false });
        } else {
          this.stop();
          return;
        }
      }

      // Schedule this row at nextRowTime (may apply F commands that change speed/bpm)
      const rowTime = this.nextRowTime;

      // Only schedule if in the future
      if (rowTime >= now) {
        this.scheduleRow(actualRow, rowTime);
      }

      // Calculate time for next row using current speed/bpm (after F commands were applied)
      const msPerRow = this.getMsPerRow();
      const secPerRow = msPerRow / 1000;
      this.nextRowTime += secPerRow;

      this.lastScheduledRow = currentRow;
    }
  }

  /**
   * Get or create effect state for a track
   */
  private getTrackEffectState(trackIndex: number): TrackEffectState {
    let state = this.trackEffectStates.get(trackIndex);
    if (!state) {
      state = createTrackEffectState();
      this.trackEffectStates.set(trackIndex, state);
    }
    return state;
  }

  /**
   * Reset all effect states (called on stop/load)
   */
  private resetEffectStates(): void {
    this.trackEffectStates.clear();
    this.pendingPosCommand = null;
  }

  /**
   * Calculate time per tick
   */
  private getMsPerTick(): number {
    return this.getMsPerRow() / this.ticksPerRow;
  }

  private scheduleRow(row: number, time: number) {
    if (!this.scheduledNoteHandler) return;

    const steps = this.stepIndex.get(row);
    const msPerTick = this.getMsPerTick();
    const secPerTick = msPerTick / 1000;

    // First pass: Apply speed/tempo commands (F commands) and position commands
    if (steps) {
      for (const step of steps) {
        if (step.speedCommand !== undefined) {
          // F01-F1F: Set speed (1-31, where 6 is normal)
          this.speed = Math.max(1, Math.min(31, step.speedCommand));
        }
        if (step.tempoCommand !== undefined) {
          // F20-FF: Set BPM directly (32-255)
          this.bpm = Math.max(32, Math.min(255, step.tempoCommand));
        }

        // Check for position commands (Bxx, Dxx)
        if (step.effect) {
          if (step.effect.type === 'posJump') {
            this.pendingPosCommand = {
              type: 'posJump',
              value: step.effect.paramX * 16 + step.effect.paramY
            };
          } else if (step.effect.type === 'patBreak') {
            this.pendingPosCommand = {
              type: 'patBreak',
              value: step.effect.paramX * 10 + step.effect.paramY // FT2 uses decimal for Dxx
            };
          }
        }
      }
    }

    // Second pass: Process each step with effects
    if (steps) {
      for (const step of steps) {
        const instrumentId = step.instrumentId;
        if (!instrumentId) continue;

        const trackIndex = step.trackIndex;
        const effectState = this.getTrackEffectState(trackIndex);

        // Handle macros
        if (step.macroIndex !== undefined && step.macroValue !== undefined) {
          if (this.scheduledMacroHandler) {
            this.scheduledMacroHandler(instrumentId, step.macroIndex, step.macroValue, time);
          } else if (this.macroHandler) {
            this.macroHandler(instrumentId, step.macroIndex, step.macroValue);
          }
        }

        // Handle note-off
        if (step.isNoteOff) {
          const event: ScheduledNoteEvent = {
            type: 'noteOff',
            instrumentId,
            row,
            trackIndex: step.trackIndex,
            time
          };
          if (step.midi !== undefined) {
            event.midi = step.midi;
          }
          this.scheduledNoteHandler(event);
          continue;
        }

        // Check if we have an effect that needs per-tick processing
        const hasTickEffect = step.effect && this.isTickBasedEffect(step.effect.type);

        // Handle note-on with effect processing
        const newNote = step.midi;
        const newVelocity = step.velocity;

        // Reset effect state on new note (unless tone portamento)
        if (newNote !== undefined && step.effect?.type !== 'tonePorta' && step.effect?.type !== 'tonePortaVol') {
          resetEffectStateForNote(effectState);
        }

        // Process tick 0
        const tick0Result = processEffectTick0(effectState, step.effect, newNote, newVelocity);

        // Check for note delay (EDx) - don't trigger note on tick 0
        const hasNoteDelay = step.effect?.type === 'noteDelay' ||
          (step.effect?.type === 'extEffect' && step.effect?.extSubtype === 'noteDelay');

        // Schedule note on tick 0 (unless delayed or tone portamento without new note)
        if (!hasNoteDelay && newNote !== undefined) {
          // For tone portamento, we update frequency but don't retrigger
          const isTonePortaContinue = (step.effect?.type === 'tonePorta' || step.effect?.type === 'tonePortaVol')
            && effectState.voiceIndex >= 0;

          if (!isTonePortaContinue) {
            const velocity = Number.isFinite(newVelocity) ? newVelocity as number : 127;
            const event: ScheduledNoteEvent = {
              type: 'noteOn',
              instrumentId,
              midi: newNote,
              row,
              trackIndex: step.trackIndex,
              time,
              velocity
            };
            this.scheduledNoteHandler(event);
          }
        }

        // Apply tick 0 frequency if we have pitch handler
        if (this.scheduledPitchHandler && tick0Result.frequency !== undefined) {
          this.scheduledPitchHandler(instrumentId, effectState.voiceIndex, tick0Result.frequency, time);
        }

        // Apply tick 0 volume if we have volume handler
        if (this.scheduledVolumeHandler && tick0Result.volume !== undefined) {
          this.scheduledVolumeHandler(instrumentId, effectState.voiceIndex, tick0Result.volume, time);
        }

        // Handle volume automation (Cxx or step velocity)
        if (this.scheduledAutomationHandler && step.velocity !== undefined && !tick0Result.volume) {
          const gain = clamp(step.velocity / 127);
          this.scheduledAutomationHandler(instrumentId, gain, time);
        }

        // Handle note cut on tick 0
        if (tick0Result.cutNote) {
          const cutEvent: ScheduledNoteEvent = {
            type: 'noteOff',
            instrumentId,
            row,
            trackIndex: step.trackIndex,
            time
          };
          this.scheduledNoteHandler(cutEvent);
        }

        // Schedule per-tick effects for ticks 1 to ticksPerRow-1
        if (hasTickEffect) {
          for (let tick = 1; tick < this.ticksPerRow; tick++) {
            const tickTime = time + tick * secPerTick;
            const tickResult = processEffectTickN(effectState, step.effect, tick, this.ticksPerRow);

            // Schedule pitch change
            if (this.scheduledPitchHandler && tickResult.frequency !== undefined) {
              this.scheduledPitchHandler(instrumentId, effectState.voiceIndex, tickResult.frequency, tickTime);
            }

            // Schedule volume change
            if (this.scheduledVolumeHandler && tickResult.volume !== undefined) {
              this.scheduledVolumeHandler(instrumentId, effectState.voiceIndex, tickResult.volume, tickTime);
            }

            // Schedule note retrigger
            if (tickResult.triggerNote && this.scheduledRetriggerHandler) {
              this.scheduledRetriggerHandler(
                instrumentId,
                tickResult.triggerNote.midi,
                tickResult.triggerNote.velocity,
                tickTime
              );
            }

            // Handle note cut
            if (tickResult.cutNote) {
              const cutEvent: ScheduledNoteEvent = {
                type: 'noteOff',
                instrumentId,
                row,
                trackIndex: step.trackIndex,
                time: tickTime
              };
              this.scheduledNoteHandler(cutEvent);
            }
          }
        }
      }
    }

    // Process position commands (handled externally)
    if (this.pendingPosCommand && this.positionCommandHandler) {
      this.positionCommandHandler(this.pendingPosCommand);
      this.pendingPosCommand = null;
    }
  }

  /**
   * Check if an effect type requires per-tick processing
   */
  private isTickBasedEffect(type: string): boolean {
    const tickEffects = [
      'portaUp', 'portaDown', 'tonePorta', 'vibrato',
      'tonePortaVol', 'vibratoVol', 'tremolo', 'arpeggio',
      'volSlide', 'panSlide', 'retrigVol', 'tremor',
      'fineVibrato', 'noteCut', 'noteDelay', 'keyOff'
    ];
    return tickEffects.includes(type);
  }

  private updatePosition() {
    if (!this.audioContext) return;
    if (this.state !== 'playing') return;

    const now = this.audioContext.currentTime;
    const elapsed = now - this.playStartTime;
    const msPerRow = this.getMsPerRow();
    const secPerRow = msPerRow / 1000;

    const rowsElapsed = Math.floor(elapsed / secPerRow);
    const totalRowsPlayed = this.startRow + rowsElapsed;

    const sequence = this.song?.sequence ?? [];
    const patterns = this.song?.patterns ?? [];

    const getPatternLength = (id: string | undefined): number => {
      if (!id) return this.length;
      const pattern = patterns.find((p) => p.id === id);
      return pattern ? Math.max(1, pattern.length) : this.length;
    };

    // Total rows across the full song sequence (for wrapping)
    const songLengthRows = sequence.reduce(
      (total, id) => total + getPatternLength(id),
      0
    );

    let effectiveRows = totalRowsPlayed;
    if (songLengthRows > 0) {
      effectiveRows =
        ((effectiveRows % songLengthRows) + songLengthRows) % songLengthRows;
    }

    let patternId = sequence[0];
    let currentPatternLength = getPatternLength(patternId);
    let remaining = effectiveRows;

    for (let i = 0; i < sequence.length; i += 1) {
      const id = sequence[i];
      const length = getPatternLength(id);
      if (remaining < length) {
        patternId = id;
        currentPatternLength = length;
        break;
      }
      remaining -= length;
    }

    const currentRow =
      currentPatternLength > 0 ? remaining % currentPatternLength : 0;

    if (currentRow !== this.position.row || patternId !== this.position.patternId) {
      const newPosition: PlaybackPosition = { row: currentRow };
      if (patternId) {
        newPosition.patternId = patternId;
      }
      this.position = newPosition;
      this.emit('position', this.position);
    }
  }

  private getMsPerRow(): number {
    const rowsPerBeat = 4; // treat one beat as 4 rows (16th grid)
    const baseMs = (60_000 / this.bpm) / rowsPerBeat;
    // Apply speed multiplier (speed 6 is normal, speed 3 is 2x faster, speed 12 is 0.5x)
    const speedMultiplier = this.speed / 6.0;
    return baseMs * speedMultiplier;
  }

  async prepareInstruments() {
    if (!this.resolver || !this.song) return;
    const instrumentIds = new Set<string>();
    for (const pattern of this.song.patterns) {
      for (const track of pattern.tracks) {
        if (track.instrumentId) {
          instrumentIds.add(track.instrumentId);
        }
        for (const step of track.steps) {
          if (step.instrumentId) {
            instrumentIds.add(step.instrumentId);
          }
        }
      }
    }

    for (const id of instrumentIds) {
      try {
        await this.resolver(id);
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  /** Legacy tick-based step function (fallback when no scheduledNoteHandler) */
  private tickAccumulator = 0;
  private step(deltaMs: number) {
    if (this.state !== 'playing') return;
    const msPerRow = this.getMsPerRow();
    this.tickAccumulator += deltaMs;

    while (this.tickAccumulator >= msPerRow && msPerRow > 0) {
      this.tickAccumulator -= msPerRow;
      let nextRow = (this.position.row + 1);

      if (nextRow >= this.length) {
        if (this.loopCurrentPattern) {
          nextRow = 0;
        } else {
          const sequence = this.song?.sequence ?? [];
          if (sequence.length === 0) {
            this.stop();
            return;
          }

          this.currentSequenceIndex += 1;
          if (this.currentSequenceIndex >= sequence.length) {
            if (this.loopSong) {
              this.currentSequenceIndex = 0;
            } else {
              this.stop();
              return;
            }
          }

          const nextPatternId = sequence[this.currentSequenceIndex];
          if (nextPatternId) {
            this.loadPattern(nextPatternId);
            nextRow = 0;
          } else {
            this.stop();
            return;
          }
        }
      }

      this.position = { ...this.position, row: nextRow };
      this.dispatchStepsForRow(nextRow);
      this.emit('position', this.position);
    }
  }

  private emit<K extends PlaybackEvent>(event: K, payload: PlaybackEventMap[K]) {
    const set = this.listeners[event];
    for (const listener of set) {
      try {
        (listener as PlaybackListener<K>)(payload);
      } catch (error) {
        console.error(`PlaybackEngine listener error for event "${event}":`, error);
      }
    }
  }

  /** Legacy immediate dispatch (fallback when no scheduledNoteHandler) */
  private dispatchStepsForRow(row: number) {
    if (!this.noteHandler) return;
    const steps = this.stepIndex.get(row);
    if (!steps || steps.length === 0) return;

    for (const step of steps) {
      const instrumentId = step.instrumentId;
      if (!instrumentId) continue;

      if (this.macroHandler && step.macroIndex !== undefined && step.macroValue !== undefined) {
        this.macroHandler(instrumentId, step.macroIndex, step.macroValue);
      }

      if (step.isNoteOff) {
        const event: PlaybackNoteEvent = {
          type: 'noteOff',
          instrumentId,
          row,
          trackIndex: step.trackIndex
        };
        if (step.midi !== undefined) {
          event.midi = step.midi;
        }
        this.noteHandler(event);
        continue;
      }

      if (step.midi === undefined) continue;

      if (this.automationHandler && step.velocity !== undefined) {
        const gain = clamp(step.velocity / 127);
        this.automationHandler(instrumentId, gain);
      }

      const event: PlaybackNoteEvent = {
        type: 'noteOn',
        instrumentId,
        midi: step.midi,
        row,
        trackIndex: step.trackIndex
      };
      const velocity = step.velocity;
      if (velocity !== undefined) {
        event.velocity = velocity;
      }
      this.noteHandler(event);
    }
  }

  private indexPattern(pattern: Pattern) {
    const index: Map<number, PlaybackPatternStep[]> = new Map();
    for (let trackIndex = 0; trackIndex < pattern.tracks.length; trackIndex++) {
      const track = pattern.tracks[trackIndex];
      if (!track) continue;
      for (const step of track.steps) {
        const bucket = index.get(step.row) ?? [];
        bucket.push({ ...step, trackIndex });
        index.set(step.row, bucket);
      }
    }
    this.stepIndex = index;
  }
}

type PlaybackPatternStep = Pattern['tracks'][number]['steps'][number] & { trackIndex: number };

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}
