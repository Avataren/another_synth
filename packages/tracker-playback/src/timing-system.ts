/**
 * TimingSystem - Single source of truth for tracker playback timing.
 *
 * Consolidates timing calculations and state that was previously scattered
 * across the PlaybackEngine. Eliminates desync between UI position display
 * and scheduled audio events.
 */

/**
 * Get pattern length by ID callback type
 */
export type PatternLengthGetter = (patternId: string | undefined) => number;

/**
 * Song sequence provider callback type
 */
export type SequenceGetter = () => string[];

export class TimingSystem {
  /** Audio context time when playback started */
  private audioStartTime: number = 0;

  /** Row offset when playback started (for seeking) */
  private positionStartRow: number = 0;

  /** Current BPM (32-255) */
  private currentBpm: number = 120;

  /** Current speed multiplier (1-31, where 6 is normal) */
  private currentSpeed: number = 6;

  /** Number of ticks per row (default 6 for FT2 style) */
  private ticksPerRow: number = 6;

  /** Cumulative row offset for the starting sequence index */
  private sequenceStartOffsetRows: number = 0;

  /** Callback to get pattern length by ID */
  private getPatternLength: PatternLengthGetter;

  /** Callback to get song sequence */
  private getSequence: SequenceGetter;

  constructor(
    getPatternLength: PatternLengthGetter,
    getSequence: SequenceGetter,
    options: {
      bpm?: number;
      speed?: number;
      ticksPerRow?: number;
    } = {}
  ) {
    this.getPatternLength = getPatternLength;
    this.getSequence = getSequence;
    this.currentBpm = options.bpm ?? 120;
    this.currentSpeed = options.speed ?? 6;
    this.ticksPerRow = options.ticksPerRow ?? 6;
  }

  /**
   * Get milliseconds per row based on current BPM and speed.
   *
   * Formula:
   * - One beat = 4 rows (16th note grid)
   * - Base duration = (60,000ms / BPM) / 4 rows
   * - Apply speed multiplier (speed 6 is normal, 3 is 2x faster, 12 is 0.5x)
   */
  getRowDuration(): number {
    const rowsPerBeat = 4;
    const baseMs = (60_000 / this.currentBpm) / rowsPerBeat;
    const speedMultiplier = this.currentSpeed / 6.0;
    return baseMs * speedMultiplier;
  }

  /**
   * Get milliseconds per tick based on current timing settings.
   */
  getTickDuration(): number {
    return this.getRowDuration() / this.ticksPerRow;
  }

  /**
   * Get seconds per row (convenience method for scheduling).
   */
  getRowDurationSeconds(): number {
    return this.getRowDuration() / 1000;
  }

  /**
   * Get seconds per tick (convenience method for scheduling).
   */
  getTickDurationSeconds(): number {
    return this.getTickDuration() / 1000;
  }

  /**
   * Calculate the current row number from audio time.
   *
   * This is used by updatePosition() to display the current playback position.
   * The calculation accounts for:
   * - Elapsed time since playback started
   * - Starting row offset (for seeking)
   * - Sequence start offset (for multi-pattern songs)
   * - Song looping (wraps around total song length)
   *
   * Returns: { row, sequenceIndex, patternId, totalRowsPlayed }
   */
  getCurrentRow(audioTime: number): {
    row: number;
    sequenceIndex: number;
    patternId: string | undefined;
    totalRowsPlayed: number;
  } {
    const elapsed = audioTime - this.audioStartTime;
    const secPerRow = this.getRowDurationSeconds();

    const rowsElapsed = Math.floor(elapsed / secPerRow);
    const totalRowsPlayed = this.sequenceStartOffsetRows + this.positionStartRow + rowsElapsed;

    const sequence = this.getSequence();

    // Calculate total rows across the full song sequence
    const songLengthRows = sequence.reduce(
      (total, id) => total + this.getPatternLength(id),
      0
    );

    // Wrap around song length for looping
    let effectiveRows = totalRowsPlayed;
    if (songLengthRows > 0) {
      effectiveRows = ((effectiveRows % songLengthRows) + songLengthRows) % songLengthRows;
    }

    // Find which pattern and row we're in
    let patternId = sequence[0];
    let currentPatternLength = this.getPatternLength(patternId);
    let remaining = effectiveRows;
    let sequenceIndex = 0;

    for (let i = 0; i < sequence.length; i += 1) {
      const id = sequence[i];
      const length = this.getPatternLength(id);
      if (remaining < length) {
        patternId = id;
        currentPatternLength = length;
        sequenceIndex = i;
        break;
      }
      remaining -= length;
    }

    const currentRow = currentPatternLength > 0 ? remaining % currentPatternLength : 0;

    return {
      row: currentRow,
      sequenceIndex,
      patternId,
      totalRowsPlayed
    };
  }

