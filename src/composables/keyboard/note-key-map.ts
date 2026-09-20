/**
 * The tracker's piano layout, by physical key (`KeyboardEvent.code`): two rows
 * of a piano, Z..M/S..J (C-3 up) under Q..P/2..0 (C-4 up), plus the punctuation
 * keys that continue each row. Values are MIDI notes at the default base
 * octave; shift them by a whole number of octaves for another one.
 *
 * Shared by the tracker's note entry and the AHX instrument editor's play
 * input, so the two pages always agree on which key is which note.
 *
 * `keyboardStore.keyMap` (the synth pages) is the same layout plus two keys,
 * pinned by `keyboard-note-maps.test.ts`: `Quote` (F#4) and `Backspace` (G#5),
 * which the tracker keeps for text and delete.
 */
export const TRACKER_NOTE_KEY_MAP: Readonly<Record<string, number>> = {
  KeyZ: 48,
  KeyS: 49,
  KeyX: 50,
  KeyD: 51,
  KeyC: 52,
  KeyV: 53,
  KeyG: 54,
  KeyB: 55,
  KeyH: 56,
  KeyN: 57,
  KeyJ: 58,
  KeyM: 59,
  Comma: 60,
  KeyL: 61,
  Period: 62,
  Semicolon: 63,
  Slash: 64,
  KeyQ: 60,
  Digit2: 61,
  KeyW: 62,
  Digit3: 63,
  KeyE: 64,
  KeyR: 65,
  Digit5: 66,
  KeyT: 67,
  Digit6: 68,
  KeyY: 69,
  Digit7: 70,
  KeyU: 71,
  KeyI: 72,
  Digit9: 73,
  KeyO: 74,
  Digit0: 75,
  KeyP: 76,
  BracketLeft: 77,
  Equal: 78,
  BracketRight: 79,
  Backslash: 81,
};

/** `<input>` types whose keys are letters and digits; a range, checkbox or button leaves them to the page. */
const TEXT_INPUT_TYPES = new Set([
  '', 'text', 'number', 'search', 'email', 'password', 'url', 'tel',
]);

/**
 * Whether `target` takes typed text, so that note keys must leave it alone.
 * Stricter than the tracker's "any input": a slider or a checkbox keeps focus
 * after it is used, and the editor is played while those are being edited.
 * A select is included: it uses letters to jump to an option.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((target as HTMLInputElement).type);
  return tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}
