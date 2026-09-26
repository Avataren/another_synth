/**
 * The SID's envelope generator, stepped a frame at a time, for measuring
 * how loud each voice is (plan-psid-import.md D6): a register trace says
 * what a player wrote, not what the chip made of it. The chip's ADSR delay
 * bug in particular (a gate-on whose rate counter has run past the attack's
 * period waits for the 15-bit counter to wrap, up to 33 ms) can hold a note
 * silent that the registers say is playing.
 *
 * The same model as the app's chip (`rust-wasm/src/sid/envelope.rs`): the
 * measured rate periods, a 15-bit rate counter compared for equality, linear
 * attack, the piecewise-exponential divider in decay and release, the
 * sustain hold and the zero-freeze latch. Here it runs step by step rather than cycle by cycle.
 */

/** Chip cycles per envelope step, by rate nibble (the measured periods). */
export const SID_RATE_PERIODS: readonly number[] = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];

const expPeriod = (level: number): number =>
  level >= 94 ? 1 : level >= 55 ? 2 : level >= 27 ? 4 : level >= 15 ? 8 : level >= 7 ? 16 : level >= 1 ? 30 : 1;

const ATTACK = 0;
const DECAY = 1;
const RELEASE = 2;

export class SidEnvelope {
  level = 0;
  private stage = RELEASE;
  private counter = 0;
  private exp = 0;
  private gate = false;
  /** The zero freeze: set by a step that lands on 0, cleared only by a gate-on. */
  private holdZero = true;
  private ad = 0;
  private sr = 0;

  /** A copy, to run on from here without touching this one. */
  clone(): SidEnvelope {
    return Object.assign(new SidEnvelope(), this);
  }

  setAdsr(ad: number, sr: number): void {
    this.ad = ad;
    this.sr = sr;
  }

  setGate(on: boolean): void {
    if (on && !this.gate) {
      this.stage = ATTACK;
      this.holdZero = false;
    } else if (!on && this.gate) this.stage = RELEASE;
    this.gate = on;
  }

  private period(): number {
    const nibble = this.stage === ATTACK ? this.ad >> 4 : this.stage === DECAY ? this.ad & 0x0f : this.sr & 0x0f;
    return SID_RATE_PERIODS[nibble]!;
  }

  /** Nothing a step does changes the level: frozen at zero, or decay at the sustain level. */
  private holding(): boolean {
    if (this.holdZero) return true;
    return this.stage === DECAY && this.level === (this.sr >> 4) * 17;
  }

  /** Run `cycles` chip cycles. */
  run(cycles: number): void {
    let left = cycles;
    while (left > 0) {
      const period = this.period();
      // The counter counts up and steps when it equals the period; past it, it wraps at $8000 first.
      const until = this.counter < period ? period - this.counter : 0x8000 - this.counter + period;
      if (until > left) {
        this.counter = (this.counter + left) & 0x7fff;
        return;
      }
      left -= until;
      this.counter = 0;
      this.step();
      if (this.holding()) {
        // Every further step until the next write does nothing but keep the counters turning.
        const steps = Math.floor(left / period);
        this.exp = (this.exp + steps) % expPeriod(this.level);
        this.counter = left % period;
        return;
      }
    }
  }

  private step(): void {
    if (this.stage !== ATTACK) {
      this.exp++;
      if (this.exp < expPeriod(this.level)) return;
    }
    this.exp = 0;
    if (this.holdZero) return;
    if (this.stage === ATTACK) {
      this.level = (this.level + 1) & 0xff;
      if (this.level === 255) this.stage = DECAY;
    } else if (this.stage === RELEASE || this.level !== (this.sr >> 4) * 17) {
      // An unfrozen 0 (a gate-on with no attack step yet) wraps to 255.
      this.level = (this.level - 1) & 0xff;
    }
    if (this.level === 0) this.holdZero = true;
  }
}

/** Per frame, one voice's register writes as the trace has them: attack/decay, sustain/release, control, and whether the gate went low inside the frame. */
export interface EnvelopeFrame {
  readonly ad: number;
  readonly sr: number;
  readonly ctrl: number;
  /** The gate went low inside the frame (a retrigger, when it ends high). */
  readonly gateLow: boolean;
}

/**
 * The envelope level at the end of each frame of `frames`, each frame's
 * writes applied at its start (attack/decay and sustain/release, then the
 * gate), `cyclesPerFrame` apart.
 */
export function envelopeLevels(frames: readonly EnvelopeFrame[], cyclesPerFrame: number, env = new SidEnvelope()): Uint8Array {
  const out = new Uint8Array(frames.length);
  frames.forEach((f, i) => {
    applyEnvelopeFrame(env, f, cyclesPerFrame);
    out[i] = env.level;
  });
  return out;
}

/** One frame of `f`'s writes on `env`, then the frame's cycles. */
export function applyEnvelopeFrame(env: SidEnvelope, f: EnvelopeFrame, cyclesPerFrame: number): void {
  env.setAdsr(f.ad, f.sr);
  if (f.gateLow) env.setGate(false);
  env.setGate((f.ctrl & 1) !== 0);
  env.run(cyclesPerFrame);
}
