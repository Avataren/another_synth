import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import TrackerPattern from 'src/components/tracker/TrackerPattern.vue';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * The playback double-buffer contract:
 *
 * - idle: one grid, as before (no second buffer rendered).
 * - playing with an upcoming pattern: BOTH buffer grids are mounted; the
 *   hidden one already renders the upcoming pattern while the visible one
 *   still shows the old one. This is the whole point -- the upcoming grid
 *   is rasterized before the swap.
 * - pattern swap: visibility flips atomically via a single active-slot
 *   variable; the old grid stays in the DOM (no unmount/mount).
 * - per-buffer rows: heights and virtual ranges are computed per buffer.
 *
 * jsdom cannot rasterize, so "no blank frame" is asserted structurally:
 * both grids present, visibility class only toggles, DOM nodes persist.
 */

function makeTrack(id: string, rowCount = 8, note = 'C-4'): TrackerTrackData {
  return {
    id,
    name: `Track ${id}`,
    entries: Array.from({ length: rowCount }, (_, i) => ({ row: i, note })),
  };
}

interface MountOptions {
  tracks?: TrackerTrackData[];
  rows?: number;
  isPlaying?: boolean;
  upcomingPattern?: { id: string; tracks: TrackerTrackData[]; rows: number } | null;
}

function mountPattern(opts: MountOptions = {}) {
  return mount(TrackerPattern, {
    props: {
      tracks: opts.tracks ?? [makeTrack('t0')],
      rows: opts.rows ?? 8,
      selectedRow: 0,
      playbackRow: 0,
      activeTrack: -1,
      activeColumn: -1,
      autoScroll: false,
      isPlaying: opts.isPlaying ?? false,
      playbackMode: 'pattern',
      activeMacroNibble: 0,
      selectionRect: null,
      scrollTop: 0,
      containerHeight: 400,
      isMouseSelecting: false,
      showExtraEffectColumn: false,
      reserveSideGutter: false,
      upcomingPattern: opts.upcomingPattern ?? null,
    },
  });
}

