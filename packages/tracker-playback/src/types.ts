export type TransportState = 'stopped' | 'playing' | 'paused';

export interface Song {
  title: string;
  author: string;
  bpm: number;
  pattern: Pattern;
}

export interface Pattern {
  id?: string;
  length: number; // rows
  tracks: Track[];
}

export interface Track {
  id: string;
  instrumentId?: string;
  steps: Step[];
}

export interface Step {
  row: number;
  note?: string;
  velocity?: number;
  instrumentId?: string;
  /**
   * Pre-parsed MIDI note number for the step. Optional so callers can
   * keep note strings but still provide a numeric value for scheduling.
   */
  midi?: number;
  /**
   * Marks this step as a note-off. When true, engines should release
   * any active notes for the given instrument (or the specific midi note
   * when provided).
   */
  isNoteOff?: boolean;
}

export interface PlaybackPosition {
  row: number;
  patternId?: string;
}

export interface PlaybackEventMap {
  position: PlaybackPosition;
  state: TransportState;
  error: Error;
}

export type PlaybackEvent = keyof PlaybackEventMap;

export type PlaybackListener<K extends PlaybackEvent> = (payload: PlaybackEventMap[K]) => void;

export interface PlaybackOptions {
  instrumentResolver?: InstrumentResolver;
  scheduler?: PlaybackScheduler;
  noteHandler?: PlaybackNoteHandler;
  /** Handler for scheduling notes at specific audio times */
  scheduledNoteHandler?: ScheduledNoteHandler;
  /** Audio context for getting current time */
  audioContext?: AudioContext;
}

export type InstrumentResolver = (instrumentId: string | undefined) => Promise<void> | void;

export interface PlaybackScheduler {
  start(tick: (deltaMs: number) => void): void;
  stop(): void;
}

export type PlaybackNoteEventType = 'noteOn' | 'noteOff';

export interface PlaybackNoteEvent {
  type: PlaybackNoteEventType;
  instrumentId?: string;
  midi?: number;
  velocity?: number;
  row: number;
  trackIndex: number;
}

export type PlaybackNoteHandler = (event: PlaybackNoteEvent) => void;

export interface ScheduledNoteEvent {
  type: PlaybackNoteEventType;
  instrumentId?: string;
  midi?: number;
  velocity?: number;
  row: number;
  trackIndex: number;
  /** Audio context time when this note should be triggered */
  time: number;
}

export type ScheduledNoteHandler = (event: ScheduledNoteEvent) => void;

export interface CancelScheduledHandler {
  (): void;
}
