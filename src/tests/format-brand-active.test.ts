import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import type { AhxDoc } from 'src/audio/tracker/ahx-doc';
import { FORMAT_BRANDS } from 'src/branding/format-brands';
import { applyFormatBrand, FORMAT_THEME_VARS } from 'src/branding/format-theme';
import { useActiveFormatBrand, useFormatBrandTheme } from 'src/composables/useFormatBrand';
import { useTrackerStore } from 'src/stores/tracker-store';
import { buildSoundtrackerMod } from './helpers/mod-builder';
import FormatBadge from 'src/components/FormatBadge.vue';

/**
 * The active song decides the branding (.ai/plan-format-branding.md): the
 * store's format (and, for AHX, the variant; for MOD, where the file came
 * from) picks the brand, and the root's `--format-*` variables follow it on
 * every switch, with no reload.
 */

/** A one-pattern, 31-sample MOD with `signature` at offset 1080. */
function buildMod(signature: string, channels = 4): ArrayBuffer {
  const header = 1084;
  const bytes = new Uint8Array(header + 64 * channels * 4);
  const title = 'BRAND TEST';
  for (let i = 0; i < title.length; i++) bytes[i] = title.charCodeAt(i);
  bytes[950] = 1; // song length
  bytes[952] = 0; // order 0 -> pattern 0
  for (let i = 0; i < 4; i++) bytes[1080 + i] = signature.charCodeAt(i);
  return bytes.buffer;
}

/** The first bytes of an HVL file: enough for the header sniff. */
function hvlHeader(): Uint8Array {
  return new Uint8Array([0x48, 0x56, 0x4c, 0x01, 0, 0, 0, 0]);
}

const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name);

beforeEach(() => {
  setActivePinia(createPinia());
  setCurrentAhxSource(null);
});
afterEach(() => {
  setCurrentAhxSource(null);
  const root = document.documentElement;
  for (const name of FORMAT_THEME_VARS) root.style.removeProperty(name);
  root.removeAttribute('data-format');
});

describe('the MOD import keeps where the file came from', () => {
  it('stores the parser\'s flavor and signature on the song', () => {
    const song = importModToTrackerSong(buildMod('M.K.'));
    expect(song.data.modOrigin).toEqual({ flavor: 'ProTracker', signature: 'M.K.' });
    const st = importModToTrackerSong(buildSoundtrackerMod().buffer as ArrayBuffer);
    expect(st.data.modOrigin?.flavor).toMatch(/Soundtracker/);
    expect(importModToTrackerSong(buildMod('8CHN', 8)).data.modOrigin).toEqual({ flavor: 'ProTracker', signature: '8CHN' });
  });

  it('survives a save and a load, and a new song clears it', () => {
    const store = useTrackerStore();
    store.loadSongFile(importModToTrackerSong(buildMod('N.T.')));
    expect(store.modOrigin).toEqual({ flavor: 'NoiseTracker', signature: 'N.T.' });
    const saved = JSON.parse(JSON.stringify(store.serializeSong()));
    expect(saved.data.modOrigin).toEqual({ flavor: 'NoiseTracker', signature: 'N.T.' });
    store.resetToNewSong();
    expect(store.modOrigin).toBeNull();
    store.loadSongFile(saved);
    expect(store.modOrigin).toEqual({ flavor: 'NoiseTracker', signature: 'N.T.' });
  });

  it('is not written for any other format', () => {
    const store = useTrackerStore();
    store.resetToNewSong();
    expect(store.serializeSong().data.modOrigin).toBeUndefined();
  });
});

