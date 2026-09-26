import { Mos6510, type CpuBus } from './mos6510';

/**
 * Enough of a C64 to run `.sid` players (plan-psid-import.md D2): 64 KB of
 * RAM, the 6510's `$01` banking, and the chips a player talks to:
 *
 *  - **SID** (`$D400`, and a second/third one where the file says): every
 *    write reaches `onSidWrite`; the registers read back the last value on
 *    the chip's bus, except voice 3's oscillator (`$D41B`) and envelope
 *    (`$D41C`), which are modelled (players use them as random numbers);
 *  - **CIA 1 / CIA 2** timers A and B (continuous or one-shot, force load,
 *    timer B counting timer A), their interrupt control register (CIA 1 on the
 *    IRQ line, CIA 2 on the NMI line); ports read as "nothing pressed";
 *  - **VIC-II** raster counter (`$D011`/`$D012`) and raster interrupt
 *    (`$D019`/`$D01A`), PAL (312 lines x 63 cycles) or NTSC (263 x 65).
 *
 * No ROM images (not ours to ship): a stand-in KERNAL of our own is visible
 * where `$01` banks the KERNAL in. It has the KERNAL's IRQ/BRK entry at
 * `$FF48` (`JMP ($0314)` / `JMP ($0316)`), its NMI entry at `$FE43`
 * (`JMP ($0318)`), the IRQ exits `$EA31`/`$EA7E`/`$EA81` and the NMI exit
 * `$FEBC`, the hardware vectors, and `RTS` everywhere else, so a call into a
 * KERNAL routine returns. The BASIC ROM's range reads `RTS` too. The RAM
 * vectors and `$02A6` (the PAL flag) are set as the KERNAL leaves them.
 *
 * `stateHash()` is a 64-bit Zobrist hash of everything a player can change:
 * RAM and the I/O registers written, updated on every write, so two equal
 * hashes at two frames mean the music repeats from there (D5).
 */

export type C64Clock = 'pal' | 'ntsc';

export interface C64Timing {
  /** CPU cycles per second. */
  readonly hz: number;
  readonly cyclesPerLine: number;
  readonly lines: number;
  /** The CIA 1 timer A latch the KERNAL sets at boot (its 60 Hz interrupt). */
  readonly kernalCiaLatch: number;
}

export const C64_TIMING: Readonly<Record<C64Clock, C64Timing>> = {
  pal: { hz: 985248, cyclesPerLine: 63, lines: 312, kernalCiaLatch: 0x4025 },
  ntsc: { hz: 1022727, cyclesPerLine: 65, lines: 263, kernalCiaLatch: 0x4295 },
};

/** Cycles of one video frame. */
export const c64FrameCycles = (t: C64Timing): number => t.cyclesPerLine * t.lines;

/** Addresses in the stand-in KERNAL (the real KERNAL's). */
export const KERNAL_IRQ_ENTRY = 0xff48;
export const KERNAL_NMI_ENTRY = 0xfe43;
export const KERNAL_IRQ_HANDLER = 0xea31;
export const KERNAL_IRQ_EXIT = 0xea81;
export const KERNAL_NMI_HANDLER = 0xfe47;
/** Where the KERNAL's BRK vector (`$0316`) points: the driver stops a call that gets here. */
export const KERNAL_BRK_HANDLER = 0xfe66;

const RTS = 0x60;

