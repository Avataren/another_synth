/**
 * S3M AdLib channels as OPL register writes (.ai/plan-opl.md O3).
 *
 * Scream Tracker 3 runs an AdLib channel through the same channel state as a
 * PCM one -- the same effects, periods and volume -- and only translates the
 * result for the chip once per tick (`updateadlib`). This does that
 * translation, sink-side: a host routes the note, pitch and volume events of
 * a track playing an AdLib instrument here instead of to a sampler, and gets
 * register writes stamped with the same AudioContext times, for an OPL chip
 * (the app's OPL worklet) to apply.
 *
 * Every rule is transcribed from st3play's `digadl.c` and `dig.c` (Olav
 * Sørensen's C port of ST3.21, BSD-3), quoted where it matters:
 *
 * - pitch: the channel's period becomes ST3's sample rate
 *   `hz = 14317056 / period` (`setspd`), the instrument's c2spd scales the
 *   period first (`scalec2spd`), and `updateadlib` turns hz into block and
 *   F-number. The engine hands over musical Hz, `14317056 / period / 16`
 *   (pitch-model.ts), which inverts to the integer period exactly.
 * - key: every pitch write carries the key-on bit; a new note writes key-off
 *   then key-on; a key-off (`^^`) writes the current note with the bit clear.
 * - volume: the carrier's TL (and the modulator's, for an additive
 *   instrument) scaled by the channel volume 0..63, KSL bits kept.
 * - instrument registers load only when the channel's instrument changes;
 *   every write is dropped when the register already holds the value
 *   (`outaw`'s cache), so this emits exactly the writes ST3 makes.
 *
 * Known differences from ST3, all at the event boundary this sits on:
 * - a volume the engine derives (tremolo, a note cut's zero) reaches the
 *   chip, where ST3 re-sends TL only on an instrument, a volume-column value
 *   or a D/K/L slide -- so ST3 plays tremolo and SCx as no-ops on AdLib;
 * - ST3.03..3.20's broken tone portamento on AdLib channels is not modelled.
 */
import type { PitchSource } from './effect-state';
import type { OplInstrumentData } from './tracker-sample';

/** YMF262 output rate: 14.31818 MHz / 288, the chip's sample clock. */
export const OPL_NATIVE_RATE = 14_318_180 / 288;

/** Where register writes go: an OPL chip, or a recorder in tests. */
export interface OplRegisterTarget {
  /** `time` in AudioContext seconds; `reg` 0x000..0x1FF; `val` a byte. */
  write(time: number, reg: number, val: number): void;
}

/** ST3's AdLib channel operator offsets (`adlibiadd`), melodic 0..8. */
const ADLIB_OPERATOR_OFFSET = [0, 1, 2, 8, 9, 10, 16, 17, 18] as const;
/** `emptyadlibins`: both operators at TL 63, what `initadlib` loads. */
const EMPTY_ADLIB_INSTRUMENT = [0, 0, 63, 63, 0, 0, 0, 0, 0, 0, 0, 0] as const;
/** ST3's period-to-rate numerator (`setspd`). */
const ST3_RATE_NUMERATOR = 14_317_056;
/** Musical Hz is ST3's rate / 16 (pitch-model.ts, S3M_TO_SYNTH_SCALE). */
const ST3_MUSICAL_SCALE = 16;
/** `C2FREQ`, and ST3's stand-in for an AdLib c2spd under 1000. */
const ST3_C2FREQ = 8363;
const ST3_KEY_ON = 0x2000;
/**
 * Key-on follows a retrigger's key-off by one chip sample. ST3's two `outaw`
 * calls are tens of microseconds apart on real hardware, so the chip sees the
 * key up for at least a sample and re-attacks; stamped at the same instant the
 * chip would see no edge and the retrigger would be lost.
 */
const RETRIGGER_GAP_SECONDS = 1 / OPL_NATIVE_RATE;

export interface St3PeriodLimits {
  /** `song.aspdmin`: 64, or 453 under the amiga-limits flag. */
  min: number;
  /** `song.aspdmax`: 32767, or 3424 under the amiga-limits flag. */
  max: number;
}

const ST3_DEFAULT_LIMITS: St3PeriodLimits = { min: 64, max: 32767 };
const ST3_AMIGA_LIMITS: St3PeriodLimits = { min: 453, max: 3424 };

/** The integer ST3 period behind one of the engine's musical frequencies. */
export function st3PeriodForFrequency(frequency: number): number {
  return frequency > 0 ? Math.round(ST3_RATE_NUMERATOR / (frequency * ST3_MUSICAL_SCALE)) : 0;
}

/**
 * `scalec2spd`: a note's period for an instrument with `c2spd` (read as
 * uint16; under 1000 means C2FREQ, as `doadlib` sets it). A quotient that
 * would not fit 16 bits is ST3's "div error", 32767.
 */
