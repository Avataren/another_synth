import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

import SidChipModelToggle from 'src/components/tracker/SidChipModelToggle.vue';
import { useTrackerStore } from 'src/stores/tracker-store';
import { decodeSidFile, serializeSidFile } from 'src/audio/tracker/sid-doc';
import { buildSidChainSong } from './helpers/sid-chain-song';

/**
 * plan-sid-tracking.md S5.7: the chip-model switcher. The player half (the
 * retag reaching a playing, paused or stopped worklet as a rebuilt player of
 * the new model) is pinned over the real wasm in `sid-playback-chain.test.ts`;
 * this file pins the toggle, the store's retag and that the choice is what a
 * save or export writes.
 */

/** Byte 5 of a SID song file: after the 'ASID' magic and the version. */
const CHIP_BYTE = 5;

beforeEach(() => {
  setActivePinia(createPinia());
});

describe('SidChipModelToggle', () => {
  it('shows both models, marks the song\'s one, and asks for the other only', async () => {
    const w = mount(SidChipModelToggle, { props: { model: '6581' } });
    const b8580 = w.get('[data-testid="sid-chip-8580"]');
    const b6581 = w.get('[data-testid="sid-chip-6581"]');
    expect(b6581.classes()).toContain('active');
    expect(b6581.attributes('aria-pressed')).toBe('true');
    expect(b8580.classes()).not.toContain('active');
    await b6581.trigger('click');
    expect(w.emitted('select')).toBeUndefined();
    await b8580.trigger('click');
    expect(w.emitted('select')).toEqual([['8580']]);
  });

  it('disabled while a song loads', () => {
    const w = mount(SidChipModelToggle, { props: { model: '8580', disabled: true } });
    expect(w.get('[data-testid="sid-chip-6581"]').attributes('disabled')).toBeDefined();
  });
});

describe('the store\'s chip retag', () => {
  it('retags the doc (undoably) and a save and a file export carry the new model', () => {
    const store = useTrackerStore();
    store.initializeIfNeeded();
    store.adoptSidDoc(buildSidChainSong());
    expect(store.sidDoc?.chipModel).toBe('6581');
    expect(serializeSidFile(store.sidDoc!)[CHIP_BYTE]).toBe(1);
    const revision = store.sidRevision;

    expect(store.setSidChip('8580')).toBe(true);
    expect(store.sidDoc?.chipModel).toBe('8580');
    // The playback store reloads a playing song on this revision.
    expect(store.sidRevision).toBeGreaterThan(revision);
    // The SID file (what the worklet and an export are given): code 0 = 8580.
    expect(serializeSidFile(store.sidDoc!)[CHIP_BYTE]).toBe(0);
    // The .cmod save embeds that file.
    const saved = decodeSidFile(store.serializeSong().data.sidFile);
    expect(saved.ok && saved.doc.chipModel).toBe('8580');
    expect(saved.ok && saved.bytes[CHIP_BYTE]).toBe(0);

    // Same model again: no edit, no undo step.
    expect(store.setSidChip('8580')).toBe(false);
    store.undo();
    expect(store.sidDoc?.chipModel).toBe('6581');
  });

  it('a song that is not SID has no chip to retag', () => {
    const store = useTrackerStore();
    store.initializeIfNeeded();
    expect(store.setSidChip('6581')).toBe(false);
  });
});

describe('TrackerPage shows the toggle in both layouts, for a SID song only', () => {
  const src = readFileSync(resolve(__dirname, '../pages/TrackerPage.vue'), 'utf8');
  it('beside the transport in the phone strip and in the desktop song panel', () => {
    const toggles = src.match(/<SidChipModelToggle[\s\S]*?\/>/g) ?? [];
    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle).toContain('v-if="sidChipModel"');
      expect(toggle).toContain('@select="onSidChipSelect"');
    }
    // The phone one sits in the strip, right after Stop (before the panel chips).
    const strip = src.slice(src.indexOf('class="toolbar-strip"'), src.indexOf('v-for="panel in MOBILE_PANELS"'));
    expect(strip).toContain('<SidChipModelToggle');
    // The desktop one sits in the song panel's transport controls.
    const transport = src.slice(src.indexOf('class="transport-controls"'), src.indexOf('class="volume-control"'));
    expect(transport).toContain('<SidChipModelToggle');
    // `null` (no toggle) for any song that is not SID.
    expect(src).toMatch(/const sidChipModel = computed\(\(\) => \(isSidSong\.value \? trackerStore\.sidDoc\?\.chipModel \?\? null : null\)\)/);
  });
});
