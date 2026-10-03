import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { sidGridHarness as harness } from './helpers/sid-grid-harness';

/**
 * Typing a slot number in the instrument column (column 1): two decimal
 * digits, the typed instrument becomes the active one, and a number with no
 * slot is ignored. Driven through the SID grid harness (the real store and
 * editing composable), whose chain song has 4 instruments.
 */

beforeEach(() => {
  setActivePinia(createPinia());
  clearAhxEditNotice();
});
afterEach(() => {
  clearAhxEditNotice();
});

describe('the instrument column takes a typed slot number', () => {
  it('0 then 3 writes instrument 03, makes it active and moves to the next row', () => {
    const h = harness();
    h.at(0, 0, 4, 1);
    h.editing.handleInstrumentInput('0');
    h.editing.handleInstrumentInput('3');
    expect(h.entryAt(0, 0, 4)?.instrument).toBe('03');
    expect(h.activeInstrumentId.value).toBe('03');
    // The next note inherits it.
    h.at(0, 0, 5, 0);
    h.editing.handleNoteEntry(60);
    expect(h.entryAt(0, 0, 5)?.instrument).toBe('03');
  });

  it('a lone digit that names a slot is written at once', () => {
    const h = harness();
    h.at(0, 0, 4, 1);
    h.editing.handleInstrumentInput('2');
    expect(h.entryAt(0, 0, 4)?.instrument).toBe('02');
    expect(h.activeInstrumentId.value).toBe('02');
  });

  it('a number with no slot is ignored and leaves no history step', () => {
    const h = harness();
    h.at(0, 0, 4, 1);
    h.editing.handleInstrumentInput('9');
    expect(h.entryAt(0, 0, 4)).toBeUndefined();
    expect(h.activeInstrumentId.value).toBe('01');
    expect(h.store.undoStack).toHaveLength(0);
  });

  it('is ignored outside the instrument column', () => {
    const h = harness();
    h.at(0, 0, 4, 0);
    h.editing.handleInstrumentInput('2');
    expect(h.entryAt(0, 0, 4)).toBeUndefined();
  });

  it('a first digit does not carry over to another row', () => {
    const h = harness();
    h.at(0, 0, 4, 1);
    h.editing.handleInstrumentInput('0');
    h.at(0, 0, 8, 1);
    h.editing.handleInstrumentInput('3');
    expect(h.entryAt(0, 0, 8)?.instrument).toBe('03');
  });
});

describe('Alt+Up / Alt+Down step the active slot', () => {
  it('moves through the filled slots and stops at the ends', () => {
    const h = harness();
    h.activeInstrumentId.value = '01';
    h.editing.stepActiveInstrument(-1);
    expect(h.activeInstrumentId.value).toBe('01');
    h.editing.stepActiveInstrument(1);
    expect(h.activeInstrumentId.value).toBe('02');
    h.editing.stepActiveInstrument(1);
    h.editing.stepActiveInstrument(1);
    h.editing.stepActiveInstrument(1);
    expect(h.activeInstrumentId.value).toBe('04');
    h.editing.stepActiveInstrument(-1);
    expect(h.activeInstrumentId.value).toBe('03');
  });
});
