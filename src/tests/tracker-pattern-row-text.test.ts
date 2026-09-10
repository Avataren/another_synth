import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import TrackerPattern from 'src/components/tracker/TrackerPattern.vue';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * The playing-row TEXT highlight (task: light up the actively playing row's
 * text — colour only, playing row only, during playback only).
 *
 * jsdom applies no scoped styles, so the colour rule itself is asserted by
 * source scan; the behaviour (which rows carry `.row-playing`, and when) is
 * asserted on the mounted grid.
 */

function makeTrack(id: string, rowCount = 8, note = 'C-4'): TrackerTrackData {
  return {
    id,
    name: `Track ${id}`,
    entries: Array.from({ length: rowCount }, (_, i) => ({ row: i, note })),
  };
}

function mountPattern(opts: {
  tracks?: TrackerTrackData[];
  rows?: number;
  isPlaying?: boolean;
  playbackRow?: number;
  playbackMode?: 'pattern' | 'song';
} = {}) {
  return mount(TrackerPattern, {
    props: {
      tracks: opts.tracks ?? [makeTrack('t0'), makeTrack('t1')],
      rows: opts.rows ?? 8,
      selectedRow: 0,
      playbackRow: opts.playbackRow ?? 0,
      activeTrack: -1,
      activeColumn: -1,
      autoScroll: false,
      isPlaying: opts.isPlaying ?? false,
      playbackMode: opts.playbackMode ?? 'pattern',
      activeMacroNibble: 0,
      selectionRect: null,
      scrollTop: 0,
      containerHeight: 400,
      isMouseSelecting: false,
      showExtraEffectColumn: false,
      reserveSideGutter: false,
      upcomingPattern: null,
    },
  });
}

describe('TrackerPattern playing-row text highlight', () => {
  it('adds .row-playing to no entry while stopped', () => {
    const wrapper = mountPattern({ isPlaying: false, playbackRow: 3 });
    expect(wrapper.findAll('.tracker-entry.row-playing')).toHaveLength(0);
    expect(wrapper.findAll('.row-number.row-playing')).toHaveLength(0);
    wrapper.unmount();
  });

  it('marks exactly the playing row — every track, plus the gutter digit — during playback', async () => {
    const wrapper = mountPattern({ isPlaying: true, playbackRow: 3 });
    await nextTick();

    const marked = wrapper.findAll('.tracker-entry.row-playing');
    // One per track (two tracks), and each sits on row 3.
    expect(marked).toHaveLength(2);
    for (const track of wrapper.findAll('.tracker-track')) {
      const rows = track.findAll('.tracker-entry');
      rows.forEach((entry, idx) => {
        expect(entry.classes().includes('row-playing')).toBe(idx === 3);
      });
    }

    const gutter = wrapper.findAll('.row-number.row-playing');
    expect(gutter).toHaveLength(1);
    expect(gutter[0]!.text()).toBe('03');
    wrapper.unmount();
  });

  it('moves the mark with playbackRow, without remounting entries', async () => {
    const wrapper = mountPattern({ isPlaying: true, playbackRow: 2 });
    await nextTick();

    const track0 = wrapper.findAll('.tracker-track')[0]!;
    const rowThreeEl = track0.findAll('.tracker-entry')[3]!.element;
    expect(track0.findAll('.tracker-entry')[2]!.classes()).toContain('row-playing');
    expect(track0.findAll('.tracker-entry')[3]!.classes()).not.toContain('row-playing');

    await wrapper.setProps({ playbackRow: 3 } as never);
    await nextTick();

    expect(track0.findAll('.tracker-entry')[2]!.classes()).not.toContain('row-playing');
    expect(track0.findAll('.tracker-entry')[3]!.classes()).toContain('row-playing');
    // Same DOM node — a class toggle, not a re-render/remount of the row.
    expect(track0.findAll('.tracker-entry')[3]!.element).toBe(rowThreeEl);
    wrapper.unmount();
  });

  it('drops every mark when playback stops', async () => {
    const wrapper = mountPattern({ isPlaying: true, playbackRow: 4 });
    await nextTick();
    expect(wrapper.findAll('.tracker-entry.row-playing').length).toBeGreaterThan(0);

    await wrapper.setProps({ isPlaying: false } as never);
    await nextTick();
    expect(wrapper.findAll('.tracker-entry.row-playing')).toHaveLength(0);
    expect(wrapper.findAll('.row-number.row-playing')).toHaveLength(0);
    wrapper.unmount();
  });

  it('leaves the active-row bar element exactly as it was (no fill/border change)', async () => {
    const stopped = mountPattern({ isPlaying: false, playbackRow: 3 });
    const barBefore = stopped.find('.active-row-bar').attributes('class');
    stopped.unmount();

    const playing = mountPattern({ isPlaying: true, playbackRow: 3 });
    await nextTick();
    // The bar keeps its single class; the highlight lives on the text, not here.
    expect(playing.find('.active-row-bar').attributes('class')).toBe(barBefore);
    playing.unmount();
  });
});

describe('playing-row text colour derives from a theme token', () => {
  const componentsDir = path.resolve(__dirname, '../components/tracker');
  const entrySrc = readFileSync(path.join(componentsDir, 'TrackerEntry.vue'), 'utf8');
  const patternSrc = readFileSync(path.join(componentsDir, 'TrackerPattern.vue'), 'utf8');

  it('TrackerEntry .row-playing rule uses var(--tracker-note-text), not a bare literal', () => {
    const rule = entrySrc
      .slice(entrySrc.indexOf('.tracker-entry.row-playing'))
      .split('}')[0]!;
    expect(rule).toMatch(/color:\s*var\(--tracker-note-text/);
    // No colour literal outside the var() fallback.
    expect(rule.replace(/var\([^)]*\)/g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb|hsl/);
  });

  it('TrackerPattern .row-number.row-playing rule uses the same token', () => {
    const rule = patternSrc
      .slice(patternSrc.indexOf('.row-number.row-playing'))
      .split('}')[0]!;
    expect(rule).toMatch(/color:\s*var\(--tracker-note-text/);
    expect(rule.replace(/var\([^)]*\)/g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb|hsl/);
  });
});
