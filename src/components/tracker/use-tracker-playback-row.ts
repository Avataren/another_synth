import type { InjectionKey, Ref } from 'vue';

/**
 * The row the sequencer is currently playing, or -1 when stopped.
 *
 * `TrackerPattern` provides it; `TrackerEntry` injects it to brighten just
 * that one row's cell text during playback. Going through provide/inject
 * (rather than a `playbackRow` prop threaded down through `TrackerTrack`)
 * keeps the per-tick cost to the two entry components whose "am I the
 * playing row?" answer actually flips — `TrackerTrack` never re-renders,
 * which is the whole point of the active-row bar.
 */
export const TRACKER_PLAYBACK_ROW: InjectionKey<Ref<number>> = Symbol('tracker-playback-row');
