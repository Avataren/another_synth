/**
 * The song bank's OPL chip (.ai/plan-opl.md O5): the OPL worklet node, the
 * `S3mOplDriver` that turns an S3M's AdLib notes into ST3's register writes,
 * and the batching between them.
 *
 * The driver writes one register at a time; the worklet takes them in
 * batches (`writes`, a Float64Array of (time, reg, val) triples). Writes
 * collect here and go at the end of the current task, after `driver.flush()`
 * has settled any tick still waiting for its final pitch or volume. The
 * engine schedules a whole look-ahead window in one task, so one scheduler
 * wake-up is one message.
 *
 * Mute and solo go through the chip's channel mask, not by dropping notes:
 * ST3's channel state (the timbre loaded, the note keyed) has to keep
 * running on a muted channel, or unmuting it mid-note plays the wrong thing.
 *
 * The output bypasses the song's global volume: ST3's `updateadlib` scales
 * TL by the channel volume alone, never by `globalvol` (st3play dig.c
 * `setvol` applies it to PCM only).
 */
import { S3mOplDriver } from '@another-synth/tracker-playback';
import type { OplInstrumentData, PitchSource } from '@another-synth/tracker-playback';
import type { OplCommand, OplEvent } from 'src/audio/worklets/opl-core';
import { debugLog } from 'src/diagnostics/debug-log';

/**
 * The chip's level in the mix when the song does not say
 * (`s3mOplMixGain` at ST3's default master volume, 48): OpenMPT's balance
 * against the samples. A song's own value comes from its header.
 */
export const OPL_DEFAULT_MIX_GAIN = (Math.SQRT1_2 * ((32768 * 6169 * 0.75) / 2 ** 27) * 128) / 48;

/** OPL2 melodic channels: all nine sound alike, so the mask covers 0..8. */
const OPL_CHANNELS = 9;
const ALL_CHANNELS_MASK = (1 << 18) - 1;

/** The song-level facts the driver needs. */
export interface OplSongInfo {
  /** AdLib timbres by instrument id ('01'..). Empty: the song has no OPL. */
  instruments: ReadonlyMap<string, OplInstrumentData>;
  /** The OPL channel per track (`s3mAdlibChannelForTrack`); null for none. */
  channels: ReadonlyArray<number | null>;
  amigaLimits: boolean;
  /** The chip's mix level (`s3mOplMixGain`); null for the default. */
  gain?: number | null;
}

/** Builds the worklet node, past its wasm handshake. Injectable for tests. */
export type OplNodeFactory = (audioContext: BaseAudioContext) => Promise<AudioWorkletNode>;

export class OplOutput {
  /** Where the chip's audio leaves: connect to the mix bus. */
  readonly output: GainNode;
  private node: AudioWorkletNode | null = null;
  private nodePromise: Promise<AudioWorkletNode | null> | null = null;
  private disposed = false;
  private instruments: ReadonlyMap<string, OplInstrumentData> = new Map();
  private channels: ReadonlyArray<number | null> = [];
  private driver: S3mOplDriver;
  private pending: number[] = [];
  private postScheduled = false;
  private mask = ALL_CHANNELS_MASK;
  private trackAudible: (trackIndex: number) => boolean = () => true;
  private trackCount = 0;
  private songGain = OPL_DEFAULT_MIX_GAIN;
  private userVolume = 1;

  constructor(
    private readonly audioContext: BaseAudioContext,
    destination: AudioNode,
    private readonly createNode: OplNodeFactory = createOplNode,
  ) {
    this.output = audioContext.createGain();
    this.output.gain.value = OPL_DEFAULT_MIX_GAIN;
    this.output.connect(destination);
    this.driver = this.makeDriver(false);
  }

  /** The user's master volume (the song's global volume does not reach the chip). */
  setUserVolume(volume: number): void {
    this.userVolume = volume;
    this.applyGain();
  }

  private applyGain(): void {
    const now = this.audioContext.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(this.songGain * this.userVolume, now);
  }

  /** Whether `instrumentId` is an AdLib instrument of the loaded song. */
  handles(instrumentId: string | undefined): boolean {
    return instrumentId !== undefined && this.instruments.has(instrumentId);
  }

  /**
   * Take the loaded song's AdLib instruments and channel map. A song with
   * none leaves the worklet unbuilt; one with some starts building it (await
   * `ready()` before playing).
   */
  setSong(info: OplSongInfo): void {
    this.instruments = info.instruments;
    this.channels = info.channels;
    this.trackCount = info.channels.length;
    this.songGain = info.gain ?? OPL_DEFAULT_MIX_GAIN;
    this.applyGain();
    this.driver = this.makeDriver(info.amigaLimits);
    this.pending = [];
    if (this.instruments.size) {
      void this.ready();
      this.restart();
    }
  }

  /** Resolves once the worklet can take writes (at once when the song has no OPL). */
  async ready(): Promise<void> {
    if (!this.instruments.size || this.disposed) return;
    if (!this.nodePromise) {
      this.nodePromise = this.createNode(this.audioContext).then(
        (node) => {
          if (this.disposed) {
            node.port.postMessage({ type: 'dispose' } satisfies OplCommand);
            return null;
          }
          node.connect(this.output);
          node.port.onmessage = (event: MessageEvent) => this.onEvent(event.data as OplEvent);
          this.node = node;
          this.postCommand({ type: 'set-channel-mask', mask: this.mask });
          this.post();
          return node;
        },
        (error: unknown) => {
          console.error('[OplOutput] OPL worklet failed to start:', error);
          this.nodePromise = null;
          return null;
        },
      );
    }
    await this.nodePromise;
  }