export function st3ScaleC2spd(period: number, c2spd: number): number {
  let c2 = c2spd & 0xffff;
  if (c2 < 1000) c2 = ST3_C2FREQ;
  const product = period * ST3_C2FREQ;
  if (Math.floor(product / 65536) >= c2) return 32767;
  return Math.min(32767, Math.floor(product / c2));
}

/**
 * `setspd`: the rate for a (c2spd-scaled) period, clamping the speed it
 * converts -- not the stored one -- to the limits. 0 means the period is 0,
 * which ST3 turns into a key-off.
 */
export function st3HzForPeriod(scaled: number, limits: St3PeriodLimits = ST3_DEFAULT_LIMITS): number {
  if (scaled <= 0) return 0;
  const speed = Math.max(limits.min, Math.min(limits.max, scaled));
  return Math.floor(ST3_RATE_NUMERATOR / speed);
}

/**
 * ST3's playback rate for a note's musical frequency on an instrument with
 * `c2spd`: `scalec2spd`, then `setspd`.
 */
export function st3AdlibHz(frequency: number, c2spd: number, limits: St3PeriodLimits = ST3_DEFAULT_LIMITS): number {
  const period = st3PeriodForFrequency(frequency);
  return period === 0 ? 0 : st3HzForPeriod(st3ScaleC2spd(period, c2spd), limits);
}

/**
 * `updateadlib`'s rate to register pair: the 16-bit value whose high byte
 * goes to B0 (key-on bit set) and low byte to A0. Block is the number of
 * halvings of `2 * hz` below 3125, written with ST3's uint8 arithmetic.
 */
export function st3AdlibNote(hz: number): number {
  let h = (hz * 2) >>> 0;
  let block = 0;
  while (h >= 3125) {
    block++;
    h >>>= 1;
  }
  const b0 = ((block << 2) | 32) & 0xff;
  const fnum = Math.floor((h * 1024) / 3125);
  return ((b0 << 8) | fnum) & 0xffff;
}

/** `updateadlib`'s TL for one operator: the instrument's TL scaled by `avol`. */
export function st3AdlibTotalLevel(instrumentLevel: number, avol: number): number {
  let out = 63 - (instrumentLevel & 63);
  if (avol < 63) {
    const vol = avol !== 0 ? avol + 1 : 0;
    out = (out * vol) >> 6;
  }
  return ((63 - out) & 63) | (instrumentLevel & 0xc0);
}

interface ChannelState {
  oplChannel: number;
  instrumentId: string | undefined;
  data: OplInstrumentData | undefined;
  /** The 16-bit A0/B0 value last written (key bit included). */
  note: number;
  /**
   * The note's unscaled period and its c2spd-scaled one. ST3 scales a note's
   * period once, at the note, and slides and vibrato then move the scaled
   * period by the same units the engine moves its unscaled one -- so a later
   * pitch is `scaledBase + (period - periodBase)`, not a re-scale.
   */
  periodBase: number;
  scaledBase: number;
  keyed: boolean;
  avol: number;
  /**
   * A retrigger not yet written: the time of the note that asked for it.
   * ST3 works out a whole tick before `updateadlib` writes it, so a pitch
   * change on the note's own tick (a fine slide, say) is in the note it keys
   * on. The key-off/key-on pair waits here until the tick's pitch is final.
   */
  retriggerAt: number | undefined;
  /** Likewise a volume (TL) write waiting for its tick's final volume. */
  volumeAt: number | undefined;
}

export interface S3mOplDriverOptions {
  target: OplRegisterTarget;
  /** The AdLib timbre for an instrument id, or undefined for a non-AdLib one. */
  instrument: (instrumentId: string) => OplInstrumentData | undefined;
  /**
   * The OPL channel (0..8) each track owns: the S3M channel setting A1..A9
   * (see `s3mAdlibChannelForTrack`). Unmapped tracks get the lowest free
   * channel on first use; all nine channels sound alike in OPL2 mode.
   */
  channelForTrack?: (trackIndex: number) => number | undefined;
  /** The file's amiga-limits flag (S3M header flags & 0x10). */
  amigaLimits?: boolean;
}

export class S3mOplDriver {
  private readonly target: OplRegisterTarget;
  private readonly lookup: (instrumentId: string) => OplInstrumentData | undefined;
  private readonly channelForTrack: ((trackIndex: number) => number | undefined) | undefined;
  private readonly limits: St3PeriodLimits;
  private readonly tracks = new Map<number, ChannelState>();
  /** `adlibmem`: what each register was last written with. */
  private readonly cache = new Uint8Array(256);
  private flushScheduled = false;

  constructor(options: S3mOplDriverOptions) {
    this.target = options.target;
    this.lookup = options.instrument;
    this.channelForTrack = options.channelForTrack;
    this.limits = options.amigaLimits ? ST3_AMIGA_LIMITS : ST3_DEFAULT_LIMITS;
    this.cache.fill(0xfc);
  }

