import { C64, c64FrameCycles, KERNAL_BRK_HANDLER, type C64Clock } from './c64';
import { psidSongUsesCia, type PsidFile } from './psid-file';
import {
  callRoutine,
  enterCall,
  hex4,
  IDLE_TRAP,
  INIT_MAX_CYCLES,
  PLAY_MAX_CYCLES,
  psidBanksFor,
  RETURN_TRAP,
} from './sid-capture';

/**
 * Plays a `.sid` as it is (.ai/plan-psid-playback.md): the tune's 6502 code
 * runs on the emulated C64 (`c64.ts`) in step with the audio, and every write
 * it makes to the first SID comes out with the cycle it was made on, ready to
 * be scheduled on a chip (`SidChipPlayer.write_after`).
 *
 * `sid-capture.ts` runs a tune to the end to learn a trace; this is the same
 * driver turned inside out: `advance(cycle)` runs the machine up to a point
 * in emulated time and stops, `drain` hands over what was written before it.
 * The tune is driven the way HVSC's environment drives it (see the capture's
 * header): a PSID with a play address has init called with the subsong in A
 * and play called once per tick, per video frame or at CIA 1 timer A's rate;
 * an RSID, or a play address of 0, is left to its own interrupts after init.
 *
 * Time is in CPU cycles from the start of playback (`origin`), so a write
 * `init` made before it is at cycle 0. What the caller may rely on: after
 * `advance(c)`, every write at a cycle below `horizon` is in the queue and no
 * later write will be stamped below it.
 */

export type PsidRunnerCreate =
  | { readonly ok: true; readonly runner: PsidRunner }
  | { readonly ok: false; readonly reason: string };

/** The horizon of a tune that has stopped: nothing more will be written. */
const NEVER = Number.POSITIVE_INFINITY;

export class PsidRunner {
  readonly machine: C64;
  readonly clock: C64Clock;
  readonly clockHz: number;
  /** Cycles between ticks of a host-driven tune (a video frame, or CIA 1 timer A's period). */
  readonly tickCycles: number;
  /** Host-driven (`play`), or left to its own interrupts after init (`irq`). */
  readonly mode: 'play' | 'irq';
  /** Why the tune stopped (its player jammed the CPU, hit a BRK, ran away), or null while it plays. */
  ended: string | null = null;

  private readonly file: PsidFile;
  /** Machine cycle that is cycle 0 of the output. */
  private readonly origin: number;
  /** The machine cycle the next host-driven tick is due on. */
  private next: number;
  /** Machine cycle before which nothing more will be written. */
  private horizonCycle: number;
  /** Writes to the first SID, in order: machine cycle, register, value. */
  private cycles = new Float64Array(1024);
  private regs = new Uint8Array(1024);
  private values = new Uint8Array(1024);
  private head = 0;
  private tail = 0;
  /** Writes to a second or third SID, dropped (the chip here is one). */
  extraSidWrites = 0;

  private constructor(file: PsidFile, clock: C64Clock, machine: C64, mode: 'play' | 'irq', tickCycles: number) {
    this.file = file;
    this.machine = machine;
    this.mode = mode;
    this.clock = clock;
    this.clockHz = machine.timing.hz;
    this.tickCycles = tickCycles;
    this.origin = machine.cpu.cycles;
    this.next = machine.cpu.cycles;
    this.horizonCycle = machine.cpu.cycles;
  }

  /** Subsong `subsong` (0-based) of `file`, initialised and ready to `advance`. Never throws for a tune's behaviour. */
  static create(file: PsidFile, subsong: number): PsidRunnerCreate {
    const clock: C64Clock = file.clock === 'ntsc' ? 'ntsc' : 'pal';
    const machine = new C64(clock, file.extraSids);
    // Nothing here compares machine states, so the hash that finds loops is dead weight.
    machine.hashPaused = true;
    const cpu = machine.cpu;
    machine.load(file.loadAddress, file.data);
    const song = Math.max(0, Math.min(file.songs - 1, subsong));
    const irqMode = file.type === 'RSID' || file.playAddress === 0;
    const early: { cycle: number; reg: number; value: number }[] = [];
    let runner: PsidRunner | null = null;
    machine.onSidWrite = (chip, reg, value, cycle) => {
      if (runner === null) {
        if (chip === 0) early.push({ cycle, reg: reg & 31, value });
        return;
      }
      if (chip !== 0) runner.extraSidWrites++;
      else runner.push(cycle, reg & 31, value);
    };

    let tickCycles = c64FrameCycles(machine.timing);
    if (!irqMode) {
      machine.setBanks(psidBanksFor(file.initAddress));
      const end = callRoutine(machine, file.initAddress, song, INIT_MAX_CYCLES);
      if (end === 'jam') return { ok: false, reason: `the tune's init routine (${hex4(file.initAddress)}) stopped the CPU (a JAM opcode at ${hex4(cpu.pc)})` };
      if (end === 'brk') return { ok: false, reason: `the tune's init routine (${hex4(file.initAddress)}) hit a BRK` };
      if (end === 'timeout') {
        return { ok: false, reason: `the tune's init routine (${hex4(file.initAddress)}) did not return in ${INIT_MAX_CYCLES / 1e6} million cycles` };
      }
      if (psidSongUsesCia(file, song + 1)) tickCycles = machine.cia1.a.latch + 1;
    } else {
      if (file.type === 'PSID') machine.setBanks(psidBanksFor(file.initAddress));
      enterCall(machine, file.initAddress, song);
    }

    runner = new PsidRunner(file, clock, machine, irqMode ? 'irq' : 'play', tickCycles);
    // What init wrote before playback began is the chip's state at cycle 0.
    for (const w of early) runner.push(w.cycle, w.reg, w.value);
    return { ok: true, runner };
  }

