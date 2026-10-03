import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { ahxEditNotice, clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { useTrackerKeyboard } from 'src/composables/keyboard/useTrackerKeyboard';
import { TRACKER_NOTE_KEY_MAP } from 'src/composables/keyboard/note-key-map';
import type { TrackerKeyboardContext } from 'src/composables/keyboard/types';

function keyboard(over: { edit?: boolean; column?: number } = {}) {
  const context = {
    isEditMode: ref(over.edit ?? false),
    activeColumn: ref(over.column ?? 0),
    noteKeyMap: TRACKER_NOTE_KEY_MAP,
    handleNoteEntry: vi.fn(),
    ensureActiveInstrument: vi.fn(),
  } as unknown as TrackerKeyboardContext;
  return useTrackerKeyboard(context);
}

const press = (code: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { code, key: code, ...init });
  Object.defineProperty(event, 'target', { value: document.body });
  return event;
};

beforeEach(() => {
  clearAhxEditNotice();
});

describe('the edit-mode-off hint', () => {
  it('a note key with edit mode off says why nothing was written', () => {
    const { handleKeyDown } = keyboard();
    handleKeyDown(press('KeyZ'));
    expect(ahxEditNotice.value?.message).toMatch(/Edit mode is off.*F2/);
  });

  it('is shown once for a run of keys, not for each', () => {
    const { handleKeyDown } = keyboard();
    handleKeyDown(press('KeyX'));
    clearAhxEditNotice();
    handleKeyDown(press('KeyC'));
    expect(ahxEditNotice.value).toBeNull();
  });

  it('stays quiet with edit mode on, off the note column, for a held key and for a shortcut', () => {
    keyboard({ edit: true }).handleKeyDown(press('KeyV'));
    keyboard({ column: 1 }).handleKeyDown(press('KeyB'));
    keyboard().handleKeyDown(press('KeyN', { repeat: true }));
    keyboard().handleKeyDown(press('KeyM', { ctrlKey: true }));
    expect(ahxEditNotice.value).toBeNull();
  });
});