  /**
   * Calculate the audio time for a given absolute row number.
   *
   * This is used by scheduleAhead() to calculate when to schedule audio events.
   * The row number is relative to the current playback start (including sequence offset).
   *
   * @param row - Absolute row number since playback start (can include sequence offset)
   * @returns Audio context time when this row should play
   */
  getAudioTimeForRow(row: number): number {
    const secPerRow = this.getRowDurationSeconds();
    const rowsSinceStart = row - this.positionStartRow;
    return this.audioStartTime + (rowsSinceStart * secPerRow);
  }

  /**
   * Reset timing reference for jump/seek scenarios.
   *
   * This is called when:
   * - Seeking to a different position
   * - Pattern flow commands (Bxx jump, Dxx break)
   * - Starting playback from a specific sequence index
   *
   * @param audioTime - Current audio context time
   * @param targetSequenceIndex - Sequence index to jump to
   * @param targetRow - Row within the target pattern
   */
  advanceToRow(audioTime: number, targetSequenceIndex: number, targetRow: number): void {
    this.audioStartTime = audioTime;
    this.positionStartRow = targetRow;
    this.sequenceStartOffsetRows = 0;

    const sequence = this.getSequence();
    for (let i = 0; i < targetSequenceIndex; i += 1) {
      const id = sequence[i];
      this.sequenceStartOffsetRows += this.getPatternLength(id);
    }
  }

  /**
   * Start timing from current audio time and row.
   *
   * Called when playback starts.
   *
   * @param audioTime - Current audio context time
   * @param sequenceIndex - Starting sequence index
   * @param row - Starting row
   */
  start(audioTime: number, sequenceIndex: number = 0, row: number = 0): void {
    this.advanceToRow(audioTime, sequenceIndex, row);
  }

  /**
   * Update BPM (clamped 32-255).
   *
   * This affects all subsequent timing calculations.
   * Called when FT2 tempo commands (F20-FF) are processed.
   *
   * @param bpm - New BPM value (will be clamped to 32-255)
   */
  setBpm(bpm: number): void {
    this.currentBpm = Math.max(32, Math.min(255, bpm));
  }

  /**
   * Update speed multiplier (clamped 1-31, where 6 is normal).
   *
   * This affects all subsequent timing calculations.
   * Called when FT2 speed commands (F01-F1F) are processed.
   *
   * @param speed - New speed value (will be clamped to 1-31)
   */
  setSpeed(speed: number): void {
    this.currentSpeed = Math.max(1, Math.min(31, speed));
  }

  /**
   * Set ticks per row (typically 6 for FT2 style).
   */
  setTicksPerRow(ticksPerRow: number): void {
    this.ticksPerRow = Math.max(1, ticksPerRow);
  }

  /**
   * Get current BPM.
   */
  getBpm(): number {
    return this.currentBpm;
  }

  /**
   * Get current speed.
   */
  getSpeed(): number {
    return this.currentSpeed;
  }

  /**
   * Get current ticks per row.
   */
  getTicksPerRow(): number {
    return this.ticksPerRow;
  }

  /**
   * Get the audio start time.
   */
  getAudioStartTime(): number {
    return this.audioStartTime;
  }

  /**
   * Get the position start row.
   */
  getPositionStartRow(): number {
    return this.positionStartRow;
  }

  /**
   * Get the sequence start offset rows.
   */
  getSequenceStartOffsetRows(): number {
    return this.sequenceStartOffsetRows;
  }
}