  /** The cycle (from the start of playback) before which every write is known. */
  get horizon(): number {
    return this.horizonCycle === NEVER ? NEVER : this.horizonCycle - this.origin;
  }

  /** How many writes wait to be drained. */
  get pending(): number {
    return this.tail - this.head;
  }

  private push(machineCycle: number, reg: number, value: number): void {
    if (this.tail === this.cycles.length) this.makeRoom();
    this.cycles[this.tail] = machineCycle;
    this.regs[this.tail] = reg;
    this.values[this.tail] = value;
    this.tail++;
  }

  private makeRoom(): void {
    const live = this.tail - this.head;
    if (this.head > 0 && live <= this.cycles.length >> 1) {
      this.cycles.copyWithin(0, this.head, this.tail);
      this.regs.copyWithin(0, this.head, this.tail);
      this.values.copyWithin(0, this.head, this.tail);
    } else {
      const size = this.cycles.length * 2;
      const c = new Float64Array(size);
      const r = new Uint8Array(size);
      const v = new Uint8Array(size);
      c.set(this.cycles.subarray(this.head, this.tail));
      r.set(this.regs.subarray(this.head, this.tail));
      v.set(this.values.subarray(this.head, this.tail));
      this.cycles = c;
      this.regs = r;
      this.values = v;
    }
    this.tail = live;
    this.head = 0;
  }

  /**
   * Hand over, in order, the writes made before cycle `until` (from the start
   * of playback), each with its cycle (never below 0), register and value.
   * `until` must not be past `horizon`.
   */
  drain(until: number, sink: (cycle: number, reg: number, value: number) => void): void {
    const limit = until + this.origin;
    while (this.head < this.tail && this.cycles[this.head]! < limit) {
      const i = this.head++;
      sink(Math.max(0, this.cycles[i]! - this.origin), this.regs[i]!, this.values[i]!);
    }
    if (this.head === this.tail) this.head = this.tail = 0;
  }

  private end(why: string): void {
    this.ended = why;
    this.horizonCycle = NEVER;
  }

  /** Run the tune until emulated time reaches cycle `until` (from the start of playback). */
  advance(until: number): void {
    if (this.ended !== null) return;
    const target = until + this.origin;
    if (this.mode === 'play') this.advancePlay(target);
    else this.advanceIrq(target);
  }

  private advancePlay(target: number): void {
    const machine = this.machine;
    const cpu = machine.cpu;
    const addr = this.file.playAddress;
    while (this.horizonCycle < target) {
      machine.idleTo(this.next);
      machine.setBanks(psidBanksFor(addr));
      const e = callRoutine(machine, addr, 0, PLAY_MAX_CYCLES);
      if (e === 'jam') return this.end(`the tune's play routine (${hex4(addr)}) stopped the CPU (JAM at ${hex4(cpu.pc)})`);
      if (e === 'brk') return this.end(`the tune's play routine (${hex4(addr)}) hit a BRK`);
      if (e === 'timeout') return this.end(`the tune's play routine (${hex4(addr)}) did not return`);
      this.next += this.tickCycles;
      // The next call starts no earlier than this: a play that overran its tick starts when it ended.
      this.horizonCycle = Math.max(this.next, cpu.cycles);
    }
  }

  private advanceIrq(target: number): void {
    const machine = this.machine;
    const cpu = machine.cpu;
    while (cpu.cycles < target) {
      if (cpu.jammed) return this.end(`the tune stopped the CPU (JAM at ${hex4(cpu.pc)})`);
      if (cpu.pc === KERNAL_BRK_HANDLER && (machine.banks & 2) !== 0) return this.end('the tune hit a BRK');
      if (cpu.pc === RETURN_TRAP) {
        // Init returned to the host: interrupts on, idle.
        cpu.pc = IDLE_TRAP;
        cpu.p &= ~0x04;
      }
      if (cpu.pc === IDLE_TRAP && !machine.interruptWaiting()) {
        // Nothing runs between the tune's interrupts: time jumps to the next one (or to the end of this stretch).
        machine.idleTo(Math.min(machine.nextEventCycle, target));
      }
      if (machine.takeInterrupt() !== null) continue;
      // An interrupt the tune keeps masked leaves the host idling, not running the I/O area.
      if (cpu.pc === IDLE_TRAP) {
        machine.idleTo(target);
        continue;
      }
      cpu.step();
    }
    this.horizonCycle = cpu.cycles;
  }
}