function standInKernal(): Uint8Array {
  const rom = new Uint8Array(0x2000).fill(RTS);
  const put = (addr: number, bytes: readonly number[]): void => rom.set(bytes, addr - 0xe000);
  // IRQ/BRK entry: save A, X, Y; B flag set -> ($0316), else ($0314).
  put(KERNAL_IRQ_ENTRY, [0x48, 0x8a, 0x48, 0x98, 0x48, 0xba, 0xbd, 0x04, 0x01, 0x29, 0x10, 0xf0, 0x03, 0x6c, 0x16, 0x03, 0x6c, 0x14, 0x03]);
  // NMI entry: SEI, JMP ($0318).
  put(KERNAL_NMI_ENTRY, [0x78, 0x6c, 0x18, 0x03]);
  // Default NMI handler: acknowledge CIA 2, return.
  put(KERNAL_NMI_HANDLER, [0x48, 0xad, 0x0d, 0xdd, 0x68, 0x40]);
  // NMI exit: pull Y, X, A; RTI.
  put(0xfebc, [0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40]);
  // Default IRQ handler: JMP $EA7E (the keyboard scan and clock are left out).
  put(KERNAL_IRQ_HANDLER, [0x4c, 0x7e, 0xea]);
  // $EA7E: acknowledge CIA 1; $EA81: pull Y, X, A; RTI.
  put(0xea7e, [0xad, 0x0d, 0xdc, 0x68, 0xa8, 0x68, 0xaa, 0x68, 0x40]);
  // Reset lands in an endless loop (nothing here resets).
  put(0xfce2, [0x4c, 0xe2, 0xfc]);
  put(0xfffa, [KERNAL_NMI_ENTRY & 0xff, KERNAL_NMI_ENTRY >> 8, 0xe2, 0xfc, KERNAL_IRQ_ENTRY & 0xff, KERNAL_IRQ_ENTRY >> 8]);
  return rom;
}

const STAND_IN_KERNAL = standInKernal();
const STAND_IN_BASIC = new Uint8Array(0x2000).fill(RTS);

/** One Zobrist key half: a 32-bit mix of `k` (never 0 for two different k in practice). */
function zobrist(k: number, seed: number): number {
  let x = Math.imul(k ^ seed, 0x9e3779b1);
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x | 0;
}
const SEED_A = 0x2545f491;
const SEED_B = 0x6c8e9cf5;
/** I/O keys live above RAM's in the key space. */
const IO_KEY = 0x10000;

// ---------------------------------------------------------------------------
// CIA 6526
// ---------------------------------------------------------------------------

class CiaTimer {
  latch = 0xffff;
  /** The counter while stopped. */
  counter = 0xffff;
  running = false;
  oneShot = false;
  /** While running: the cycle of the next underflow. */
  nextUnderflow = Infinity;
  /** Timer B only: counts timer A underflows instead of cycles. */
  countsA = false;
}

class Cia {
  readonly a = new CiaTimer();
  readonly b = new CiaTimer();
  cra = 0;
  crb = 0;
  mask = 0;
  flags = 0;
  portA = 0xff;
  portB = 0xff;
  ddrA = 0;
  ddrB = 0;

  /** Bring the timers to cycle `now`, setting the interrupt flags of every underflow up to it. */
  sync(now: number): void {
    const a = this.a;
    const b = this.b;
    while (a.running && a.nextUnderflow <= now) {
      const at = a.nextUnderflow;
      this.flags |= 1;
      if (b.running && b.countsA) this.countB(at);
      if (a.oneShot) {
        a.running = false;
        a.counter = a.latch;
        this.cra &= ~1;
        a.nextUnderflow = Infinity;
      } else {
        a.nextUnderflow = at + a.latch + 1;
      }
    }
    while (b.running && !b.countsA && b.nextUnderflow <= now) {
      const at = b.nextUnderflow;
      this.flags |= 2;
      if (b.oneShot) {
        b.running = false;
        b.counter = b.latch;
        this.crb &= ~1;
        b.nextUnderflow = Infinity;
      } else {
        b.nextUnderflow = at + b.latch + 1;
      }
    }
  }

  private countB(_at: number): void {
    const b = this.b;
    if (b.counter === 0) {
      this.flags |= 2;
      b.counter = b.latch;
      if (b.oneShot) {
        b.running = false;
        this.crb &= ~1;
      }
    } else {
      b.counter--;
    }
  }

  /** The counter's value at `now` (after `sync(now)`). */
  counterAt(t: CiaTimer, now: number): number {
    if (!t.running || t === this.b && t.countsA) return t.counter;
    return Math.max(0, Math.min(0xffff, t.nextUnderflow - now - 1));
  }

  /** The next cycle at which an enabled interrupt source fires (Infinity: none). */
  nextInterrupt(): number {
    let next = Infinity;
    if (this.mask & 1 && this.a.running) next = this.a.nextUnderflow;
    if (this.mask & 2 && this.b.running && !this.b.countsA) next = Math.min(next, this.b.nextUnderflow);
    // Timer B counting A: fires on one of A's underflows.
    if (this.mask & 2 && this.b.running && this.b.countsA && this.a.running) next = Math.min(next, this.a.nextUnderflow);
    return next;
  }

