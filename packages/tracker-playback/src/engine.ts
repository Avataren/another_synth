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
  type Step,
  type Song,
  type TransportState,
  type ScheduledAutomationHandler,
  type AutomationHandler,
  type ScheduledMacroHandler,
  type MacroHandler,
  type ScheduledPitchHandler,
  type ScheduledVolumeHandler,
  type ScheduledSampleOffsetHandler,
  type ScheduledGlobalVolumeHandler,
  type ScheduledRetriggerHandler,
  type PositionCommandHandler,
  type PlaybackClock
} from './types';
import { createAudioContextScheduler, IntervalScheduler } from './scheduler';
import { createVisibilityClock } from './clock';
import {
  type TrackEffectState,
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN,
  resetEffectStateForNote,
  type ProcessorCommand
} from './effect-processor';
import { TimingSystem } from './timing-system';

type ListenerMap = {
  [K in PlaybackEvent]: Set<PlaybackListener<K>>;
};

export class PlaybackEngine {
  private song: Song | null = null;
  private state: TransportState = 'stopped';
  private position: PlaybackPosition = { row: 0 };
  private length = 64;
  private currentSequenceIndex = 0;
  /** Unified timing system for all timing calculations */
  private timingSystem: TimingSystem;
  private readonly listeners: ListenerMap = {
    position: new Set(),
    state: new Set(),
    error: new Set()
  };
  private readonly resolver: InstrumentResolver | undefined;
  private readonly scheduler: PlaybackScheduler;
  private readonly playbackClock: PlaybackClock;
  private readonly noteHandler: PlaybackNoteHandler | undefined;
  private readonly scheduledNoteHandler: ScheduledNoteHandler | undefined;
  private readonly scheduledAutomationHandler: ScheduledAutomationHandler | undefined;
  private readonly automationHandler: AutomationHandler | undefined;
  private readonly scheduledMacroHandler: ScheduledMacroHandler | undefined;
  private readonly macroHandler: MacroHandler | undefined;
  private readonly scheduledPitchHandler: ScheduledPitchHandler | undefined;
  private readonly scheduledVolumeHandler: ScheduledVolumeHandler | undefined;
  private readonly scheduledSampleOffsetHandler: ScheduledSampleOffsetHandler | undefined;
  private readonly scheduledGlobalVolumeHandler: ScheduledGlobalVolumeHandler | undefined;
  private readonly scheduledRetriggerHandler: ScheduledRetriggerHandler | undefined;
  private readonly positionCommandHandler: PositionCommandHandler | undefined;
  private readonly audioContext: AudioContext | undefined;
  private stepIndex: Map<number, PlaybackPatternStep[]> = new Map();
  private loopCurrentPattern = false;
  private loopSong = true;

  /** Last scheduled row (for lookahead scheduling) */
  private lastScheduledRow = -1;
  /** Exact audio time for the next row to be scheduled */
  private nextRowTime = 0;
  /** Pattern loop count for scheduling */
  private scheduledLoops = 0;
  /** Track if tab is currently visible */
  private isTabVisible = true;
  /** Base lookahead when visible/hidden (seconds) */
  private readonly baseLookaheadVisible = 0.5;
  private readonly baseLookaheadHidden = 1.0;
  /** If the next row is within this threshold (seconds), consider scheduling "late" */
  private readonly lateScheduleThreshold = 0.02;
  /** Count of consecutive late scheduling loops */
  private lateScheduleCount = 0;
  /** Track worst lead deficit observed while scheduling late */
  private maxLeadDeficit = 0;

  /** Per-track effect state for FT2-style effects */
  private trackEffectStates: Map<number, TrackEffectState> = new Map();

  /** Position/pattern commands to process (Bxx, Dxx) */
  private pendingPosCommand: { type: 'posJump' | 'patBreak'; value: number } | null = null;

  /** Pattern loop state (E6x) */
  private patternLoopStart = 0; // Row where loop starts (set by E60)
  private patternLoopCount = 0; // Current loop iteration
  private patternLoopTarget = 0; // Total number of loops requested

