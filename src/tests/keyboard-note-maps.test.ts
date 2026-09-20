// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { TRACKER_NOTE_KEY_MAP } from 'src/composables/keyboard/note-key-map';
import { useKeyboardStore } from 'src/stores/keyboard-store';

/**
 * Two key maps exist (the tracker's shared `TRACKER_NOTE_KEY_MAP` and the
 * keyboard store's `keyMap`, which the tracker's live preview is fed from).
 * They must agree on every key they share, and their known differences are
 * written down in both files: change one, and this says so.
 */
describe('note key maps', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('give every key of the tracker map the same note in the store map', () => {
    const storeMap = useKeyboardStore().keyMap;
    for (const [code, note] of Object.entries(TRACKER_NOTE_KEY_MAP)) {
      expect(storeMap[code], code).toBe(note);
    }
  });

  it('differ only by Quote and Backspace, which are notes in the store map alone', () => {
    const trackerCodes = new Set(Object.keys(TRACKER_NOTE_KEY_MAP));
    const extra = Object.keys(useKeyboardStore().keyMap).filter((code) => !trackerCodes.has(code));
    expect(extra.sort()).toEqual(['Backspace', 'Quote']);
  });
});