  get asserted(): boolean {
    return (this.flags & this.mask & 0x1f) !== 0;
  }

  read(reg: number, now: number): number {
    this.sync(now);
    switch (reg) {
      case 0x0:
        return (this.portA | ~this.ddrA) & 0xff;
      case 0x1:
        return (this.portB | ~this.ddrB) & 0xff;
      case 0x2:
        return this.ddrA;
      case 0x3:
        return this.ddrB;
      case 0x4:
        return this.counterAt(this.a, now) & 0xff;
      case 0x5:
        return this.counterAt(this.a, now) >> 8;
      case 0x6:
        return this.counterAt(this.b, now) & 0xff;
      case 0x7:
        return this.counterAt(this.b, now) >> 8;
      case 0xd: {
        const v = (this.flags & 0x1f) | (this.asserted ? 0x80 : 0);
        this.flags = 0;
        return v;
      }
      case 0xe:
        return this.cra & 0xef;
      case 0xf:
        return this.crb & 0xef;
      default:
        return 0;
    }
  }

  write(reg: number, v: number, now: number): void {
    this.sync(now);
    const a = this.a;
    const b = this.b;
    switch (reg) {
      case 0x0:
        this.portA = v;
        break;
      case 0x1:
        this.portB = v;
        break;
      case 0x2:
        this.ddrA = v;
        break;
      case 0x3:
        this.ddrB = v;
        break;
      case 0x4:
        a.latch = (a.latch & 0xff00) | v;
        break;
      case 0x5:
        a.latch = (a.latch & 0x00ff) | (v << 8);
        if (!a.running) a.counter = a.latch;
        break;
      case 0x6:
        b.latch = (b.latch & 0xff00) | v;
        break;
      case 0x7:
        b.latch = (b.latch & 0x00ff) | (v << 8);
        if (!b.running) b.counter = b.latch;
        break;
      case 0xd:
        if (v & 0x80) this.mask |= v & 0x1f;
        else this.mask &= ~(v & 0x1f);
        break;
      case 0xe:
        this.control(a, v, now, false);
        this.cra = v & ~0x10;
        break;
      case 0xf:
        this.control(b, v, now, true);
        this.crb = v & ~0x10;
        break;
      default:
        break;
    }
  }

  private control(t: CiaTimer, v: number, now: number, isB: boolean): void {
    const current = this.counterAt(t, now);
    t.counter = v & 0x10 ? t.latch : current;
    t.oneShot = (v & 0x08) !== 0;
    // Counting the CNT pin (nothing drives it) never counts; timer B may count timer A.
    const countsCnt = isB ? (v & 0x60) === 0x20 : (v & 0x20) !== 0;
    t.countsA = isB && (v & 0x40) !== 0;
    t.running = (v & 1) !== 0 && !countsCnt;
    t.nextUnderflow = t.running && !t.countsA ? now + t.counter + 1 : Infinity;
  }
}

// ---------------------------------------------------------------------------
// SID voice 3 readback
// ---------------------------------------------------------------------------

/** reSID's rate counter periods (cycles per envelope step) for rates 0-15. */
const ENV_PERIOD = [9, 32, 63, 95, 149, 220, 267, 313, 392, 977, 1954, 3126, 3907, 11720, 19532, 31251];

/** Voice 3's oscillator and envelope, as far as `$D41B`/`$D41C` show them. */
class Voice3 {
  freq = 0;
  pw = 0;
  ctrl = 0;
  ad = 0;
  sr = 0;
  acc = 0;
  lfsr = 0x7ffff8;
  /** The cycle `acc` and `lfsr` are at. */
  at = 0;
  // Envelope.
  env = 0;
  state: 'attack' | 'decay' | 'release' = 'release';
  envAt = 0;
  rateCount = 0;
  expCount = 0;

