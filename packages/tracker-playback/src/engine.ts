import {
  type InstrumentResolver,
  type Pattern,
  type PlaybackEvent,
  type PlaybackEventMap,
  type PlaybackListener,
  type PlaybackOptions,
  type PlaybackPosition,
  type PlaybackScheduler,
  type Song,
  type TransportState
} from './types';
import { createAudioContextScheduler, IntervalScheduler } from './scheduler';

type ListenerMap = {
  [K in PlaybackEvent]: Set<PlaybackListener<K>>;
};

export class PlaybackEngine {
  private song: Song | null = null;
  private state: TransportState = 'stopped';
  private position: PlaybackPosition = { row: 0 };
  private bpm = 120;
  private length = 64;
  private readonly listeners: ListenerMap = {
    position: new Set(),
    state: new Set(),
    error: new Set()
  };
  private readonly resolver: InstrumentResolver | undefined;
  private readonly scheduler: PlaybackScheduler;
  private tickAccumulator = 0;

  constructor(options: PlaybackOptions = {}) {
    this.resolver = options.instrumentResolver;
    this.scheduler =
      options.scheduler ||
      createAudioContextScheduler() ||
      new IntervalScheduler();
  }

  loadSong(song: Song) {
    this.song = song;
    this.bpm = song.bpm;
    this.setPattern(song.pattern);
    this.emit('state', this.state);
  }

  setPattern(pattern: Pattern) {
    this.length = Math.max(1, pattern.length);
    this.position = pattern.id ? { row: 0, patternId: pattern.id } : { row: 0 };
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
    this.scheduler.start((deltaMs) => this.step(deltaMs));
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.scheduler.stop();
    this.emit('state', this.state);
  }

  stop() {
    this.state = 'stopped';
    this.scheduler.stop();
    this.position = { ...this.position, row: 0 };
    this.emit('state', this.state);
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

  private async prepareInstruments() {
    if (!this.resolver || !this.song) return;
    const trackInstrumentIds = this.song.pattern.tracks
      .map((t) => t.instrumentId ?? t.id)
      .filter(Boolean);
    for (const id of trackInstrumentIds) {
      try {
        await this.resolver(id);
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private step(deltaMs: number) {
    if (this.state !== 'playing') return;
    const msPerRow = (60_000 / this.bpm) || 0;
    this.tickAccumulator += deltaMs;

    while (this.tickAccumulator >= msPerRow && msPerRow > 0) {
      this.tickAccumulator -= msPerRow;
      const nextRow = (this.position.row + 1) % this.length;
      this.position = { ...this.position, row: nextRow };
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
}