  /** Pattern delay state (EEx) - delays current row by x ticks */
  private patternDelayCount = 0; // Number of times to repeat current row

  /** Global volume state (Gxx/Hxy), normalized 0-1 */
  private globalVolume = 1.0;

  constructor(options: PlaybackOptions = {}) {
    this.resolver = options.instrumentResolver;
    this.scheduler =
      options.scheduler ||
      createAudioContextScheduler() ||
      new IntervalScheduler();
    this.playbackClock = options.playbackClock ?? createVisibilityClock({ targetFps: 30 });
    this.noteHandler = options.noteHandler;
    this.scheduledNoteHandler = options.scheduledNoteHandler;
    this.scheduledAutomationHandler = options.scheduledAutomationHandler;
    this.automationHandler = options.automationHandler;
    this.scheduledMacroHandler = options.scheduledMacroHandler;
    this.macroHandler = options.macroHandler;
    this.scheduledPitchHandler = options.scheduledPitchHandler;
    this.scheduledVolumeHandler = options.scheduledVolumeHandler;
    this.scheduledSampleOffsetHandler = options.scheduledSampleOffsetHandler;
    this.scheduledGlobalVolumeHandler = options.scheduledGlobalVolumeHandler;
    this.scheduledRetriggerHandler = options.scheduledRetriggerHandler;
    this.positionCommandHandler = options.positionCommandHandler;
    this.audioContext = options.audioContext;

    // Initialize timing system with callbacks
    this.timingSystem = new TimingSystem(
      (id: string | undefined) => this.getPatternLength(id),
      () => this.song?.sequence ?? [],
      {
        bpm: 120,
        speed: 6,
        ticksPerRow: options.ticksPerRow ?? 6
      }
    );

    this.setupVisibilityHandling();
  }