  syncOsc(now: number): void {
    const dt = now - this.at;
    this.at = now;
    if (dt <= 0) return;
    if (this.ctrl & 0x08) {
      this.acc = 0;
      return;
    }
    const before = this.acc;
    const total = before + this.freq * dt;
    // Noise: the LFSR clocks on every rise of accumulator bit 19.
    const rises = Math.floor((total + 0x80000) / 0x100000) - Math.floor((before + 0x80000) / 0x100000);
    for (let i = 0; i < Math.min(rises, 0x7fffff); i++) {
      const bit = ((this.lfsr >> 22) ^ (this.lfsr >> 17)) & 1;
      this.lfsr = ((this.lfsr << 1) | bit) & 0x7fffff;
    }
    this.acc = total % 0x1000000;
  }

  osc(now: number): number {
    this.syncOsc(now);
    const acc = this.acc;
    let out = 0xff;
    let any = false;
    if (this.ctrl & 0x10) {
      const tri = (acc & 0x800000 ? acc ^ 0xffffff : acc) >> 15;
      out &= tri & 0xff;
      any = true;
    }
    if (this.ctrl & 0x20) {
      out &= acc >> 16;
      any = true;
    }
    if (this.ctrl & 0x40) {
      out &= (acc >> 12) >= (this.pw & 0xfff) ? 0xff : 0;
      any = true;
    }
    if (this.ctrl & 0x80) {
      const l = this.lfsr;
      const noise =
        (((l >> 22) & 1) << 7) | (((l >> 20) & 1) << 6) | (((l >> 16) & 1) << 5) | (((l >> 13) & 1) << 4) |
        (((l >> 11) & 1) << 3) | (((l >> 7) & 1) << 2) | (((l >> 4) & 1) << 1) | ((l >> 2) & 1);
      out &= noise;
      any = true;
    }
    return any ? out : 0;
  }

  /** Step the envelope to `now`, one rate period at a time. */
  syncEnv(now: number): void {
    while (true) {
      const rate = this.state === 'attack' ? this.ad >> 4 : this.state === 'decay' ? this.ad & 0x0f : this.sr & 0x0f;
      const period = ENV_PERIOD[rate]!;
      const next = this.envAt + period - this.rateCount;
      if (next > now) {
        this.rateCount += now - this.envAt;
        this.envAt = now;
        return;
      }
      this.envAt = next;
      this.rateCount = 0;
      if (this.state === 'attack') {
        this.env = (this.env + 1) & 0xff;
        if (this.env === 0xff) this.state = 'decay';
        continue;
      }
      const expPeriod = this.env >= 0x5d ? 1 : this.env >= 0x36 ? 2 : this.env >= 0x1a ? 4 : this.env >= 0x0e ? 8 : this.env >= 0x06 ? 16 : 30;
      if (++this.expCount < expPeriod) continue;
      this.expCount = 0;
      const sustain = (this.sr >> 4) * 0x11;
      if (this.env > 0 && !(this.state === 'decay' && this.env <= sustain)) this.env--;
      if (this.env === 0 || (this.state === 'decay' && this.env <= sustain)) {
        // Held (sustain) or frozen at zero until the next gate change.
        this.envAt = now;
        return;
      }
    }
  }

