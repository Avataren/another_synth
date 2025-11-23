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
  type MacroHandler
} from './types';
import { createAudioContextScheduler, IntervalScheduler } from './scheduler';

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
  private readonly audioContext: AudioContext | undefined;
  private stepIndex: Map<number, PlaybackPatternStep[]> = new Map();
  private loopCurrentPattern = false;

  /** Audio context time when playback started */
  private playStartTime = 0;
  /** Row offset when playback started (for seeking) */
  private startRow = 0;
  /** Last scheduled row (for lookahead scheduling) */
  private lastScheduledRow = -1;
  /** Pattern loop count for scheduling */
  private scheduledLoops = 0;
  /** RAF handle for playback loop */
  private rafHandle: number | null = null;

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
    this.audioContext = options.audioContext;
  }

  setLoopCurrentPattern(loop: boolean) {
    this.loopCurrentPattern = loop;
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

  loadPattern(patternId: string) {
    const pattern = this.song?.patterns.find(p => p.id === patternId);
    if (!pattern) {
      this.emit('error', new Error(`Pattern with id ${patternId} not found.`));
      return;
    }
    this.length = Math.max(1, pattern.length);
    this.position = { row: 0, patternId: pattern.id };
    this.indexPattern(pattern);
    this.emit('position', this.position);
  }

  setBpm(bpm: number) {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    this.bpm = bpm;
  }

  setLength(rows: number) {
    this.length = Math.max(1, Math.round(rows));
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
    this.position = { ...this.position, row: 0 };
    this.currentSequenceIndex = 0;
    if (this.song && this.song.sequence.length > 0) {
      this.loadPattern(this.song.sequence[0] as string);
    }
    this.emit('state', this.state);
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

    // Schedule initial batch of notes
    this.scheduleAhead();

    // Use RAF for both scheduling and position updates
    const loop = () => {
      if (this.state !== 'playing') return;
      this.updatePosition();
      this.scheduleAhead();
      this.rafHandle = requestAnimationFrame(loop);
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  private stopScheduledPlayback() {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.lastScheduledRow = -1;
    this.scheduledLoops = 0;
  }

  private scheduleAhead() {
    if (!this.audioContext || !this.scheduledNoteHandler) return;
    if (this.state !== 'playing') return;

    const now = this.audioContext.currentTime;
    const scheduleUntil = now + SCHEDULE_AHEAD_TIME;
    const msPerRow = this.getMsPerRow();
    const secPerRow = msPerRow / 1000;

    // Calculate which row corresponds to scheduleUntil time
    const elapsedSec = scheduleUntil - this.playStartTime;
    const rowsElapsed = Math.floor(elapsedSec / secPerRow);
    let targetRow = this.startRow + rowsElapsed;

    while (this.lastScheduledRow < targetRow) {
      const currentRow = this.lastScheduledRow + 1;
      const actualRow = currentRow % this.length;

      if (actualRow === 0 && currentRow > 0 && !this.loopCurrentPattern) { // Pattern finished
        this.currentSequenceIndex++;
        if (this.currentSequenceIndex >= (this.song?.sequence.length ?? 0)) {
          this.stop();
          return;
        }
        const nextPatternId = this.song?.sequence[this.currentSequenceIndex];
        if (nextPatternId) {
          this.loadPattern(nextPatternId);
          this.startRow = this.startRow - this.length;
          targetRow = this.startRow + rowsElapsed;
        } else {
          this.stop();
          return;
        }
      }

      // Calculate the exact time for this row
      const rowOffset = currentRow - this.startRow;
      const rowTime = this.playStartTime + (rowOffset * secPerRow);

      // Only schedule if in the future
      if (rowTime >= now) {
        this.scheduleRow(actualRow, rowTime);
      }

      this.lastScheduledRow = currentRow;
    }
  }

  private scheduleRow(row: number, time: number) {
    if (!this.scheduledNoteHandler) return;

    const steps = this.stepIndex.get(row);
    if (!steps || steps.length === 0) return;

    for (const step of steps) {
      const instrumentId = step.instrumentId;
      if (!instrumentId) continue;

      if (step.macroIndex !== undefined && step.macroValue !== undefined) {
        if (this.scheduledMacroHandler) {
          this.scheduledMacroHandler(instrumentId, step.macroIndex, step.macroValue, time);
        } else if (this.macroHandler) {
          this.macroHandler(instrumentId, step.macroIndex, step.macroValue);
        }
      }

      if (this.scheduledAutomationHandler && step.velocity !== undefined) {
        const gain = clamp(step.velocity / 127);
        this.scheduledAutomationHandler(instrumentId, gain, time);
      }

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

      if (step.midi === undefined) continue;

      const velocity = Number.isFinite(step.velocity) ? step.velocity : undefined;
      const event: ScheduledNoteEvent = {
        type: 'noteOn',
        instrumentId,
        midi: step.midi,
        row,
        trackIndex: step.trackIndex,
        time
      };
      if (velocity !== undefined) {
        event.velocity = velocity;
      }
      this.scheduledNoteHandler(event);
    }
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

    let tempRowsPlayed = totalRowsPlayed;
    let sequenceIndex = 0;
    let patternId = this.song?.sequence[0];
    let currentPatternLength = this.song?.patterns.find(p => p.id === patternId)?.length ?? this.length;

    while (tempRowsPlayed >= currentPatternLength && sequenceIndex < (this.song?.sequence.length ?? 0) -1) {
      tempRowsPlayed -= currentPatternLength;
      sequenceIndex++;
      patternId = this.song?.sequence[sequenceIndex];
      currentPatternLength = this.song?.patterns.find(p => p.id === patternId)?.length ?? this.length;
    }


    const currentRow = tempRowsPlayed % currentPatternLength;

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
    return (60_000 / this.bpm) / rowsPerBeat;
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
          this.currentSequenceIndex++;
          if (this.currentSequenceIndex >= (this.song?.sequence.length ?? 0)) {
            this.stop();
            return;
          }
          const nextPatternId = this.song?.sequence[this.currentSequenceIndex];
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