  private setupVisibilityHandling() {
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      this.isTabVisible = !document.hidden;
      if (this.state === 'playing') {
        this.playbackClock.setVisible?.(this.isTabVisible);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  /**
   * Compute the current scheduling lookahead window (seconds).
   * Expands when tab is hidden or when we’ve observed consecutive “late” loops.
   */
  private getLookaheadSeconds(): number {
    const base = this.isTabVisible ? this.baseLookaheadVisible : this.baseLookaheadHidden;
    const latePenalty = this.lateScheduleCount >= 3 ? 0.5 : 0; // widen window after repeated lateness
    return base + latePenalty;
  }

  setLoopCurrentPattern(loop: boolean) {
    this.loopCurrentPattern = loop;
  }

  setLoopSong(loop: boolean) {
    this.loopSong = loop;
  }

  /**
   * Precompute tone portamento targets (3xx) across the full song sequence.
   *
   * For rows that have a 3xx effect but no note, ProTracker players often
   * slide towards the next note in the same track, even when that note
   * lives in the next pattern. To approximate this, we scan forward along
   * the song's sequence and, for such rows, fill in `step.midi` with the
   * MIDI value of the next note-on in that track. The playback engine then
   * treats that MIDI value as the portamento target without retriggering
   * the note (since tonePorta rows never schedule a new note-on).
   */
  private precomputeTonePortaTargets(): void {
    if (!this.song) return;
    const song = this.song;

    // Build quick lookup for patterns by id
    const patternsById = new Map<string, Pattern>();
    for (const pattern of song.patterns) {
      patternsById.set(pattern.id, pattern);
    }

    // Determine maximum track count across all patterns
    let maxTracks = 0;
    for (const pattern of song.patterns) {
      if (pattern.tracks.length > maxTracks) {
        maxTracks = pattern.tracks.length;
      }
    }

    // For each track index, walk through the song sequence and collect steps
    for (let trackIndex = 0; trackIndex < maxTracks; trackIndex += 1) {
      const stepsInOrder: Step[] = [];

      for (const patternId of song.sequence) {
        const pattern = patternsById.get(patternId);
        if (!pattern) continue;
        const track = pattern.tracks[trackIndex];
        if (!track || !track.steps || track.steps.length === 0) continue;

        // Ensure steps are processed in row order within each pattern
        const sortedSteps = [...track.steps].sort((a, b) => a.row - b.row);
        for (const step of sortedSteps) {
          stepsInOrder.push(step);
        }
      }

      if (stepsInOrder.length === 0) continue;

      let nextNoteMidi: number | undefined;
      let nextNoteFrequency: number | undefined;

      // Walk backwards so each 3xx without a note can see the next note-on ahead.
      for (let i = stepsInOrder.length - 1; i >= 0; i -= 1) {
        const step = stepsInOrder[i];
        if (!step) continue;

        // Stop propagation across explicit note-offs.
        if (step.isNoteOff) {
          nextNoteMidi = undefined;
          nextNoteFrequency = undefined;
          continue;
        }

        if (step.midi !== undefined) {
          nextNoteMidi = step.midi;
          nextNoteFrequency = step.frequency;
          continue;
        }

        const isTonePorta =
          step.effect?.type === 'tonePorta' || step.effect?.type === 'tonePortaVol';

        // Do not overwrite tone portamento targets for rows without notes.
        // Continuing 3xx rows should keep sliding toward the existing target/note.
        if (isTonePorta && nextNoteMidi !== undefined && step.midi === undefined) {
          step.midi = nextNoteMidi;
          if (nextNoteFrequency !== undefined) {
            step.frequency = nextNoteFrequency;
          }
        }
      }
    }
  }

  loadSong(song: Song, startSequenceIndex = 0) {
    this.song = song;
    // Precompute tone portamento targets (3xx) across the full sequence so
    // rows with 3xx but no note can still slide towards the next note in
    // the same track, even when it lives in the next pattern.
    this.precomputeTonePortaTargets();
    // Set BPM in timing system (will clamp to valid range)
    this.timingSystem.setBpm(song.bpm);
    const maxIndex = Math.max(0, song.sequence.length - 1);
    this.currentSequenceIndex = Math.max(0, Math.min(startSequenceIndex, maxIndex));

    // Initialize timing system with the starting sequence index for position calculations
    // This ensures updatePosition() works correctly even if playback hasn't started yet
    if (this.audioContext) {
      this.timingSystem.start(this.audioContext.currentTime, this.currentSequenceIndex, 0);
    }

    if (this.song.sequence.length > 0) {
      const patternId = this.song.sequence[this.currentSequenceIndex] as string;
      this.loadPattern(patternId, { emitPosition: false, updatePosition: false });
      this.position = {
        row: 0,
        patternId,
        sequenceIndex: this.currentSequenceIndex
      };
      this.emit('position', this.position);
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

  private getPatternLength(id: string | undefined): number {
    if (!id) return this.length;
    const pattern = this.song?.patterns.find((p) => p.id === id);
    return pattern ? Math.max(1, pattern.length) : this.length;
  }

  setBpm(bpm: number) {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    // Clamp to FastTracker 2 limits (matches F command range)
    this.timingSystem.setBpm(bpm);
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
    this.resetEffectStates();
    this.emit('state', this.state);
    // Emit position as-is (no forced row reset) so UI stays aligned with last played pattern/row
    this.emit('position', this.position);
  }

  seek(row: number) {
    const clamped = ((Math.round(row) % this.length) + this.length) % this.length;
    this.position = { ...this.position, row: clamped };
    this.emit('position', this.position);
  }

  on<K extends PlaybackEvent>(event: K, listener: PlaybackListener<K>): () => void {
    const set = this.listeners[event];
    set.add(listener as PlaybackListener<K>);
    return () => set.delete(listener as PlaybackListener<K>);
  }

  private startScheduledPlayback() {
    if (!this.audioContext || !this.scheduledNoteHandler) return;

    const now = this.audioContext.currentTime;
    // Initialize timing system for current position
    this.timingSystem.start(now, this.currentSequenceIndex, this.position.row);
    this.timingSystem.setSpeed(6); // Reset to normal speed

    this.lastScheduledRow = this.position.row - 1;
    this.scheduledLoops = 0;
    // Initialize timing for cumulative tempo changes
    this.nextRowTime = now;
    // Reset effect states for clean playback start
    this.resetEffectStates();

    // Schedule initial batch of notes
    this.scheduleAhead();

    // Drive ongoing scheduling via the visibility-aware clock
    this.playbackClock.stop(); // ensure we start from a clean state
    this.playbackClock.setVisible?.(this.isTabVisible);
    this.playbackClock.start(() => {
      this.updatePosition();
      this.scheduleAhead();
    });
  }

  private stopScheduledPlayback() {
    this.playbackClock.stop();
    this.lastScheduledRow = -1;
    this.scheduledLoops = 0;
  }

  private scheduleAhead() {
    if (!this.audioContext || !this.scheduledNoteHandler) return;
    if (this.state !== 'playing') return;

    const now = this.audioContext.currentTime;
    const lookahead = this.getLookaheadSeconds();
    const scheduleUntil = now + lookahead;
    const catchUpLead = 0.01; // ensure late rows still land slightly in the future

    // Schedule rows using cumulative timing to support dynamic tempo changes
    while (this.nextRowTime < scheduleUntil) {
      const currentRow = this.lastScheduledRow + 1;
      const actualRow = currentRow % this.length;

      // Apply pending position commands ASAP (before auto pattern advance)
      if (this.pendingPosCommand) {
        const cmd = this.pendingPosCommand;
        this.pendingPosCommand = null;

        // Notify handler for UI sync
        if (this.positionCommandHandler) {
          this.positionCommandHandler(cmd);
        }

        const sequence = this.song?.sequence ?? [];
        if (sequence.length === 0) {
          this.stop();
          return;
        }

        if (cmd.type === 'posJump') {
          // Bxx: Jump to sequence position xx, row 0
          if (cmd.value >= sequence.length || sequence.length === 0) {
            // ProTracker stops when jumping past the order list
            this.stop();
            return;
          }
          const targetIndex = cmd.value;
          this.currentSequenceIndex = targetIndex;
          const targetPatternId = sequence[targetIndex];
          if (!targetPatternId) {
            this.stop();
            return;
          }
          this.loadPattern(targetPatternId, { emitPosition: true, updatePosition: true });
          // Reset to start of target pattern
          this.lastScheduledRow = -1;
          this.resetPositionReference(this.currentSequenceIndex, 0, now);
          this.position = { row: 0, patternId: targetPatternId, sequenceIndex: this.currentSequenceIndex };
          this.emit('position', this.position);
        } else if (cmd.type === 'patBreak') {
          // Dxx: Break to row xx of next pattern
          this.currentSequenceIndex += 1;
          if (this.currentSequenceIndex >= sequence.length) {
            if (this.loopSong) {
              this.currentSequenceIndex = 0;
            } else {
              this.stop();
              return;
            }
          }
          const targetPatternId = sequence[this.currentSequenceIndex];
          if (targetPatternId) {
            this.loadPattern(targetPatternId, { emitPosition: true, updatePosition: true });
            // Jump to specified row in next pattern (clamped to pattern length)
            const targetRow = Math.max(0, Math.min(cmd.value, this.length - 1));
            this.lastScheduledRow = targetRow - 1;
            this.resetPositionReference(this.currentSequenceIndex, targetRow, now);
            this.position = { row: targetRow, patternId: targetPatternId, sequenceIndex: this.currentSequenceIndex };
            this.emit('position', this.position);
          } else {
            this.stop();
            return;
          }
        }

        // Continue scheduling from new position
        continue;
      }

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
          // Reset pattern loop state when entering new pattern
          this.patternLoopStart = 0;
          this.patternLoopCount = 0;
          this.patternLoopTarget = 0;
        } else {
          this.stop();
          return;
        }
      }

      // Schedule this row at nextRowTime (may apply F commands that change speed/bpm)
      const rowTime = this.nextRowTime;

      // If we're late, still schedule the row just ahead of now to avoid drops
      const isLate = rowTime < now;
      const scheduledRowTime = isLate ? now + catchUpLead : rowTime;
      if (isLate) {
        console.warn(
          `[PlaybackEngine] Scheduling row ${actualRow} late by ${(now - rowTime).toFixed(
            3,
          )}s, using catch-up lead ${catchUpLead}s`,
        );
      }
      if (scheduledRowTime >= now) {
        this.scheduleRow(actualRow, scheduledRowTime);
      }

      // Handle pattern delay (EEx) - repeat current row x times
      if (this.patternDelayCount > 0) {
        // Decrement delay counter
        this.patternDelayCount--;
        // Re-schedule the same row again (don't advance lastScheduledRow)
        const msPerRow = this.getMsPerRow();
        const secPerRow = msPerRow / 1000;
        this.nextRowTime += secPerRow;
        // Continue without advancing lastScheduledRow, so next iteration schedules same row
        continue;
      }

      // Handle pattern loop (E6x) - jump back to loop start
      if (this.patternLoopCount > 0 && this.patternLoopCount <= this.patternLoopTarget) {
        // Increment loop counter
        this.patternLoopCount++;

        if (this.patternLoopCount <= this.patternLoopTarget) {
          // Still looping - jump back to loop start
          this.lastScheduledRow = this.patternLoopStart - 1;
          const msPerRow = this.getMsPerRow();
          const secPerRow = msPerRow / 1000;
          this.nextRowTime += secPerRow;
          continue;
        } else {
          // Finished looping - reset state and continue normally
          this.patternLoopCount = 0;
          this.patternLoopTarget = 0;
        }
      }

      // Calculate time for next row using current speed/bpm (after F commands were applied)
      const msPerRow = this.getMsPerRow();
      const secPerRow = msPerRow / 1000;
      this.nextRowTime += secPerRow;

      this.lastScheduledRow = currentRow;
    }

    // Jitter/lag instrumentation: track when scheduling approaches the deadline
    const lead = this.nextRowTime - now;
    if (lead < this.lateScheduleThreshold) {
      this.lateScheduleCount = Math.min(this.lateScheduleCount + 1, 10);
      this.maxLeadDeficit = Math.min(this.maxLeadDeficit, lead);
      if (this.lateScheduleCount === 3) {
        console.warn(
          `[PlaybackEngine] Scheduling is running close to deadline (lead=${lead.toFixed(3)}s, max deficit=${this.maxLeadDeficit.toFixed(3)}s). Expanding lookahead.`,
        );
      }
    } else {
      this.lateScheduleCount = 0;
      this.maxLeadDeficit = 0;
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
    this.patternLoopStart = 0;
    this.patternLoopCount = 0;
    this.patternLoopTarget = 0;
    this.patternDelayCount = 0;
  }

  /**
   * Calculate time per tick
   */
  private getMsPerTick(): number {
    return this.timingSystem.getTickDuration();
  }

  private scheduleRow(row: number, time: number) {
    if (!this.scheduledNoteHandler) return;

    const steps = this.stepIndex.get(row);
    const msPerRow = this.getMsPerRow();
    const msPerTick = this.getMsPerTick();
    const secPerTick = msPerTick / 1000;
    const secPerRow = msPerRow / 1000;

    // First pass: Apply speed/tempo commands (F commands) and position commands
    if (steps) {
      let rowHasPatDelay = false;
      for (const step of steps) {
        if (step.speedCommand !== undefined) {
          // F01-F1F: Set speed (1-31, where 6 is normal)
          this.timingSystem.setSpeed(step.speedCommand);
        }
        if (step.tempoCommand !== undefined) {
          // F20-FF: Set BPM directly (32-255)
          this.timingSystem.setBpm(step.tempoCommand);
        }

        // Check for position commands (Bxx, Dxx), pattern flow commands (E6x, EEx),
        // and song-level global volume commands (Gxx/Hxy).
        if (step.effect) {
          if (step.effect.type === 'posJump') {
            // Bxx overrides any earlier Dxx on the same row (PatternJump.mod behavior)
            this.pendingPosCommand = {
              type: 'posJump',
              value: step.effect.paramX * 16 + step.effect.paramY
            };
          } else if (step.effect.type === 'patBreak') {
            // Only set if no posJump has already claimed this row
            if (!this.pendingPosCommand || this.pendingPosCommand.type !== 'posJump') {
              const rawTarget = step.effect.paramX * 10 + step.effect.paramY; // FT2 uses decimal for Dxx
              const adjustedTarget = rowHasPatDelay ? rawTarget + 1 : rawTarget;
              this.pendingPosCommand = {
                type: 'patBreak',
                value: adjustedTarget
              };
            }
          } else if (step.effect.type === 'extEffect' && step.effect.extSubtype === 'patLoop') {
            // E6x: Pattern loop
            const loopCount = step.effect.paramY;
            if (loopCount === 0) {
              // E60: Set loop start point
              this.patternLoopStart = row;
            } else {
              // E6x (x>0): Loop back x times
              // Only trigger if we haven't already processed this loop
              if (this.patternLoopCount === 0) {
                this.patternLoopTarget = loopCount;
                this.patternLoopCount = 1; // Start counting from 1
              }
            }
          } else if (step.effect.type === 'patDelay') {
            // EEx: Pattern delay - repeat this row x times
            const delayCount = step.effect.paramY;
            if (delayCount > 0 && this.patternDelayCount === 0) {
              this.patternDelayCount = delayCount;
              rowHasPatDelay = true;
            }
          } else if (step.effect.type === 'setGlobalVol') {
            // Gxx: Set global volume (0-64 in ProTracker, 0-128 in FT2)
            const raw = step.effect.paramX * 16 + step.effect.paramY;
            const clamped = Math.max(0, Math.min(64, raw));
            this.globalVolume = clamped / 64;
            if (this.scheduledGlobalVolumeHandler) {
              this.scheduledGlobalVolumeHandler(this.globalVolume, time);
            }
          } else if (step.effect.type === 'globalVolSlide') {
            // Hxy: Global volume slide (x=up, y=down). Apply as a per-row slide.
            const up = step.effect.paramX;
            const down = step.effect.paramY;
            if (up > 0 && down === 0) {
              this.globalVolume = Math.min(1, this.globalVolume + up / 64);
            } else if (down > 0 && up === 0) {
              this.globalVolume = Math.max(0, this.globalVolume - down / 64);
            }
            if (this.scheduledGlobalVolumeHandler) {
              this.scheduledGlobalVolumeHandler(this.globalVolume, time);
            }
          }
        }
      }
    }

    // Second pass: Process each step with effects
    if (steps) {
      for (const step of steps) {
        const trackIndex = step.trackIndex;
        const effectState = this.getTrackEffectState(trackIndex);

        // Resolve instrumentId: use explicit step.instrumentId, or fall back to
        // the instrument currently playing on this track (for "naked" effects)
        let instrumentId = step.instrumentId;
        if (!instrumentId && effectState.instrumentId) {
          instrumentId = effectState.instrumentId;
        }

        // Skip if no instrument ID is available at all
        if (!instrumentId) continue;

        // Update effect state with current instrument (for future "naked" effects)
        if (step.instrumentId) {
          effectState.instrumentId = step.instrumentId;
        }

        // Handle macros
        if (step.macroIndex !== undefined && step.macroValue !== undefined) {
          if (this.scheduledMacroHandler) {
            const ramp =
              step.macroRamp && step.macroRamp.targetRow > row
                ? {
                    targetValue: step.macroRamp.targetValue,
                    // Nudge the ramp to end just before the target row start to avoid overlapping set/ramp at identical times
                    targetTime: (() => {
                      const ideal = time + (step.macroRamp.targetRow - row) * secPerRow;
                      const epsilon = 1e-5; // 10 microseconds
                      return Math.max(time + epsilon, ideal - epsilon);
                    })(),
                    ...(step.macroRamp.interpolation
                      ? { interpolation: step.macroRamp.interpolation }
                      : {})
                  }
                : undefined;
            this.scheduledMacroHandler(instrumentId, step.macroIndex, step.macroValue, time, ramp);
          } else if (this.macroHandler) {
            this.macroHandler(instrumentId, step.macroIndex, step.macroValue);
          }
        }

        const context = {
          instrumentId,
          row,
          trackIndex: step.trackIndex,
          time,
          voiceIndex: effectState.voiceIndex
        };

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

        // Process tick 0 (pass step.frequency for ProTracker MODs)
        const tick0Batch = processEffectTick0(
          effectState,
          step.effect,
          newNote,
          newVelocity,
          step.frequency,
          this.timingSystem.getTicksPerRow(),
          step.pan
        );

        this.dispatchCommands(tick0Batch.commands, context);

        // Handle volume automation (Cxx or step velocity)
        // NOTE: Effects like EA1 (fine volume slide) emit volume commands above
        const tick0HasVolumeCommand = tick0Batch.commands.some((cmd) => cmd.kind === 'volume');
        if (this.scheduledAutomationHandler && step.velocity !== undefined && !tick0HasVolumeCommand) {
          const gain = clamp(step.velocity / 255);
          this.scheduledAutomationHandler(instrumentId, gain, time);
        }

        // Schedule per-tick effects for ticks 1 to ticksPerRow-1
        if (hasTickEffect && step.effect) {
          const canUseRamp = this.canUseAutomationRamp(step.effect.type);

          if (canUseRamp) {
            // Optimization: Process all ticks to maintain correct state, but use a single
            // ramp to the final value instead of scheduling each tick discretely.
            // This reduces scheduling calls from 5 per row to 1 per row (83% reduction)
            // while maintaining correct effect state progression.
            let finalFrequency: number | undefined;
            let finalVolume: number | undefined;

            const ticksPerRow = this.timingSystem.getTicksPerRow();
            // Process all ticks to advance effect state correctly
            for (let tick = 1; tick < ticksPerRow; tick++) {
              const tickBatch = processEffectTickN(effectState, step.effect, tick, ticksPerRow);
              // Keep track of final values
              for (const cmd of tickBatch.commands) {
                if (cmd.kind === 'pitch') finalFrequency = cmd.frequency;
                if (cmd.kind === 'volume') finalVolume = cmd.volume;
              }
            }

            // Schedule smooth ramp to final value (instead of discrete per-tick values)
            const endTime = time + (ticksPerRow - 1) * secPerTick;

            if (this.scheduledPitchHandler && finalFrequency !== undefined) {
              // Use exponential ramp for pitch (frequency is exponential)
              this.scheduledPitchHandler(
                instrumentId,
                effectState.voiceIndex,
                finalFrequency,
                endTime,
                step.trackIndex,
                'exponential'
              );
            }

            if (this.scheduledVolumeHandler && finalVolume !== undefined) {
              // Use linear ramp for volume
              this.scheduledVolumeHandler(
                instrumentId,
                effectState.voiceIndex,
                finalVolume,
                endTime,
                step.trackIndex,
                'linear'
              );
            }
          } else {
            // Complex effects (vibrato, tremolo, arpeggio, etc.) still need per-tick processing
            const ticksPerRow = this.timingSystem.getTicksPerRow();
            for (let tick = 1; tick < ticksPerRow; tick++) {
              const tickTime = time + tick * secPerTick;
              const tickBatch = processEffectTickN(effectState, step.effect, tick, ticksPerRow);
              this.dispatchCommands(tickBatch.commands, { ...context, time: tickTime });
            }
          }
        }
      }
    }

    // Note: Position commands (Bxx, Dxx) are now handled in scheduleAhead()
    // after this row is scheduled, so the scheduling loop can react immediately
  }

  private dispatchCommands(
    commands: ProcessorCommand[],
    context: {
      instrumentId: string;
      row: number;
      trackIndex: number;
      time: number;
      voiceIndex: number;
    }
  ) {
    if (!commands.length) return;

    for (const cmd of commands) {
      switch (cmd.kind) {
        case 'noteOn':
          if (!this.scheduledNoteHandler) break;
          this.scheduledNoteHandler({
            type: 'noteOn',
            instrumentId: context.instrumentId,
            midi: cmd.midi,
            row: context.row,
            trackIndex: context.trackIndex,
            time: context.time,
            velocity: cmd.velocity,
            ...(cmd.frequency !== undefined ? { frequency: cmd.frequency } : {}),
            ...(cmd.pan !== undefined ? { pan: cmd.pan } : {})
          });
          break;

        case 'noteOff':
          if (!this.scheduledNoteHandler) break;
          this.scheduledNoteHandler({
            type: 'noteOff',
            instrumentId: context.instrumentId,
            row: context.row,
            trackIndex: context.trackIndex,
            time: context.time,
            ...(cmd.midi !== undefined ? { midi: cmd.midi } : {})
          });
          break;

        case 'pitch':
          if (!this.scheduledPitchHandler) break;
          this.scheduledPitchHandler(
            context.instrumentId,
            cmd.voiceIndex ?? context.voiceIndex,
            cmd.frequency,
            context.time,
            context.trackIndex,
            cmd.glide
          );
          break;

        case 'volume':
          if (!this.scheduledVolumeHandler) break;
          this.scheduledVolumeHandler(
            context.instrumentId,
            cmd.voiceIndex ?? context.voiceIndex,
            cmd.volume,
            context.time,
            context.trackIndex,
            cmd.ramp
          );
          break;

        case 'sampleOffset':
          if (!this.scheduledSampleOffsetHandler) break;
          this.scheduledSampleOffsetHandler(
            context.instrumentId,
            cmd.voiceIndex ?? context.voiceIndex,
            cmd.offset,
            context.time,
            context.trackIndex
          );
          break;

        case 'retrigger':
          if (!this.scheduledRetriggerHandler) break;
          this.scheduledRetriggerHandler(
            context.instrumentId,
            cmd.midi,
            cmd.velocity,
            context.time
          );
          break;

        case 'pan':
          // No dedicated pan handler yet; pan is conveyed on noteOn events when present.
          break;
      }
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

  /**
   * Check if an effect can use audio-rate automation ramps instead of per-tick scheduling.
   * Simple linear/exponential slides can use ramps for better performance and smoother audio.
   */
  private canUseAutomationRamp(type: string): boolean {
    const rampableEffects = [
      'portaUp', 'portaDown', 'tonePorta', 'tonePortaVol', 'volSlide'
    ];
    return rampableEffects.includes(type);
  }

  private updatePosition() {
    if (!this.audioContext) return;
    if (this.state !== 'playing') return;

    const now = this.audioContext.currentTime;
    const currentPosition = this.timingSystem.getCurrentRow(now);

    if (
      currentPosition.row !== this.position.row ||
      currentPosition.patternId !== this.position.patternId ||
      currentPosition.sequenceIndex !== this.position.sequenceIndex
    ) {
      const newPosition: PlaybackPosition = {
        row: currentPosition.row,
        sequenceIndex: currentPosition.sequenceIndex
      };
      if (currentPosition.patternId) {
        newPosition.patternId = currentPosition.patternId;
      }
      this.position = newPosition;
      this.emit('position', this.position);
    }
  }

  /**
   * Reset position tracking reference for jump/seek scenarios.
   * Aligns timing system to the given target position.
   */
  private resetPositionReference(targetSequenceIndex: number, targetRow: number, now: number) {
    this.timingSystem.advanceToRow(now, targetSequenceIndex, targetRow);
  }

  private getMsPerRow(): number {
    return this.timingSystem.getRowDuration();
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

    const resolverTasks: Promise<void>[] = [];
    for (const id of instrumentIds) {
      try {
        resolverTasks.push(Promise.resolve(this.resolver(id)));
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    }
    await Promise.all(resolverTasks);
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
        const gain = clamp(step.velocity / 255);
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