  // --- the TrackerSink events, for an instrument `handles` accepts --------

  noteOn(instrumentId: string, velocity: number, time: number, trackIndex: number, frequency: number): void {
    this.driver.noteOn(instrumentId, velocity, time, trackIndex, frequency);
    this.schedulePost();
  }

  noteOff(time: number, trackIndex: number): void {
    this.driver.noteOff(time, trackIndex);
    this.schedulePost();
  }

  setPitch(time: number, trackIndex: number, frequency: number, source?: PitchSource): void {
    this.driver.setPitch(time, trackIndex, frequency, source);
    this.schedulePost();
  }

  setVolume(time: number, trackIndex: number, volume: number): void {
    this.driver.setVolume(time, trackIndex, volume);
    this.schedulePost();
  }

  /** S3M's key-off-all / a song loop: every channel off at `time`. */
  allNotesOffAt(time: number): void {
    if (!this.instruments.size) return;
    this.driver.allNotesOff(time);
    this.schedulePost();
  }

  /**
   * Stop, seek or a new start: drop everything the chip has queued, key it
   * silent, and put the driver back to `initadlib`. The queue going means
   * the driver's register cache no longer matches the chip, so it has to
   * start over rather than just key off.
   */
  restart(): void {
    if (!this.instruments.size) return;
    this.pending = [];
    this.postCommand({ type: 'panic' });
    this.driver.reset(this.audioContext.currentTime);
    this.schedulePost();
  }

  /**
   * Mute/solo: a track is heard when `audible(track)` says so; an OPL channel
   * plays while any track on it is heard, or while no track claims it.
   */
  setTrackAudibility(audible: (trackIndex: number) => boolean, trackCount: number): void {
    this.trackAudible = audible;
    this.trackCount = Math.max(this.trackCount, trackCount);
    this.updateMask();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = [];
    if (this.node) {
      this.postCommand({ type: 'dispose' });
      this.node.disconnect();
      this.node.port.onmessage = null;
      this.node = null;
    }
    this.output.disconnect();
  }

  // --- internals -----------------------------------------------------------

  private makeDriver(amigaLimits: boolean): S3mOplDriver {
    return new S3mOplDriver({
      target: {
        write: (time, reg, val) => {
          this.pending.push(time, reg, val);
          this.schedulePost();
        },
      },
      instrument: (id) => this.instruments.get(id),
      channelForTrack: (track) => this.channels[track] ?? undefined,
      amigaLimits,
    });
  }

  private updateMask(): void {
    let silenced = 0;
    let heard = 0;
    for (let track = 0; track < this.trackCount; track++) {
      const ch = this.driver.oplChannelForTrack(track);
      if (ch === undefined || ch < 0 || ch >= OPL_CHANNELS) continue;
      if (this.trackAudible(track)) heard |= 1 << ch;
      else silenced |= 1 << ch;
    }
    const mask = ALL_CHANNELS_MASK & ~(silenced & ~heard);
    if (mask === this.mask) return;
    this.mask = mask;
    this.postCommand({ type: 'set-channel-mask', mask });
  }

  private schedulePost(): void {
    if (this.postScheduled) return;
    this.postScheduled = true;
    queueMicrotask(() => this.post());
  }

  /** Settle the driver's open ticks, then send everything collected. */
  private post(): void {
    this.postScheduled = false;
    this.driver.flush();
    // A track the driver placed on its first note can change the mask.
    this.updateMask();
    if (!this.node || !this.pending.length) return;
    const writes = Float64Array.from(this.pending);
    this.pending = [];
    this.node.port.postMessage({ type: 'writes', writes } satisfies OplCommand, [writes.buffer]);
  }

  private postCommand(command: OplCommand): void {
    this.node?.port.postMessage(command);
  }

  private onEvent(event: OplEvent): void {
    if (event.type === 'late-writes') {
      debugLog(`[OplOutput] ${event.total} OPL writes applied late`);
    } else if (event.type === 'error') {
      console.error('[OplOutput] OPL worklet:', event.message);
    }
  }
}

/**
 * Create the OPL worklet node and run its wasm handshake (`ready` -> the
 * wasm bytes -> `wasm-ready`), as `createSidPlayer` does.
 */
export async function createOplNode(audioContext: BaseAudioContext): Promise<AudioWorkletNode> {
  await audioContext.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/opl-worklet.js`);
  const node = new AudioWorkletNode(audioContext, 'opl-audio-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      node.port.onmessage = null;
      node.port.close();
      reject(error);
    };
    node.onprocessorerror = () => fail(new Error('OPL worklet processor error'));
    node.port.onmessage = async (event: MessageEvent) => {
      const data = event.data as OplEvent | { type: 'ready' | 'wasm-ready' };
      if (data.type === 'ready') {
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}wasm/audio_processor_bg.wasm`, { cache: 'no-cache' });
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          const wasmBytes = await response.arrayBuffer();
          node.port.postMessage({ type: 'wasm-binary', wasmBytes }, [wasmBytes]);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      } else if (data.type === 'wasm-ready') {
        resolve();
      } else if (data.type === 'error') {
        fail(new Error(data.message));
      }
    };
  });
  return node;
}
