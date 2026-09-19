import { ahxNoteIndexFromMidi } from '@another-synth/tracker-playback';
import {
  createAhxPlayer,
  type AhxPlayerClient,
} from 'src/audio/tracker/ahx-player';
import type { AhxTransportHost } from 'src/audio/tracker/ahx-transport';

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

  constructor(
    private readonly host: AhxTransportHost & {
      /** Resumes a suspended context (a worklet cannot start on one); resolves whether it runs. */
      ensureAudioContextRunning?(): Promise<boolean>;
    },
    private readonly createPlayer: (
      ctx: AudioContext,
    ) => Promise<AhxPlayerClient> = createAhxPlayer,
  ) {}

  /** Whether a preview worklet currently exists (for tests and diagnostics). */
  get active(): boolean {
    return this.client !== null;
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

  /** Release whatever sounds (focus lost, song changed). */
  allNotesOff(): void {
    this.wanted = null;
    this.client?.previewNoteOff();
  }

  dispose(): void {
    this.disposed = true;
    this.wanted = null;
    this.disposeClient();
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
    await client.loadSong(bytes);
    this.loadedSource = bytes;
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
        this.client = client;
        return client;
      })
      .finally(() => {
        this.creating = null;
      });
    return this.creating;
  }

  private disposeClient(): void {
    this.client?.dispose();
    this.client = null;
    this.loadedSource = null;
  }
}
