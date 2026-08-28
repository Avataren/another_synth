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
  type ScheduledPanHandler,
  type ScheduledSampleOffsetHandler,
  type ScheduledGlobalVolumeHandler,
  type ScheduledRetriggerHandler,
  type PositionCommandHandler,
  type PlaybackClock,
  type Step,
  type ModuleFormat,
  DEFAULT_MODULE_FORMAT,
} from './types';
import { createAudioContextScheduler, IntervalScheduler } from './scheduler';
import { createVisibilityClock } from './clock';
import {
  type TrackEffectState,
  createTrackEffectState,
  processEffectTick0,
  processEffectTickN,
  resetEffectStateForNote,
  type ProcessorCommand,
} from './effect-processor';
import { TimingSystem } from './timing-system';
import { type FormatProfile, profileForFormat } from './format-profile';

type ListenerMap = {
  [K in PlaybackEvent]: Set<PlaybackListener<K>>;
};

export function shouldRetriggerLastNote(
  newNote: number | undefined,
  step: Pick<
    Step,
    'instrumentId' | 'velocity' | 'effect' | 'speedCommand' | 'tempoCommand'
  >,
): boolean {
  if (newNote !== undefined) return false;
  if (!step.instrumentId) return false;
  if (step.velocity !== undefined) return false;
  // Fxx (speed/tempo) is tracked on its own step fields, not step.effect,
  // so a row carrying *only* a speed/tempo change (no note, no other
  // effect) falls through to the "naked instrument number" case below and
  // looks identical to it. But a bare speed/tempo change is never a
  // note-retrigger convention in any tracker format -- and
  // useTrackerSongBuilder stamps instrumentId onto every row sticky, so
  // real-world patterns that alternate speed every row (a common
  // shuffle/groove trick, e.g. repeated F05/F06) used to replay the
  // track's last note from scratch on every single row instead of letting
  // it sustain, which is audible as a sample retriggering nonstop instead
  // of playing normally.
  if (step.speedCommand !== undefined || step.tempoCommand !== undefined) {
    return false;
  }
  const effectType = step.effect?.type;
  if (effectType === undefined) return true;
  if (effectType === 'volSlide') {
    // Only retrigger on vol slides when the row also carries a note.
    // Naked Axx rows should not revive the last note.
    return (
      (step as { midi?: number; note?: string }).midi !== undefined ||
      (step as { midi?: number; note?: string }).note !== undefined
    );
  }
  return false;
}

export class PlaybackEngine {
  private song: Song | null = null;
  /**
   * Format semantics for the loaded song. Nothing branches on this yet --
   * it becomes the FormatProfile selector in Phase 2 (see
   * PLAN-module-format-support.md).
   */
  private moduleFormat: ModuleFormat = DEFAULT_MODULE_FORMAT;
  /** Playback semantics derived from moduleFormat; handed to each track state. */
  private formatProfile: FormatProfile = profileForFormat(DEFAULT_MODULE_FORMAT);
  private state: TransportState = 'stopped';
  private position: PlaybackPosition = { row: 0 };
  private length = 64;
  private currentSequenceIndex = 0;
  /** Unified timing system for all timing calculations */
  private timingSystem: TimingSystem;
  private readonly listeners: ListenerMap = {
    position: new Set(),
    state: new Set(),
    error: new Set(),
  };
  private readonly resolver: InstrumentResolver | undefined;
  private readonly scheduler: PlaybackScheduler;
  private readonly playbackClock: PlaybackClock;
  private readonly noteHandler: PlaybackNoteHandler | undefined;
  private readonly scheduledNoteHandler: ScheduledNoteHandler | undefined;
  private readonly scheduledAutomationHandler:
    | ScheduledAutomationHandler
    | undefined;
  private readonly automationHandler: AutomationHandler | undefined;
  private readonly scheduledMacroHandler: ScheduledMacroHandler | undefined;
  private readonly macroHandler: MacroHandler | undefined;
  private readonly scheduledPitchHandler: ScheduledPitchHandler | undefined;
  private readonly scheduledVolumeHandler: ScheduledVolumeHandler | undefined;
  private readonly scheduledPanHandler: ScheduledPanHandler | undefined;
  private readonly scheduledSampleOffsetHandler:
    | ScheduledSampleOffsetHandler
    | undefined;
  private readonly scheduledGlobalVolumeHandler:
    | ScheduledGlobalVolumeHandler
    | undefined;
  private readonly scheduledRetriggerHandler:
    | ScheduledRetriggerHandler
    | undefined;
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
  /** Debug: last row we logged a pitch per track */
  private pitchLogRow: Map<number, number> = new Map();

