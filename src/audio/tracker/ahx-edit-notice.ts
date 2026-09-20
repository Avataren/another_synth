import { shallowRef, type ShallowRef } from 'vue';

/**
 * The status line of an AHX edit: what a refused keystroke or bulk edit says.
 *
 * Not `ahx-notices.ts`: that list dedupes identical messages and is cleared
 * only when the song's bytes change, which is right for "the engine and the
 * editor have come apart" and wrong for feedback on a keystroke (a repeated
 * refusal must show again, and edit notices must not pile up beside the real
 * ones). Every report here is a fresh object with a new `id`, so an identical
 * message re-triggers the status line; it clears itself after a few seconds,
 * on the next successful edit and on a song change.
 */
export interface AhxEditNotice {
  readonly id: number;
  readonly message: string;
}

/** How long a notice stays before it clears itself. */
export const AHX_EDIT_NOTICE_MS = 4000;

export const ahxEditNotice: ShallowRef<AhxEditNotice | null> = shallowRef(null);

let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;

function stopTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

export function reportAhxEditNotice(message: string): void {
  stopTimer();
  ahxEditNotice.value = { id: nextId++, message };
  timer = setTimeout(clearAhxEditNotice, AHX_EDIT_NOTICE_MS);
  // A pending notice must not keep a node process (a test run) alive.
  (timer as { unref?: () => void }).unref?.();
}

export function clearAhxEditNotice(): void {
  stopTimer();
  ahxEditNotice.value = null;
}