  /** Whether `instrumentId` is an AdLib instrument this driver plays. */
  handles(instrumentId: string | undefined): boolean {
    return instrumentId !== undefined && this.lookup(instrumentId) !== undefined;
  }

  /**
   * The OPL channel (0..8) a track plays on: the one it was given at its
   * first note, else the channel map's, else undefined. For a host that
   * mutes tracks through the chip's channel mask.
   */
  oplChannelForTrack(trackIndex: number): number | undefined {
    return this.tracks.get(trackIndex)?.oplChannel ?? this.channelForTrack?.(trackIndex);
  }

  /**
   * `initadlib`: waveform select on, CSM/NTS and rhythm off, every channel
   * silent at note 0. Call at song start; forgets every channel's state.
   */
  reset(time: number): void {
    this.cache.fill(0xfc);
    this.tracks.clear();
    this.out(time, 0x01, 0x20);
    this.out(time, 0x08, 0x00);
    this.out(time, 0xbd, 0x00);
    for (let ch = 0; ch < 9; ch++) {
      this.loadInstrument(time, ch, EMPTY_ADLIB_INSTRUMENT);
      this.outNote(time, ch, 0);
    }
  }

  /** A new note (not a tone portamento): load the timbre if it changed, re-key. */
  noteOn(instrumentId: string | undefined, velocity: number, time: number, trackIndex: number, frequency: number): void {
    if (instrumentId === undefined) return;
    const data = this.lookup(instrumentId);
    // doadlib: a non-AdLib instrument on an AdLib channel does nothing at all.
    if (!data) return;
    const state = this.channel(trackIndex);
    if (!state) return;
    this.settle(time, state);

    if (state.instrumentId !== instrumentId) {
      state.instrumentId = instrumentId;
      state.data = data;
      this.loadInstrument(time, state.oplChannel, data.registers);
    }

    state.avol = Math.min(63, Math.max(0, Math.round((velocity * 64) / 127)));
    state.periodBase = st3PeriodForFrequency(frequency);
    state.scaledBase = state.periodBase === 0 ? 0 : st3ScaleC2spd(state.periodBase, data.c2spd);
    const hz = st3HzForPeriod(state.scaledBase, this.limits);
    if (hz === 0) {
      state.retriggerAt = undefined;
      this.keyOff(time, state);
    } else {
      state.note = st3AdlibNote(hz);
      state.keyed = true;
      state.retriggerAt = time;
    }
    state.volumeAt = time;
    this.scheduleFlush();
  }

