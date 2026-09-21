import { ahxNoteIndexFromMidi } from '@another-synth/tracker-playback';
import {
  createAhxPlayer,
  type AhxPListRow,
  type AhxPlayerClient,
} from 'src/audio/tracker/ahx-player';
import type { AhxTransportHost } from 'src/audio/tracker/ahx-transport';
import { currentAhxInstrumentEdits, type AhxInstrumentEdit } from 'src/audio/tracker/ahx-source';

/**
 * Playing an AHX song's instruments from the keyboard.
 *
 * The song's own worklet (`AhxTransport`) runs the file's transport and cannot
 * be played by hand, and must not be disturbed by someone trying an
 * instrument. So the preview is a second worklet node running its own engine
 * instance in live mode (`AhxPlayer.enable_preview`): the same bytes, so the
 * same instruments, waveforms and PList, but one mono voice driven by
 * note-on / note-off. The song can play, pause or be replaced without it
 * noticing.
 *
 * It is created ahead of the first key, by `preload` (an AHX slot is selected,
 * an AHX song loads), so that the first key sounds at once instead of paying
 * for a worklet, a wasm instance and a song load. It then stays for as long as
 * that song does: there is no idle timeout, and the owner disposes it when the
 * song changes or is unloaded. (The note-on itself still prewarms the pressed
 * instrument's hi-fi tables in the worklet's message handler; see `hifi.rs`.)
 *
 * Routed like the song: into the song bank's mix bus, so the master volume,
 * post-fx rack, meters and recorder treat it like any other sound.
 *
 * Monophonic, last key wins: a note-off only releases the note that is
 * sounding, so letting go of an earlier key while a later one is down does not
 * cut it.
 */
export class AhxPreview {
  private client: AhxPlayerClient | null = null;
  private creating: Promise<AhxPlayerClient> | null = null;
  private loadedSource: Uint8Array | null = null;
  private loading: { bytes: Uint8Array; promise: Promise<AhxPlayerClient | null> } | null = null;
  /** The key that should be sounding: set at note-on, cleared by its note-off. */
  private wanted: { midi: number } | null = null;
  private disposed = false;
  /** Kept here, not on a client, so subscribing creates nothing and a client made later (or replaced) gets them. */
  private readonly plistRowListeners = new Set<(r: AhxPListRow) => void>();
  private clientUnsubs: Array<() => void> = [];

  constructor(
    private readonly host: AhxTransportHost & {
      /** Resumes a suspended context (a worklet cannot start on one); resolves whether it runs. */
      ensureAudioContextRunning?(): Promise<boolean>;
    },
    private readonly createPlayer: (
      ctx: AudioContext,
    ) => Promise<AhxPlayerClient> = createAhxPlayer,
    /** The instrument edits a load applies on top of the file's own bytes. */
    private readonly editsToApply: () => readonly AhxInstrumentEdit[] = currentAhxInstrumentEdits,
    /** Told the instruments (1-based) of the edits a load applied that the engine refused, when there were any. */
    private readonly onRejectedEdits?: (instruments: number[]) => void,
  ) {}

  /** Whether a preview worklet currently exists (for tests and diagnostics). */
  get active(): boolean {
    return this.client !== null;
  }

  /**
   * The PList row the sounding preview note is on, each time it changes, and
   * `{ instrument: 0, row: -1 }` when the note is over (or its worklet goes).
   * Lazy: subscribing does not create the worklet (`preload` and the first key
   * do), and a listener stays through the worklet being replaced.
   */
  onPListRow(listener: (r: AhxPListRow) => void): () => void {
    this.plistRowListeners.add(listener);
    return () => this.plistRowListeners.delete(listener);
  }

  /**
   * Get the worklet created and the song `bytes` loaded, ahead of the first
   * key. Resolves when it is ready to be played (or has failed; the failure is
   * logged and the first key tries again). Does not resume a suspended
   * context: a key does, and shares this load when it arrives.
   */
  async preload(bytes: Uint8Array): Promise<void> {
    if (this.disposed) return;
    try {
      await this.ready(bytes);
    } catch (error) {
      if (!this.disposed) console.warn('[AhxPreview] could not prepare the preview voice', error);
    }
  }

