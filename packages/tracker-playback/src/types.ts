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
}

export type InstrumentResolver = (instrumentId: string | undefined) => Promise<void> | void;

export interface PlaybackScheduler {
  start(tick: (deltaMs: number) => void): void;
  stop(): void;
}