describe('TrackerPattern buffering', () => {
  it('renders a single grid when not playing', () => {
    const wrapper = mountPattern({ isPlaying: false });
    expect(wrapper.findAll('.pattern-buffer')).toHaveLength(0);
    expect(wrapper.findAll('.tracker-track')).toHaveLength(1);
    wrapper.unmount();
  });

  it('mounts both buffers when playing with an upcoming pattern', async () => {
    const oldTracks = [makeTrack('old')];
    const upcoming = {
      id: 'p1',
      tracks: [makeTrack('new', 8, 'D-4')],
      rows: 8,
    };
    const wrapper = mountPattern({ isPlaying: true, tracks: oldTracks });
    await wrapper.setProps({ upcomingPattern: upcoming });
    await nextTick();

    const buffers = wrapper.findAll('.pattern-buffer');
    expect(buffers).toHaveLength(2);

    // Hidden buffer pre-renders the upcoming pattern; visible still shows old.
    const hidden = buffers.find((b) => b.classes().includes('buffer-hidden'))!;
    const visible = buffers.find((b) => !b.classes().includes('buffer-hidden'))!;
    expect(hidden.attributes('aria-hidden')).toBe('true');
    expect(visible.attributes('aria-hidden')).toBe('false');
    expect(hidden.text()).toContain('D-4');
    expect(visible.text()).not.toContain('D-4');
    wrapper.unmount();
  });

  it('flips atomically on pattern swap without unmounting the grid', async () => {
    const oldTracks = [makeTrack('old', 8, 'C-4')];
    const newTracks = [makeTrack('new', 8, 'D-4')];
    const upcoming = { id: 'p1', tracks: newTracks, rows: 8 };

    const wrapper = mountPattern({ isPlaying: true, tracks: oldTracks });
    await wrapper.setProps({ upcomingPattern: upcoming });
    await nextTick();

    const buffersBefore = wrapper.findAll('.pattern-buffer');
    const visibleBefore = buffersBefore.find((b) => !b.classes().includes('buffer-hidden'))!;
    const hiddenBefore = buffersBefore.find((b) => b.classes().includes('buffer-hidden'))!;
    expect(visibleBefore.text()).toContain('C-4');
    expect(hiddenBefore.text()).toContain('D-4'); // pre-rendered upcoming

    // Parent swaps patterns: the tracks prop now carries what the hidden
    // buffer pre-rendered. The visible grid's DOM node must persist; only
    // the visibility class moves.
    await wrapper.setProps({ tracks: newTracks });
    await nextTick();

    const buffers = wrapper.findAll('.pattern-buffer');
    expect(buffers).toHaveLength(2); // no unmount/remount of the pair

    const visibleAfter = buffers.find((b) => !b.classes().includes('buffer-hidden'))!;
    expect(visibleAfter.text()).toContain('D-4');
    // Same DOM node persists across the flip (only visibility moved): the
    // pre-rendered hidden buffer became the visible one.
    expect(visibleAfter.element).toBe(hiddenBefore.element);

    const hiddenAfter = buffers.find((b) => b.classes().includes('buffer-hidden'))!;
    expect(hiddenAfter.attributes('aria-hidden')).toBe('true');
    wrapper.unmount();
  });

  it('keeps per-buffer row heights when patterns differ in length', async () => {
    const oldTracks = [makeTrack('old', 8)];
    const upcoming = { id: 'p1', tracks: [makeTrack('new', 32)], rows: 32 };
    const wrapper = mountPattern({ isPlaying: true, tracks: oldTracks, rows: 8 });
    await wrapper.setProps({ upcomingPattern: upcoming });
    await nextTick();

    const buffers = wrapper.findAll('.pattern-buffer');
    expect(buffers).toHaveLength(2);
    const hidden = buffers.find((b) => b.classes().includes('buffer-hidden'))!;
    // 32 rows * (30px height + 6px gap) = 1152
    const container = hidden.find('.row-numbers-container');
    expect(container.attributes('style')).toContain('1152px');
    wrapper.unmount();
  });

  it('syncs a direct pattern jump into the visible buffer without flipping', async () => {
    const oldTracks = [makeTrack('old', 8, 'C-4')];
    const jumpTracks = [makeTrack('jump', 8, 'E-4')];
    const wrapper = mountPattern({ isPlaying: true, tracks: oldTracks });
    await nextTick();

    // No upcoming pre-rendered: the swap is a direct jump, the visible
    // buffer updates in place. Still no unmount (same component instance).
    await wrapper.setProps({ tracks: jumpTracks });
    await nextTick();

    const buffers = wrapper.findAll('.pattern-buffer');
    expect(buffers).toHaveLength(2);
    const visible = buffers.find((b) => !b.classes().includes('buffer-hidden'))!;
    expect(visible.text()).toContain('E-4');
    wrapper.unmount();
  });

  it('falls back to single-buffer behavior when upcoming is null while playing', async () => {
    const wrapper = mountPattern({ isPlaying: true, tracks: [makeTrack('t0')] });
    await nextTick();
    // Playing without an upcoming pattern: hidden buffer stays empty.
    const buffers = wrapper.findAll('.pattern-buffer');
    expect(buffers).toHaveLength(2);
    const hidden = buffers.find((b) => b.classes().includes('buffer-hidden'))!;
    expect(hidden.findAll('.tracker-track')).toHaveLength(0);
    wrapper.unmount();
  });
});

describe('TrackerTrack stable keys', () => {
  it('patches entries in place when pattern data swaps', async () => {
    const TrackerTrack = (await import('src/components/tracker/TrackerTrack.vue')).default;
    const trackA = makeTrack('any', 8, 'C-4');
    const wrapper = mount(TrackerTrack, {
      props: {
        track: trackA,
        rowCount: 8,
        selectedRow: -1,
        index: 0,
        activeTrack: -1,
        activeColumn: -1,
        activeMacroNibble: 0,
        selectionRect: null,
        visibleStartRow: 0,
        visibleEndRow: 7,
        showExtraEffectColumn: false,
      },
    });

    const firstEntry = wrapper.find('.tracker-entry').element;
    // Different track id, same row numbers: the entry DOM must persist
    // (rows keyed by row number, not track.id-row).
    const trackB = makeTrack('different-id', 8, 'D-4');
    await wrapper.setProps({ track: trackB });
    await nextTick();

    expect(wrapper.find('.tracker-entry').element).toBe(firstEntry);
    expect(wrapper.text()).toContain('D-4');
    wrapper.unmount();
  });
});