  /**
   * Sound `instrument` (1-based; the file's own numbering) of the song `bytes`
   * at `midi`. Resolves once the note has been handed to the worklet, or
   * without playing if its key was released (or another pressed) while the
   * worklet was still starting.
   */
  async noteOn(
    bytes: Uint8Array,
    instrument: number,
    midi: number,
    velocity = 127,
  ): Promise<void> {
    const note = ahxNoteIndexFromMidi(midi);
    if (note === undefined || this.disposed) return;
    const key = { midi };
    this.wanted = key;
    let client: AhxPlayerClient | null;
    try {
      // `wanted` is already set: a key-up that lands during any of these
      // awaits is seen when they are over.
      await this.host.ensureAudioContextRunning?.();
      client = await this.ready(bytes);
    } catch (error) {
      console.warn('[AhxPreview] could not start the preview voice', error);
      return;
    }
    if (!client || this.wanted !== key) return;
    client.previewNoteOn(instrument, note, Math.max(0, Math.min(127, Math.round(velocity))));
  }

  /** Key up: releases the note if it is the one sounding. */
  noteOff(midi: number): void {
    if (this.wanted?.midi !== midi) return;
    this.wanted = null;
    this.client?.previewNoteOff();
  }

  /**
   * The song's instrument `instrument` was edited: the preview worklet swaps it
   * in (the same song data the song player plays), so the next key on it sounds
   * the edit without a reload, and forgets the hi-fi tables it prewarmed for the
   * old one (the next note-on prewarms the new one, in the worklet's message
   * handler). A note already sounding carries on with what its trigger copied,
   * and picks up PList and envelope changes at once. Resolves at once with no
   * worklet yet (its load applies every edit).
   */
  replaceInstrument(instrument: number, bytes: Uint8Array): Promise<void> {
    return this.client ? this.client.replaceInstrument(instrument, bytes) : Promise.resolve();
  }

  /** Release whatever sounds (focus lost, song changed). */
  allNotesOff(): void {
    this.wanted = null;
    this.client?.previewNoteOff();
  }

  dispose(): void {
    this.disposed = true;
    this.wanted = null;
    this.disposeClient();
    this.plistRowListeners.clear();
  }

  private ready(bytes: Uint8Array): Promise<AhxPlayerClient | null> {
    if (this.client && this.loadedSource === bytes) return Promise.resolve(this.client);
    if (this.loading?.bytes === bytes) return this.loading.promise;
    const promise = this.prepare(bytes);
    const entry = { bytes, promise };
    this.loading = entry;
    const clear = () => {
      if (this.loading === entry) this.loading = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  private async prepare(bytes: Uint8Array): Promise<AhxPlayerClient | null> {
    if (this.client && this.client.audioContext !== this.host.audioContext) {
      this.disposeClient();
    }
    const client = await this.ensureClient();
    if (this.loadedSource === bytes) return client;
    this.loadedSource = null;
    const info = await client.loadSong(bytes, 2, this.editsToApply());
    this.loadedSource = bytes;
    if (info.rejectedInstruments && info.rejectedInstruments.length > 0) {
      this.onRejectedEdits?.(info.rejectedInstruments);
    }
    return this.disposed ? null : client;
  }

  private ensureClient(): Promise<AhxPlayerClient> {
    if (this.client) return Promise.resolve(this.client);
    this.creating ??= this.createPlayer(this.host.audioContext)
      .then((client) => {
        if (this.disposed) {
          client.dispose();
          throw new Error('AHX preview disposed');
        }
        client.output.connect(this.host.output);
        // Before the load: the worklet puts the song in preview mode as it
        // loads it, and (hi-fi on) leaves the band-limited tables to each
        // note-on's prewarm rather than walking a song that is never played.
        client.setPreview(true);
        client.setHifi(true);
        this.clientUnsubs = [
          client.onPListRow((r) => {
            for (const listener of this.plistRowListeners) listener(r);
          }),
        ];
        this.client = client;
        return client;
      })
      .finally(() => {
        this.creating = null;
      });
    return this.creating;
  }

  private disposeClient(): void {
    for (const unsubscribe of this.clientUnsubs) unsubscribe();
    this.clientUnsubs = [];
    // The worklet that reported a row is gone, and with it the note.
    if (this.client) for (const listener of this.plistRowListeners) listener({ instrument: 0, row: -1 });
    this.client?.dispose();
    this.client = null;
    this.loadedSource = null;
  }
}
