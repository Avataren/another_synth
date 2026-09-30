import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ScopeWall from 'src/components/tracker/ScopeWall.vue';
import VisualizationPicker from 'src/components/VisualizationPicker.vue';
import { scopeWallGrid } from 'src/components/tracker/scope-wall-layout';
import {
  DEFAULT_VISUALIZATION_MODE,
  VISUALIZATION_MODES,
  sanitizeVisualizationMode,
} from 'src/components/tracker/visualization-modes';
import { defaultSettings, useUserSettingsStore } from 'src/stores/user-settings-store';

/**
 * The visualization picker and the scope wall it opens: the default stays the
 * original view, a stored value this build does not know cannot blank the
 * page, and the wall's grid gives every channel a scope in the box it is given.
 */

describe('visualization modes', () => {
  it('defaults to the original pattern view', () => {
    expect(DEFAULT_VISUALIZATION_MODE).toBe('pattern');
    expect(defaultSettings.visualizationMode).toBe('pattern');
  });

  it('lists the default first, and every mode once', () => {
    const ids = VISUALIZATION_MODES.map((mode) => mode.id);
    expect(ids[0]).toBe('pattern');
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('scopes');
    expect(ids).toContain('glow');
    expect(ids).toContain('crt');
    expect(ids).toContain('bloom');
    expect(ids).toContain('spikes');
    expect(ids).toContain('stereo');
    expect(ids).toContain('equalizer');
  });

  it('reads an unknown stored value as the default', () => {
    expect(sanitizeVisualizationMode('scopes')).toBe('scopes');
    expect(sanitizeVisualizationMode('waterfall-from-the-future')).toBe('pattern');
    expect(sanitizeVisualizationMode(undefined)).toBe('pattern');
    expect(sanitizeVisualizationMode(3)).toBe('pattern');
  });
});

describe('scopeWallGrid', () => {
  it('makes four channels a 2x2 unless the box is very short for its width', () => {
    expect(scopeWallGrid(4, 1920, 500)).toEqual({ columns: 2, rows: 2 });
    expect(scopeWallGrid(4, 1920, 300)).toEqual({ columns: 2, rows: 2 });
    expect(scopeWallGrid(4, 2560, 400)).toEqual({ columns: 2, rows: 2 });
    // Wider screens need more height before 2x2 beats a row: about width / 7.
    expect(scopeWallGrid(4, 2560, 300)).toEqual({ columns: 4, rows: 1 });
    expect(scopeWallGrid(4, 1600, 150)).toEqual({ columns: 4, rows: 1 });
  });

  it('spreads more channels into more columns as the box gets shorter', () => {
    expect(scopeWallGrid(8, 1600, 400)).toEqual({ columns: 3, rows: 3 });
    expect(scopeWallGrid(8, 1600, 200)).toEqual({ columns: 4, rows: 2 });
  });

  it('stacks scopes in a tall box', () => {
    expect(scopeWallGrid(4, 400, 1600)).toEqual({ columns: 1, rows: 4 });
  });

  it('always has a cell for every channel', () => {
    for (const count of [1, 3, 4, 5, 8, 18, 32]) {
      for (const [w, h] of [
        [1920, 900],
        [800, 600],
        [500, 1000],
        [0, 0],
      ] as const) {
        const { columns, rows } = scopeWallGrid(count, w, h);
        expect(columns * rows).toBeGreaterThanOrEqual(count);
        // No empty trailing row.
        expect((rows - 1) * columns).toBeLessThan(count);
      }
    }
  });

  it('does not fold 18 channels into a sliver', () => {
    const { columns, rows } = scopeWallGrid(18, 1600, 800);
    expect(columns).toBeGreaterThan(1);
    expect(rows).toBeGreaterThan(1);
  });

  it('copes with no channels', () => {
    expect(scopeWallGrid(0, 800, 600)).toEqual({ columns: 1, rows: 1 });
  });
});

describe('ScopeWall', () => {
  function mountWall(props: Record<string, unknown> = {}) {
    return mount(ScopeWall, {
      props: { trackCount: 4, audioNodes: {}, audioContext: null, ...props },
      global: { stubs: { TrackWaveform: { template: '<div class="track-waveform-stub" />' } } },
    });
  }

  it('draws one scope per channel', () => {
    const wrapper = mountWall({ trackCount: 6 });
    expect(wrapper.findAll('[data-testid="scope-wall-cell"]')).toHaveLength(6);
    expect(wrapper.findAll('.track-waveform-stub')).toHaveLength(6);
    wrapper.unmount();
  });

  it('dims the channels that are not audible', () => {
    const wrapper = mountWall({ isAudible: (channel: number) => channel !== 1 });
    const cells = wrapper.findAll('[data-testid="scope-wall-cell"]');
    expect(cells.map((cell) => cell.classes().includes('muted'))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    wrapper.unmount();
  });

  it('click mutes a channel and shift-click solos it', async () => {
    const wrapper = mountWall();
    const cells = wrapper.findAll('[data-testid="scope-wall-cell"]');
    await cells[2]!.trigger('click');
    await cells[3]!.trigger('click', { shiftKey: true });
    expect(wrapper.emitted('toggle-mute')).toEqual([[2]]);
    expect(wrapper.emitted('toggle-solo')).toEqual([[3]]);
    wrapper.unmount();
  });
});

describe('VisualizationPicker', () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  function mountPicker() {
    return mount(VisualizationPicker, {
      global: {
        stubs: {
          'q-icon': { template: '<span />' },
          'q-menu': { template: '<div><slot /></div>' },
          'q-list': { template: '<div><slot /></div>' },
          'q-item': {
            emits: ['click'],
            template: '<div @click="$emit(\'click\')"><slot /></div>',
          },
          'q-item-section': { template: '<span><slot /></span>' },
        },
        directives: { 'close-popup': {} },
      },
    });
  }

  it('shows the current mode and starts on the default', () => {
    const wrapper = mountPicker();
    expect(wrapper.find('.viz-picker-label').text()).toBe('Pattern');
    wrapper.unmount();
  });

  it('switches the shared setting when a mode is picked', async () => {
    const wrapper = mountPicker();
    await wrapper.find('[data-testid="visualization-option-scopes"]').trigger('click');
    expect(useUserSettingsStore().settings.visualizationMode).toBe('scopes');
    expect(wrapper.find('.viz-picker-label').text()).toBe('Scopes');
    wrapper.unmount();
  });

  it('shows the default for a stored mode it does not know', () => {
    localStorage.setItem('synth-user-settings', JSON.stringify({ visualizationMode: 'nope' }));
    setActivePinia(createPinia());
    const wrapper = mountPicker();
    expect(wrapper.find('.viz-picker-label').text()).toBe('Pattern');
    wrapper.unmount();
  });
});