  writeCtrl(v: number, now: number): void {
    this.syncOsc(now);
    this.syncEnv(now);
    const gateOn = (v & 1) !== 0 && (this.ctrl & 1) === 0;
    const gateOff = (v & 1) === 0 && (this.ctrl & 1) !== 0;
    if (v & 0x08) this.acc = 0;
    this.ctrl = v;
    if (gateOn) this.state = 'attack';
    if (gateOff) this.state = 'release';
  }
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export class C64 implements CpuBus {
  readonly ram = new Uint8Array(0x10000);
  readonly cpu: Mos6510;
  readonly timing: C64Timing;
  readonly cia1 = new Cia();
  readonly cia2 = new Cia();
  /** SID chip base addresses; chip 0 is $D400. */
  readonly sidBases: readonly number[];
  /** Every SID write: chip index, register (0-31), value, cycle. */
  onSidWrite: ((chip: number, reg: number, value: number, cycle: number) => void) | null = null;

  private basicIn = true;
  private kernalIn = true;
  private ioIn = true;
  private readonly vic = new Uint8Array(0x40);
  private rasterCompare = 0;
  private vicFlags = 0;
  private vicMask = 0;
  /** Cycle of the next raster interrupt event (Infinity while none can fire). */
  private nextRaster = Infinity;
  private nmiAsserted = false;
  /** An NMI edge waits to be taken. */
  private nmiPending = false;
  private sidBus = 0;
  private readonly voice3 = new Voice3();
  private readonly ioShadow = new Uint8Array(0x1000);
  /** RAM as the state hash has it: the values of the writes made while hashing. */
  private readonly hashedRam = new Uint8Array(0x10000);
  private hashA = 0;
  private hashB = 0;
  /**
   * While set, writes leave the state hash alone: the capture sets it while
   * an NMI handler runs, whose sample playback is not the music's state (a
   * sample pointer that never repeats would hide the song's loop).
   */
  hashPaused = false;
  /** Cycle of the next timer/raster event to look at. */
  private nextEvent = Infinity;

  constructor(clock: C64Clock = 'pal', extraSids: readonly number[] = []) {
    this.timing = C64_TIMING[clock];
    this.sidBases = [0xd400, ...extraSids];
    this.cpu = new Mos6510(this);
    const ram = this.ram;
    ram[0x00] = 0x2f;
    ram[0x01] = 0x37;
    // KERNAL RAM vectors and the PAL/NTSC flag, as after boot.
    ram.set([KERNAL_IRQ_HANDLER & 0xff, KERNAL_IRQ_HANDLER >> 8, KERNAL_BRK_HANDLER & 0xff, KERNAL_BRK_HANDLER >> 8, KERNAL_NMI_HANDLER & 0xff, KERNAL_NMI_HANDLER >> 8], 0x0314);
    ram[0x02a6] = clock === 'pal' ? 1 : 0;
    this.hashedRam.set(ram);
    this.updateBanks();
    // The KERNAL's 60 Hz interrupt: CIA 1 timer A, continuous, IRQ enabled.
    this.cia1.write(0x4, this.timing.kernalCiaLatch & 0xff, 0);
    this.cia1.write(0x5, this.timing.kernalCiaLatch >> 8, 0);
    this.cia1.write(0xd, 0x81, 0);
    this.cia1.write(0xe, 0x11, 0);
    this.vic[0x11] = 0x1b;
    this.scheduleEvents();
  }

  /** The 64-bit state hash as a string key. */
  stateHash(): string {
    return `${(this.hashA >>> 0).toString(36)}.${(this.hashB >>> 0).toString(36)}`;
  }

  /** Load `data` at `address` (RAM, whatever the banking). */
  load(address: number, data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) this.writeRam((address + i) & 0xffff, data[i]!);
  }

  /** Set the `$01` banking (as a write to $01). */
  setBanks(value: number): void {
    this.writeRam(1, value);
    this.updateBanks();
  }

  get banks(): number {
    return this.ram[1]!;
  }

  private updateBanks(): void {
    const bits = (this.ram[1]! | ~this.ram[0]!) & 7;
    const lo = (bits & 1) !== 0;
    const hi = (bits & 2) !== 0;
    this.basicIn = lo && hi;
    this.kernalIn = hi;
    this.ioIn = (lo || hi) && (bits & 4) !== 0;
  }

  private writeRam(addr: number, v: number): void {
    this.ram[addr] = v;
    if (this.hashPaused) return;
    const old = this.hashedRam[addr]!;
    if (old === v) return;
    const k = addr << 8;
    this.hashA ^= zobrist(k | old, SEED_A) ^ zobrist(k | v, SEED_A);
    this.hashB ^= zobrist(k | old, SEED_B) ^ zobrist(k | v, SEED_B);
    this.hashedRam[addr] = v;
  }

  private shadowIo(addr: number, v: number): void {
    if (this.hashPaused) return;
    const i = addr & 0xfff;
    const old = this.ioShadow[i]!;
    if (old === v) return;
    const k = (IO_KEY | addr) << 8;
    this.hashA ^= zobrist(k | old, SEED_A) ^ zobrist(k | v, SEED_A);
    this.hashB ^= zobrist(k | old, SEED_B) ^ zobrist(k | v, SEED_B);
    this.ioShadow[i] = v;
  }

  read(addr: number): number {
    if (addr >= 0xa000) {
      if (addr < 0xc000) {
        if (this.basicIn) return STAND_IN_BASIC[addr - 0xa000]!;
      } else if (addr >= 0xe000) {
        if (this.kernalIn) return STAND_IN_KERNAL[addr - 0xe000]!;
      } else if (addr >= 0xd000 && this.ioIn) {
        return this.readIo(addr);
      }
    }
    return this.ram[addr]!;
  }