  /**
   * Write any retrigger still waiting for its tick to finish. The driver
   * does this itself before a later event on the same channel and at the
   * end of the current task; a host that needs the writes sooner (a test
   * reading the target synchronously) can call it.
   */
  flush(): void {
    this.flushScheduled = false;
    for (const state of new Set(this.tracks.values())) this.flushTick(state);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  /**
   * updateadlib for one channel: the retrigger (key-off then key-on, with
   * the tick's note), then the volume retrigger (addherzretrigvol).
   */
  private flushTick(state: ChannelState): void {
    const time = state.retriggerAt;
    if (time !== undefined) {
      state.retriggerAt = undefined;
      this.outNote(time, state.oplChannel, state.note & ~ST3_KEY_ON);
      if (state.keyed) this.outNote(time + RETRIGGER_GAP_SECONDS, state.oplChannel, state.note);
    }
    if (state.volumeAt !== undefined) {
      const at = state.volumeAt;
      state.volumeAt = undefined;
      this.writeVolume(at, state);
    }
  }

  /** Settles a channel's pending writes unless `time` is still their tick. */
  private settle(time: number, state: ChannelState): void {
    const pending = state.retriggerAt ?? state.volumeAt;
    if (pending !== undefined && Math.abs(time - pending) > 1e-9) this.flushTick(state);
  }

  /**
   * The channel's pitch moved. A slide or vibrato (`source` absent) adds to
   * the scaled period, as ST3 moves `aspd`/`aorgspd`; a pitch read off the
   * note table -- an arpeggio step (`'table'`), a tone portamento landing on
   * its note (`'target'`, which ST3 makes the new base) -- is scaled afresh,
   * as `s_arp` and `asldspd` are.
   */
  setPitch(time: number, trackIndex: number, frequency: number, source?: PitchSource): void {
    const state = this.tracks.get(trackIndex);
    if (!state?.data || !state.keyed) return;
    this.settle(time, state);
    const period = st3PeriodForFrequency(frequency);
    let scaled: number;
    if (period === 0) {
      scaled = 0;
    } else if (source) {
      scaled = st3ScaleC2spd(period, state.data.c2spd);
      if (source === 'target') {
        state.periodBase = period;
        state.scaledBase = scaled;
      }
    } else {
      scaled = Math.min(32767, state.scaledBase + (period - state.periodBase));
    }
    const hz = st3HzForPeriod(scaled, this.limits);
    if (hz === 0) {
      this.flushTick(state);
      this.keyOff(time, state);
      return;
    }
    state.note = st3AdlibNote(hz);
    // On the note's own tick the pitch joins the pending retrigger.
    if (state.retriggerAt === undefined) this.outNote(time, state.oplChannel, state.note);
  }

  /** The channel volume, 0..1 of ST3's 0..64. */
  setVolume(time: number, trackIndex: number, volume: number): void {
    const state = this.tracks.get(trackIndex);
    if (!state?.data) return;
    this.settle(time, state);
    state.avol = Math.min(63, Math.max(0, Math.round(volume * 64)));
    state.volumeAt = time;
    this.scheduleFlush();
  }

  /** `^^`: key off at the current frequency. */
  noteOff(time: number, trackIndex: number): void {
    const state = this.tracks.get(trackIndex);
    if (!state) return;
    this.flushTick(state);
    this.keyOff(time, state);
  }

  /** Key every channel off (a stop, or S3M's key-off-all). */
  allNotesOff(time: number): void {
    for (const state of new Set(this.tracks.values())) {
      this.flushTick(state);
      this.keyOff(time, state);
    }
  }

  private channel(trackIndex: number): ChannelState | undefined {
    const existing = this.tracks.get(trackIndex);
    if (existing) return existing;
    let oplChannel = this.channelForTrack?.(trackIndex);
    if (oplChannel === undefined) {
      const used = new Set([...this.tracks.values()].map((s) => s.oplChannel));
      oplChannel = [0, 1, 2, 3, 4, 5, 6, 7, 8].find((ch) => !used.has(ch));
    }
    if (oplChannel === undefined || oplChannel < 0 || oplChannel > 8) return undefined;
    // ST3 keeps channel state per channel *setting* (getnote1:
    // `&song._zchn[song.header.channel[dat & 0x1F]]`), so two file channels
    // set to the same AdLib channel are one channel: share its state.
    for (const other of this.tracks.values()) {
      if (other.oplChannel === oplChannel) {
        this.tracks.set(trackIndex, other);
        return other;
      }
    }
    const state: ChannelState = {
      oplChannel,
      instrumentId: undefined,
      data: undefined,
      note: 0,
      periodBase: 0,
      scaledBase: 0,
      keyed: false,
      avol: 63,
      retriggerAt: undefined,
      volumeAt: undefined,
    };
    this.tracks.set(trackIndex, state);
    return state;
  }

  private keyOff(time: number, state: ChannelState): void {
    state.keyed = false;
    this.outNote(time, state.oplChannel, state.note & ~ST3_KEY_ON);
  }

  /** `adlibloadins`: D00..D0A into the channel's operator and C0 registers. */
  private loadInstrument(time: number, ch: number, d: readonly number[]): void {
    const op = ADLIB_OPERATOR_OFFSET[ch]!;
    const byte = (i: number) => (d[i] ?? 0) & 0xff;
    this.out(time, 0x20 + op, byte(0));
    this.out(time, 0x23 + op, byte(1));
    this.out(time, 0x40 + op, byte(2));
    this.out(time, 0x43 + op, byte(3));
    this.out(time, 0x60 + op, byte(4));
    this.out(time, 0x63 + op, byte(5));
    this.out(time, 0x80 + op, byte(6));
    this.out(time, 0x83 + op, byte(7));
    this.out(time, 0xe0 + op, byte(8));
    this.out(time, 0xe3 + op, byte(9));
    this.out(time, 0xc0 + ch, byte(10));
  }

  /** `updateadlib`'s volume retrigger: carrier always, modulator if additive. */
  private writeVolume(time: number, state: ChannelState): void {
    const d = state.data?.registers;
    if (!d) return;
    const op = ADLIB_OPERATOR_OFFSET[state.oplChannel]!;
    if ((d[10] ?? 0) & 1) this.out(time, 0x40 + op, st3AdlibTotalLevel(d[2] ?? 0, state.avol));
    this.out(time, 0x43 + op, st3AdlibTotalLevel(d[3] ?? 0, state.avol));
  }

  /** `outnote`: low byte to A0, high byte to B0. */
  private outNote(time: number, ch: number, note: number): void {
    this.out(time, 0xa0 + ch, note & 0xff);
    this.out(time, 0xb0 + ch, (note >> 8) & 0xff);
  }

  /** `outaw`: skip a write the register already holds. */
  private out(time: number, reg: number, val: number): void {
    if (this.cache[reg] === val) return;
    this.cache[reg] = val;
    this.target.write(time, reg, val);
  }
}