  /** Position/pattern commands to process (Bxx, Dxx) */
  private pendingPosCommand: {
    type: 'posJump' | 'patBreak';
    value: number;
  } | null = null;

  /** Pattern loop state (E6x) */
  private patternLoopStart = 0; // Row where loop starts (set by E60)
  private patternLoopCount = 0; // Current loop iteration
  private patternLoopTarget = 0; // Total number of loops requested

  /** Pattern delay state (EEx) - delays current row by x ticks */
  private patternDelayCount = 0; // Number of times to repeat current row

  /** Global volume state (Gxx/Hxy), normalized 0-1 */
  private globalVolume = 1.0;

  /**
   * Audio-time timeline of rows the scheduler has queued, used to drive the
   * position display.
   *
   * The display used to be derived by dividing elapsed audio time by the
   * *current* row duration. That silently assumes the duration never changed:
   * the moment a song hits an Fxx speed or tempo command, the new duration is
   * applied retroactively to all previously elapsed time, so the displayed row
   * jumps and then stays wrong. Pattern delay (EEx), pattern loop (E6x) and
   * position jumps (Bxx/Dxx) break the same assumption by making the row count
   * non-linear in time.
   *
   * The scheduler already computes each row's exact start time cumulatively,
   * with the tempo in force at that row, so recording those times and looking
   * up the latest one that has been reached is both simpler and exact.
   */
  private scheduledPositions: Array<{
    time: number;
    row: number;
    sequenceIndex: number;
    patternId: string | undefined;
  }> = [];

  /** Last note played per track (for instrument-only retrigger rows) */
  private lastTrackNote: Map<number, { midi: number; velocity: number }> =
    new Map();

  constructor(options: PlaybackOptions = {}) {
    this.resolver = options.instrumentResolver;
    this.scheduler =
      options.scheduler ||
      createAudioContextScheduler() ||
      new IntervalScheduler();
    this.playbackClock =
      options.playbackClock ?? createVisibilityClock({ targetFps: 30 });
    this.noteHandler = options.noteHandler;
    this.scheduledNoteHandler = options.scheduledNoteHandler;
    this.scheduledAutomationHandler = options.scheduledAutomationHandler;
    this.automationHandler = options.automationHandler;
    this.scheduledMacroHandler = options.scheduledMacroHandler;
    this.macroHandler = options.macroHandler;
    this.scheduledPitchHandler = options.scheduledPitchHandler;
    this.scheduledVolumeHandler = options.scheduledVolumeHandler;
    this.scheduledPanHandler = options.scheduledPanHandler;
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
        ticksPerRow: options.ticksPerRow ?? 6,
      },
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
    const base = this.isTabVisible
      ? this.baseLookaheadVisible
      : this.baseLookaheadHidden;
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

