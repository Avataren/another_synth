// Scheduled-event queue for TrackerSongBank.
//
// Extracted verbatim from song-bank.ts (P2, D95): pure queueing semantics
// only. The queue holds note-on/note-off events that were requested while the
// AudioContext was suspended or an instrument was not yet ready, and replays
// them through the bank's dispatch methods once flushing is possible.

export type PendingScheduledEvent =
  | {
      kind: 'noteOn';
      instrumentId: string;
      midi: number;
      velocity: number;
      time: number;
      trackIndex?: number;
      frequency?: number;
      pan?: number;
      /** Normalized 0-1 sample start offset (ProTracker 9xx). */
      sampleOffsetFrames?: number;
      /** Tick duration in seconds, for tick-timed instrument envelopes. */
      tickSeconds?: number;
      enqueuedAt: number;
    }
  | {
      kind: 'noteOff';
      instrumentId: string;
      midi?: number;
      time: number;
      trackIndex?: number;
      enqueuedAt: number;
    };

export const MIN_SCHEDULE_LEAD_SECONDS = 0.01;
const MAX_PENDING_SCHEDULED_EVENTS = 2048;

import type { ActiveInstrument } from './song-bank';

/** What the queue needs from the bank to replay an event. */
export interface ScheduledEventHost {
  readonly audioContext: AudioContext;
  readonly instruments: Map<string, ActiveInstrument>;
  dispatchNoteOnAtTime(
    instrumentId: string,
    midi: number,
    velocity: number,
    time: number,
    trackIndex?: number,
    frequency?: number,
    pan?: number,
    sampleOffsetFrames?: number,
    tickSeconds?: number,
  ): void;
  dispatchNoteOffAtTime(
    instrumentId: string,
    midi: number | undefined,
    time: number,
    trackIndex?: number,
  ): void;
}

export class ScheduledEventQueue {
  private events: PendingScheduledEvent[] = [];
  private flushing = false;

  constructor(private readonly host: ScheduledEventHost) {}

  enqueue(event: PendingScheduledEvent) {
    if (this.events.length >= MAX_PENDING_SCHEDULED_EVENTS) {
      // Drop the oldest to avoid unbounded growth
      this.events.shift();
      console.warn(
        '[SongBank] Pending scheduled event queue is full; dropping oldest event.',
      );
    }
    this.events.push(event);
  }

  getEnqueueTimestamp(): number {
    if (
      typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
    ) {
      return performance.now();
    }
    return Date.now();
  }

  async flushPendingScheduledEvents(instrumentId?: string): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const now = this.host.audioContext.currentTime;
      const remaining: PendingScheduledEvent[] = [];

      for (const event of this.events) {
        if (instrumentId && event.instrumentId !== instrumentId) {
          remaining.push(event);
          continue;
        }

        const active = this.host.instruments.get(event.instrumentId);
        const contextReady = this.host.audioContext.state === 'running';
        if (!active || !active.instrument.isReady || !contextReady) {
          remaining.push(event);
          continue;
        }

        const scheduledTime = Math.max(
          event.time,
          now + MIN_SCHEDULE_LEAD_SECONDS,
        );
        if (event.kind === 'noteOn') {
          this.host.dispatchNoteOnAtTime(
            event.instrumentId,
            event.midi,
            event.velocity,
            scheduledTime,
            event.trackIndex,
            event.frequency,
            event.pan,
            event.sampleOffsetFrames,
            event.tickSeconds,
          );
        } else {
          this.host.dispatchNoteOffAtTime(
            event.instrumentId,
            event.midi,
            scheduledTime,
            event.trackIndex,
          );
        }
      }

      this.events = remaining;
    } finally {
      this.flushing = false;
    }
  }
}
