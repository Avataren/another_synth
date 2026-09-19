import { ahxNoteIndexFromMidi } from '@another-synth/tracker-playback';
import {
  createAhxPlayer,
  type AhxPlayerClient,
} from 'src/audio/tracker/ahx-player';
import type { AhxTransportHost } from 'src/audio/tracker/ahx-transport';

/** How long an idle preview keeps its worklet before dropping it (a note re-creates it). */
const IDLE_DROP_MS = 30_000;

/**
 * Playing an AHX song's instruments from the keyboard.
 *
 * The song's own worklet (`AhxTransport`) runs the file's transport and cannot
 * be played by hand, and must not be disturbed by someone trying an
 * instrument. So the preview is a second worklet node running its own engine
 * instance in live mode (`AhxPlayer.enable_preview`): the same bytes, so the
 * same instruments, waveforms and PList, but one mono voice driven by
 * note-on / note-off. It is created on the first key and dropped again after a
 * while idle; the song can play, pause or be replaced without it noticing.
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
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly host: AhxTransportHost & {
      /** Resumes a suspended context (a worklet cannot start on one); resolves whether it runs. */
      ensureAudioContextRunning?(): Promise<boolean>;
    },
    private readonly createPlayer: (
      ctx: AudioContext,
    ) => Promise<AhxPlayerClient> = createAhxPlayer,
    private readonly idleDropMs: number = IDLE_DROP_MS,
  ) {}

  /** Whether a preview worklet currently exists (for tests and diagnostics). */
  get active(): boolean {
    return this.client !== null;
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
    this.clearIdleTimer();
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
    this.armIdleTimer();
  }

  /** Release whatever sounds (focus lost, song changed). */
  allNotesOff(): void {
    this.wanted = null;
    this.client?.previewNoteOff();
    this.armIdleTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.wanted = null;
    this.clearIdleTimer();
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
        // loads it, and (hi-fi on) builds the band-limited tables lazily
        // rather than walking a song that is never played.
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

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.disposed || !this.client) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.wanted === null) this.disposeClient();
    }, this.idleDropMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private disposeClient(): void {
    this.client?.dispose();
    this.client = null;
    this.loadedSource = null;
  }
}
