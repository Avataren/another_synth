import { shallowRef, type ShallowRef } from 'vue';
import { Notify } from 'quasar';

/**
 * Problems with the audio an AHX song is playing that the user has to be told
 * of, because the editor and the sound have come apart: an instrument edit the
 * engine refused (at a load, or as a live replace), so that what the editor
 * shows is not what plays. The console is not where a musician looks.
 *
 * A notice is shown once (a toast) and stays listed (`ahxNotices`, which the
 * AHX instrument page shows) until the song changes (`clearAhxNotices`, called
 * when the current song's bytes change). The same message is not listed twice:
 * the song player and the keyboard preview both load the same edits, and
 * refuse the same ones.
 */
export const ahxNotices: ShallowRef<readonly string[]> = shallowRef([]);

/** The message a notice reported under an `id` is listed as, so that one notice can be cleared alone. */
const idMessages = new Map<string, string>();

/**
 * List `message` (once) and toast it. With an `id` the notice can later be
 * cleared on its own (`clearAhxNotice`); the others stay.
 */
export function reportAhxNotice(message: string, id?: string): void {
  if (id !== undefined) idMessages.set(id, message);
  if (ahxNotices.value.includes(message)) return;
  ahxNotices.value = [...ahxNotices.value, message];
  try {
    Notify.create({ type: 'warning', message, timeout: 8000 });
  } catch {
    // No Notify plugin installed (a bare test harness): the list is all there is.
  }
  // eslint-disable-next-line no-console
  console.warn(`[AHX] ${message}`);
}

export function clearAhxNotices(): void {
  idMessages.clear();
  if (ahxNotices.value.length > 0) ahxNotices.value = [];
}

/**
 * Remove the notice reported under `id`, and only that one: the reload that
 * made the editor and the sound agree again clears its own recovery notice,
 * while a rejected-instrument notice (a different problem) stays listed.
 */
export function clearAhxNotice(id: string): void {
  const message = idMessages.get(id);
  if (message === undefined) return;
  idMessages.delete(id);
  // Another id may have been reported with the very same text: it keeps it listed.
  if ([...idMessages.values()].includes(message)) return;
  ahxNotices.value = ahxNotices.value.filter((listed) => listed !== message);
}

/** The instruments a load's `rejectedInstruments` names, as one notice. */
export function reportRejectedAhxInstruments(instruments: readonly number[] | undefined, where: string): void {
  if (!instruments || instruments.length === 0) return;
  const list = instruments.map((n) => `#${n}`).join(', ');
  reportAhxNotice(
    `The ${where} did not accept the edit${instruments.length > 1 ? 's' : ''} of instrument ${list}: it plays as in the file, not as the editor shows.`,
  );
}