  write(addr: number, v: number): void {
    if (addr >= 0xd000 && addr < 0xe000 && this.ioIn) {
      this.writeIo(addr, v);
      return;
    }
    this.writeRam(addr, v);
    if (addr < 2) this.updateBanks();
  }

  private sidChip(addr: number): number {
    for (let i = this.sidBases.length - 1; i > 0; i--) {
      const base = this.sidBases[i]!;
      if (addr >= base && addr < base + 0x20) return i;
    }
    return addr >= 0xd400 && addr < 0xd800 ? 0 : -1;
  }

  private readIo(addr: number): number {
    const now = this.cpu.cycles;
    if (addr < 0xd400) return this.readVic(addr & 0x3f, now);
    if (addr < 0xd800 || addr >= 0xde00) {
      const chip = this.sidChip(addr);
      if (chip < 0) return 0;
      const reg = addr & 0x1f;
      if (chip === 0 && reg === 0x1b) return this.voice3.osc(now);
      if (chip === 0 && reg === 0x1c) {
        this.voice3.syncEnv(now);
        return this.voice3.env;
      }
      if (reg === 0x19 || reg === 0x1a) return 0xff;
      return this.sidBus;
    }
    if (addr < 0xdc00) return this.ram[addr]! & 0x0f;
    if (addr < 0xdd00) {
      const v = this.cia1.read(addr & 0x0f, now);
      if ((addr & 0x0f) === 0xd) this.scheduleEvents();
      return v;
    }
    if (addr < 0xde00) {
      const v = this.cia2.read(addr & 0x0f, now);
      if ((addr & 0x0f) === 0xd) {
        this.nmiAsserted = this.cia2.asserted;
        this.scheduleEvents();
      }
      return v;
    }
    return 0;
  }

  private writeIo(addr: number, v: number): void {
    const now = this.cpu.cycles;
    this.shadowIo(addr, v);
    if (addr < 0xd400) {
      this.writeVic(addr & 0x3f, v, now);
      return;
    }
    if (addr < 0xd800 || addr >= 0xde00) {
      const chip = this.sidChip(addr);
      if (chip < 0) return;
      const reg = addr & 0x1f;
      this.sidBus = v;
      if (chip === 0) this.voice3Write(reg, v, now);
      this.onSidWrite?.(chip, reg, v, now);
      return;
    }
    if (addr < 0xdc00) {
      this.writeRam(addr, v & 0x0f);
      return;
    }
    if (addr < 0xdd00) {
      this.cia1.write(addr & 0x0f, v, now);
      this.scheduleEvents();
      return;
    }
    this.cia2.write(addr & 0x0f, v, now);
    this.scheduleEvents();
  }

  private voice3Write(reg: number, v: number, now: number): void {
    const v3 = this.voice3;
    switch (reg) {
      case 0x0e:
        v3.syncOsc(now);
        v3.freq = (v3.freq & 0xff00) | v;
        break;
      case 0x0f:
        v3.syncOsc(now);
        v3.freq = (v3.freq & 0x00ff) | (v << 8);
        break;
      case 0x10:
        v3.pw = (v3.pw & 0xf00) | v;
        break;
      case 0x11:
        v3.pw = (v3.pw & 0x0ff) | ((v & 0x0f) << 8);
        break;
      case 0x12:
        v3.writeCtrl(v, now);
        break;
      case 0x13:
        v3.syncEnv(now);
        v3.ad = v;
        break;
      case 0x14:
        v3.syncEnv(now);
        v3.sr = v;
        break;
      default:
        break;
    }
  }

  // --- VIC-II ---------------------------------------------------------------

  private rasterLine(now: number): number {
    return Math.floor(now / this.timing.cyclesPerLine) % this.timing.lines;
  }

  private readVic(reg: number, now: number): number {
    this.syncRaster(now);
    switch (reg) {
      case 0x11:
        return (this.vic[0x11]! & 0x7f) | ((this.rasterLine(now) & 0x100) >> 1);
      case 0x12:
        return this.rasterLine(now) & 0xff;
      case 0x19:
        return (this.vicFlags & 0x0f) | 0x70 | ((this.vicFlags & this.vicMask & 0x0f) !== 0 ? 0x80 : 0);
      case 0x1a:
        return this.vicMask | 0xf0;
      default:
        return this.vic[reg]!;
    }
  }

