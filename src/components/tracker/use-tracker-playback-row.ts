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

/**
 * Is a given playback buffer slot the visible one?
 *
 * `TRACKER_PLAYBACK_ROW` is provided once and reaches BOTH ping-pong buffer
 * slots, so without this an entry in the hidden upcoming-pattern buffer would
 * also match `row === playbackRow` and get `.row-playing` (invisible today
 * behind `opacity: 0`, but wrong — MINOR-3). `TrackerPattern` provides a
 * stable function that reads its reactive `activeSlot`; `TrackerEntry` gets
 * its slot as a static prop (`bufferSlot`, never changes per tick, so no
 * TrackerTrack re-render) and gates the class on it. Idle single-buffer mode
 * passes no slot and no provider, so the entry stays always-visible.
 */
export type TrackerBufferSlot = 'a' | 'b';
export const TRACKER_SLOT_VISIBLE: InjectionKey<(slot: TrackerBufferSlot) => boolean> =
  Symbol('tracker-slot-visible');
