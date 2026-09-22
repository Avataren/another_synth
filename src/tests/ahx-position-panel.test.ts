import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AhxPositionPanel from 'src/components/ahx/AhxPositionPanel.vue';
import TrackerTrack from 'src/components/tracker/TrackerTrack.vue';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const channels = [
  { track: 38, transpose: 0 },
  { track: 4, transpose: -2 },
  { track: 41, transpose: -3 },
  { track: 37, transpose: 5 },
];

const track = (name: string): TrackerTrackData => ({
  id: `t-${name}`,
  name,
  entries: [],
});

const trackProps = (transposeLabel?: string) => ({
  track: track('Main'),
  rowCount: 4,
  selectedRow: -1,
  index: 2,
  activeTrack: -1,
  activeColumn: -1,
  activeMacroNibble: 0,
  visibleStartRow: 0,
  visibleEndRow: 4,
  showExtraEffectColumn: false,
  transposeLabel,
});

// ---------------------------------------------------------------------------
// AhxPositionPanel (the position editor surface)
// ---------------------------------------------------------------------------

describe('AhxPositionPanel', () => {
  it('renders one transpose input per channel with the doc values', () => {
    const wrapper = mount(AhxPositionPanel, {
      props: { position: 41, channels },
    });
    const root = wrapper.get('[data-testid="ahx-position-panel"]');
    expect(root.attributes('data-position')).toBe('41');
    for (let ch = 0; ch < 4; ch++) {
      const input = wrapper.get(`[data-testid="ahx-pos-transpose-${ch}"]`);
      expect((input.element as HTMLInputElement).value).toBe(String(channels[ch]?.transpose));
      expect((input.element as HTMLInputElement).min).toBe('-128');
      expect((input.element as HTMLInputElement).max).toBe('127');
    }
  });

  it('shows the doc track numbers and the position number', () => {
    const wrapper = mount(AhxPositionPanel, { props: { position: 41, channels } });
    const text = wrapper.text();
    expect(text).toContain('Position 42');
    for (const ch of channels) expect(text).toContain(`track ${ch.track}`);
  });

  it('emits set-transpose with the channel index and clamped value', async () => {
    const wrapper = mount(AhxPositionPanel, { props: { position: 41, channels } });
    await wrapper.get('[data-testid="ahx-pos-transpose-2"]').setValue('-1');
    expect(wrapper.emitted('set-transpose')).toEqual([[2, -1]]);
  });

  it('uses native elements only (no q-* components, the export-dialog rule)', () => {
    const wrapper = mount(AhxPositionPanel, { props: { position: 41, channels } });
    expect(wrapper.findAllComponents('[class*="q-"]').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The grid badge (TrackerTrack header)
// ---------------------------------------------------------------------------

describe('TrackerTrack transpose badge', () => {
  it('renders the transpose label when given (T wording, zero included)', () => {
    for (const label of ['T0', 'T-1', 'T+3']) {
      const wrapper = mount(TrackerTrack, { props: trackProps(label) });
      const badge = wrapper.get('[data-testid="track-transpose-badge"]');
      expect(badge.text()).toBe(label);
    }
  });

  it('renders nothing (and no badge element) when absent — every non-AHX mount', () => {
    const wrapper = mount(TrackerTrack, { props: trackProps(undefined) });
    expect(wrapper.find('[data-testid="track-transpose-badge"]').exists()).toBe(false);
  });

  it('emits transposeBadgeClick with the track index on click (the hand-off)', async () => {
    const wrapper = mount(TrackerTrack, { props: trackProps('T-1') });
    await wrapper.get('[data-testid="track-transpose-badge"]').trigger('click');
    expect(wrapper.emitted('transposeBadgeClick')).toEqual([[2]]);
  });
});