describe('useActiveFormatBrand', () => {
  it('follows the song: new song, MOD load, then a new song again', async () => {
    const store = useTrackerStore();
    const active = useActiveFormatBrand();
    expect(active.value.id).toBe('native');
    expect(active.value.variant).toBeNull();

    store.loadSongFile(importModToTrackerSong(buildMod('M.K.')));
    await nextTick();
    expect(active.value.id).toBe('mod');
    expect(active.value.brand).toBe(FORMAT_BRANDS.mod);
    expect(active.value.variant).toBe('ProTracker · M.K.');

    store.resetToNewSong();
    await nextTick();
    expect(active.value.id).toBe('native');
    expect(active.value.variant).toBeNull();
  });

  it('brands an AHX song by its doc, else by its source header', async () => {
    const store = useTrackerStore();
    const active = useActiveFormatBrand();
    store.moduleFormat = 'ahx';
    await nextTick();
    expect(active.value.id).toBe('ahx');

    // A read-only song (no doc): the header of its bytes decides.
    setCurrentAhxSource(hvlHeader());
    await nextTick();
    expect(active.value.id).toBe('hvl');

    // An editable one: the doc is the authority, over a stale header.
    store.ahxDoc = { format: 'ahx' } as unknown as AhxDoc;
    await nextTick();
    expect(active.value.id).toBe('ahx');
    store.ahxDoc = { format: 'hvl' } as unknown as AhxDoc;
    await nextTick();
    expect(active.value.id).toBe('hvl');
  });

  it('falls back to the native look for a format it does not know', async () => {
    const store = useTrackerStore();
    const active = useActiveFormatBrand();
    store.moduleFormat = 'it' as never;
    await nextTick();
    expect(active.value.id).toBe('native');
  });
});

describe('the format theme on the root', () => {
  it('sets only the format variables and the data-format attribute', () => {
    const root = document.documentElement;
    const before = Array.from(root.style).filter((name) => !name.startsWith('--format-'));
    const values = before.map((name) => root.style.getPropertyValue(name));
    applyFormatBrand('xm');
    expect(root.dataset.format).toBe('xm');
    expect(rootVar('--format-accent')).toBe(FORMAT_BRANDS.xm.palette.dark.accent);
    expect(rootVar('--format-accent-ink')).toBe(FORMAT_BRANDS.xm.palette.dark.accentInk);
    const after = Array.from(root.style).filter((name) => !name.startsWith('--format-'));
    expect(after).toEqual(before);
    expect(after.map((name) => root.style.getPropertyValue(name))).toEqual(values);
    // Pattern text stays the theme's: the layer never writes a tracker token.
    expect(Array.from(root.style).some((name) => name.startsWith('--tracker-'))).toBe(false);
  });

  it('switches with the song, with no reload', async () => {
    const store = useTrackerStore();
    const Host = { template: '<div />', setup: () => { useFormatBrandTheme(); } };
    const host = mount(Host);
    await nextTick();
    expect(document.documentElement.dataset.format).toBe('native');
    expect(rootVar('--format-accent')).toBe(FORMAT_BRANDS.native.palette.dark.accent);

    store.moduleFormat = 'sid';
    await nextTick();
    expect(document.documentElement.dataset.format).toBe('goat');
    expect(rootVar('--format-accent')).toBe(FORMAT_BRANDS.goat.palette.dark.accent);

    store.loadSongFile(importModToTrackerSong(buildMod('M.K.')));
    await nextTick();
    expect(document.documentElement.dataset.format).toBe('mod');

    store.resetToNewSong();
    await nextTick();
    expect(document.documentElement.dataset.format).toBe('native');
    host.unmount();
  });
});

describe('FormatBadge', () => {
  it('shows the brand\'s mark and label, names it for a screen reader, and scopes its colours', () => {
    const w = mount(FormatBadge, { props: { brand: 'hvl' } });
    const el = w.get('[data-testid="format-badge"]');
    expect(el.attributes('data-format')).toBe('hvl');
    expect(el.attributes('aria-label')).toBe('HivelyTracker HVL');
    expect(el.attributes('title')).toBe('HivelyTracker HVL');
    expect(el.findAll('svg')).toHaveLength(2);
    expect(el.attributes('style')).toContain(`--format-accent: ${FORMAT_BRANDS.hvl.palette.dark.accent}`);
  });

  it('adds the variant to its name', () => {
    const w = mount(FormatBadge, { props: { brand: 'mod', variant: 'ProTracker · M.K.' } });
    expect(w.get('[data-testid="format-badge"]').attributes('title')).toBe('Amiga MOD · ProTracker · M.K.');
  });

  it('can show the mark alone', () => {
    const w = mount(FormatBadge, { props: { brand: 'goat', markOnly: true } });
    expect(w.findAll('svg')).toHaveLength(1);
    expect(w.get('[data-testid="format-badge"]').attributes('aria-label')).toBe('GoatTracker (C64 SID)');
  });
});