    // For each track index, walk forward and let 3xx rows inherit the most recent
    // tone porta target (the last tonePorta/tonePortaVol row that specified a note).
    for (let trackIndex = 0; trackIndex < maxTracks; trackIndex += 1) {
      let lastTargetMidi: number | undefined;
      let lastTargetFrequency: number | undefined;

      for (const patternId of song.sequence) {
        const pattern = patternsById.get(patternId);
        if (!pattern) continue;
        const track = pattern.tracks[trackIndex];
        if (!track || !track.steps || track.steps.length === 0) continue;

        // Process rows in order within the pattern
        const sortedSteps = [...track.steps].sort((a, b) => a.row - b.row);
        for (const step of sortedSteps) {
          if (step.isNoteOff) {
            continue;
          }

          const isTonePorta =
            step.effect?.type === 'tonePorta' ||
            step.effect?.type === 'tonePortaVol';

          if (isTonePorta && step.midi !== undefined) {
            // Tone porta with an explicit note: update the target.
            lastTargetMidi = step.midi;
            lastTargetFrequency = step.frequency;
          } else if (
            isTonePorta &&
            step.midi === undefined &&
            lastTargetMidi !== undefined
          ) {
            // Tone porta continuation without a note: inherit the last target so we keep sliding.
            step.midi = lastTargetMidi;
            if (lastTargetFrequency !== undefined) {
              step.frequency = lastTargetFrequency;
            }
          }
        }
      }
    }
  }

  /** Format semantics the currently loaded song plays under. */
  getModuleFormat(): ModuleFormat {
    return this.moduleFormat;
  }

  /** The resolved playback profile for the loaded song. */
  getFormatProfile(): FormatProfile {
    return this.formatProfile;
  }

  loadSong(song: Song, startSequenceIndex = 0) {
    this.song = song;
    this.moduleFormat = song.moduleFormat ?? DEFAULT_MODULE_FORMAT;
    this.scheduledPositions.length = 0;
    this.formatProfile = profileForFormat(this.moduleFormat, {
      ...(song.linearFrequency !== undefined
        ? { linearFrequency: song.linearFrequency }
        : {}),
    });
    // Track states cache the profile, so drop any built for the previous song.
    this.trackEffectStates.clear();
    // Precompute tone portamento targets (3xx) across the full sequence so
    // rows with 3xx but no note can still slide towards the next note in
    // the same track, even when it lives in the next pattern.
    this.precomputeTonePortaTargets();
    // Set BPM in timing system (will clamp to valid range)
    this.timingSystem.setBpm(song.bpm);
    const maxIndex = Math.max(0, song.sequence.length - 1);
    this.currentSequenceIndex = Math.max(
      0,
      Math.min(startSequenceIndex, maxIndex),
    );

    // Initialize timing system with the starting sequence index for position calculations
    // This ensures updatePosition() works correctly even if playback hasn't started yet
    if (this.audioContext) {
      this.timingSystem.start(
        this.audioContext.currentTime,
        this.currentSequenceIndex,
        0,
      );
    }

    if (this.song.sequence.length > 0) {
      const patternId = this.song.sequence[this.currentSequenceIndex] as string;
      this.loadPattern(patternId, {
        emitPosition: false,
        updatePosition: false,
      });
      this.position = {
        row: 0,
        patternId,
        sequenceIndex: this.currentSequenceIndex,
      };
      this.emit('position', this.position);
    }
    this.emit('state', this.state);
  }

  loadPattern(
    patternId: string,
    options?: { emitPosition?: boolean; updatePosition?: boolean },
  ) {
    const pattern = this.song?.patterns.find((p) => p.id === patternId);
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

  /**
   * Set the fallback row count used when no pattern is loaded.
   *
   * This used to overwrite *every* pattern's length, back when row count was
   * a song-level setting. Patterns now carry their own length (XM varies it
   * per pattern), so stomping them here would flatten exactly the thing the
   * format needs. Use `setPatternLength` to change one pattern.
   */
  setLength(rows: number) {
    this.length = Math.max(1, Math.round(rows));
  }

  /** Change the row count of a single pattern in the loaded song. */
  setPatternLength(patternId: string, rows: number) {
    if (!this.song) return;
    const clamped = Math.max(1, Math.round(rows));
    let found = false;
    const patterns = this.song.patterns.map((pattern) => {
      if (pattern.id !== patternId) return pattern;
      found = true;
      return { ...pattern, length: clamped };
    });
    if (!found) return;
    this.song = { ...this.song, patterns };
    // Keep the active pattern's scheduling length in step with the edit.
    if (this.position.patternId === patternId) {
      this.length = clamped;
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
    this.scheduledPositions.length = 0;
    this.emit('state', this.state);
    // Emit position as-is (no forced row reset) so UI stays aligned with last played pattern/row
    this.emit('position', this.position);
  }

  seek(row: number) {
    const clamped =
      ((Math.round(row) % this.length) + this.length) % this.length;
    this.position = { ...this.position, row: clamped };
    // Rows queued for display belong to the position we just left.
    this.scheduledPositions.length = 0;
    this.emit('position', this.position);
  }

  on<K extends PlaybackEvent>(
    event: K,
    listener: PlaybackListener<K>,
  ): () => void {
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
    // Discard any rows queued for display by a previous run.
    this.scheduledPositions.length = 0;

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
          this.loadPattern(targetPatternId, {
            emitPosition: true,
            updatePosition: true,
          });
          // Reset to start of target pattern
          this.lastScheduledRow = -1;
          this.resetPositionReference(this.currentSequenceIndex, 0, now);
          this.position = {
            row: 0,
            patternId: targetPatternId,
            sequenceIndex: this.currentSequenceIndex,
          };
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
            this.loadPattern(targetPatternId, {
              emitPosition: true,
              updatePosition: true,
            });
            // Jump to specified row in next pattern (clamped to pattern length)
            const targetRow = Math.max(0, Math.min(cmd.value, this.length - 1));
            this.lastScheduledRow = targetRow - 1;
            this.resetPositionReference(
              this.currentSequenceIndex,
              targetRow,
              now,
            );
            this.position = {
              row: targetRow,
              patternId: targetPatternId,
              sequenceIndex: this.currentSequenceIndex,
            };
            this.emit('position', this.position);
          } else {
            this.stop();
            return;
          }
        }

        // Continue scheduling from new position
        continue;
      }

      if (actualRow === 0 && currentRow > 0 && !this.loopCurrentPattern) {
        // Pattern finished
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
          this.loadPattern(nextPatternId, {
            emitPosition: false,
            updatePosition: false,
          });
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
          `[PlaybackEngine] Scheduling row ${actualRow} late by ${(
            now - rowTime
          ).toFixed(3)}s, using catch-up lead ${catchUpLead}s`,
        );
      }
      if (scheduledRowTime >= now) {
        this.scheduleRow(actualRow, scheduledRowTime);
        this.recordScheduledPosition(actualRow, scheduledRowTime);
      }

      // Handle pattern delay (EEx) - repeat current row x times
      if (this.patternDelayCount > 0) {
        // Decrement delay counter
        this.patternDelayCount--;
        const msPerRow = this.getMsPerRow();
        const secPerRow = msPerRow / 1000;
        this.nextRowTime += secPerRow;
        if (this.patternDelayCount > 0) {
          // Still repeating -- schedule the same row again next iteration
          // (don't advance lastScheduledRow yet).
          continue;
        }
        // This was the last repeat: fall through to advance lastScheduledRow
        // normally below. Without this, the row where the counter first
        // reaches 0 would *also* `continue`, leaving lastScheduledRow
        // stuck -- the next iteration re-runs scheduleRow() for the same
        // row, which sees patternDelayCount === 0 and re-arms it right
        // back to the full delay count, looping forever and never
        // advancing past this row (audibly: playback hangs on this row
        // indefinitely instead of just holding it for the requested
        // number of extra rows).
      }

      // Handle pattern loop (E6x) - jump back to loop start
      if (
        this.patternLoopCount > 0 &&
        this.patternLoopCount <= this.patternLoopTarget
      ) {
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
      state = createTrackEffectState(this.formatProfile);
      this.trackEffectStates.set(trackIndex, state);
    }
    return state;
  }

  /**
   * Reset all effect states (called on stop/load)
   */
  private resetEffectStates(): void {
    this.trackEffectStates.clear();
    this.pitchLogRow.clear();
    this.lastTrackNote.clear();
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
              value: step.effect.paramX * 16 + step.effect.paramY,
            };
          } else if (step.effect.type === 'patBreak') {
            // Only set if no posJump has already claimed this row
            if (
              !this.pendingPosCommand ||
              this.pendingPosCommand.type !== 'posJump'
            ) {
              const rawTarget = step.effect.paramX * 10 + step.effect.paramY; // FT2 uses decimal for Dxx
              const adjustedTarget = rowHasPatDelay ? rawTarget + 1 : rawTarget;
              this.pendingPosCommand = {
                type: 'patBreak',
                value: adjustedTarget,
              };
            }
          } else if (
            step.effect.type === 'extEffect' &&
            step.effect.extSubtype === 'patLoop'
          ) {
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

    // Compute row/tick durations *after* the first pass above has applied
    // any F05/F06-style speed (or tempo) command carried by this row.
    // ProTracker semantics: a speed/tempo change on a row takes effect
    // immediately -- it governs that same row's own remaining ticks, not
    // just rows after it. Capturing these before the first pass (as this
    // used to) left every per-tick effect on a speed-changing row (note
    // delay, retrigger, vibrato/tremolo, tremor, ramped porta/volslide)
    // using the *previous* row's tick duration paired with the *new*
    // row's tick count from timingSystem.getTicksPerRow() -- a mismatch
    // that scrambled sub-row timing specifically on rows that change
    // speed, e.g. a shuffle/groove pattern alternating F05/F06 every row.
    const msPerRow = this.getMsPerRow();
    const msPerTick = this.getMsPerTick();
    const secPerTick = msPerTick / 1000;
    const secPerRow = msPerRow / 1000;

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
                      const ideal =
                        time + (step.macroRamp.targetRow - row) * secPerRow;
                      const epsilon = 1e-5; // 10 microseconds
                      return Math.max(time + epsilon, ideal - epsilon);
                    })(),
                    ...(step.macroRamp.interpolation
                      ? { interpolation: step.macroRamp.interpolation }
                      : {}),
                  }
                : undefined;
            this.scheduledMacroHandler(
              instrumentId,
              step.macroIndex,
              step.macroValue,
              time,
              ramp,
            );
          } else if (this.macroHandler) {
            this.macroHandler(instrumentId, step.macroIndex, step.macroValue);
          }
        }

        const context = {
          instrumentId,
          row,
          trackIndex: step.trackIndex,
          time,
          voiceIndex: effectState.voiceIndex,
        };

        // Handle note-off
        if (step.isNoteOff) {
          const event: ScheduledNoteEvent = {
            type: 'noteOff',
            instrumentId,
            row,
            trackIndex: step.trackIndex,
            time,
          };
          if (step.midi !== undefined) {
            event.midi = step.midi;
          }
          this.scheduledNoteHandler(event);
          continue;
        }

        // Check if we have an effect that needs per-tick processing
        const hasTickEffect =
          step.effect && this.isTickBasedEffect(step.effect.type);

        // Handle note-on with effect processing
        let newNote = step.midi;
        let newVelocity = step.velocity;

        // If an instrument is specified but no note/effect/velocity is provided, retrigger the last
        // note played on this track (if any). Skip when velocity is set so volume-only rows
        // don’t restart the sample.
        if (shouldRetriggerLastNote(newNote, step)) {
          const last = this.lastTrackNote.get(step.trackIndex);
          if (last) {
            newNote = last.midi;
            if (newVelocity === undefined) {
              newVelocity = last.velocity;
            }
          } else {
            // Fallback to the track effect state's current note/volume if we
            // don't have an explicit last note recorded yet.
            newNote = Math.round(effectState.currentMidi);
            if (newVelocity === undefined) {
              newVelocity = Math.round(
                Math.max(0, Math.min(1, effectState.currentVolume)) * 255,
              );
            }
          }
        }

        // Reset effect state on new note (unless tone portamento)
        if (
          newNote !== undefined &&
          step.effect?.type !== 'tonePorta' &&
          step.effect?.type !== 'tonePortaVol'
        ) {
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
          step.pan,
        );

        // // Debug the tone porta state for track 3 (fourth track) to investigate 3xx slides.
        // if (step.trackIndex === 3) {
        //   const pitchCmd = tick0Batch.commands.find((cmd) => cmd.kind === 'pitch');
        //   console.log(
        //     `[PitchState] row=${row} track=${step.trackIndex} note=${newNote ?? '—'} ` +
        //       `effect=${step.effect?.type ?? 'none'} speed=${effectState.tonePortaSpeed} ` +
        //       `curr=${effectState.currentFrequency.toFixed(4)}Hz ` +
        //       `target=${effectState.targetFrequency.toFixed(4)}Hz ` +
        //       `period=${effectState.currentPeriod ?? '—'} ` +
        //       `pitchCmd=${pitchCmd && 'frequency' in pitchCmd ? pitchCmd.frequency.toFixed(4) : 'none'} ` +
        //       `voice=${effectState.voiceIndex}`,
        //   );
        // }

        this.dispatchCommands(tick0Batch.commands, context);

        // Handle volume automation (Cxx or step velocity)
        // NOTE: Effects like EA1 (fine volume slide) emit volume commands above
        const tick0HasVolumeCommand = tick0Batch.commands.some(
          (cmd) => cmd.kind === 'volume',
        );
        if (step.velocity !== undefined && !tick0HasVolumeCommand) {
          const gain = clamp(step.velocity / 255);
          if (this.scheduledVolumeHandler) {
            // Per-track velocity should drive per-voice gain, not global instrument gain.
            this.scheduledVolumeHandler(
              instrumentId,
              -1, // resolve via track voice history
              gain,
              time,
              step.trackIndex,
              undefined,
            );
          } else if (this.scheduledAutomationHandler) {
            // Fallback: legacy global gain path
            this.scheduledAutomationHandler(instrumentId, gain, time);
          }
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
              const tickBatch = processEffectTickN(
                effectState,
                step.effect,
                tick,
                ticksPerRow,
              );
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
                'exponential',
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
                'linear',
              );
            }
          } else {
            // Complex effects (vibrato, tremolo, arpeggio, etc.) still need per-tick processing
            const ticksPerRow = this.timingSystem.getTicksPerRow();
            for (let tick = 1; tick < ticksPerRow; tick++) {
              const tickTime = time + tick * secPerTick;
              const tickBatch = processEffectTickN(
                effectState,
                step.effect,
                tick,
                ticksPerRow,
              );
              this.dispatchCommands(tickBatch.commands, {
                ...context,
                time: tickTime,
              });
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
    },
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
            ...(cmd.frequency !== undefined
              ? { frequency: cmd.frequency }
              : {}),
            ...(cmd.pan !== undefined ? { pan: cmd.pan } : {}),
            ...(cmd.sampleOffset !== undefined
              ? { sampleOffset: cmd.sampleOffset }
              : {}),
          });
          if (cmd.midi !== undefined) {
            this.lastTrackNote.set(context.trackIndex, {
              midi: cmd.midi,
              velocity:
                cmd.velocity !== undefined
                  ? cmd.velocity
                  : (this.lastTrackNote.get(context.trackIndex)?.velocity ??
                    100),
            });
          }
          break;

        case 'noteOff':
          if (!this.scheduledNoteHandler) break;
          this.scheduledNoteHandler({
            type: 'noteOff',
            instrumentId: context.instrumentId,
            row: context.row,
            trackIndex: context.trackIndex,
            time: context.time,
            ...(cmd.midi !== undefined ? { midi: cmd.midi } : {}),
          });
          break;

        case 'pitch':
          // Debug: log the first pitch seen for this track on this row
          {
            // Debug log only for track index 3 (fourth track)
            if (context.trackIndex === 3) {
              const lastRow = this.pitchLogRow.get(context.trackIndex);
              if (lastRow !== context.row) {
                this.pitchLogRow.set(context.trackIndex, context.row);
              }
            }
          }
          if (!this.scheduledPitchHandler) break;
          this.scheduledPitchHandler(
            context.instrumentId,
            cmd.voiceIndex ?? context.voiceIndex,
            cmd.frequency,
            context.time,
            context.trackIndex,
            cmd.glide,
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
            cmd.ramp,
          );
          break;

        case 'sampleOffset':
          if (!this.scheduledSampleOffsetHandler) break;
          this.scheduledSampleOffsetHandler(
            context.instrumentId,
            cmd.voiceIndex ?? context.voiceIndex,
            cmd.offset,
            context.time,
            context.trackIndex,
          );
          break;

        case 'retrigger':
          if (!this.scheduledRetriggerHandler) break;
          this.scheduledRetriggerHandler(
            context.instrumentId,
            cmd.midi,
            cmd.velocity,
            context.time,
            cmd.frequency,
          );
          break;

        case 'pan':
          // 8xx / E8x / Pxy change panning on a *sounding* voice, so they need
          // their own handler -- conveying pan only on noteOn (as this used to
          // do) silently discarded every mid-note pan change.
          //
          // The effect processor works in -1..1; the instrument pan API takes
          // 0..1 (0 = hard left, 0.5 = centre).
          if (!this.scheduledPanHandler) break;
          this.scheduledPanHandler(
            context.instrumentId,
            cmd.voiceIndex ?? context.voiceIndex,
            Math.max(0, Math.min(1, (cmd.pan + 1) / 2)),
            context.time,
            context.trackIndex,
          );
          break;
      }
    }
  }

  /**
   * Check if an effect type requires per-tick processing
   */
  private isTickBasedEffect(type: string): boolean {
    const tickEffects = [
      'portaUp',
      'portaDown',
      'tonePorta',
      'vibrato',
      'tonePortaVol',
      'vibratoVol',
      'tremolo',
      'arpeggio',
      'volSlide',
      'panSlide',
      'retrigVol',
      'tremor',
      'fineVibrato',
      'noteCut',
      'noteDelay',
      'keyOff',
    ];
    return tickEffects.includes(type);
  }

  /**
   * Check if an effect can use audio-rate automation ramps instead of per-tick scheduling.
   * Simple linear/exponential slides can use ramps for better performance and smoother audio.
   */
  private canUseAutomationRamp(type: string): boolean {
    const rampableEffects = ['portaUp', 'portaDown', 'volSlide'];
    return rampableEffects.includes(type);
  }

  /** Note when a scheduled row will actually be heard, for the display. */
  private recordScheduledPosition(row: number, time: number) {
    this.scheduledPositions.push({
      time,
      row,
      sequenceIndex: this.currentSequenceIndex,
      patternId: this.song?.sequence[this.currentSequenceIndex],
    });
    // The queue only ever holds the lookahead window plus the entry currently
    // being displayed, but cap it so a long run cannot grow it without bound.
    const MAX_SCHEDULED_POSITIONS = 512;
    if (this.scheduledPositions.length > MAX_SCHEDULED_POSITIONS) {
      this.scheduledPositions.splice(
        0,
        this.scheduledPositions.length - MAX_SCHEDULED_POSITIONS,
      );
    }
  }

  private updatePosition() {
    if (!this.audioContext) return;
    if (this.state !== 'playing') return;

    const now = this.audioContext.currentTime;

    // Advance to the most recent row whose scheduled time has been reached,
    // keeping it as the head of the queue so it stays current until the next
    // row is due.
    let reached = -1;
    for (let i = 0; i < this.scheduledPositions.length; i++) {
      if (this.scheduledPositions[i]!.time <= now) reached = i;
      else break;
    }
    if (reached < 0) return;
    if (reached > 0) this.scheduledPositions.splice(0, reached);

    const current = this.scheduledPositions[0]!;
    if (
      current.row !== this.position.row ||
      current.patternId !== this.position.patternId ||
      current.sequenceIndex !== this.position.sequenceIndex
    ) {
      const newPosition: PlaybackPosition = {
        row: current.row,
        sequenceIndex: current.sequenceIndex,
      };
      if (current.patternId) {
        newPosition.patternId = current.patternId;
      }
      this.position = newPosition;
      this.emit('position', this.position);
    }
  }

  /**
   * Reset position tracking reference for jump/seek scenarios.
   * Aligns timing system to the given target position.
   */
  private resetPositionReference(
    targetSequenceIndex: number,
    targetRow: number,
    now: number,
  ) {
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
        this.emit(
          'error',
          error instanceof Error ? error : new Error(String(error)),
        );
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
      let nextRow = this.position.row + 1;

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

  private emit<K extends PlaybackEvent>(
    event: K,
    payload: PlaybackEventMap[K],
  ) {
    const set = this.listeners[event];
    for (const listener of set) {
      try {
        (listener as PlaybackListener<K>)(payload);
      } catch (error) {
        console.error(
          `PlaybackEngine listener error for event "${event}":`,
          error,
        );
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

      if (
        this.macroHandler &&
        step.macroIndex !== undefined &&
        step.macroValue !== undefined
      ) {
        this.macroHandler(instrumentId, step.macroIndex, step.macroValue);
      }

      if (step.isNoteOff) {
        const event: PlaybackNoteEvent = {
          type: 'noteOff',
          instrumentId,
          row,
          trackIndex: step.trackIndex,
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
        trackIndex: step.trackIndex,
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

type PlaybackPatternStep = Pattern['tracks'][number]['steps'][number] & {
  trackIndex: number;
};

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}