  private writeVic(reg: number, v: number, now: number): void {
    this.syncRaster(now);
    this.vic[reg] = v;
    switch (reg) {
      case 0x11:
        this.rasterCompare = (this.rasterCompare & 0xff) | ((v & 0x80) << 1);
        this.scheduleRaster(now);
        break;
      case 0x12:
        this.rasterCompare = (this.rasterCompare & 0x100) | v;
        this.scheduleRaster(now);
        break;
      case 0x19:
        this.vicFlags &= ~v & 0x0f;
        break;
      case 0x1a:
        this.vicMask = v & 0x0f;
        break;
      default:
        break;
    }
    this.scheduleEvents();
  }

  /** The start cycle of the next line `rasterCompare` after `now` (Infinity if the line does not exist). */
  private scheduleRaster(now: number): void {
    const t = this.timing;
    if (this.rasterCompare >= t.lines) {
      this.nextRaster = Infinity;
      return;
    }
    const lineNow = Math.floor(now / t.cyclesPerLine);
    const inFrame = lineNow % t.lines;
    let delta = (this.rasterCompare - inFrame + t.lines) % t.lines;
    if (delta === 0) delta = t.lines;
    this.nextRaster = (lineNow + delta) * t.cyclesPerLine;
  }

  private syncRaster(now: number): void {
    while (this.nextRaster <= now) {
      this.vicFlags |= 1;
      this.nextRaster += c64FrameCycles(this.timing);
    }
  }

  // --- Interrupts and time --------------------------------------------------

  private scheduleEvents(): void {
    const now = this.cpu.cycles;
    if (this.nextRaster === Infinity && this.rasterCompare < this.timing.lines) this.scheduleRaster(now);
    const raster = this.vicMask & 1 ? this.nextRaster : Infinity;
    this.nextEvent = Math.min(raster, this.cia1.nextInterrupt(), this.cia2.nextInterrupt());
  }

  /** Whether the IRQ line is held (CIA 1 or the VIC). */
  get irqLine(): boolean {
    return this.cia1.asserted || (this.vicFlags & this.vicMask & 0x0f) !== 0;
  }

  /** Bring the chips to the CPU's cycle: set flags and latch an NMI edge. */
  private service(): void {
    const now = this.cpu.cycles;
    this.syncRaster(now);
    this.cia1.sync(now);
    this.cia2.sync(now);
    const nmi = this.cia2.asserted;
    if (nmi && !this.nmiAsserted) this.nmiPending = true;
    this.nmiAsserted = nmi;
    this.scheduleEvents();
  }

  /** The cycle of the next interrupt event (for idling up to it). */
  get nextEventCycle(): number {
    return this.nextEvent;
  }

  /**
   * Whether the CPU would take an interrupt before its next instruction: an
   * NMI edge, or the IRQ line held with I clear. An idle CPU must not skip
   * time past one (an IRQ that came while an NMI ran is taken as that NMI
   * returns, not at the next event).
   */
  interruptWaiting(): boolean {
    if (this.cpu.cycles >= this.nextEvent) this.service();
    return this.nmiPending || (this.irqLine && (this.cpu.p & 0x04) === 0);
  }

  /**
   * Take a waiting interrupt, if any: 'nmi', 'irq' or null. Call before each
   * instruction (`step` does).
   */
  takeInterrupt(): 'irq' | 'nmi' | null {
    if (this.cpu.cycles >= this.nextEvent) this.service();
    if (this.nmiPending) {
      this.nmiPending = false;
      this.cpu.nmi();
      return 'nmi';
    }
    if (this.irqLine && this.cpu.irq()) return 'irq';
    return null;
  }

  /** Advance time to `cycle` without running code (an idle CPU). */
  idleTo(cycle: number): void {
    if (cycle > this.cpu.cycles) this.cpu.cycles = cycle;
  }

  /** Run one instruction (taking an interrupt first if one is due). */
  step(): 'irq' | 'nmi' | null {
    const taken = this.takeInterrupt();
    this.cpu.step();
    return taken;
  }
}
