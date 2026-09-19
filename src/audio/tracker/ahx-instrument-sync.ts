import type { AhxInstrumentEdit } from 'src/audio/tracker/ahx-source';

/**
 * Carries instrument edits to the worklets that already hold the song.
 *
 * An edit is committed to the song the moment it is made (the slot's `ahxData`
 * and the recorded edit in `ahx-source`); what this decides is only when the
 * *song player* is told. An edit that can reach another wave table costs it a
 * hi-fi re-prewarm (it walks the song to build the tables the new instrument
 * reaches, on the audio thread), and typing a number into a field is a burst of
 * edits, so the last edit of each instrument in a burst is sent, once the burst
 * has been quiet for `delayMs`. `flush` sends what is waiting at once: a play
 * must hear the edits made a moment before it.
 *
 * Nothing is lost by waiting or by a worklet that is not there: every load
 * applies all the recorded edits (`currentAhxInstrumentEdits`), so a worklet
 * made later starts with them.
 */
export class AhxInstrumentSync {
  private readonly waiting = new Map<number, Uint8Array>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    /** Sends one edit to every live worklet; a failure is the callee's to report. */
    private readonly send: (edit: AhxInstrumentEdit) => void,
    private readonly delayMs = 120,
  ) {}

  /** Queue an edit; a newer one for the same instrument replaces it. */
  push(edit: AhxInstrumentEdit): void {
    this.waiting.set(edit.instrument, edit.bytes);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** Send everything waiting, now. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const edits = [...this.waiting.entries()].sort(([a], [b]) => a - b);
    this.waiting.clear();
    for (const [instrument, bytes] of edits) this.send({ instrument, bytes });
  }

  /** Drop what is waiting without sending it (the song it belonged to is gone). */
  discard(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.waiting.clear();
  }

  get pending(): number {
    return this.waiting.size;
  }
}
