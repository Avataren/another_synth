import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import JukeboxPanel from 'src/components/tracker/JukeboxPanel.vue';
import { FORMAT_BRANDS } from 'src/branding/format-brands';
import type { JukeboxEntry } from 'src/stores/jukebox-store';

/**
 * The jukebox panel brands what it shows from each entry's own index label
 * (.ai/plan-format-branding.md): a queued song is not the store's song yet.
 */

const stubs = { QMenu: true, QList: true, QItem: true, QItemSection: true, QIcon: true };

function entry(file: string, format: string): JukeboxEntry {
  return { file, url: `demos/${file}`, title: file, format, channels: 4, bytes: 2048 };
}

function mountPanel(current: JukeboxEntry | null, entries: JukeboxEntry[]) {
  return mount(JukeboxPanel, {
    props: {
      entries,
      visibleEntries: entries.map((e, index) => ({ entry: e, index })),
      filter: '',
      currentIndex: current ? entries.indexOf(current) : -1,
      current,
      hasEntries: entries.length > 0,
      isPlaying: true,
      repeat: false,
      busy: false,
      playlistSources: [],
    },
    global: { stubs },
  });
}

beforeEach(() => setActivePinia(createPinia()));

describe('JukeboxPanel branding', () => {
  it('brands the current entry and scopes its accent on the now-playing block', () => {
    const hvl = entry('ahx/cyberfunk.hvl', 'HVL');
    const w = mountPanel(hvl, [hvl, entry('goat/streets.sng', 'GT1')]);
    expect(w.get('[data-testid="jukebox-panel-format"]').attributes('data-format')).toBe('hvl');
    expect(w.get('.now-playing').attributes('style')).toContain(`--format-accent: ${FORMAT_BRANDS.hvl.palette.dark.accent}`);
  });

  it('marks every playlist row with its own format', () => {
    const entries = [entry('a.mod', 'MOD'), entry('b.xm', 'XM'), entry('c.sng', 'GT2'), entry('d.it', 'IT')];
    const w = mountPanel(entries[0]!, entries);
    const rows = w.findAll('.playlist-item [data-testid="format-badge"]');
    expect(rows.map((r) => r.attributes('data-format'))).toEqual(['mod', 'xm', 'goat', 'native']);
  });

  it('shows no badge and no accent when nothing is queued', () => {
    const w = mountPanel(null, []);
    expect(w.find('[data-testid="jukebox-panel-format"]').exists()).toBe(false);
    expect(w.get('.now-playing').attributes('style')).toBeUndefined();
  });
});
